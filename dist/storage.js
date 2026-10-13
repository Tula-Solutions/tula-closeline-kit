import {
  reduceAwsCause,
  isTransientAwsFailure
} from "./shared/chunk-3xpsbhky.js";
import {
  STORAGE_ERROR_CODES2,
  StorageError2,
  MAX_LIST_LIMIT2,
  DEFAULT_CONTENT_TYPE2
} from "./shared/chunk-r2rshw7g.js";
import {
  encodeCursor,
  createStorageValidator
} from "./shared/chunk-jstn60a3.js";

// src/storage/aws.ts
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
var S3_DEFAULT_TIMEOUT_MS = 5000;
var S3_DEFAULT_DEADLINE_MS = 60000;
var S3_DEFAULT_MAX_ATTEMPTS = 3;
var S3_KEY_PREFIX = "orgs/";
var LIST_MAX_ROUNDS = 10;
var ENDPOINT_VARIABLES = ["AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_S3"];
var MISSING = new Set(["NoSuchKey", "NotFound"]);
function mapFailure(operation, error) {
  const cause = reduceAwsCause(error);
  return isTransientAwsFailure(error) ? new StorageError2(STORAGE_ERROR_CODES2.unavailable, `the store did not complete ${operation}`, {
    cause
  }) : new StorageError2(STORAGE_ERROR_CODES2.rejected, `the store refused ${operation}`, { cause });
}
function discardBody(body) {
  const stream = body;
  try {
    if (typeof stream?.destroy === "function") {
      stream.destroy();
    } else if (typeof stream?.cancel === "function") {
      Promise.resolve(stream.cancel()).catch(() => {
        return;
      });
    }
  } catch {}
}
function isMissing(error) {
  return error instanceof Error && MISSING.has(error.name);
}
function createS3ObjectStore(options) {
  if (options.endpoint !== undefined && options.environment !== "local") {
    throw new TypeError(`an S3 endpoint override is only for ENVIRONMENT=local, not ${options.environment}`);
  }
  if (options.environment !== "local") {
    for (const name of ENDPOINT_VARIABLES) {
      if ((process.env[name] ?? "") !== "") {
        throw new TypeError(`${name} is set; an S3 endpoint override is only for ENVIRONMENT=local`);
      }
    }
  }
  if (options.bucket === "" || /[^a-z0-9.-]/.test(options.bucket)) {
    throw new TypeError("bucket must be a non-empty S3 bucket name");
  }
  const timeoutMs = options.timeoutMs ?? S3_DEFAULT_TIMEOUT_MS;
  const deadlineMs = options.deadlineMs ?? S3_DEFAULT_DEADLINE_MS;
  const maxAttempts = options.maxAttempts ?? S3_DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) {
    throw new TypeError("timeoutMs must be a whole number from 100 to 60000");
  }
  if (!Number.isInteger(deadlineMs) || deadlineMs < timeoutMs || deadlineMs > 600000) {
    throw new TypeError("deadlineMs must be a whole number from timeoutMs to 600000");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new TypeError("maxAttempts must be a whole number from 1 to 10");
  }
  const check = createStorageValidator({
    maxObjectBytes: options.maxObjectBytes,
    isOrganizationId: options.isOrganizationId
  });
  const { bucket, logger } = options;
  const client = options.client ?? new S3Client({
    region: options.region,
    maxAttempts,
    retryMode: "standard",
    requestHandler: {
      connectionTimeout: timeoutMs,
      requestTimeout: timeoutMs,
      throwOnRequestTimeout: true
    },
    ...options.endpoint === undefined ? {} : {
      endpoint: options.endpoint,
      forcePathStyle: true,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED"
    }
  });
  const prefixOf = (organization) => `${S3_KEY_PREFIX}${organization}/`;
  const send = (command) => client.send(command, {
    requestTimeout: timeoutMs,
    abortSignal: AbortSignal.timeout(deadlineMs)
  });
  async function head(organizationId, key) {
    const location = prefixOf(check.organization(organizationId)) + check.key(key);
    let output;
    try {
      output = await send(new HeadObjectCommand({ Bucket: bucket, Key: location }));
    } catch (error) {
      if (isMissing(error)) {
        return;
      }
      throw mapFailure("a head", error);
    }
    return infoOf(key, output);
  }
  function infoOf(key, output) {
    if (output.ContentLength === undefined || output.LastModified === undefined) {
      throw new StorageError2(STORAGE_ERROR_CODES2.badResponse, "the store returned an object without a size or time");
    }
    return {
      key,
      size: output.ContentLength,
      contentType: output.ContentType ?? DEFAULT_CONTENT_TYPE2,
      lastModified: output.LastModified
    };
  }
  return {
    async put(organizationId, key, body, putOptions) {
      const location = prefixOf(check.organization(organizationId)) + check.key(key);
      const bytes = check.body(body);
      const contentType = check.contentType(putOptions?.contentType);
      try {
        await send(new PutObjectCommand({
          Bucket: bucket,
          Key: location,
          Body: bytes,
          ContentLength: bytes.byteLength,
          ContentType: contentType
        }));
      } catch (error) {
        throw mapFailure("a put", error);
      }
    },
    async get(organizationId, key) {
      const location = prefixOf(check.organization(organizationId)) + check.key(key);
      let output;
      try {
        output = await send(new GetObjectCommand({ Bucket: bucket, Key: location }));
      } catch (error) {
        if (isMissing(error)) {
          return;
        }
        throw mapFailure("a get", error);
      }
      try {
        const described = infoOf(key, output);
        if (described.size > check.maxObjectBytes) {
          throw new StorageError2(STORAGE_ERROR_CODES2.objectTooLarge, "the object is too large", {
            details: { limitBytes: check.maxObjectBytes }
          });
        }
        if (output.Body === undefined) {
          throw new StorageError2(STORAGE_ERROR_CODES2.badResponse, "the store returned no body");
        }
        let body;
        try {
          body = await output.Body.transformToByteArray();
        } catch (error) {
          throw mapFailure("reading a body", error);
        }
        if (body.byteLength !== described.size) {
          throw new StorageError2(STORAGE_ERROR_CODES2.badResponse, "the body is not the size announced");
        }
        const stored = { ...described, body };
        return stored;
      } catch (error) {
        discardBody(output.Body);
        throw error;
      }
    },
    head,
    async delete(organizationId, key) {
      const location = prefixOf(check.organization(organizationId)) + check.key(key);
      try {
        await send(new DeleteObjectCommand({ Bucket: bucket, Key: location }));
      } catch (error) {
        if (!isMissing(error)) {
          throw mapFailure("a delete", error);
        }
      }
    },
    async list(organizationId, listOptions) {
      const root = prefixOf(check.organization(organizationId));
      const { prefix, after, limit } = check.list(listOptions);
      const items = [];
      let startAfter = after === undefined ? undefined : root + after;
      let skipped = 0;
      let more = false;
      for (let round = 1;round <= LIST_MAX_ROUNDS; round++) {
        let output;
        try {
          output = await send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: root + prefix,
            MaxKeys: round === 1 ? limit : MAX_LIST_LIMIT2,
            ...startAfter === undefined ? {} : { StartAfter: startAfter }
          }));
        } catch (error) {
          throw mapFailure("a list", error);
        }
        const contents = output.Contents ?? [];
        if (contents.length > (round === 1 ? limit : MAX_LIST_LIMIT2)) {
          throw new StorageError2(STORAGE_ERROR_CODES2.badResponse, "the store returned too many keys");
        }
        let overflow = false;
        for (const entry of contents) {
          if (entry.Key === undefined || !entry.Key.startsWith(root) || entry.Size === undefined || entry.LastModified === undefined) {
            throw new StorageError2(STORAGE_ERROR_CODES2.badResponse, "the store returned a key outside the Organization or without a size");
          }
          startAfter = entry.Key;
          const key = entry.Key.slice(root.length);
          if (!check.isKey(key)) {
            skipped += 1;
            continue;
          }
          if (items.length < limit) {
            items.push({ key, size: entry.Size, lastModified: entry.LastModified });
          } else {
            overflow = true;
            break;
          }
        }
        more = overflow || output.IsTruncated === true;
        if (items.length >= limit || output.IsTruncated !== true) {
          break;
        }
        if (round === LIST_MAX_ROUNDS && items.length === 0) {
          throw new StorageError2(STORAGE_ERROR_CODES2.badResponse, "the listing holds too many keys that cannot be listed");
        }
      }
      if (skipped > 0) {
        logger?.debug("storage.list_skipped_keys", { skippedKeys: skipped });
      }
      const result = { items };
      const last = items.at(-1);
      if (more && last !== undefined) {
        result.nextCursor = encodeCursor(last.key);
      }
      return result;
    }
  };
}
export {
  S3_DEFAULT_DEADLINE_MS,
  S3_DEFAULT_MAX_ATTEMPTS,
  S3_DEFAULT_TIMEOUT_MS,
  S3_KEY_PREFIX,
  createS3ObjectStore
};
