import {
  AppError2
} from "./chunk-tya44yhr.js";

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

export { STORAGE_ERROR_CODES2, StorageError2, MAX_KEY_BYTES2, MAX_KEY_SEGMENTS2, DEFAULT_MAX_OBJECT_BYTES2, MAX_OBJECT_BYTES_LIMIT2, DEFAULT_LIST_LIMIT2, MAX_LIST_LIMIT2, DEFAULT_CONTENT_TYPE2 };
