import { AppError } from '../errors'

/** The `area.reason` codes the calendar port and adapters throw. */
export const CALENDAR_ERROR_CODES = {
  /** The Organization id, connection, request id, times, event fields, grant, options or retry policy are not acceptable. Nothing was sent to the vendor. */
  invalidRequest: 'calendar.invalid_request',
  /** The Rep revoked access (or Closeline did): the connection can no longer be used and must be connected again. */
  revoked: 'calendar.revoked',
  /** The event does not exist on this connection's calendar. */
  notFound: 'calendar.not_found',
  /** The vendor refused for a reason a retry cannot fix (a refused grant, quota, a policy, a rejected event). */
  rejected: 'calendar.rejected',
  /** The vendor could not be reached, was throttled or failed, after the bounded retries. The only retryable code. */
  unavailable: 'calendar.unavailable',
  /** The time limit passed; the underlying request was aborted. */
  timeout: 'calendar.timeout',
  /** The caller's own AbortSignal fired; the underlying request was aborted. */
  aborted: 'calendar.aborted',
} as const

/** One of {@link CALENDAR_ERROR_CODES}'s values. */
export type CalendarErrorCode = (typeof CALENDAR_ERROR_CODES)[keyof typeof CALENDAR_ERROR_CODES]

const STATUS: Record<CalendarErrorCode, number> = {
  'calendar.invalid_request': 400,
  'calendar.revoked': 403,
  'calendar.not_found': 404,
  'calendar.rejected': 502,
  'calendar.unavailable': 503,
  'calendar.timeout': 504,
  'calendar.aborted': 499,
}

/**
 * What a calendar adapter throws. Its message and details never hold a token, a grant, an event
 * title, description or attendee, or a vendor URL; they describe fields and codes only.
 */
export class CalendarError extends AppError {
  declare readonly code: CalendarErrorCode

  constructor(
    code: CalendarErrorCode,
    message: string,
    options: { cause?: unknown; details?: Record<string, unknown> } = {}
  ) {
    super({
      code,
      status: STATUS[code],
      message,
      ...(options.cause === undefined ? {} : { cause: options.cause }),
      ...(options.details === undefined ? {} : { details: options.details }),
    })
    this.name = 'CalendarError'
  }
}
