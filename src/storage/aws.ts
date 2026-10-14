import { createHash } from 'node:crypto'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { isTransientAwsFailure, reduceAwsCause } from '../aws-failure'
import type { Logger } from '../logger'
import type { OrganizationIdCheck } from '../organization'
import type { Environment } from '../reporting/env'
import { createS3Client } from './client'
import { STORAGE_ERROR_CODES, StorageError } from './errors'
import {
  DEFAULT_CONTENT_TYPE,
  type ListPage,
  MAX_LIST_LIMIT,
  type ObjectEntry,
  type ObjectInfo,
  type ObjectStore,
  type ObjectStream,
  type PutStreamResult,
  STREAM_IDLE_TIMEOUT_MS,
  type StoredObject,
} from './port'
import { checkIdleTimeout, checkStreamLimit, readChunks, tooLarge } from './stream'
import { createStorageValidator, encodeCursor } from './validate'

/** The one SDK method the adapter uses; a test passes a stub with this shape. */
export interface S3Sender {
  /** Sends one SDK command, with a per-call timeout and abort signal. */
  send(
    command:
      | PutObjectCommand
      | GetObjectCommand
      | HeadObjectCommand
      | DeleteObjectCommand
      | ListObjectsV2Command
      | CreateMultipartUploadCommand
      | UploadPartCommand
      | CompleteMultipartUploadCommand
      | AbortMultipartUploadCommand,
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
  /** Bound on one public call (a `list` may make several requests) including every attempt, in ms; default 60000. */
  deadlineMs?: number
  /** Attempts per call, the first included, with the SDK's jittered exponential back-off; default 3. */
  maxAttempts?: number
  /** How long a streamed get may wait for the next bytes, in ms, 10 to 600000; default 30000. */
  streamIdleTimeoutMs?: number
  /** Size of one part of a streamed put in bytes, 5 MiB to 64 MiB; default 8 MiB. */
  partBytes?: number
  /** Parts of one streamed put uploading at once, 1 to 8; default 2. */
  partConcurrency?: number
  /** Where `list` reports, by number, the keys it skipped; nothing else is logged. */
  logger?: Logger
  /** A replacement for the SDK client, for unit tests with no network. */
  client?: S3Sender
}

/** The default bound on one attempt, in milliseconds. */
export const S3_DEFAULT_TIMEOUT_MS = 5_000

/** The default bound on a whole operation, in milliseconds. */
export const S3_DEFAULT_DEADLINE_MS = 60_000

/** The default number of attempts per call. */
export const S3_DEFAULT_MAX_ATTEMPTS = 3

/** The default size of a part of a streamed put, in bytes. */
export const S3_DEFAULT_PART_BYTES = 8 * 1024 * 1024

/** The default number of parts of one streamed put uploading at once. */
export const S3_DEFAULT_PART_CONCURRENCY = 2

/** Every object of every Organization lives under this prefix, then `<organizationId>/`. */
export const S3_KEY_PREFIX = 'orgs/'

/** The most requests one `list` makes while it skips keys the port cannot name. */
const LIST_MAX_ROUNDS = 10

const ENDPOINT_VARIABLES = ['AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_S3'] as const
const MISSING = new Set(['NoSuchKey', 'NotFound'])

/**
 * Turns an SDK failure into a StorageError. A permanent failure (access denied, no such bucket, a
 * credentials provider that found nothing) is `storage.rejected`; a transient one (server faults,
 * throttling, timeouts, aborts, connection failures) is `storage.unavailable`, after the SDK's own
 * retries. The cause is a reduced description, never the SDK error (see `reduceAwsCause`).
 */
function mapFailure(operation: string, error: unknown): StorageError {
  const cause = reduceAwsCause(error)
  return isTransientAwsFailure(error)
    ? new StorageError(STORAGE_ERROR_CODES.unavailable, `the store did not complete ${operation}`, {
        cause,
      })
    : new StorageError(STORAGE_ERROR_CODES.rejected, `the store refused ${operation}`, { cause })
}

/** Closes a response body that will not be read, so its connection is released. */
function discardBody(body: unknown): void {
  const stream = body as { destroy?: () => unknown; cancel?: () => unknown } | undefined
  try {
    if (typeof stream?.destroy === 'function') {
      stream.destroy()
    } else if (typeof stream?.cancel === 'function') {
      void Promise.resolve(stream.cancel()).catch(() => undefined)
    }
  } catch {
    // The body is already closed or failed; nothing is left to release.
  }
}

/**
 * Wraps a response body so that a read that stalls for the idle timeout, or fails, becomes
 * `storage.unavailable` instead of a raw socket error, and so that `cancel` destroys the
 * underlying connection.
 */
function guardBody(
  source: ReadableStream<Uint8Array>,
  raw: unknown,
  idleMs: number
): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  let released = false
  const release = () => {
    if (!released) {
      released = true
      discardBody(raw)
    }
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const step = await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('the body stalled')), idleMs)
          }),
        ])
        if (step.done) {
          controller.close()
        } else {
          controller.enqueue(step.value)
        }
      } catch (error) {
        if (released) {
          return
        }
        release()
        void reader.cancel().catch(() => undefined)
        controller.error(
          new StorageError(
            STORAGE_ERROR_CODES.unavailable,
            'the body could not be read to the end',
            {
              cause: reduceAwsCause(error),
            }
          )
        )
      } finally {
        clearTimeout(timer)
      }
    },
    cancel() {
      release()
      return reader.cancel().catch(() => undefined)
    },
  })
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
 * Keys the port cannot name (a console folder marker, a name with a space) are skipped by `list`,
 * which reads ahead for at most ten requests: the first asks for the page size, the other nine for
 * 1000 keys each. The cursor is the last key handed out, so more than about 9,000 such keys in a
 * row after it (the page size plus 9,000) make every attempt to list past them fail with
 * `storage.bad_response`, and the valid keys beyond the run cannot be reached through the port.
 * Accepted by design: this adapter is the only writer under the prefix, and it never writes one.
 *
 * Streamed puts: a body of at most one part is one PutObject. A larger one is a multipart upload
 * with parts of `partBytes` (8 MiB), `partConcurrency` (2) at a time, so memory is about
 * (concurrency + 1) parts whatever the object size. Every request has the per-call deadline
 * (`deadlineMs`) and the SDK's retries; the stream as a whole is bounded by `maxBytes` and by the
 * caller's `signal`. On any failure the in-flight parts are awaited and the multipart upload is
 * aborted, so no part stays billed. The object appears only when the upload completes, so a write
 * that fails before the completing request leaves nothing readable and an object already under
 * the key stays as it was.
 *
 * Residual cases, which no code here can close: (1) a throw after the last part was sent (the
 * completing request timed out or its answer was lost) means the content under the key is unknown,
 * because S3 may have finished: the caller retries (put is idempotent) or heads and deletes before
 * relying on absence; (2) the abort is best-effort; (3) a create or part request that timed out
 * client-side but reached S3 can leave an incomplete upload that only the bucket's lifecycle rule
 * removes, as does a process that dies mid-upload. The bucket must carry that rule: abort
 * incomplete multipart uploads 1 day after initiation (`AbortIncompleteMultipartUpload`,
 * `DaysAfterInitiation: 1`, the finest S3 offers).
 *
 * Complexity: put and get O(object size); putStream O(object size) time and O(part size)
 * memory; getStream, head and delete O(1); list O(limit); one HTTP call each, except a streamed
 * put (one call per part).
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
  const streamIdleMs = options.streamIdleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS
  if (!Number.isInteger(streamIdleMs) || streamIdleMs < 10 || streamIdleMs > 600_000) {
    throw new TypeError('streamIdleTimeoutMs must be a whole number from 10 to 600000')
  }
  const partBytes = options.partBytes ?? S3_DEFAULT_PART_BYTES
  const partConcurrency = options.partConcurrency ?? S3_DEFAULT_PART_CONCURRENCY
  if (!Number.isInteger(partBytes) || partBytes < 5 * 1024 * 1024 || partBytes > 64 * 1024 * 1024) {
    throw new TypeError('partBytes must be a whole number from 5 MiB to 64 MiB')
  }
  if (!Number.isInteger(partConcurrency) || partConcurrency < 1 || partConcurrency > 8) {
    throw new TypeError('partConcurrency must be a whole number from 1 to 8')
  }
  const check = createStorageValidator({
    maxObjectBytes: options.maxObjectBytes,
    isOrganizationId: options.isOrganizationId,
  })
  const { bucket, logger } = options
  const client: S3Sender =
    options.client ??
    createS3Client({
      region: options.region,
      environment: options.environment,
      endpoint: options.endpoint,
      timeoutMs,
      maxAttempts,
    })

  const prefixOf = (organization: string) => `${S3_KEY_PREFIX}${organization}/`
  // One deadline per public call, shared by every request the call makes (a listing may make ten).
  const send = (deadline: AbortSignal, command: Parameters<S3Sender['send']>[0]) =>
    client.send(command, {
      requestTimeout: timeoutMs,
      abortSignal: deadline,
    })

  async function head(organizationId: string, key: string): Promise<ObjectInfo | undefined> {
    const deadline = AbortSignal.timeout(deadlineMs)
    const location = prefixOf(check.organization(organizationId)) + check.key(key)
    let output: HeadObjectCommandOutput
    try {
      output = (await send(
        deadline,
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
      const deadline = AbortSignal.timeout(deadlineMs)
      const location = prefixOf(check.organization(organizationId)) + check.key(key)
      const bytes = check.body(body)
      const contentType = check.contentType(putOptions?.contentType)
      try {
        await send(
          deadline,
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

    async putStream(organizationId, key, body, putOptions) {
      const location = prefixOf(check.organization(organizationId)) + check.key(key)
      const contentType = check.contentType(putOptions?.contentType)
      const maxBytes = checkStreamLimit(putOptions?.maxBytes)
      const stop = new AbortController()
      const requestSignal = () =>
        AbortSignal.any([
          AbortSignal.timeout(deadlineMs),
          stop.signal,
          ...(putOptions?.signal === undefined ? [] : [putOptions.signal]),
        ])
      const hash = createHash('sha256')
      let size = 0
      let current = Buffer.allocUnsafe(partBytes)
      let filled = 0
      let uploadId: string | undefined
      let partNumber = 0
      const completed: Array<{ ETag: string; PartNumber: number }> = []
      const inflight = new Set<Promise<void>>()
      let failure: unknown

      const uploadPart = async (data: Buffer, number: number): Promise<void> => {
        const output = (await client.send(
          new UploadPartCommand({
            Bucket: bucket,
            Key: location,
            UploadId: uploadId as string,
            PartNumber: number,
            Body: data,
            ContentLength: data.byteLength,
          }),
          { requestTimeout: timeoutMs, abortSignal: requestSignal() }
        )) as { ETag?: string }
        if (output.ETag === undefined) {
          throw new StorageError(STORAGE_ERROR_CODES.badResponse, 'the store returned no part tag')
        }
        completed.push({ ETag: output.ETag, PartNumber: number })
      }
      const launch = async (data: Buffer): Promise<void> => {
        if (uploadId === undefined) {
          const created = (await client.send(
            new CreateMultipartUploadCommand({
              Bucket: bucket,
              Key: location,
              ContentType: contentType,
            }),
            { requestTimeout: timeoutMs, abortSignal: requestSignal() }
          )) as { UploadId?: string }
          if (created.UploadId === undefined) {
            throw new StorageError(
              STORAGE_ERROR_CODES.badResponse,
              'the store returned no upload id'
            )
          }
          uploadId = created.UploadId
        }
        // Wait for a free slot; a failed part surfaces here, before more is read.
        while (inflight.size >= partConcurrency && failure === undefined) {
          await Promise.race(inflight)
        }
        if (failure !== undefined) {
          throw failure
        }
        partNumber += 1
        const task: Promise<void> = uploadPart(data, partNumber).then(
          () => {
            inflight.delete(task)
          },
          (error: unknown) => {
            failure ??= error
            inflight.delete(task)
            stop.abort()
          }
        )
        inflight.add(task)
      }

      try {
        for await (const chunk of readChunks(
          body,
          putOptions?.signal,
          checkIdleTimeout(putOptions?.idleTimeoutMs)
        )) {
          size += chunk.byteLength
          if (size > maxBytes) {
            throw tooLarge(maxBytes)
          }
          hash.update(chunk)
          let offset = 0
          while (offset < chunk.byteLength) {
            const take = Math.min(partBytes - filled, chunk.byteLength - offset)
            current.set(chunk.subarray(offset, offset + take), filled)
            filled += take
            offset += take
            if (filled === partBytes) {
              await launch(current)
              current = Buffer.allocUnsafe(partBytes)
              filled = 0
            }
          }
        }
        if (uploadId === undefined) {
          // At most one part: an ordinary put, which also covers an empty body.
          await send(
            requestSignal(),
            new PutObjectCommand({
              Bucket: bucket,
              Key: location,
              Body: current.subarray(0, filled),
              ContentLength: filled,
              ContentType: contentType,
            })
          )
        } else {
          if (filled > 0) {
            await launch(current.subarray(0, filled))
          }
          while (inflight.size > 0) {
            await Promise.all(inflight)
          }
          if (failure !== undefined) {
            throw failure
          }
          completed.sort((x, y) => x.PartNumber - y.PartNumber)
          await client.send(
            new CompleteMultipartUploadCommand({
              Bucket: bucket,
              Key: location,
              UploadId: uploadId,
              MultipartUpload: { Parts: completed },
            }),
            { requestTimeout: timeoutMs, abortSignal: requestSignal() }
          )
        }
        const result: PutStreamResult = { size, sha256: hash.digest('hex') }
        return result
      } catch (error) {
        stop.abort()
        await Promise.allSettled(inflight)
        if (uploadId !== undefined) {
          try {
            await client.send(
              new AbortMultipartUploadCommand({
                Bucket: bucket,
                Key: location,
                UploadId: uploadId,
              }),
              { requestTimeout: timeoutMs, abortSignal: AbortSignal.timeout(timeoutMs * 2) }
            )
          } catch {
            // Nothing more can be done from here; the bucket's lifecycle rule expires the parts.
          }
        }
        throw error instanceof StorageError ? error : mapFailure('a streamed put', error)
      }
    },

    async getStream(organizationId, key) {
      // The deadline bounds getting the headers only. A large object read slowly must not be cut
      // by it, so the timer is cleared once `send` answers and the body has an idle timeout.
      const opening = new AbortController()
      const timer = setTimeout(() => opening.abort(), deadlineMs)
      const location = prefixOf(check.organization(organizationId)) + check.key(key)
      let output: GetObjectCommandOutput
      try {
        output = (await client.send(new GetObjectCommand({ Bucket: bucket, Key: location }), {
          requestTimeout: timeoutMs,
          abortSignal: opening.signal,
        })) as GetObjectCommandOutput
      } catch (error) {
        if (isMissing(error)) {
          return undefined
        }
        throw mapFailure('a get', error)
      } finally {
        clearTimeout(timer)
      }
      try {
        const described = infoOf(key, output)
        if (output.Body === undefined || typeof output.Body.transformToWebStream !== 'function') {
          throw new StorageError(STORAGE_ERROR_CODES.badResponse, 'the store returned no body')
        }
        const source = output.Body.transformToWebStream() as ReadableStream<Uint8Array>
        const stream: ObjectStream = {
          ...described,
          body: guardBody(source, output.Body, streamIdleMs),
        }
        return stream
      } catch (error) {
        discardBody(output.Body)
        throw error
      }
    },

    async get(organizationId, key) {
      const deadline = AbortSignal.timeout(deadlineMs)
      const location = prefixOf(check.organization(organizationId)) + check.key(key)
      let output: GetObjectCommandOutput
      try {
        output = (await send(
          deadline,
          new GetObjectCommand({ Bucket: bucket, Key: location })
        )) as GetObjectCommandOutput
      } catch (error) {
        if (isMissing(error)) {
          return undefined
        }
        throw mapFailure('a get', error)
      }
      try {
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
      } catch (error) {
        // Whatever the reason for refusing the response, do not leave its connection waiting.
        discardBody(output.Body)
        throw error
      }
    },

    head,

    async delete(organizationId, key) {
      const deadline = AbortSignal.timeout(deadlineMs)
      const location = prefixOf(check.organization(organizationId)) + check.key(key)
      try {
        await send(deadline, new DeleteObjectCommand({ Bucket: bucket, Key: location }))
      } catch (error) {
        // S3 answers 204 for a missing key; a stand-in that says not found has still left it gone.
        if (!isMissing(error)) {
          throw mapFailure('a delete', error)
        }
      }
    },

    async list(organizationId, listOptions) {
      const deadline = AbortSignal.timeout(deadlineMs)
      const root = prefixOf(check.organization(organizationId))
      const { prefix, after, limit } = check.list(listOptions)
      const items: ObjectEntry[] = []
      let startAfter = after === undefined ? undefined : root + after
      let skipped = 0
      let more = false
      for (let round = 1; round <= LIST_MAX_ROUNDS; round++) {
        let output: ListObjectsV2CommandOutput
        try {
          output = (await send(
            deadline,
            new ListObjectsV2Command({
              Bucket: bucket,
              Prefix: root + prefix,
              // The first request asks for what the caller wants; later ones only happen because
              // keys were skipped, so they read ahead in bigger steps.
              MaxKeys: round === 1 ? limit : MAX_LIST_LIMIT,
              ...(startAfter === undefined ? {} : { StartAfter: startAfter }),
            })
          )) as ListObjectsV2CommandOutput
        } catch (error) {
          throw mapFailure('a list', error)
        }
        const contents = output.Contents ?? []
        if (contents.length > (round === 1 ? limit : MAX_LIST_LIMIT)) {
          throw new StorageError(
            STORAGE_ERROR_CODES.badResponse,
            'the store returned too many keys'
          )
        }
        let overflow = false
        for (const entry of contents) {
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
          startAfter = entry.Key
          const key = entry.Key.slice(root.length)
          if (!check.isKey(key)) {
            // Made outside this adapter (a console folder marker, a name with a space): it cannot
            // be named through the port, so it is not listed.
            skipped += 1
            continue
          }
          if (items.length < limit) {
            items.push({ key, size: entry.Size, lastModified: entry.LastModified })
          } else {
            overflow = true
            break
          }
        }
        more = overflow || output.IsTruncated === true
        if (items.length >= limit || output.IsTruncated !== true) {
          break
        }
        if (round === LIST_MAX_ROUNDS && items.length === 0) {
          throw new StorageError(
            STORAGE_ERROR_CODES.badResponse,
            'the listing holds too many keys that cannot be listed'
          )
        }
      }
      if (skipped > 0) {
        logger?.debug('storage.list_skipped_keys', { skippedKeys: skipped })
      }
      const result: ListPage = { items }
      const last = items.at(-1)
      // The cursor is always the last key handed out, which is a valid key, never a raw store key.
      if (more && last !== undefined) {
        result.nextCursor = encodeCursor(last.key)
      }
      return result
    },
  }
}
