const CODE_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/

/** Everything needed to build an AppError. */
export interface AppErrorInit {
  /** Stable machine-readable code of the form `area.reason`, e.g. `auth.token_expired`. */
  code: string
  /** HTTP status the error maps to. */
  status: number
  /** Human-readable message that is safe to return to a client. */
  message: string
  /** Extra plain data that is safe to return to a client. */
  details?: Record<string, unknown>
  /** The underlying error, kept for logs and never returned to a client. */
  cause?: unknown
}

/** The JSON body a service returns for a failed request. */
export interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> }
}

/** An expected failure with a stable `area.reason` code and the HTTP status it maps to. */
export class AppError extends Error {
  readonly code: string
  readonly status: number
  readonly details?: Record<string, unknown>

  constructor(init: AppErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause })
    if (!CODE_PATTERN.test(init.code)) {
      throw new TypeError(
        `AppError code must look like "area.reason", got ${JSON.stringify(init.code)}`
      )
    }
    if (!Number.isInteger(init.status) || init.status < 100 || init.status > 599) {
      throw new TypeError(`AppError status must be an HTTP status, got ${init.status}`)
    }
    this.name = 'AppError'
    this.code = init.code
    this.status = init.status
    if (init.details !== undefined) {
      this.details = init.details
    }
  }
}

/** Narrows an unknown value to an AppError. */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError
}

/** Builds the client-facing JSON body for an AppError, leaving out `details` when there are none. */
export function toErrorBody(error: AppError): ErrorBody {
  const body: ErrorBody = { error: { code: error.code, message: error.message } }
  if (error.details !== undefined) {
    body.error.details = error.details
  }
  return body
}
