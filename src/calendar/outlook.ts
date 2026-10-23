import { createHash, randomUUID } from 'node:crypto'
import type { OrganizationId } from 'tula-closeline-contract'
import { type Clock, systemClock } from '../clock'
import type { Logger } from '../logger'
import { AttemptAborted, raceAbort } from '../messaging/deadline'
import { type Sleep, systemSleep } from '../queue/sleep'
import type { ErrorReporter } from '../reporting/port'
import { CalendarConnection } from './connection'
import { startCalendarDeadline, withCalendarRetry } from './deadline'
import { CALENDAR_ERROR_CODES, CalendarError } from './errors'
import {
  type BusyInterval,
  type CalendarAttendee,
  type CalendarBusyRequest,
  type CalendarCallOptions,
  type CalendarConnectRequest,
  type CalendarCreateRequest,
  type CalendarDeleteRequest,
  type CalendarEventChanges,
  type CalendarEventCreated,
  type CalendarEventRef,
  type CalendarPort,
  type CalendarRequestBase,
  type CalendarUpdateRequest,
  MAX_BUSY_INTERVALS,
} from './port'
import {
  checkBase,
  checkChanges,
  checkEvent,
  checkEventId,
  checkEventTimes,
  checkGrant,
  checkOptions,
  checkOrganizationId,
  checkRange,
  checkRequestId,
  invalid,
} from './validate'

/** The least scopes the adapter needs: read and write the Rep's calendar, and a refresh token (`offline_access`). Ask for exactly these in the consent URL. */
export const OUTLOOK_CALENDAR_SCOPES: readonly string[] = ['offline_access', 'Calendars.ReadWrite']

const LOGIN = 'https://login.microsoftonline.com'
const GRAPH = 'https://graph.microsoft.com/v1.0'
const MAX_RESPONSE_BYTES = 2_097_152
const DEFAULT_ATTEMPT_TIMEOUT_MS = 5_000
const TOKEN_MARGIN_MS = 60_000
const MAX_CACHED_TOKENS = 1_024
const MAX_ROTATED = 10_000
/** How much older than the start of a create attempt an event must be, in ms, to be one made earlier; absorbs clock skew with Graph. */
const CREATED_SKEW_MS = 5_000
const PAGE_SIZE = 200
const MAX_PAGES = 50
/** The namespace of the single-value extended properties the adapter writes to recognise its own events. */
const PROPERTY_NAMESPACE = '{d4b6f1c2-7a3e-4c58-9a1b-3e5f8c2d6a47}'
const THROTTLE_CODES = new Set([
  'TooManyRequests',
  'ApplicationThrottled',
  'ErrorServerBusy',
  'ErrorTimeoutExceeded',
  'MailboxConcurrency',
  'activityLimitReached',
])
const BUSY_STATES = new Set(['busy', 'tentative', 'oof', 'unknown'])

/** The HTTP client the adapter uses: `fetch`, injected for tests. */
export type OutlookCalendarFetch = (input: string, init: RequestInit) => Promise<Response>

/** Options for {@link createOutlookCalendar}. The kit takes options, not environment variables. */
export interface OutlookCalendarOptions {
  /** The application (client) id of the Closeline app registration in Microsoft Entra. */
  clientId: string
  /** The client secret. Never logged. */
  clientSecret: string
  /** The Entra tenant that signs the Rep in: `common` (default), `organizations`, `consumers`, a tenant id or a verified domain. */
  tenant?: string
  /** The calendar read and written, by Graph id; the Rep's default calendar when absent. */
  calendarId?: string
  /** The HTTP client; the global `fetch` by default. For tests. */
  fetch?: OutlookCalendarFetch
  /** The time limit of one HTTP request, in ms, 1 to 60000; default 5000. The call's own deadline still applies. */
  attemptTimeoutMs?: number
  /** Receives the errors that mean Microsoft failed; nothing if absent. */
  reporter?: ErrorReporter
  /** Where retries are noted (metadata only); nothing if absent. */
  logger?: Logger
  /** The time source for access-token expiry; the system clock by default. */
  clock?: Clock
  /** Pauses between retries; real time by default. */
  sleep?: Sleep
  /** A number in `[0, 1)` for the jitter; `Math.random` by default. */
  random?: () => number
  /**
   * Told when Microsoft rotates a refresh token: `credential` is the newest one, which core must
   * store in place of the connection's (the old one stops working after a while). Called with the
   * secret itself, so never log it. A throw is swallowed so the calendar call still completes.
   */
  onCredentialRotated?: (connection: CalendarConnection, credential: string) => void | Promise<void>
}

