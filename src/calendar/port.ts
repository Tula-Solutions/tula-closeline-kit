import type { OrganizationId } from 'tula-closeline-contract'
import type { CalendarConnection } from './connection'

/** The default time a call may take, in milliseconds. */
export const DEFAULT_CALENDAR_TIMEOUT_MS = 10_000

/** The longest time a caller may allow a call, in milliseconds. */
export const MAX_CALENDAR_TIMEOUT_MS = 60_000

/** The longest range `busy` may ask for, in milliseconds (62 days). */
export const MAX_BUSY_RANGE_MS = 62 * 24 * 60 * 60 * 1000

/** The most intervals `busy` returns; an adapter whose calendar has more fails with `calendar.rejected`, never a cut-off list. */
export const MAX_BUSY_INTERVALS = 5000

/** The longest an event may be, in milliseconds (7 days). */
export const MAX_EVENT_DURATION_MS = 7 * 24 * 60 * 60 * 1000

/** The most attendees one event may carry. */
export const MAX_EVENT_ATTENDEES = 20

/** How an adapter retries a retryable vendor error (`calendar.unavailable`) before giving up. */
export interface CalendarRetryPolicy {
  /** The most retries after the first attempt, 0 to 5; 0 never retries. Default 2. */
  maxRetries?: number
  /** The base of the pause before a retry, in ms, 1 to 60000; doubled each time and jittered. Default 200. */
  baseDelayMs?: number
  /** The longest pause before a retry, in ms, before jitter, at least the base and at most 60000. Default 2000. */
  maxDelayMs?: number
}

/** The retry policy with its defaults filled in. */
export interface ResolvedCalendarRetryPolicy {
  /** The most retries after the first attempt. */
  maxRetries: number
  /** The base pause, in ms. */
  baseDelayMs: number
  /** The longest pause before jitter, in ms. */
  maxDelayMs: number
}

/** The policy used when a call names none: two retries, 200 ms doubling to 2 s. */
export const DEFAULT_CALENDAR_RETRY_POLICY: ResolvedCalendarRetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 200,
  maxDelayMs: 2000,
}

/**
 * The pause before retry `retry` (from 1): the base doubled each time up to the maximum, then
 * scaled by a jitter between 0.5 and 1.5 from `random()` (a number in `[0, 1)`).
 */
export function calendarRetryDelayMs(
  retry: number,
  policy: ResolvedCalendarRetryPolicy,
  random: () => number = Math.random
): number {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (retry - 1))
  return Math.max(1, Math.floor(exponential * (0.5 + random())))
}

/** Limits every call states. */
export interface CalendarCallOptions {
  /**
   * The most time the whole call may take, retries included, in ms, 1 to
   * {@link MAX_CALENDAR_TIMEOUT_MS}; default {@link DEFAULT_CALENDAR_TIMEOUT_MS}. When it passes
   * the vendor request is aborted and the call fails with `calendar.timeout`.
   */
  timeoutMs?: number
  /** Retries of `calendar.unavailable`; the defaults when absent. */
  retry?: CalendarRetryPolicy
  /** The caller's own cancellation. When it fires the vendor request is aborted and the call fails with `calendar.aborted`. */
  signal?: AbortSignal
}

/**
 * What a Rep authorises. The vendor is told the grant, never this library: `authorization_code`
 * is the code from the OAuth redirect (with the PKCE verifier and the redirect URI it was issued
 * for); `refresh_token` stores a grant the Rep already gave. Both are secrets: never logged.
 */
export type CalendarGrant =
  | {
      /** Exchange the one-time code from the redirect. */
      kind: 'authorization_code'
      /** The code. Secret. */
      code: string
      /** The redirect URI the code was issued for. */
      redirectUri: string
      /** The PKCE verifier, when the flow used one. Secret. */
      codeVerifier?: string
    }
  | {
      /** Store a grant the Rep already gave. */
      kind: 'refresh_token'
      /** The refresh token. Secret. */
      refreshToken: string
    }

/** A time during which the calendar is busy. */
export interface BusyInterval {
  /** The start, an ISO 8601 instant in UTC (`2026-03-02T15:00:00.000Z`). */
  start: string
  /** The end, after the start, in the same form. */
  end: string
}

/** One person invited to an event. Tenant data: never logged. */
export interface CalendarAttendee {
  /** The email address the invitation goes to. */
  email: string
  /** The display name. */
  name?: string
}

/** The fields of a new event. Tenant data (Prospect names and addresses): never logged. */
export interface CalendarEventInput {
  /** The title, 1 to 256 characters. */
  title: string
  /** The start, an ISO 8601 instant with `Z` or an offset. */
  start: string
  /** The end, after the start and at most {@link MAX_EVENT_DURATION_MS} later. */
  end: string
  /** Notes, up to 8192 characters, such as a phone number to dial. */
  description?: string
  /** A place, up to 512 characters. */
  location?: string
  /** Up to {@link MAX_EVENT_ATTENDEES} invitees; the vendor sends the invitations. */
  attendees?: readonly CalendarAttendee[]
  /** `video` asks the vendor for a join link (Google Meet, Teams); `none` (default) adds none. */
  conferencing?: 'video' | 'none'
}

