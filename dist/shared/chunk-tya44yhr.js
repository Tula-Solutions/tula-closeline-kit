// src/errors.ts
var CODE_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

class AppError2 extends Error {
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
function isAppError2(value) {
  return value instanceof AppError2;
}
function toErrorBody2(error) {
  const body = { error: { code: error.code, message: error.message } };
  if (error.details !== undefined) {
    body.error.details = error.details;
  }
  return body;
}

export { AppError2, isAppError2, toErrorBody2 };