type Json = Record<string, unknown>

interface Answer {
  status: number
  json: Json | null
  /** The `Retry-After` pause in ms, when the response carried a usable one. */
  retryAfterMs?: number
}

/** The longest `Retry-After` pause honoured, in ms; the call's deadline still cuts a sleep short. */
const MAX_RETRY_AFTER_MS = 60_000

/** The pause Microsoft asked for, kept off the error so nothing about it reaches a log. */
const retryAfterOf = new WeakMap<CalendarError, number>()

/** Reads `Retry-After` as seconds or an HTTP date; undefined when absent or unusable. */
function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null) {
    return undefined
  }
  const text = value.trim()
  const ms = /^\d{1,9}$/.test(text) ? Number(text) * 1000 : Date.parse(text) - nowMs
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : undefined
}

function unavailable(phase: string, status?: number, retryAfterMs?: number): CalendarError {
  const error = new CalendarError(
    CALENDAR_ERROR_CODES.unavailable,
    'The calendar provider is unavailable',
    { details: { phase, ...(status === undefined ? {} : { status }) } }
  )
  if (retryAfterMs !== undefined) {
    retryAfterOf.set(error, retryAfterMs)
  }
  return error
}

function rejected(reason: string, status?: number): CalendarError {
  return new CalendarError(
    CALENDAR_ERROR_CODES.rejected,
    'The calendar provider refused the request',
    { details: { reason, ...(status === undefined ? {} : { status }) } }
  )
}