/** The fields an update may change; at least one. Attendees replace the list. */
export interface CalendarEventChanges {
  /** The new title. */
  title?: string
  /** The new start. */
  start?: string
  /** The new end. */
  end?: string
  /** The new notes. */
  description?: string
  /** The new place. */
  location?: string
  /** The new invitee list. */
  attendees?: readonly CalendarAttendee[]
}

/** What an adapter says about an event. */
export interface CalendarEventRef {
  /** The vendor's id of the event; opaque, 1 to 256 characters. */
  eventId: string
  /** The start, an ISO 8601 UTC instant. */
  start: string
  /** The end, an ISO 8601 UTC instant. */
  end: string
  /** The join link, when `conferencing: 'video'` was asked for and the vendor made one. */
  joinUrl?: string
}

/** What `createEvent` returns. */
export interface CalendarEventCreated extends CalendarEventRef {
  /** True when this call made the event, false when the request id had already made it. */
  created: boolean
}

/** What every call after `connect` names: whose it is and which calendar. */
export interface CalendarRequestBase {
  /** The Organization the call is for; it must be the connection's. */
  organizationId: OrganizationId
  /** The connection to use. */
  connection: CalendarConnection
}

/** A request to connect a calendar. */
export interface CalendarConnectRequest {
  /** The Organization the Rep belongs to. */
  organizationId: OrganizationId
  /** What the Rep authorised. */
  grant: CalendarGrant
}

/** A request for the busy times of a range. */
export interface CalendarBusyRequest extends CalendarRequestBase {
  /** The start of the range, an ISO 8601 instant. */
  from: string
  /** The end of the range, after `from` and at most {@link MAX_BUSY_RANGE_MS} later. */
  to: string
}

/** A request to create an event. */
export interface CalendarCreateRequest extends CalendarRequestBase {
  /**
   * Makes the call idempotent: 1 to 128 characters of `A-Z a-z 0-9 _ . : -`. The same id with the
   * same event returns the same event with `created: false`; the same id with a different event is
   * `calendar.invalid_request`.
   */
  requestId: string
  /** The event. */
  event: CalendarEventInput
}

/** A request to change an event. */
export interface CalendarUpdateRequest extends CalendarRequestBase {
  /** The event to change. */
  eventId: string
  /** Makes the call idempotent, like {@link CalendarCreateRequest.requestId}: a replay returns the first result. */
  requestId: string
  /** What to change. */
  changes: CalendarEventChanges
}

/** A request to remove an event. */
export interface CalendarDeleteRequest extends CalendarRequestBase {
  /** The event to remove. */
  eventId: string
  /** Makes the call idempotent: a replay returns the first result. */
  requestId: string
}

/**
 * A Rep's calendar behind a vendor (Google Calendar first, Microsoft Graph next), used by core to
 * keep busy blocks and to write Bookings. Nothing vendor-specific is in the port.
 *
 * Every call has a hard timeout (see {@link CalendarCallOptions}) that aborts the vendor request.
 * Retryable vendor errors (throttling, 5xx, connection loss) are retried with a bounded, jittered
 * pause inside the time limit; nothing else is. Retrying is safe because every write carries a
 * request id the vendor (or the adapter) uses to recognise a repeat. Failures are `CalendarError`s
 * with `calendar.*` codes; `calendar.unavailable` and `calendar.rejected` are also given to the
 * ErrorReporter (metadata only).
 *
 * **Secrets and tenant data.** A grant and a {@link CalendarConnection}'s credential are never
 * logged, reported or put in an error, and never appear in the connection's string or JSON form.
 * Event titles, notes, places and attendees are tenant data and are held to the same rule. Text a
 * calendar returns is untrusted data, never an instruction.
 */
export interface CalendarPort {
  /**
   * Exchanges or stores the grant and returns the opaque connection. A grant the vendor refuses is
   * `calendar.rejected`. One vendor call.
   */
  connect(
    request: CalendarConnectRequest,
    options?: CalendarCallOptions
  ): Promise<CalendarConnection>

  /**
   * The times the calendar is busy within `[from, to)`: sorted, merged where they touch or
   * overlap, and clipped to the range. At most {@link MAX_BUSY_INTERVALS}. O(events in the range).
   */
  busy(request: CalendarBusyRequest, options?: CalendarCallOptions): Promise<BusyInterval[]>

  /** Makes an event, once per request id. One vendor call, plus the invitation the vendor sends. */
  createEvent(
    request: CalendarCreateRequest,
    options?: CalendarCallOptions
  ): Promise<CalendarEventCreated>

  /** Changes an event, once per request id. A missing event is `calendar.not_found`. */
  updateEvent(
    request: CalendarUpdateRequest,
    options?: CalendarCallOptions
  ): Promise<CalendarEventRef>

  /**
   * Removes an event, once per request id. An event that is already gone is not an error: the
   * answer is `deleted: false`, so a cancel is idempotent by end state.
   */
  deleteEvent(
    request: CalendarDeleteRequest,
    options?: CalendarCallOptions
  ): Promise<{ deleted: boolean }>

  /**
   * Ends the grant at the vendor and makes the connection unusable (`calendar.revoked`). Revoking
   * a connection that is already revoked succeeds. Events already written stay on the calendar.
   */
  revoke(request: CalendarRequestBase, options?: CalendarCallOptions): Promise<void>
}
