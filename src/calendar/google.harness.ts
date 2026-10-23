import { createHash, randomUUID } from 'node:crypto'
import { createFixedClock } from '../clock'
import { createMemoryErrorReporter } from '../reporting/testing'
import { createGoogleCalendar, type GoogleCalendarOptions } from './google'
import type { BusyInterval } from './port'

/** Test-only: a stateful fake of Google's OAuth and Calendar endpoints behind a stubbed `fetch`. */
export const CLIENT_ID = 'client-id-test.apps.example.test'
/** Test-only client secret. */
export const CLIENT_SECRET = 'CLIENT-SECRET-MARKER-0123'

/** What the fake saw of one request. */
export interface Seen {
  url: string
  method: string
  headers: Record<string, string>
  body: string
  form: URLSearchParams
  aborted: boolean
}

interface FakeEvent {
  id: string
  status: 'confirmed' | 'cancelled'
  json: Record<string, unknown>
}

interface Account {
  refreshToken: string
  revoked: boolean
  events: Map<string, FakeEvent>
  busy: BusyInterval[]
}

/** A JSON response. */
export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function googleError(status: number, reason: string): Response {
  return json(status, { error: { code: status, errors: [{ reason }], message: 'text' } })
}

function deepMerge(into: Record<string, unknown>, from: Record<string, unknown>) {
  for (const [key, value] of Object.entries(from)) {
    const current = into[key]
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      typeof current === 'object' &&
      current !== null &&
      !Array.isArray(current)
    ) {
      deepMerge(current as Record<string, unknown>, value as Record<string, unknown>)
    } else {
      into[key] = value
    }
  }
}

