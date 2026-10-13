// src/aws-failure.ts
var SAFE = /^[A-Za-z0-9_.-]{1,64}$/;
function safe(value) {
  return typeof value === "string" && SAFE.test(value) ? value : undefined;
}
function reduceAwsCause(error) {
  const sdk = typeof error === "object" && error !== null ? error : {};
  const cause = { name: safe(sdk.name) ?? "Error" };
  const status = sdk.$metadata?.httpStatusCode;
  if (typeof status === "number" && Number.isInteger(status)) {
    cause.httpStatus = status;
  }
  const requestId = safe(sdk.$metadata?.requestId);
  if (requestId !== undefined) {
    cause.requestId = requestId;
  }
  const fault = safe(sdk.$fault);
  if (fault !== undefined) {
    cause.fault = fault;
  }
  const code = safe(sdk.code);
  if (code !== undefined) {
    cause.code = code;
  }
  return cause;
}
var RETRYABLE_NAMES = new Set([
  "TimeoutError",
  "RequestTimeout",
  "RequestTimeoutException",
  "AbortError",
  "NetworkingError"
]);
var RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT"
]);
function isTransientAwsFailure(error) {
  const sdk = typeof error === "object" && error !== null ? error : {};
  if (sdk.$fault === "client" && sdk.$retryable === undefined) {
    return false;
  }
  if (sdk.$retryable !== undefined || sdk.$fault === "server") {
    return true;
  }
  const status = sdk.$metadata?.httpStatusCode;
  if (typeof status === "number") {
    return status >= 500 || status === 408 || status === 429;
  }
  return typeof sdk.name === "string" && RETRYABLE_NAMES.has(sdk.name) || typeof sdk.code === "string" && RETRYABLE_CODES.has(sdk.code);
}

export { reduceAwsCause, isTransientAwsFailure };
