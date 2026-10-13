// Internal: how the AWS adapters describe and classify an SDK failure. Not exported from any entry.

/** What an error's `cause` holds instead of the SDK error: nothing that can name a key, a URL or a body. */
export interface AwsFailureCause {
  /** The SDK error's name, such as `AccessDenied`. */
  name: string
  /** The HTTP status, when the call got one. */
  httpStatus?: number
  /** The AWS request id, for support. */
  requestId?: string
  /** `client` or `server`, as the SDK blames it. */
  fault?: string
  /** The operating-system error code of a network failure, such as `ECONNRESET`. */
  code?: string
}

interface SdkLikeError {
  name?: unknown
  code?: unknown
  $fault?: unknown
  $retryable?: unknown
  $metadata?: { httpStatusCode?: unknown; requestId?: unknown }
}

const SAFE = /^[A-Za-z0-9_.-]{1,64}$/

function safe(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE.test(value) ? value : undefined
}

/**
 * Reduces an SDK error to {@link AwsFailureCause}. The SDK error carries the request's key or
 * queue URL, the raw response and a message that can repeat them, so none of that is kept.
 */
export function reduceAwsCause(error: unknown): AwsFailureCause {
  const sdk = (typeof error === 'object' && error !== null ? error : {}) as SdkLikeError
  const cause: AwsFailureCause = { name: safe(sdk.name) ?? 'Error' }
  const status = sdk.$metadata?.httpStatusCode
  if (typeof status === 'number' && Number.isInteger(status)) {
    cause.httpStatus = status
  }
  const requestId = safe(sdk.$metadata?.requestId)
  if (requestId !== undefined) {
    cause.requestId = requestId
  }
  const fault = safe(sdk.$fault)
  if (fault !== undefined) {
    cause.fault = fault
  }
  const code = safe(sdk.code)
  if (code !== undefined) {
    cause.code = code
  }
  return cause
}

const RETRYABLE_NAMES = new Set([
  'TimeoutError',
  'RequestTimeout',
  'RequestTimeoutException',
  'AbortError',
  'NetworkingError',
])
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
])

/**
 * True when trying the same call again can succeed. A fault the SDK blames on the client and does
 * not call retryable is permanent (access denied, no such bucket). The SDK's own retryable flag,
 * a server fault, a 5xx, 408 or 429 are transient. An error with no HTTP status is transient only
 * when it is a named timeout, abort or connection failure; anything else (a credentials provider
 * that found nothing, a programming error) is permanent, because a retry cannot fix it.
 */
export function isTransientAwsFailure(error: unknown): boolean {
  const sdk = (typeof error === 'object' && error !== null ? error : {}) as SdkLikeError
  if (sdk.$fault === 'client' && sdk.$retryable === undefined) {
    return false
  }
  if (sdk.$retryable !== undefined || sdk.$fault === 'server') {
    return true
  }
  const status = sdk.$metadata?.httpStatusCode
  if (typeof status === 'number') {
    return status >= 500 || status === 408 || status === 429
  }
  return (
    (typeof sdk.name === 'string' && RETRYABLE_NAMES.has(sdk.name)) ||
    (typeof sdk.code === 'string' && RETRYABLE_CODES.has(sdk.code))
  )
}
