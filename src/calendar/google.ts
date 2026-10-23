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

/** The least scopes the adapter needs: free/busy times and the events it writes. Ask for exactly these in the consent URL (with `access_type=offline`). */
export const GOOGLE_CALENDAR_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.events',
]

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const API = 'https://www.googleapis.com/calendar/v3'
const MAX_RESPONSE_BYTES = 2_097_152
const DEFAULT_ATTEMPT_TIMEOUT_MS = 5_000
const TOKEN_MARGIN_MS = 60_000
const MAX_CACHED_TOKENS = 1_024
const BASE32HEX = '0123456789abcdefghijklmnopqrstuv'
const RETRYABLE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'backendError'])

/** The HTTP client the adapter uses: `fetch`, injected for tests. */
export type GoogleCalendarFetch = (input: string, init: RequestInit) => Promise<Response>

/** Options for {@link createGoogleCalendar}. The kit takes options, not environment variables. */
export interface GoogleCalendarOptions {
  /** The OAuth client id of the Closeline Google Cloud project. */
  clientId: string
  /** The OAuth client secret. Never logged. */
  clientSecret: string
  /** The calendar read and written; the Rep's primary calendar by default. */
  calendarId?: string
  /** The HTTP client; the global `fetch` by default. For tests. */
  fetch?: GoogleCalendarFetch
  /** The time limit of one HTTP request, in ms, 1 to 60000; default 5000. The call's own deadline still applies. */
  attemptTimeoutMs?: number
  /** Receives the errors that mean Google failed; nothing if absent. */
  reporter?: ErrorReporter
  /** Where retries are noted (metadata only); nothing if absent. */
  logger?: Logger
  /** The time source for access-token expiry; the system clock by default. */
  clock?: Clock
  /** Pauses between retries; real time by default. */
  sleep?: Sleep
  /** A number in `[0, 1)` for the jitter; `Math.random` by default. */
  random?: () => number
}

type Json = Record<string, unknown>

interface Answer {
  status: number
  json: Json | null
}

function unavailable(phase: string, status?: number): CalendarError {
  return new CalendarError(
    CALENDAR_ERROR_CODES.unavailable,
    'The calendar provider is unavailable',
    {
      details: { phase, ...(status === undefined ? {} : { status }) },
    }
  )
}