/** The fake Google, a `fetch` for the adapter, and the knobs the behaviour suite turns. */
export function fakeGoogle() {
  const accounts = new Map<string, Account>()
  const allowedCodes = new Map<string, string>()
  const accessTokens = new Map<string, string>()
  const seen: Seen[] = []
  const failures: ('retryable' | 'fatal')[] = []
  let lose = 0
  let hang = false
  let tokenCounter = 0
  const scope =
    'https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/calendar.events'

  function account(refreshToken: string): Account {
    let found = accounts.get(refreshToken)
    if (found === undefined) {
      found = { refreshToken, revoked: false, events: new Map(), busy: [] }
      accounts.set(refreshToken, found)
    }
    return found
  }

  function issue(refreshToken: string): string {
    const token = `access-${++tokenCounter}`
    accessTokens.set(token, refreshToken)
    return token
  }

  function token(form: URLSearchParams): Response {
    if (form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== CLIENT_SECRET) {
      return json(401, { error: 'invalid_client' })
    }
    if (form.get('grant_type') === 'authorization_code') {
      const refresh = allowedCodes.get(form.get('code') ?? '')
      if (refresh === undefined) {
        return json(400, { error: 'invalid_grant' })
      }
      allowedCodes.delete(form.get('code') ?? '')
      account(refresh)
      return json(200, {
        access_token: issue(refresh),
        refresh_token: refresh,
        expires_in: 3599,
        scope,
        token_type: 'Bearer',
      })
    }
    const refresh = form.get('refresh_token') ?? ''
    const found = accounts.get(refresh)
    if (found === undefined || found.revoked) {
      return json(400, { error: 'invalid_grant' })
    }
    return json(200, {
      access_token: issue(refresh),
      expires_in: 3599,
      scope,
      token_type: 'Bearer',
    })
  }

  function api(record: Seen): Response {
    const bearer = (record.headers.authorization ?? '').replace(/^Bearer /, '')
    const refresh = accessTokens.get(bearer)
    const owner = refresh === undefined ? undefined : accounts.get(refresh)
    if (owner === undefined || owner.revoked) {
      return json(401, { error: { code: 401, errors: [{ reason: 'authError' }] } })
    }
    const url = new URL(record.url)
    const body = record.body === '' ? {} : (JSON.parse(record.body) as Record<string, unknown>)
    if (url.pathname === '/calendar/v3/freeBusy') {
      const from = Date.parse(String(body.timeMin))
      const to = Date.parse(String(body.timeMax))
      const events = [...owner.events.values()]
        .filter((e) => e.status === 'confirmed')
        .map((e) => ({
          start: String((e.json.start as { dateTime: string }).dateTime),
          end: String((e.json.end as { dateTime: string }).dateTime),
        }))
      const busy = [...owner.busy, ...events]
        .filter((b) => Date.parse(b.end) > from && Date.parse(b.start) < to)
        .reverse()
      return json(200, { calendars: { primary: { busy } } })
    }
    const match = /^\/calendar\/v3\/calendars\/[^/]+\/events(?:\/([^/]+))?$/.exec(url.pathname)
    if (match === null) {
      return googleError(404, 'notFound')
    }
    const id = match[1] === undefined ? undefined : decodeURIComponent(match[1])
    if (record.method === 'POST' && id === undefined) {
      const newId = String(body.id)
      if (!/^[a-v0-9]{5,1024}$/.test(newId)) {
        return googleError(400, 'invalid')
      }
      if (owner.events.has(newId)) {
        return googleError(409, 'duplicate')
      }
      const stored: Record<string, unknown> = { ...body, status: 'confirmed' }
      if (
        body.conferenceData !== undefined &&
        url.searchParams.get('conferenceDataVersion') === '1'
      ) {
        stored.hangoutLink = `https://meet.example.test/${newId.slice(0, 10)}`
        stored.conferenceData = {
          entryPoints: [{ entryPointType: 'video', uri: stored.hangoutLink }],
        }
      } else {
        stored.conferenceData = undefined
      }
      owner.events.set(newId, { id: newId, status: 'confirmed', json: stored })
      return json(200, stored)
    }
    const event = id === undefined ? undefined : owner.events.get(id)
    if (record.method === 'GET') {
      return event === undefined
        ? googleError(404, 'notFound')
        : json(200, { ...event.json, status: event.status })
    }
    if (record.method === 'PATCH') {
      if (event === undefined || event.status === 'cancelled') {
        return googleError(event === undefined ? 404 : 410, 'deleted')
      }
      deepMerge(event.json, body)
      return json(200, event.json)
    }
    if (record.method === 'DELETE') {
      if (event === undefined) {
        return googleError(404, 'notFound')
      }
      if (event.status === 'cancelled') {
        return googleError(410, 'deleted')
      }
      owner.events.delete(event.id)
      return new Response(null, { status: 204 })
    }
    return googleError(405, 'notAllowed')
  }

  const fetchStub = async (input: string, init: RequestInit): Promise<Response> => {
    const form = new URLSearchParams(typeof init.body === 'string' ? init.body : '')
    const record: Seen = {
      url: input,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? init.body : '',
      form,
      aborted: false,
    }
    seen.push(record)
    let done = false
    init.signal?.addEventListener('abort', () => {
      if (!done) {
        record.aborted = true
      }
    })
    try {
      if (hang) {
        hang = false
        return await new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
      }
      const failure = failures.shift()
      if (failure === 'retryable') {
        return googleError(503, 'backendError')
      }
      if (failure === 'fatal') {
        return googleError(403, 'forbidden')
      }
      const url = new URL(input)
      if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') {
        return token(form)
      }
      if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/revoke') {
        const target = form.get('token') ?? ''
        const found = accounts.get(target)
        if (found === undefined || found.revoked) {
          return json(400, { error: 'invalid_token' })
        }
        found.revoked = true
        return json(200, {})
      }
      const response = api(record)
      if (lose > 0 && record.headers.authorization !== undefined) {
        lose--
        throw new TypeError('connection reset')
      }
      return response
    } finally {
      done = true
    }
  }

  return {
    fetch: fetchStub,
    seen,
    scope,
    allowCode(code: string): string {
      const refresh = `refresh-${createHash('sha256').update(code).digest('hex').slice(0, 24)}`
      allowedCodes.set(code, refresh)
      return refresh
    },
    allowRefresh(refresh: string) {
      account(refresh)
    },
    revokeAt(refresh: string) {
      const found = accounts.get(refresh)
      if (found !== undefined) {
        found.revoked = true
      }
    },
    addBusy(refresh: string, interval: BusyInterval) {
      account(refresh).busy.push(interval)
    },
    failNext(kind: 'retryable' | 'fatal', times: number) {
      for (let i = 0; i < times; i++) {
        failures.push(kind)
      }
    },
    loseNext(times: number) {
      lose += times
    },
    hangNext() {
      hang = true
    },
    eventCount(refresh: string): number {
      return account(refresh).events.size
    },
  }
}

/** Builds the adapter over a fake Google. */
export function googleHarness(extra: Partial<GoogleCalendarOptions> = {}) {
  const fake = fakeGoogle()
  const sleeps: number[] = []
  const logs: string[] = []
  const logger = {
    debug: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    info: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    warn: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    error: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    child: () => logger,
  }
  const reporter = createMemoryErrorReporter()
  const clock = createFixedClock('2026-03-01T00:00:00.000Z')
  const port = createGoogleCalendar({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    reporter,
    logger,
    clock,
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    fetch: fake.fetch,
    ...extra,
  })
  return { port, fake, reporter, logs, sleeps, clock, unique: () => randomUUID() }
}
