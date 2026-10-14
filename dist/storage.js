import {
  reduceAwsCause,
  isTransientAwsFailure
} from "./shared/chunk-3xpsbhky.js";
import {
  STORAGE_ERROR_CODES2,
  StorageError2,
  MAX_LIST_LIMIT2,
  DEFAULT_CONTENT_TYPE2,
  STREAM_IDLE_TIMEOUT_MS2
} from "./shared/chunk-60y8a3sa.js";
import {
  checkStreamLimit,
  checkIdleTimeout,
  readChunks,
  tooLarge,
  encodeCursor,
  createStorageValidator
} from "./shared/chunk-9sd8894z.js";

// src/storage/aws.ts
import { createHash } from "node:crypto";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  UploadPartCommand
} from "@aws-sdk/client-s3";

// src/storage/client.ts
import { S3Client } from "@aws-sdk/client-s3";
function createS3Client(settings) {
  return new S3Client({
    region: settings.region,
    maxAttempts: settings.maxAttempts,
    retryMode: "standard",
    requestHandler: {
      connectionTimeout: settings.timeoutMs,
      requestTimeout: settings.timeoutMs,
      throwOnRequestTimeout: true
    },
    ...settings.environment === "local" ? {} : { ignoreConfiguredEndpointUrls: true },
    ...settings.endpoint === undefined ? {} : {
      endpoint: settings.endpoint,
      forcePathStyle: true,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED"
    }
  });
}