function rejected(reason: string, status?: number): CalendarError {
  return new CalendarError(
    CALENDAR_ERROR_CODES.rejected,
    'The calendar provider refused the request',
    {
      details: { reason, ...(status === undefined ? {} : { status }) },
    }
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

function sha256(...parts: string[]): Buffer {
  return createHash('sha256').update(parts.join('\u0000')).digest()
}

/** Base32hex (`0-9a-v`) of the bytes, the alphabet Google allows in a client-chosen event id. */
function base32hex(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32HEX[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) {
    out += BASE32HEX[(value << (5 - bits)) & 31]
  }
  return out
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function googleReason(json: Json | null): string | undefined {
  const error = json?.error
  if (!isObject(error) || !Array.isArray(error.errors)) {
    return undefined
  }
  const first: unknown = error.errors[0]
  return isObject(first) &&
    typeof first.reason === 'string' &&
    /^[A-Za-z0-9_]{1,64}$/.test(first.reason)
    ? first.reason
    : undefined
}

function eventRef(json: Json | null, status: number): CalendarEventRef {
  const id = json?.id
  const start = isObject(json?.start) ? json.start.dateTime : undefined
  const end = isObject(json?.end) ? json.end.dateTime : undefined
  if (
    typeof id !== 'string' ||
    id.length < 1 ||
    id.length > 256 ||
    typeof start !== 'string' ||
    typeof end !== 'string' ||
    Number.isNaN(Date.parse(start)) ||
    Number.isNaN(Date.parse(end))
  ) {
    throw rejected('shape', status)
  }
  let joinUrl: string | undefined
  const link = json?.hangoutLink
  if (typeof link === 'string' && link.startsWith('https://')) {
    joinUrl = link
  } else if (isObject(json?.conferenceData) && Array.isArray(json.conferenceData.entryPoints)) {
    for (const point of json.conferenceData.entryPoints as unknown[]) {
      if (
        isObject(point) &&
        point.entryPointType === 'video' &&
        typeof point.uri === 'string' &&
        point.uri.startsWith('https://')
      ) {
        joinUrl = point.uri
        break
      }
    }
  }
  return {
    eventId: id,
    start: iso(Date.parse(start)),
    end: iso(Date.parse(end)),
    ...(joinUrl === undefined ? {} : { joinUrl }),
  }
}

function privateProperty(json: Json | null, key: string): string | undefined {
  const props = json?.extendedProperties
  const priv = isObject(props) ? props.private : undefined
  const value = isObject(priv) ? priv[key] : undefined
  return typeof value === 'string' ? value : undefined
}

function attendeesBody(attendees: readonly CalendarAttendee[]) {
  return attendees.map((a) => ({
    email: a.email,
    ...(a.name === undefined ? {} : { displayName: a.name }),
  }))
}

/**
 * Creates the {@link CalendarPort} on the Google Calendar REST API (v3) with OAuth 2.0.
 *
 * Scopes are the least that work ({@link GOOGLE_CALENDAR_SCOPES}): `calendar.freebusy` for busy
 * times (the Rep's event titles are never read) and `calendar.events` for the events it writes. The
 * credential of a {@link CalendarConnection} is the Rep's refresh token; access tokens are
 * short-lived, held in a bounded in-process cache and refreshed when they near expiry. A refresh
 * Google refuses with `invalid_grant` is `calendar.revoked`.
 *
 * Every HTTP request has its own time limit and each call an overall deadline that aborts the
 * request; a network error, 429, 5xx and Google's rate-limit 403s are retried a bounded number of
 * times with jitter, any other failure never, and `connect` never (a code is single-use). A write
 * is idempotent by request id: `createEvent` sends a client-chosen event id derived from the
 * connection and request id, and a duplicate (409) is read back and compared by a fingerprint kept
 * in the event's private extended properties; `updateEvent` keeps the last request id and
 * fingerprint the same way (a late replay of an older update is applied again, not recognised). Nothing is logged but retry metadata, and no token, title, note,
 * address or URL is put in an error, a log line or a report. Text Google returns is data.
 */
export function createGoogleCalendar(options: GoogleCalendarOptions): CalendarPort {
  if (typeof options.clientId !== 'string' || options.clientId.length < 1) {
    throw new TypeError('clientId is required')
  }
  if (typeof options.clientSecret !== 'string' || options.clientSecret.length < 1) {
    throw new TypeError('clientSecret is required')
  }
  const calendarId = options.calendarId ?? 'primary'
  if (typeof calendarId !== 'string' || calendarId.length < 1 || calendarId.length > 256) {
    throw new TypeError('calendarId is not acceptable')
  }
  const attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS
  if (!Number.isInteger(attemptTimeoutMs) || attemptTimeoutMs < 1 || attemptTimeoutMs > 60_000) {
    throw new TypeError('attemptTimeoutMs must be 1 to 60000')
  }
  const { clientId, clientSecret } = options
  const clock = options.clock ?? systemClock
  const sleep = options.sleep ?? systemSleep
  const doFetch: GoogleCalendarFetch = options.fetch ?? ((input, init) => fetch(input, init))
  const eventsUrl = `${API}/calendars/${encodeURIComponent(calendarId)}/events`
  const tokens = new Map<string, { accessToken: string; expiresAtMs: number }>()

  function tokenKey(credential: string): string {
    return sha256(credential).toString('hex')
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

  /** One HTTP request with its own time limit and a bounded body; failures are classified by `classify`. */
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
      return { status: response.status, json: parseJson(text) }
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
      TOKEN_URL,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          ...form,
        }).toString(),
      },
      overall
    )
  }

  /** Reads an OAuth token answer; `grantGone` is what `invalid_grant` means for the caller. */
  function tokenAnswer(answer: Answer, grantGone: () => CalendarError) {
    if (answer.status === 429 || answer.status >= 500) {
      throw unavailable('token', answer.status)
    }
    if (answer.status === 400 && answer.json?.error === 'invalid_grant') {
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
    const scope = answer.json?.scope
    if (typeof scope === 'string') {
      const granted = new Set(scope.split(' '))
      if (!GOOGLE_CALENDAR_SCOPES.every((required) => granted.has(required))) {
        throw rejected('scope', answer.status)
      }
    }
    const seconds =
      typeof expiresIn === 'number' && Number.isFinite(expiresIn)
        ? Math.min(Math.max(expiresIn, 0), 86_400)
        : 3_600
    return { accessToken, seconds, refreshToken: answer.json?.refresh_token }
  }

  async function accessToken(credential: string, overall: AbortSignal): Promise<string> {
    const cached = tokens.get(tokenKey(credential))
    if (cached !== undefined && cached.expiresAtMs > clock.now().getTime()) {
      return cached.accessToken
    }
    const answer = await tokenRequest(
      { grant_type: 'refresh_token', refresh_token: credential },
      overall
    )
    const read = tokenAnswer(answer, revoked)
    remember(credential, read.accessToken, read.seconds)
    return read.accessToken
  }

  /** An API request with the connection's access token; a 401 drops the cached token and tries once more. */
  async function api(
    connection: CalendarConnection,
    method: string,
    url: string,
    body: unknown,
    overall: AbortSignal
  ): Promise<Answer> {
    const credential = connection.unsafeCredential()
    for (let pass = 0; ; pass++) {
      const token = await accessToken(credential, overall)
      const answer = await http(
        url,
        {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        overall
      )
      if (answer.status === 401 && pass === 0) {
        tokens.delete(tokenKey(credential))
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
      return unavailable('http', status)
    }
    const reason = googleReason(answer.json)
    if (status === 403 && reason !== undefined && RETRYABLE_REASONS.has(reason)) {
      return unavailable('rate_limit', status)
    }
    return rejected(reason ?? 'http', status)
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
    return `${eventsUrl}/${encodeURIComponent(eventId)}${query}`
  }

  /** Reads an event; a missing or cancelled one is `missing`. */
  async function readEvent(
    connection: CalendarConnection,
    eventId: string,
    overall: AbortSignal,
    missing: CalendarError
  ): Promise<Json> {
    const answer = await api(connection, 'GET', eventUrl(eventId), undefined, overall)
    if (answer.status !== 200) {
      throw failure(answer, missing)
    }
    if (answer.json?.status === 'cancelled') {
      throw missing
    }
    return answer.json ?? {}
  }

  function fingerprint(value: unknown): string {
    return sha256(JSON.stringify(value)).toString('hex')
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
            const read = tokenAnswer(answer, () => rejected('invalid_grant', 400))
            remember(grant.refreshToken, read.accessToken, read.seconds)
            return grant.refreshToken
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
          const read = tokenAnswer(answer, () => rejected('invalid_grant', 400))
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
            provider: 'google',
            connectionId: `gcal_${randomUUID()}`,
            credential,
          })
      )
    },

    async busy(request: CalendarBusyRequest, callOptions) {
      const connection = checkBase(request)
      const { fromMs, toMs } = checkRange(request.from, request.to)
      return call('busy', request.organizationId, callOptions, async (overall) => {
        const answer = await api(
          connection,
          'POST',
          `${API}/freeBusy`,
          {
            timeMin: iso(fromMs),
            timeMax: iso(toMs),
            timeZone: 'UTC',
            items: [{ id: calendarId }],
          },
          overall
        )
        if (answer.status !== 200) {
          throw failure(answer, rejected('calendar_not_found', answer.status))
        }
        const calendars = answer.json?.calendars
        const entries = isObject(calendars) ? Object.values(calendars) : []
        const entry = entries.length === 1 ? entries[0] : undefined
        if (!isObject(entry) || !Array.isArray(entry.busy)) {
          throw rejected('shape', answer.status)
        }
        if (Array.isArray(entry.errors) && entry.errors.length > 0) {
          throw rejected('calendar_error', answer.status)
        }
        const blocks: { startMs: number; endMs: number }[] = []
        for (const item of entry.busy as unknown[]) {
          const start = isObject(item) ? Date.parse(String(item.start)) : Number.NaN
          const end = isObject(item) ? Date.parse(String(item.end)) : Number.NaN
          if (Number.isNaN(start) || Number.isNaN(end)) {
            throw rejected('shape', answer.status)
          }
          const clipped = { startMs: Math.max(start, fromMs), endMs: Math.min(end, toMs) }
          if (clipped.startMs < clipped.endMs) {
            blocks.push(clipped)
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
          throw new CalendarError(
            CALENDAR_ERROR_CODES.rejected,
            'The calendar has too many busy intervals',
            { details: { reason: 'too_many_intervals', max: MAX_BUSY_INTERVALS } }
          )
        }
        return merged.map<BusyInterval>((b) => ({ start: iso(b.startMs), end: iso(b.endMs) }))
      })
    },

    async createEvent(request: CalendarCreateRequest, callOptions): Promise<CalendarEventCreated> {
      const connection = checkBase(request)
      const requestId = checkRequestId(request.requestId)
      const { event, startMs, endMs } = checkEvent(request.event)
      const video = event.conferencing === 'video'
      const id = base32hex(sha256(connection.connectionId, requestId))
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
        id,
        summary: event.title,
        start: { dateTime: iso(startMs) },
        end: { dateTime: iso(endMs) },
        ...(event.description === undefined ? {} : { description: event.description }),
        ...(event.location === undefined ? {} : { location: event.location }),
        ...(event.attendees === undefined ? {} : { attendees: attendeesBody(event.attendees) }),
        extendedProperties: { private: { kitFp: fp } },
        ...(video
          ? {
              conferenceData: {
                createRequest: { requestId: id, conferenceSolutionKey: { type: 'hangoutsMeet' } },
              },
            }
          : {}),
      }
      const query = `?sendUpdates=all${video ? '&conferenceDataVersion=1' : ''}`
      return call('create', request.organizationId, callOptions, async (overall) => {
        const answer = await api(connection, 'POST', `${eventsUrl}${query}`, body, overall)
        if (answer.status === 200) {
          return { ...eventRef(answer.json, answer.status), created: true }
        }
        if (answer.status !== 409) {
          throw failure(answer)
        }
        // The id exists: this call's own earlier attempt (a lost response), or a replay.
        const existing = await readEvent(connection, id, overall, rejected('event_deleted'))
        if (privateProperty(existing, 'kitFp') !== fp) {
          invalid('requestId')
        }
        return { ...eventRef(existing, answer.status), created: false }
      })
    },

    async updateEvent(request: CalendarUpdateRequest, callOptions) {
      const connection = checkBase(request)
      const eventId = checkEventId(request.eventId)
      const requestId = checkRequestId(request.requestId)
      const changes: CalendarEventChanges = checkChanges(request.changes)
      const requestHash = base32hex(sha256(requestId))
      const changeHash = fingerprint(changes)
      const notFound = new CalendarError(CALENDAR_ERROR_CODES.notFound, 'The event does not exist')
      return call('update', request.organizationId, callOptions, async (overall) => {
        const existing = await readEvent(connection, eventId, overall, notFound)
        const last = privateProperty(existing, 'kitUpd')
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
          ...(changes.title === undefined ? {} : { summary: changes.title }),
          ...(changes.description === undefined ? {} : { description: changes.description }),
          ...(changes.location === undefined ? {} : { location: changes.location }),
          ...(changes.attendees === undefined
            ? {}
            : { attendees: attendeesBody(changes.attendees) }),
          ...(changes.start === undefined ? {} : { start: { dateTime: iso(startMs) } }),
          ...(changes.end === undefined ? {} : { end: { dateTime: iso(endMs) } }),
          extendedProperties: { private: { kitUpd: `${requestHash}:${changeHash}` } },
        }
        const answer = await api(
          connection,
          'PATCH',
          eventUrl(eventId, '?sendUpdates=all'),
          body,
          overall
        )
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
        const answer = await api(
          connection,
          'DELETE',
          eventUrl(eventId, '?sendUpdates=all'),
          undefined,
          overall
        )
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
      const credential = connection.unsafeCredential()
      await call('revoke', request.organizationId, callOptions, async (overall) => {
        const answer = await http(
          REVOKE_URL,
          {
            method: 'POST',
            headers: {
              accept: 'application/json',
              'content-type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({ token: credential }).toString(),
          },
          overall
        )
        tokens.delete(tokenKey(credential))
        // 400 invalid_token: the grant is already gone, which is what was asked for.
        if (
          answer.status === 200 ||
          (answer.status === 400 && answer.json?.error === 'invalid_token')
        ) {
          return
        }
        if (answer.status === 429 || answer.status >= 500) {
          throw unavailable('revoke', answer.status)
        }
        throw rejected('revoke', answer.status)
      })
    },
  }
}
