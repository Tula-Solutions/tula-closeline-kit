import type { Region } from 'tula-closeline-contract'
import { isAppError } from '../errors'
import type { Logger } from '../logger'
import type { Environment } from './env'

/** What a service knows about the failed request; the only fields an ErrorReporter sends. */
export interface ErrorContext {
  /** The request's id, for finding the log lines. */
  requestId?: string
  /** The Organization the request was for, so one customer's errors can be filtered. */
  organizationId?: string
  /** HTTP method of the failed request. */
  method?: string
  /** Request path without its query string. */
  path?: string
  /** HTTP status the service answered with. */
  status?: number
  /** Extra low-cardinality labels, such as `{ feature: 'import' }`; never values from a customer. */
  tags?: Record<string, string>
}

/** The one way a service reports an unexpected error. No service imports an error tracker itself. */
export interface ErrorReporter {
  /**
   * Reports an error if `shouldReportError` says it is unexpected. Returns at once, never throws
   * and never waits for the network.
   */
  capture(error: unknown, context?: ErrorContext): void
  /** Waits up to `timeoutMs` for reported errors to be delivered; true if all were. Call it on shutdown. */
  flush(timeoutMs: number): Promise<boolean>
  /**
   * Delivers what is pending (up to `timeoutMs`; true if all was) and then releases what the
   * reporter holds, such as the process listeners of an error tracker. After it, `capture` does
   * nothing and `flush` resolves false. Call it once on shutdown, after the last `capture`.
   */
  close(timeoutMs: number): Promise<boolean>
}

/** Options for createErrorReporter. */
export interface ErrorReporterOptions {
  /** The Sentry DSN of this Region's project; no DSN gives a reporter that sends nothing. */
  dsn?: string | undefined
  /** Service name, sent as the `service` tag. */
  service: string
  /** The `ENVIRONMENT` the service runs in, sent as the `environment` tag. */
  environment: Environment
  /** The Region this deployment serves, sent as the `region` tag. */
  region: Region
  /** The git SHA of the running build, sent as the event's release. */
  release?: string | undefined
  /** Where the reporter says that it is off or that a send failed; errors themselves never go here. */
  logger: Logger
}

function isAppErrorShaped(error: unknown): error is { status: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AppError' &&
    typeof (error as { status?: unknown }).status === 'number'
  )
}

/**
 * True for an error worth reporting: any unknown error, and an AppError with status 500 or above.
 * An AppError below 500 is an expected outcome (bad input, expired token) and is never sent.
 */
export function shouldReportError(error: unknown): boolean {
  try {
    // By class first, whatever name a subclass gives itself, then by shape, so an AppError from a
    // second copy of the kit still counts.
    if (isAppError(error)) {
      return error.status >= 500
    }
    return !(isAppErrorShaped(error) && error.status < 500)
  } catch {
    return true
  }
}