function revoked(): CalendarError {
  return new CalendarError(CALENDAR_ERROR_CODES.revoked, 'The calendar connection was revoked')
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readBounded(response: Response): Promise<string> {
  const body = response.body
  if (body === null) {
    return ''
  }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    total += value.byteLength
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw rejected('too_large')
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

function parseJson(text: string): Json | null {
  try {
    const value: unknown = JSON.parse(text)
    return isObject(value) ? value : null
  } catch {
    return null
  }
}

function sha256Hex(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex')
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

/** A Graph date-time body: UTC, without the `Z` Graph does not accept next to a time zone name. */
function graphTime(ms: number) {
  return { dateTime: iso(ms).slice(0, -1), timeZone: 'UTC' }
}

/** Reads a Graph `dateTimeTimeZone` asked for in UTC (`Prefer: outlook.timezone="UTC"`) as epoch ms. */
function readTime(value: unknown): number {
  if (!isObject(value) || typeof value.dateTime !== 'string') {
    return Number.NaN
  }
  const zone = value.timeZone
  if (typeof zone === 'string' && zone.toUpperCase() !== 'UTC') {
    return Number.NaN
  }
  const text = value.dateTime
  return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(text) ? text : `${text}Z`)
}

function graphCode(json: Json | null): string | undefined {
  const error = json?.error
  const code = isObject(error) ? error.code : undefined
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : undefined
}

function propertyId(name: string): string {
  return `String ${PROPERTY_NAMESPACE} Name ${name}`
}

function property(json: Json | null, name: string): string | undefined {
  const list = json?.singleValueExtendedProperties
  if (!Array.isArray(list)) {
    return undefined
  }
  const id = propertyId(name)
  for (const item of list as unknown[]) {
    if (isObject(item) && item.id === id && typeof item.value === 'string') {
      return item.value
    }
  }
  return undefined
}

function eventRef(json: Json | null, status: number): CalendarEventRef {
  const id = json?.id
  const startMs = readTime(json?.start)
  const endMs = readTime(json?.end)
  if (
    typeof id !== 'string' ||
    id.length < 1 ||
    id.length > 256 ||
    Number.isNaN(startMs) ||
    Number.isNaN(endMs)
  ) {
    throw rejected('shape', status)
  }
  const meeting = json?.onlineMeeting
  const link = isObject(meeting) ? meeting.joinUrl : undefined
  const joinUrl = typeof link === 'string' && link.startsWith('https://') ? link : undefined
  return {
    eventId: id,
    start: iso(startMs),
    end: iso(endMs),
    ...(joinUrl === undefined ? {} : { joinUrl }),
  }
}

function attendeesBody(attendees: readonly CalendarAttendee[]) {
  return attendees.map((a) => ({
    emailAddress: { address: a.email, ...(a.name === undefined ? {} : { name: a.name }) },
    type: 'required',
  }))
}

/**
 * Creates the {@link CalendarPort} on Microsoft Graph (v1.0) with OAuth 2.0 against the Microsoft
 * identity platform, using plain `fetch`.
 *
 * Scopes are {@link OUTLOOK_CALENDAR_SCOPES}. The credential of a {@link CalendarConnection} is
 * the Rep's refresh token; access tokens are short-lived, held in a bounded in-process cache and
 * refreshed when they near expiry. A token request Microsoft refuses with `invalid_grant`, and a
 * 401 that survives one token refresh, are `calendar.revoked`: the Rep must connect again.
 *
 * Busy times are the Rep's `calendarView` of the range, following `@odata.nextLink` (only links
 * on Graph's own host), counting every state except free and working-elsewhere as busy; titles
 * are never selected. Every HTTP request has its own time limit and each call an overall deadline
 * that aborts the request; a network error, 429, 5xx and Graph's throttling codes are retried a
 * bounded number of times with jittered backoff, any other failure never, and `connect` never.
 *
 * Writes are idempotent by request id. `createEvent` sends a hash of the connection and request
 * id as Graph's `transactionId`, so a repeat (a retry after a lost response, or a replay) gets the
 * first event back instead of a second one. An event Graph reports as created more than 5 s before
 * the attempt began is a replay: it is read back and its fingerprint (a single-value extended
 * property) compared, so a different event under the same id is refused, and `created` is false.
 * A replay inside that 5 s skew window is reported `created: true` (one event exists either way). `updateEvent`
 * keeps the last request id and change fingerprint the same way (a late replay of an older update
 * is applied again, not recognised).
 *
 * Microsoft has no call that revokes one refresh token (only all of a user's sign-in sessions,
 * which would sign the Rep out everywhere, so it is not used). `revoke` therefore validates the
 * request and drops the cached access token, nothing more: it keeps no revoked state, in this
 * process or at Microsoft. Core deleting the stored credential is what ends access, and the Rep
 * can withdraw the app's access in their Microsoft account (later refreshes then fail with
 * `calendar.revoked`).
 *
 * Microsoft rotates the refresh token. When a token answer carries a new one, it is used for later
 * refreshes in this process and handed to `onCredentialRotated`, which core must use to replace the
 * stored credential. `Retry-After` on a 429 or 5xx (seconds or an HTTP date, at most 60 s) replaces
 * the computed backoff for that retry; the retry count and the call's deadline still bound it.
 *
 * Nothing is logged but retry metadata, and no token, title, note, address or URL is put in an
 * error, a log line or a report. Text Graph returns is data.
 */
export function createOutlookCalendar(options: OutlookCalendarOptions): CalendarPort {
  if (typeof options.clientId !== 'string' || options.clientId.length < 1) {
    throw new TypeError('clientId is required')
  }
  if (typeof options.clientSecret !== 'string' || options.clientSecret.length < 1) {
    throw new TypeError('clientSecret is required')
  }
  const tenant = options.tenant ?? 'common'
  if (typeof tenant !== 'string' || !/^[A-Za-z0-9.-]{1,128}$/.test(tenant)) {
    throw new TypeError('tenant is not acceptable')
  }
  const calendarId = options.calendarId
  if (
    calendarId !== undefined &&
    (typeof calendarId !== 'string' || calendarId.length < 1 || calendarId.length > 512)
  ) {
    throw new TypeError('calendarId is not acceptable')
  }
  const attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS
  if (!Number.isInteger(attemptTimeoutMs) || attemptTimeoutMs < 1 || attemptTimeoutMs > 60_000) {
    throw new TypeError('attemptTimeoutMs must be 1 to 60000')
  }
  const { clientId, clientSecret } = options
  const clock = options.clock ?? systemClock
  const sleep = options.sleep ?? systemSleep
  const doFetch: OutlookCalendarFetch = options.fetch ?? ((input, init) => fetch(input, init))
  const tokenUrl = `${LOGIN}/${tenant}/oauth2/v2.0/token`
  const calendarUrl =
    calendarId === undefined
      ? `${GRAPH}/me/calendar`
      : `${GRAPH}/me/calendars/${encodeURIComponent(calendarId)}`
  const scope = OUTLOOK_CALENDAR_SCOPES.join(' ')
  const tokens = new Map<string, { accessToken: string; expiresAtMs: number }>()
  const rotated = new Map<string, string>()

  function tokenKey(credential: string): string {
    return sha256Hex(credential)
  }

  function remember(credential: string, accessToken: string, expiresInSeconds: number) {
    const key = tokenKey(credential)
    tokens.delete(key)
    tokens.set(key, {
      accessToken,
      expiresAtMs: clock.now().getTime() + expiresInSeconds * 1000 - TOKEN_MARGIN_MS,
    })
    if (tokens.size > MAX_CACHED_TOKENS) {
      const oldest = tokens.keys().next().value
      if (oldest !== undefined) {
        tokens.delete(oldest)
      }
    }
  }

  /** One HTTP request with its own time limit and a bounded body. */
  async function http(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
    overall: AbortSignal
  ): Promise<Answer> {
    const own = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      own.abort()
    }, attemptTimeoutMs)
    timer.unref?.()
    const signal = AbortSignal.any([overall, own.signal])
    try {
      const response = await raceAbort(
        doFetch(url, { ...init, redirect: 'manual', signal }),
        signal
      )
      const text = await raceAbort(readBounded(response), signal)
      const retryAfterMs = parseRetryAfter(
        response.headers.get('retry-after'),
        clock.now().getTime()
      )
      return {
        status: response.status,
        json: parseJson(text),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      }
    } catch (error) {
      if (error instanceof CalendarError) {
        throw error
      }
      if (error instanceof AttemptAborted && !timedOut) {
        throw error
      }
      throw unavailable(timedOut ? 'attempt_timeout' : 'network')
    } finally {
      clearTimeout(timer)
    }
  }

  function tokenRequest(form: Record<string, string>, overall: AbortSignal): Promise<Answer> {
    return http(
      tokenUrl,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          scope,
          ...form,
        }).toString(),
      },
      overall
    )
  }

  /** Reads an OAuth token answer; `grantGone` is what `invalid_grant` means for the caller. */
  function tokenAnswer(answer: Answer, grantGone: () => CalendarError) {
    if (answer.status === 429 || answer.status >= 500) {
      throw unavailable('token', answer.status, answer.retryAfterMs)
    }
    if (
      (answer.status === 400 || answer.status === 401) &&
      (answer.json?.error === 'invalid_grant' || answer.json?.error === 'interaction_required')
    ) {
      throw grantGone()
    }
    if (answer.status !== 200) {
      throw rejected('token', answer.status)
    }
    const accessToken = answer.json?.access_token
    const expiresIn = answer.json?.expires_in
    if (typeof accessToken !== 'string' || accessToken.length < 1) {
      throw rejected('token_shape', answer.status)
    }
    const granted = answer.json?.scope
    if (typeof granted === 'string') {
      const have = new Set(granted.toLowerCase().split(' '))
      if (
        !have.has('calendars.readwrite') &&
        !have.has('https://graph.microsoft.com/calendars.readwrite')
      ) {
        throw rejected('scope', answer.status)
      }
    }
    const seconds =
      typeof expiresIn === 'number' && Number.isFinite(expiresIn)
        ? Math.min(Math.max(expiresIn, 0), 86_400)
        : 3_600
    return { accessToken, seconds, refreshToken: answer.json?.refresh_token }
  }

  /** Notes a refresh token Microsoft rotated: later refreshes use it, and core is told to store it. */
  async function rotation(connection: CalendarConnection, used: string, next: unknown) {
    if (typeof next !== 'string' || next.length < 1 || next === used) {
      return
    }
    const key = tokenKey(connection.unsafeCredential())
    rotated.delete(key)
    rotated.set(key, next)
    if (rotated.size > MAX_ROTATED) {
      const oldest = rotated.keys().next().value
      if (oldest !== undefined) {
        rotated.delete(oldest)
      }
    }
    try {
      await options.onCredentialRotated?.(connection, next)
    } catch {
      options.logger?.warn('A rotated calendar credential was not stored', { feature: 'calendar' })
    }
  }

  async function accessToken(
    connection: CalendarConnection,
    overall: AbortSignal
  ): Promise<string> {
    const key = tokenKey(connection.unsafeCredential())
    const cached = tokens.get(key)
    if (cached !== undefined && cached.expiresAtMs > clock.now().getTime()) {
      return cached.accessToken
    }
    const used = rotated.get(key) ?? connection.unsafeCredential()
    const answer = await tokenRequest({ grant_type: 'refresh_token', refresh_token: used }, overall)
    const read = tokenAnswer(answer, revoked)
    remember(connection.unsafeCredential(), read.accessToken, read.seconds)
    await rotation(connection, used, read.refreshToken)
    return read.accessToken
  }

  /** A Graph request with the connection's access token; a 401 drops the cached token and tries once more. */
  async function api(
    connection: CalendarConnection,
    method: string,
    url: string,
    body: unknown,
    overall: AbortSignal
  ): Promise<Answer> {
    for (let pass = 0; ; pass++) {
      const token = await accessToken(connection, overall)
      const answer = await http(
        url,
        {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            prefer: 'outlook.timezone="UTC"',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        overall
      )
      if (answer.status === 401 && pass === 0) {
        tokens.delete(tokenKey(connection.unsafeCredential()))
        continue
      }
      if (answer.status === 401) {
        throw revoked()
      }
      return answer
    }
  }

  /** Turns a failed API answer into the calendar error; `notFound` is what 404 and 410 mean to the caller. */
  function failure(
    answer: Answer,
    notFound: CalendarError = rejected('not_found', 404)
  ): CalendarError {
    const { status } = answer
    if (status === 404 || status === 410) {
      return notFound
    }
    if (status === 429 || status >= 500) {
      return unavailable('http', status, answer.retryAfterMs)
    }
    const code = graphCode(answer.json)
    if (code !== undefined && THROTTLE_CODES.has(code)) {
      return unavailable('rate_limit', status, answer.retryAfterMs)
    }
    return rejected(code ?? 'http', status)
  }

  function report(error: unknown, organizationId: OrganizationId) {
    if (
      !(error instanceof CalendarError) ||
      (error.code !== CALENDAR_ERROR_CODES.unavailable &&
        error.code !== CALENDAR_ERROR_CODES.rejected)
    ) {
      return
    }
    try {
      options.reporter?.capture(error, { organizationId, tags: { feature: 'calendar' } })
    } catch {
      // Reporting must never turn an error into a different one.
    }
  }

  /** The whole call: options, deadline, bounded retry of `calendar.unavailable`, reporting. */
  async function call<T>(
    kind: string,
    organizationId: OrganizationId,
    callOptions: CalendarCallOptions | undefined,
    attempt: (overall: AbortSignal) => Promise<T>,
    retries = true
  ): Promise<T> {
    const checked = checkOptions(callOptions)
    const deadline = startCalendarDeadline(checked.timeoutMs, checked.signal)
    try {
      return await withCalendarRetry(
        async () => {
          try {
            return await attempt(deadline.signal)
          } catch (error) {
            if (error instanceof AttemptAborted) {
              deadline.check()
              throw unavailable('attempt_timeout')
            }
            throw error
          }
        },
        {
          policy: retries ? checked.retry : { ...checked.retry, maxRetries: 0 },
          deadline,
          sleep,
          adjustDelay: (error, delayMs) =>
            error instanceof CalendarError ? (retryAfterOf.get(error) ?? delayMs) : delayMs,
          ...(options.random === undefined ? {} : { random: options.random }),
          onRetry: (retry, delayMs) =>
            options.logger?.warn('A calendar call is retrying', {
              feature: 'calendar',
              kind,
              retry,
              delayMs,
            }),
        }
      )
    } catch (error) {
      report(error, organizationId)
      throw error
    } finally {
      deadline.stop()
    }
  }

  function eventUrl(eventId: string, query = ''): string {
    return `${GRAPH}/me/events/${encodeURIComponent(eventId)}${query}`
  }

  function expand(names: readonly string[]): string {
    const filter = names.map((n) => `id eq '${propertyId(n)}'`).join(' or ')
    return `$expand=${encodeURIComponent(`singleValueExtendedProperties($filter=${filter})`)}`
  }

  /** Reads an event with the named properties; a missing or cancelled one is `missing`. */
  async function readEvent(
    connection: CalendarConnection,
    eventId: string,
    names: readonly string[],
    overall: AbortSignal,
    missing: CalendarError
  ): Promise<Json> {
    const answer = await api(
      connection,
      'GET',
      eventUrl(eventId, `?${expand(names)}`),
      undefined,
      overall
    )
    if (answer.status !== 200) {
      throw failure(answer, missing)
    }
    if (answer.json?.isCancelled === true) {
      throw missing
    }
    return answer.json ?? {}
  }

  function fingerprint(value: unknown): string {
    return sha256Hex(JSON.stringify(value))
  }

  return {
    async connect(request: CalendarConnectRequest, callOptions) {
      checkOrganizationId(request?.organizationId)
      const grant = checkGrant(request.grant)
      return call(
        'connect',
        request.organizationId,
        callOptions,
        async (overall) => {
          if (grant.kind === 'refresh_token') {
            const answer = await tokenRequest(
              { grant_type: 'refresh_token', refresh_token: grant.refreshToken },
              overall
            )
            const read = tokenAnswer(answer, () => rejected('invalid_grant', answer.status))
            const next =
              typeof read.refreshToken === 'string' && read.refreshToken.length > 0
                ? read.refreshToken
                : grant.refreshToken
            remember(next, read.accessToken, read.seconds)
            return next
          }
          const answer = await tokenRequest(
            {
              grant_type: 'authorization_code',
              code: grant.code,
              redirect_uri: grant.redirectUri,
              ...(grant.codeVerifier === undefined ? {} : { code_verifier: grant.codeVerifier }),
            },
            overall
          )
          const read = tokenAnswer(answer, () => rejected('invalid_grant', answer.status))
          if (typeof read.refreshToken !== 'string' || read.refreshToken.length < 1) {
            throw rejected('no_refresh_token', answer.status)
          }
          remember(read.refreshToken, read.accessToken, read.seconds)
          return read.refreshToken
        },
        false
      ).then(
        (credential) =>
          new CalendarConnection({
            organizationId: request.organizationId,
            provider: 'microsoft',
            connectionId: `ocal_${randomUUID()}`,
            credential,
          })
      )
    },

    async busy(request: CalendarBusyRequest, callOptions) {
      const connection = checkBase(request)
      const { fromMs, toMs } = checkRange(request.from, request.to)
      return call('busy', request.organizationId, callOptions, async (overall) => {
        const blocks: { startMs: number; endMs: number }[] = []
        let url: string | undefined =
          `${calendarUrl}/calendarView?startDateTime=${encodeURIComponent(iso(fromMs))}` +
          `&endDateTime=${encodeURIComponent(iso(toMs))}&$select=start,end,showAs,isCancelled&$top=${PAGE_SIZE}`
        for (let page = 0; url !== undefined; page++) {
          if (page >= MAX_PAGES) {
            throw tooMany()
          }
          const answer: Answer = await api(connection, 'GET', url, undefined, overall)
          if (answer.status !== 200) {
            throw failure(answer, rejected('calendar_not_found', answer.status))
          }
          const items = answer.json?.value
          if (!Array.isArray(items)) {
            throw rejected('shape', answer.status)
          }
          for (const item of items as unknown[]) {
            if (!isObject(item)) {
              throw rejected('shape', answer.status)
            }
            const start = readTime(item.start)
            const end = readTime(item.end)
            if (Number.isNaN(start) || Number.isNaN(end)) {
              throw rejected('shape', answer.status)
            }
            const state = typeof item.showAs === 'string' ? item.showAs.toLowerCase() : 'busy'
            if (item.isCancelled === true || !BUSY_STATES.has(state)) {
              continue
            }
            const clipped = { startMs: Math.max(start, fromMs), endMs: Math.min(end, toMs) }
            if (clipped.startMs < clipped.endMs) {
              blocks.push(clipped)
            }
          }
          const next = answer.json?.['@odata.nextLink']
          if (next === undefined) {
            url = undefined
          } else if (typeof next === 'string' && next.startsWith(`${GRAPH}/`)) {
            url = next
          } else {
            // A link off Graph's host would carry our access token to someone else.
            throw rejected('next_link', answer.status)
          }
        }
        blocks.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
        const merged: { startMs: number; endMs: number }[] = []
        for (const block of blocks) {
          const last = merged.at(-1)
          if (last !== undefined && block.startMs <= last.endMs) {
            last.endMs = Math.max(last.endMs, block.endMs)
          } else {
            merged.push({ ...block })
          }
        }
        if (merged.length > MAX_BUSY_INTERVALS) {
          throw tooMany()
        }
        return merged.map<BusyInterval>((b) => ({ start: iso(b.startMs), end: iso(b.endMs) }))
      })
    },

    async createEvent(request: CalendarCreateRequest, callOptions): Promise<CalendarEventCreated> {
      const connection = checkBase(request)
      const requestId = checkRequestId(request.requestId)
      const { event, startMs, endMs } = checkEvent(request.event)
      const video = event.conferencing === 'video'
      const key = sha256Hex(connection.connectionId, requestId)
      const fp = fingerprint({
        title: event.title,
        startMs,
        endMs,
        description: event.description ?? null,
        location: event.location ?? null,
        attendees: event.attendees ?? [],
        video,
      })
      const body = {
        transactionId: key,
        subject: event.title,
        start: graphTime(startMs),
        end: graphTime(endMs),
        ...(event.description === undefined
          ? {}
          : { body: { contentType: 'text', content: event.description } }),
        ...(event.location === undefined ? {} : { location: { displayName: event.location } }),
        ...(event.attendees === undefined ? {} : { attendees: attendeesBody(event.attendees) }),
        ...(video ? { isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' } : {}),
        singleValueExtendedProperties: [{ id: propertyId('kitFp'), value: fp }],
      }
      return call('create', request.organizationId, callOptions, async (overall) => {
        const startedAt = clock.now().getTime()
        const answer = await api(connection, 'POST', `${calendarUrl}/events`, body, overall)
        if (answer.status !== 201 && answer.status !== 200) {
          throw failure(answer)
        }
        const ref = eventRef(answer.json, answer.status)
        const madeAt = Date.parse(String(answer.json?.createdDateTime))
        if (Number.isNaN(madeAt) || madeAt >= startedAt - CREATED_SKEW_MS) {
          // A replay inside the skew window looks new; a different title or time still shows.
          if (
            answer.json?.subject !== event.title ||
            Date.parse(ref.start) !== startMs ||
            Date.parse(ref.end) !== endMs
          ) {
            invalid('requestId')
          }
          return { ...ref, created: true }
        }
        // Graph answered a repeated `transactionId` with the event an earlier attempt or call made.
        const notFound = rejected('event_deleted')
        const existing = await readEvent(connection, ref.eventId, ['kitFp'], overall, notFound)
        if (property(existing, 'kitFp') !== fp) {
          invalid('requestId')
        }
        return { ...ref, created: false }
      })
    },

    async updateEvent(request: CalendarUpdateRequest, callOptions) {
      const connection = checkBase(request)
      const eventId = checkEventId(request.eventId)
      const requestId = checkRequestId(request.requestId)
      const changes: CalendarEventChanges = checkChanges(request.changes)
      const requestHash = sha256Hex(requestId).slice(0, 32)
      const changeHash = fingerprint(changes)
      const notFound = new CalendarError(CALENDAR_ERROR_CODES.notFound, 'The event does not exist')
      return call('update', request.organizationId, callOptions, async (overall) => {
        const existing = await readEvent(connection, eventId, ['kitUpd'], overall, notFound)
        const last = property(existing, 'kitUpd')
        if (last?.startsWith(`${requestHash}:`)) {
          if (last !== `${requestHash}:${changeHash}`) {
            invalid('requestId')
          }
          return eventRef(existing, 200)
        }
        const current = eventRef(existing, 200)
        const startMs =
          changes.start === undefined ? Date.parse(current.start) : Date.parse(changes.start)
        const endMs = changes.end === undefined ? Date.parse(current.end) : Date.parse(changes.end)
        checkEventTimes(startMs, endMs)
        const body = {
          ...(changes.title === undefined ? {} : { subject: changes.title }),
          ...(changes.description === undefined
            ? {}
            : { body: { contentType: 'text', content: changes.description } }),
          ...(changes.location === undefined
            ? {}
            : { location: { displayName: changes.location } }),
          ...(changes.attendees === undefined
            ? {}
            : { attendees: attendeesBody(changes.attendees) }),
          ...(changes.start === undefined ? {} : { start: graphTime(startMs) }),
          ...(changes.end === undefined ? {} : { end: graphTime(endMs) }),
          singleValueExtendedProperties: [
            { id: propertyId('kitUpd'), value: `${requestHash}:${changeHash}` },
          ],
        }
        const answer = await api(connection, 'PATCH', eventUrl(eventId), body, overall)
        if (answer.status !== 200) {
          throw failure(answer, notFound)
        }
        return eventRef(answer.json, answer.status)
      })
    },

    async deleteEvent(request: CalendarDeleteRequest, callOptions) {
      const connection = checkBase(request)
      const eventId = checkEventId(request.eventId)
      checkRequestId(request.requestId)
      let attempts = 0
      return call('delete', request.organizationId, callOptions, async (overall) => {
        attempts++
        // Deleting a meeting the Rep organises sends the cancellation to its attendees.
        const answer = await api(connection, 'DELETE', eventUrl(eventId), undefined, overall)
        if (answer.status === 204 || answer.status === 200) {
          return { deleted: true }
        }
        if (answer.status === 404 || answer.status === 410) {
          // On a retry the event may have been removed by this very call (a lost response).
          return { deleted: attempts > 1 }
        }
        throw failure(answer)
      })
    },

    async revoke(request: CalendarRequestBase, callOptions) {
      const connection = checkBase(request)
      const key = tokenKey(connection.unsafeCredential())
      await call('revoke', request.organizationId, callOptions, async () => {
        // Nothing to revoke at Microsoft; only the cached access token is let go.
        tokens.delete(key)
        rotated.delete(key)
      })
    },
  }
}

function tooMany(): CalendarError {
  return new CalendarError(
    CALENDAR_ERROR_CODES.rejected,
    'The calendar has too many busy intervals',
    { details: { reason: 'too_many_intervals', max: MAX_BUSY_INTERVALS } }
  )
}
