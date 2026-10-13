import {
  AppError2
} from "./chunk-tya44yhr.js";

// src/organization.ts
import { organizationIdSchema } from "tula-closeline-contract";
var contractOrganizationIdCheck2 = (value) => organizationIdSchema.safeParse(value).success;
var SAFE_ORGANIZATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
function createOrganizationIdGuard2(check = contractOrganizationIdCheck2) {
  return (value) => typeof value === "string" && SAFE_ORGANIZATION_ID.test(value) && check(value);
}

// src/storage/errors.ts
var STORAGE_ERROR_CODES2 = {
  invalidRequest: "storage.invalid_request",
  objectTooLarge: "storage.object_too_large",
  rejected: "storage.rejected",
  unavailable: "storage.unavailable",
  badResponse: "storage.bad_response"
};
var STATUS = {
  "storage.invalid_request": 400,
  "storage.object_too_large": 413,
  "storage.rejected": 500,
  "storage.unavailable": 503,
  "storage.bad_response": 502
};

class StorageError2 extends AppError2 {
  constructor(code, message, options = {}) {
    super({
      code,
      status: STATUS[code],
      message,
      ...options.cause === undefined ? {} : { cause: options.cause },
      ...options.details === undefined ? {} : { details: options.details }
    });
    this.name = "StorageError";
  }
}

// src/storage/port.ts
var MAX_KEY_BYTES2 = 512;
var MAX_KEY_SEGMENTS2 = 16;
var DEFAULT_MAX_OBJECT_BYTES2 = 25 * 1024 * 1024;
var MAX_OBJECT_BYTES_LIMIT2 = 100 * 1024 * 1024;
var DEFAULT_LIST_LIMIT2 = 100;
var MAX_LIST_LIMIT2 = 1000;
var DEFAULT_CONTENT_TYPE2 = "application/octet-stream";
var SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
var CONTENT_TYPE = /^[A-Za-z0-9][\w!#$&^.+-]*\/[A-Za-z0-9][\w!#$&^.+-]*(?:;[ \t]*[\w.-]+=[\w.+"-]+)*$/;
var CURSOR = /^[A-Za-z0-9_-]{1,700}$/;
var bad = (message) => new StorageError2(STORAGE_ERROR_CODES2.invalidRequest, message);
function encodeCursor2(key) {
  return Buffer.from(key, "utf8").toString("base64url");
}
function createStorageValidator2(options = {}) {
  const maxObjectBytes = options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES2;
  if (!Number.isInteger(maxObjectBytes) || maxObjectBytes < 1 || maxObjectBytes > MAX_OBJECT_BYTES_LIMIT2) {
    throw new TypeError("maxObjectBytes must be a whole number from 1 to 104857600");
  }
  const isOrganization = createOrganizationIdGuard2(options.isOrganizationId);
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
    if (encodeCursor2(decoded) !== value) {
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

export { contractOrganizationIdCheck2, createOrganizationIdGuard2, STORAGE_ERROR_CODES2, StorageError2, MAX_KEY_BYTES2, MAX_KEY_SEGMENTS2, DEFAULT_MAX_OBJECT_BYTES2, MAX_OBJECT_BYTES_LIMIT2, DEFAULT_LIST_LIMIT2, MAX_LIST_LIMIT2, DEFAULT_CONTENT_TYPE2, encodeCursor2, createStorageValidator2 };
