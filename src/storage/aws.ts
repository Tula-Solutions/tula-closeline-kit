import {
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import type { OrganizationIdCheck } from '../organization'
import type { Environment } from '../reporting/env'
import { STORAGE_ERROR_CODES, StorageError } from './errors'
import {
  createStorageValidator,
  DEFAULT_CONTENT_TYPE,
  encodeCursor,
  type ListPage,
  type ObjectInfo,
  type ObjectStore,
  type StoredObject,
} from './port'

/** The one SDK method the adapter uses; a test passes a stub with this shape. */
export interface S3Sender {
  /** Sends one SDK command, with a per-call timeout and abort signal. */
  send(
    command:
      | PutObjectCommand
      | GetObjectCommand
      | HeadObjectCommand
      | DeleteObjectCommand
      | ListObjectsV2Command,
    options?: { requestTimeout?: number; abortSignal?: AbortSignal }
  ): Promise<unknown>
}

/** Options for {@link createS3ObjectStore}. */
export interface S3ObjectStoreOptions {
  /** The bucket. One bucket per Region (ADR 0001); Organizations are separated by key prefix. */
  bucket: string
  /** The AWS Region of the bucket. */
  region: string
  /** The `ENVIRONMENT` the service runs in. */
  environment: Environment
  /**
   * An endpoint to use instead of AWS, for the S3 stand-in in local development
   * (`http://127.0.0.1:9090`). Accepted only when `environment` is `local`; anywhere else it
   * throws at construction, as does a set `AWS_ENDPOINT_URL` or `AWS_ENDPOINT_URL_S3`. Credentials
   * are never an option: they come from the SDK's default chain.
   */
  endpoint?: string
  /** Largest object in bytes; default 25 MiB, at most 100 MiB. */
  maxObjectBytes?: number
  /** Extra Organization id rule; the contract's format by default. */
  isOrganizationId?: OrganizationIdCheck
  /** Bound on one attempt's connect and idle time, in ms; default 5000. */
  timeoutMs?: number
  /** Bound on one operation including every attempt, in ms; default 60000. */
  deadlineMs?: number
  /** Attempts per call, the first included, with the SDK's jittered exponential back-off; default 3. */
  maxAttempts?: number
  /** A replacement for the SDK client, for unit tests with no network. */
  client?: S3Sender
}

/** The default bound on one attempt, in milliseconds. */
export const S3_DEFAULT_TIMEOUT_MS = 5_000

/** The default bound on a whole operation, in milliseconds. */
export const S3_DEFAULT_DEADLINE_MS = 60_000

/** The default number of attempts per call. */
export const S3_DEFAULT_MAX_ATTEMPTS = 3

/** Every object of every Organization lives under this prefix, then `<organizationId>/`. */
export const S3_KEY_PREFIX = 'orgs/'

const ENDPOINT_VARIABLES = ['AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_S3'] as const
const MISSING = new Set(['NoSuchKey', 'NotFound'])

/**
 * Turns an SDK failure into a StorageError. A fault the SDK blames on the client and does not call
 * retryable (access denied, no such bucket, bad request) can never succeed on retry: it is
 * `storage.rejected`. Everything else (server faults, throttling, timeouts, a dropped connection)
 * is `storage.unavailable`. The SDK has already retried what it considers retryable.
 */
function mapFailure(operation: string, error: unknown): StorageError {
  const fault = error as { $fault?: unknown; $retryable?: unknown } | null
  if (fault?.$fault === 'client' && fault.$retryable === undefined) {
    return new StorageError(STORAGE_ERROR_CODES.rejected, `the store refused ${operation}`, {
      cause: error,
    })
  }
  return new StorageError(
    STORAGE_ERROR_CODES.unavailable,
    `the store did not complete ${operation}`,
    {
      cause: error,
    }
  )
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && MISSING.has(error.name)
}

/**
 * Creates the S3 adapter, built on the AWS SDK v3 S3 client.
 *
 * Location: an object is stored at `orgs/<organizationId>/<key>`. Both parts were validated, the
 * Organization id against a hard character set (no separator, dot or escape) and the key by the
 * port's segment rules, and the prefix ends in `/`, so `org_1` never reaches `org_10`. A listing
 * asks S3 for that prefix only and the adapter refuses any key S3 returns outside it.
 *
 * Timeouts: every attempt has a connect and an idle timeout (`timeoutMs`) and the whole operation
 * has a deadline (`deadlineMs`). Retries: the SDK's own, `maxAttempts` with the `standard` mode's
 * jittered exponential back-off and retry quota, for the failures it calls retryable (5xx,
 * throttling, timeouts, dropped connections); a 4xx such as access denied is not retried. Put and
 * delete are idempotent, so a retry is safe. Neither bodies nor keys are logged: the adapter does
 * not log.
 *
 * Proxies: the SDK's Node HTTP handler is used with its default agents, which in Bun do not read
 * `HTTP_PROXY`, `HTTPS_PROXY` or `ALL_PROXY` (see the SQS adapter's proof, `aws-proxy.test.ts`).
 *
 * Complexity: put and get O(object size); head and delete O(1); list O(limit); one HTTP call each.
 */
export function createS3ObjectStore(options: S3ObjectStoreOptions): ObjectStore {
  if (options.endpoint !== undefined && options.environment !== 'local') {
    throw new TypeError(
      `an S3 endpoint override is only for ENVIRONMENT=local, not ${options.environment}`
    )
  }
  if (options.environment !== 'local') {
    for (const name of ENDPOINT_VARIABLES) {
      if ((process.env[name] ?? '') !== '') {
        throw new TypeError(`${name} is set; an S3 endpoint override is only for ENVIRONMENT=local`)
      }
    }
  }
  if (options.bucket === '' || /[^a-z0-9.-]/.test(options.bucket)) {
    throw new TypeError('bucket must be a non-empty S3 bucket name')
  }
  const timeoutMs = options.timeoutMs ?? S3_DEFAULT_TIMEOUT_MS
  const deadlineMs = options.deadlineMs ?? S3_DEFAULT_DEADLINE_MS
  const maxAttempts = options.maxAttempts ?? S3_DEFAULT_MAX_ATTEMPTS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new TypeError('timeoutMs must be a whole number from 100 to 60000')
  }
  if (!Number.isInteger(deadlineMs) || deadlineMs < timeoutMs || deadlineMs > 600_000) {
    throw new TypeError('deadlineMs must be a whole number from timeoutMs to 600000')
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new TypeError('maxAttempts must be a whole number from 1 to 10')
  }
  const check = createStorageValidator({
    maxObjectBytes: options.maxObjectBytes,
    isOrganizationId: options.isOrganizationId,
  })
  const { bucket } = options
  const client: S3Sender =
    options.client ??
    new S3Client({
      region: options.region,
      maxAttempts,
      retryMode: 'standard',
      requestHandler: {
        connectionTimeout: timeoutMs,
        requestTimeout: timeoutMs,
        throwOnRequestTimeout: true,
      },
      ...(options.endpoint === undefined
        ? {}
        : {
            endpoint: options.endpoint,
            forcePathStyle: true,
            // Stand-ins do not all take the SDK's default checksum trailers.
            requestChecksumCalculation: 'WHEN_REQUIRED',
            responseChecksumValidation: 'WHEN_REQUIRED',
          }),
    })

  const prefixOf = (organization: string) => `${S3_KEY_PREFIX}${organization}/`
  const send = (command: Parameters<S3Sender['send']>[0]) =>
    client.send(command, {
      requestTimeout: timeoutMs,
      abortSignal: AbortSignal.timeout(deadlineMs),
    })

  async function head(organizationId: string, key: string): Promise<ObjectInfo | undefined> {
    const location = prefixOf(check.organization(organizationId)) + check.key(key)
    let output: HeadObjectCommandOutput
    try {
      output = (await send(
        new HeadObjectCommand({ Bucket: bucket, Key: location })
      )) as HeadObjectCommandOutput
    } catch (error) {
      if (isMissing(error)) {
        return undefined
      }
      throw mapFailure('a head', error)
    }
    return infoOf(key, output)
  }

  function infoOf(
    key: string,
    output: { ContentLength?: number; ContentType?: string; LastModified?: Date }
  ): ObjectInfo {
    if (output.ContentLength === undefined || output.LastModified === undefined) {
      throw new StorageError(
        STORAGE_ERROR_CODES.badResponse,
        'the store returned an object without a size or time'
      )
    }
    return {
      key,
      size: output.ContentLength,
      contentType: output.ContentType ?? DEFAULT_CONTENT_TYPE,
      lastModified: output.LastModified,
    }
  }

  return {
    async put(organizationId, key, body, putOptions) {
      const location = prefixOf(check.organization(organizationId)) + check.key(key)
      const bytes = check.body(body)
      const contentType = check.contentType(putOptions?.contentType)
      try {
        await send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: location,
            Body: bytes,
            ContentLength: bytes.byteLength,
            ContentType: contentType,
          })
        )
      } catch (error) {
        throw mapFailure('a put', error)
      }
    },

    async get(organizationId, key) {
      const location = prefixOf(check.organization(organizationId)) + check.key(key)
      let output: GetObjectCommandOutput
      try {
        output = (await send(
          new GetObjectCommand({ Bucket: bucket, Key: location })
        )) as GetObjectCommandOutput
      } catch (error) {
        if (isMissing(error)) {
          return undefined
        }
        throw mapFailure('a get', error)
      }
      const described = infoOf(key, output)
      if (described.size > check.maxObjectBytes) {
        // Refuse before reading: an object written by someone else can be larger than this store accepts.
        throw new StorageError(STORAGE_ERROR_CODES.objectTooLarge, 'the object is too large', {
          details: { limitBytes: check.maxObjectBytes },
        })
      }
      if (output.Body === undefined) {
        throw new StorageError(STORAGE_ERROR_CODES.badResponse, 'the store returned no body')
      }
      let body: Uint8Array
      try {
        body = await output.Body.transformToByteArray()
      } catch (error) {
        throw mapFailure('reading a body', error)
      }
      if (body.byteLength !== described.size) {
        throw new StorageError(
          STORAGE_ERROR_CODES.badResponse,
          'the body is not the size announced'
        )
      }
      const stored: StoredObject = { ...described, body }
      return stored
    },

    head,

    async delete(organizationId, key) {
      const location = prefixOf(check.organization(organizationId)) + check.key(key)
      try {
        await send(new DeleteObjectCommand({ Bucket: bucket, Key: location }))
      } catch (error) {
        // S3 answers 204 for a missing key; a stand-in that says not found has still left it gone.
        if (!isMissing(error)) {
          throw mapFailure('a delete', error)
        }
      }
    },

    async list(organizationId, listOptions) {
      const root = prefixOf(check.organization(organizationId))
      const { prefix, after, limit } = check.list(listOptions)
      let output: ListObjectsV2CommandOutput
      try {
        output = (await send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: root + prefix,
            MaxKeys: limit,
            ...(after === undefined ? {} : { StartAfter: root + after }),
          })
        )) as ListObjectsV2CommandOutput
      } catch (error) {
        throw mapFailure('a list', error)
      }
      const contents = output.Contents ?? []
      if (contents.length > limit) {
        throw new StorageError(STORAGE_ERROR_CODES.badResponse, 'the store returned too many keys')
      }
      const items = contents.map((entry) => {
        if (
          entry.Key === undefined ||
          !entry.Key.startsWith(root) ||
          entry.Size === undefined ||
          entry.LastModified === undefined
        ) {
          throw new StorageError(
            STORAGE_ERROR_CODES.badResponse,
            'the store returned a key outside the Organization or without a size'
          )
        }
        const key = entry.Key.slice(root.length)
        try {
          check.key(key)
        } catch (error) {
          throw new StorageError(STORAGE_ERROR_CODES.badResponse, 'the store returned an odd key', {
            cause: error,
          })
        }
        return { key, size: entry.Size, lastModified: entry.LastModified }
      })
      const result: ListPage = { items }
      const last = items.at(-1)
      if (output.IsTruncated === true && last !== undefined) {
        result.nextCursor = encodeCursor(last.key)
      }
      return result
    },
  }
}