// src/storage/aws.ts
var S3_DEFAULT_TIMEOUT_MS = 5000;
var S3_DEFAULT_DEADLINE_MS = 60000;
var S3_DEFAULT_MAX_ATTEMPTS = 3;
var S3_DEFAULT_PART_BYTES = 8 * 1024 * 1024;
var S3_DEFAULT_PART_CONCURRENCY = 2;
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
function guardBody(source, raw) {
  const reader = source.getReader();
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      discardBody(raw);
    }
  };
  return new ReadableStream({
    async pull(controller) {
      let timer;
      try {
        const step = await Promise.race([
          reader.read(),
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("the body stalled")), STREAM_IDLE_TIMEOUT_MS2);
          })
        ]);
        if (step.done) {
          controller.close();
        } else {
          controller.enqueue(step.value);
        }
      } catch (error) {
        if (released) {
          return;
        }
        release();
        reader.cancel().catch(() => {
          return;
        });
        controller.error(new StorageError2(STORAGE_ERROR_CODES2.unavailable, "the body could not be read to the end", {
          cause: reduceAwsCause(error)
        }));
      } finally {
        clearTimeout(timer);
      }
    },
    cancel() {
      release();
      return reader.cancel().catch(() => {
        return;
      });
    }
  });
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
  const partBytes = options.partBytes ?? S3_DEFAULT_PART_BYTES;
  const partConcurrency = options.partConcurrency ?? S3_DEFAULT_PART_CONCURRENCY;
  if (!Number.isInteger(partBytes) || partBytes < 5 * 1024 * 1024 || partBytes > 64 * 1024 * 1024) {
    throw new TypeError("partBytes must be a whole number from 5 MiB to 64 MiB");
  }
  if (!Number.isInteger(partConcurrency) || partConcurrency < 1 || partConcurrency > 8) {
    throw new TypeError("partConcurrency must be a whole number from 1 to 8");
  }
  const check = createStorageValidator({
    maxObjectBytes: options.maxObjectBytes,
    isOrganizationId: options.isOrganizationId
  });
  const { bucket, logger } = options;
  const client = options.client ?? createS3Client({
    region: options.region,
    environment: options.environment,
    endpoint: options.endpoint,
    timeoutMs,
    maxAttempts
  });
  const prefixOf = (organization) => `${S3_KEY_PREFIX}${organization}/`;
  const send = (deadline, command) => client.send(command, {
    requestTimeout: timeoutMs,
    abortSignal: deadline
  });
  async function head(organizationId, key) {
    const deadline = AbortSignal.timeout(deadlineMs);
    const location = prefixOf(check.organization(organizationId)) + check.key(key);
    let output;
    try {
      output = await send(deadline, new HeadObjectCommand({ Bucket: bucket, Key: location }));
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
      const deadline = AbortSignal.timeout(deadlineMs);
      const location = prefixOf(check.organization(organizationId)) + check.key(key);
      const bytes = check.body(body);
      const contentType = check.contentType(putOptions?.contentType);
      try {
        await send(deadline, new PutObjectCommand({
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
    async putStream(organizationId, key, body, putOptions) {
      const location = prefixOf(check.organization(organizationId)) + check.key(key);
      const contentType = check.contentType(putOptions?.contentType);
      const maxBytes = checkStreamLimit(putOptions?.maxBytes);
      const stop = new AbortController;
      const requestSignal = () => AbortSignal.any([
        AbortSignal.timeout(deadlineMs),
        stop.signal,
        ...putOptions?.signal === undefined ? [] : [putOptions.signal]
      ]);
      const hash = createHash("sha256");
      let size = 0;
      let current = Buffer.allocUnsafe(partBytes);
      let filled = 0;
      let uploadId;
      let partNumber = 0;
      const completed = [];
      const inflight = new Set;
      let failure;
      const uploadPart = async (data, number) => {
        const output = await client.send(new UploadPartCommand({
          Bucket: bucket,
          Key: location,
          UploadId: uploadId,
          PartNumber: number,
          Body: data,
          ContentLength: data.byteLength
        }), { requestTimeout: timeoutMs, abortSignal: requestSignal() });
        if (output.ETag === undefined) {
          throw new StorageError2(STORAGE_ERROR_CODES2.badResponse, "the store returned no part tag");
        }
        completed.push({ ETag: output.ETag, PartNumber: number });
      };
      const launch = async (data) => {
        if (uploadId === undefined) {
          const created = await client.send(new CreateMultipartUploadCommand({
            Bucket: bucket,
            Key: location,
            ContentType: contentType
          }), { requestTimeout: timeoutMs, abortSignal: requestSignal() });
          if (created.UploadId === undefined) {
            throw new StorageError2(STORAGE_ERROR_CODES2.badResponse, "the store returned no upload id");
          }
          uploadId = created.UploadId;
        }
        while (inflight.size >= partConcurrency && failure === undefined) {
          await Promise.race(inflight);
        }
        if (failure !== undefined) {
          throw failure;
        }
        partNumber += 1;
        const task = uploadPart(data, partNumber).then(() => {
          inflight.delete(task);
        }, (error) => {
          failure ??= error;
          inflight.delete(task);
          stop.abort();
        });
        inflight.add(task);
      };
      try {
        for await (const chunk of readChunks(body, putOptions?.signal, checkIdleTimeout(putOptions?.idleTimeoutMs))) {
          size += chunk.byteLength;
          if (size > maxBytes) {
            throw tooLarge(maxBytes);
          }
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.byteLength) {
            const take = Math.min(partBytes - filled, chunk.byteLength - offset);
            current.set(chunk.subarray(offset, offset + take), filled);
            filled += take;
            offset += take;
            if (filled === partBytes) {
              await launch(current);
              current = Buffer.allocUnsafe(partBytes);
              filled = 0;
            }
          }
        }
        if (uploadId === undefined) {
          await send(requestSignal(), new PutObjectCommand({
            Bucket: bucket,
            Key: location,
            Body: current.subarray(0, filled),
            ContentLength: filled,
            ContentType: contentType
          }));
        } else {
          if (filled > 0) {
            await launch(current.subarray(0, filled));
          }
          while (inflight.size > 0) {
            await Promise.all(inflight);
          }
          if (failure !== undefined) {
            throw failure;
          }
          completed.sort((x, y) => x.PartNumber - y.PartNumber);
          await client.send(new CompleteMultipartUploadCommand({
            Bucket: bucket,
            Key: location,
            UploadId: uploadId,
            MultipartUpload: { Parts: completed }
          }), { requestTimeout: timeoutMs, abortSignal: requestSignal() });
        }
        const result = { size, sha256: hash.digest("hex") };
        return result;
      } catch (error) {
        stop.abort();
        await Promise.allSettled(inflight);
        if (uploadId !== undefined) {
          try {
            await client.send(new AbortMultipartUploadCommand({
              Bucket: bucket,
              Key: location,
              UploadId: uploadId
            }), { requestTimeout: timeoutMs, abortSignal: AbortSignal.timeout(timeoutMs * 2) });
          } catch {}
        }
        throw error instanceof StorageError2 ? error : mapFailure("a streamed put", error);
      }
    },
    async getStream(organizationId, key) {
      const opening = new AbortController;
      const timer = setTimeout(() => opening.abort(), deadlineMs);
      const location = prefixOf(check.organization(organizationId)) + check.key(key);
      let output;
      try {
        output = await client.send(new GetObjectCommand({ Bucket: bucket, Key: location }), {
          requestTimeout: timeoutMs,
          abortSignal: opening.signal
        });
      } catch (error) {
        if (isMissing(error)) {
          return;
        }
        throw mapFailure("a get", error);
      } finally {
        clearTimeout(timer);
      }
      try {
        const described = infoOf(key, output);
        if (output.Body === undefined || typeof output.Body.transformToWebStream !== "function") {
          throw new StorageError2(STORAGE_ERROR_CODES2.badResponse, "the store returned no body");
        }
        const source = output.Body.transformToWebStream();
        const stream = { ...described, body: guardBody(source, output.Body) };
        return stream;
      } catch (error) {
        discardBody(output.Body);
        throw error;
      }
    },
    async get(organizationId, key) {
      const deadline = AbortSignal.timeout(deadlineMs);
      const location = prefixOf(check.organization(organizationId)) + check.key(key);
      let output;
      try {
        output = await send(deadline, new GetObjectCommand({ Bucket: bucket, Key: location }));
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
      const deadline = AbortSignal.timeout(deadlineMs);
      const location = prefixOf(check.organization(organizationId)) + check.key(key);
      try {
        await send(deadline, new DeleteObjectCommand({ Bucket: bucket, Key: location }));
      } catch (error) {
        if (!isMissing(error)) {
          throw mapFailure("a delete", error);
        }
      }
    },
    async list(organizationId, listOptions) {
      const deadline = AbortSignal.timeout(deadlineMs);
      const root = prefixOf(check.organization(organizationId));
      const { prefix, after, limit } = check.list(listOptions);
      const items = [];
      let startAfter = after === undefined ? undefined : root + after;
      let skipped = 0;
      let more = false;
      for (let round = 1;round <= LIST_MAX_ROUNDS; round++) {
        let output;
        try {
          output = await send(deadline, new ListObjectsV2Command({
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
  S3_DEFAULT_PART_BYTES,
  S3_DEFAULT_PART_CONCURRENCY,
  S3_DEFAULT_TIMEOUT_MS,
  S3_KEY_PREFIX,
  createS3ObjectStore
};
