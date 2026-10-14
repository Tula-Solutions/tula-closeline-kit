import {
  STORAGE_ERROR_CODES2,
  StorageError2,
  MAX_KEY_BYTES2,
  MAX_KEY_SEGMENTS2,
  DEFAULT_MAX_OBJECT_BYTES2,
  MAX_OBJECT_BYTES_LIMIT2,
  DEFAULT_LIST_LIMIT2,
  MAX_LIST_LIMIT2,
  DEFAULT_CONTENT_TYPE2,
  MAX_STREAM_BYTES_LIMIT2,
  MAX_PRESIGN_SECONDS2,
  DEFAULT_PRESIGN_SECONDS2,
  STREAM_IDLE_TIMEOUT_MS2
} from "./chunk-5sf8d2rb.js";

// src/storage/stream.ts
function checkStreamLimit(maxBytes) {
  if (typeof maxBytes !== "number" || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_STREAM_BYTES_LIMIT2) {
    throw new StorageError2(STORAGE_ERROR_CODES2.invalidRequest, "maxBytes must be a whole number from 1 to 2147483648");
  }
  return maxBytes;
}
function checkIdleTimeout(idleMs) {
  if (idleMs === undefined) {
    return STREAM_IDLE_TIMEOUT_MS2;
  }
  if (typeof idleMs !== "number" || !Number.isInteger(idleMs) || idleMs < 10 || idleMs > 600000) {
    throw new StorageError2(STORAGE_ERROR_CODES2.invalidRequest, "idleTimeoutMs must be a whole number from 10 to 600000");
  }
  return idleMs;
}
function puller(source) {
  if (typeof source.getReader === "function") {
    const reader = source.getReader();
    return {
      next: () => reader.read(),
      close: () => {
        reader.cancel().catch(() => {
          return;
        });
      }
    };
  }
  const iterator = source[Symbol.asyncIterator]();
  return {
    next: () => iterator.next(),
    close: () => {
      Promise.resolve(iterator.return?.()).catch(() => {
        return;
      });
    }
  };
}
async function* readChunks(source, signal, idleMs = STREAM_IDLE_TIMEOUT_MS2) {
  if (typeof source !== "object" || source === null || typeof source.getReader !== "function" && typeof source[Symbol.asyncIterator] !== "function") {
    throw new StorageError2(STORAGE_ERROR_CODES2.invalidRequest, "the body must be a stream or an async iterable of bytes");
  }
  const pull = puller(source);
  try {
    for (;; ) {
      if (signal?.aborted) {
        throw new StorageError2(STORAGE_ERROR_CODES2.unavailable, "the write was aborted");
      }
      let timer;
      let onAbort;
      const guard = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new StorageError2(STORAGE_ERROR_CODES2.unavailable, "the source stream stalled")), idleMs);
        onAbort = () => reject(new StorageError2(STORAGE_ERROR_CODES2.unavailable, "the write was aborted"));
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      let step;
      try {
        step = await Promise.race([pull.next(), guard]);
      } catch (error) {
        if (error instanceof StorageError2) {
          throw error;
        }
        throw new StorageError2(STORAGE_ERROR_CODES2.invalidRequest, "the source stream failed", {
          cause: error instanceof Error ? error.name : "unknown"
        });
      } finally {
        clearTimeout(timer);
        if (onAbort !== undefined) {
          signal?.removeEventListener("abort", onAbort);
        }
        guard.catch(() => {
          return;
        });
      }
      if (step.done) {
        return;
      }
      if (!(step.value instanceof Uint8Array)) {
        throw new StorageError2(STORAGE_ERROR_CODES2.invalidRequest, "the stream must hold only bytes");
      }
      yield step.value;
    }
  } finally {
    pull.close();
  }
}
function tooLarge(maxBytes) {
  return new StorageError2(STORAGE_ERROR_CODES2.objectTooLarge, "the stream is over its limit", {
    details: { limitBytes: maxBytes }
  });
}

// src/organization-guard.ts
import { organizationIdSchema } from "tula-closeline-contract";
var contractOrganizationIdCheck = (value) => organizationIdSchema.safeParse(value).success;
var SAFE_ORGANIZATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
function createOrganizationIdGuard(check = contractOrganizationIdCheck) {
  return (value) => typeof value === "string" && SAFE_ORGANIZATION_ID.test(value) && check(value);
}

