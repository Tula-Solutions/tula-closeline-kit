import {
  systemClock2,
  createFixedClock2,
  redactFields
} from "./shared/chunk-279hrqks.js";
// src/errors.ts
var CODE_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

class AppError extends Error {
  code;
  status;
  details;
  constructor(init) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    if (!CODE_PATTERN.test(init.code)) {
      throw new TypeError(`AppError code must look like "area.reason", got ${JSON.stringify(init.code)}`);
    }
    if (!Number.isInteger(init.status) || init.status < 100 || init.status > 599) {
      throw new TypeError(`AppError status must be an HTTP status, got ${init.status}`);
    }
    this.name = "AppError";
    this.code = init.code;
    this.status = init.status;
    if (init.details !== undefined) {
      this.details = init.details;
    }
  }
}
function isAppError(value) {
  return value instanceof AppError;
}
function toErrorBody(error) {
  const body = { error: { code: error.code, message: error.message } };
  if (error.details !== undefined) {
    body.error.details = error.details;
  }
  return body;
}
// src/logger.ts
import pino from "pino";
var RESERVED_KEYS = ["level", "time", "msg", "service"];
function protectReserved(fields) {
  for (const key of RESERVED_KEYS) {
    if (key in fields) {
      fields[`field_${key}`] = fields[key];
      delete fields[key];
    }
  }
  return fields;
}
function prepare(fields) {
  return protectReserved(redactFields(fields ?? {}));
}
function wrap(base) {
  return {
    debug: (message, fields) => base.debug(prepare(fields), message),
    info: (message, fields) => base.info(prepare(fields), message),
    warn: (message, fields) => base.warn(prepare(fields), message),
    error: (message, fields) => base.error(prepare(fields), message),
    child: (fields) => wrap(base.child(prepare(fields)))
  };
}
function createLogger(options) {
  const config = {
    level: options.level ?? "info",
    base: { service: options.service },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: { err: (value) => value }
  };
  return wrap(options.destination ? pino(config, options.destination) : pino(config));
}

// src/index.ts
var PACKAGE = "tula-closeline-kit";
export {
  AppError,
  PACKAGE,
  createFixedClock2 as createFixedClock,
  createLogger,
  isAppError,
  systemClock2 as systemClock,
  toErrorBody
};