// src/storage/validate.ts
var SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
var CONTENT_TYPE = /^[A-Za-z0-9][\w!#$&^.+-]*\/[A-Za-z0-9][\w!#$&^.+-]*(?:;[ \t]*[\w.-]+=[\w.+"-]+)*$/;
var CURSOR = /^[A-Za-z0-9_-]{1,700}$/;
var bad = (message) => new StorageError2(STORAGE_ERROR_CODES2.invalidRequest, message);
function encodeCursor(key) {
  return Buffer.from(key, "utf8").toString("base64url");
}
function createStorageValidator(options = {}) {
  const maxObjectBytes = options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES2;
  if (!Number.isInteger(maxObjectBytes) || maxObjectBytes < 1 || maxObjectBytes > MAX_OBJECT_BYTES_LIMIT2) {
    throw new TypeError("maxObjectBytes must be a whole number from 1 to 104857600");
  }
  const isOrganization = createOrganizationIdGuard(options.isOrganizationId);
  function key(value) {
    if (typeof value !== "string" || value === "" || value.length > MAX_KEY_BYTES2) {
      throw bad("the key must be a non-empty string of at most 512 bytes");
    }
    const segments = value.split("/");
    if (segments.length > MAX_KEY_SEGMENTS2 || !segments.every((s) => SEGMENT.test(s))) {
      throw bad('the key must be up to 16 segments of letters, digits, ".", "_" and "-", none empty or starting with "."');
    }
    return value;
  }
  function prefix(value) {
    if (value === undefined || value === "") {
      return "";
    }
    if (typeof value !== "string" || value.length > MAX_KEY_BYTES2) {
      throw bad("the prefix must be a string of at most 512 bytes");
    }
    const segments = value.split("/");
    const last = segments.pop() ?? "";
    if (segments.length >= MAX_KEY_SEGMENTS2 || !segments.every((s) => SEGMENT.test(s)) || last !== "" && !SEGMENT.test(last)) {
      throw bad("the prefix must be whole segments, optionally ending in a part of one");
    }
    return value;
  }
  function cursor(value) {
    if (value === undefined) {
      return;
    }
    if (typeof value !== "string" || !CURSOR.test(value)) {
      throw bad("the cursor is not one this store gave");
    }
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    try {
      key(decoded);
    } catch {
      throw bad("the cursor is not one this store gave");
    }
    if (encodeCursor(decoded) !== value) {
      throw bad("the cursor is not one this store gave");
    }
    return decoded;
  }
  return {
    maxObjectBytes,
    organization(value) {
      if (!isOrganization(value)) {
        throw bad("the Organization id is not valid");
      }
      return value;
    },
    key,
    isKey(value) {
      try {
        key(value);
        return true;
      } catch {
        return false;
      }
    },
    body(value) {
      if (!(value instanceof Uint8Array)) {
        throw bad("the body must be a Uint8Array");
      }
      if (value.byteLength > maxObjectBytes) {
        throw new StorageError2(STORAGE_ERROR_CODES2.objectTooLarge, "the object is too large", {
          details: { limitBytes: maxObjectBytes }
        });
      }
      return value;
    },
    contentType(value) {
      if (value === undefined) {
        return DEFAULT_CONTENT_TYPE2;
      }
      if (typeof value !== "string" || value.length > 255 || !CONTENT_TYPE.test(value)) {
        throw bad('the content type must look like "type/subtype" with optional parameters');
      }
      return value;
    },
    expiry(options) {
      const raw = options?.expiresInSeconds;
      if (options !== undefined && (typeof options !== "object" || options === null)) {
        throw bad("the presign options must be an object");
      }
      if (raw === undefined) {
        return DEFAULT_PRESIGN_SECONDS2;
      }
      if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > MAX_PRESIGN_SECONDS2) {
        throw bad("expiresInSeconds must be a whole number from 1 to 900");
      }
      return raw;
    },
    list(listOptions) {
      const limit = listOptions?.limit ?? DEFAULT_LIST_LIMIT2;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT2) {
        throw bad("the limit must be a whole number from 1 to 1000");
      }
      return {
        prefix: prefix(listOptions?.prefix),
        after: cursor(listOptions?.cursor),
        limit
      };
    }
  };
}

export { checkStreamLimit, checkIdleTimeout, readChunks, tooLarge, createOrganizationIdGuard, encodeCursor, createStorageValidator };
