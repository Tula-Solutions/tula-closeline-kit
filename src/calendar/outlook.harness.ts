import { createHash, randomUUID } from 'node:crypto'
import { createFixedClock } from '../clock'
import { createMemoryErrorReporter } from '../reporting/testing'
import { createOutlookCalendar, type OutlookCalendarOptions } from './outlook'
import type { BusyInterval } from './port'

/** Test-only OAuth client id. */
export const OUTLOOK_CLIENT_ID = '00000000-0000-4000-8000-0000000000aa'
/** Test-only client secret. */
export const OUTLOOK_CLIENT_SECRET = 'CLIENT-SECRET-MARKER-0123'

/** What the fake saw of one request. */
export interface OutlookSeen {
  url: string
  method: string
  headers: Record<string, string>
  body: string
  form: URLSearchParams
  aborted: boolean
}

interface FakeEvent {
  id: string
  transactionId: string | undefined
  json: Record<string, unknown>
  properties: Map<string, string>
}

interface Account {
  refreshToken: string
  revoked: boolean
  events: Map<string, FakeEvent>
  busy: BusyInterval[]
  free: BusyInterval[]
}

/** A JSON response. */
export function outlookJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function graphError(status: number, code: string): Response {
  return outlookJson(status, { error: { code, message: 'text' } })
}

function graphTime(iso: string) {
  return { dateTime: `${iso.slice(0, -1)}0000`, timeZone: 'UTC' }
}

/** The Graph start/end object a request body names, as Graph answers it (UTC, seven fraction digits). */
function normaliseTime(value: unknown): unknown {
  const v = value as { dateTime: string }
  return { dateTime: `${v.dateTime}0000`, timeZone: 'UTC' }
}

const PAGE = 2

/** The fake Microsoft identity platform and Graph, a `fetch` for the adapter, and the knobs the behaviour suite turns. */
export function fakeOutlook(now: () => Date = () => new Date()) {
  const accounts = new Map<string, Account>()
  const allowedCodes = new Map<string, string>()
  const accessTokens = new Map<string, string>()
  const seen: OutlookSeen[] = []
  const failures: ('retryable' | 'fatal')[] = []
  let lose = 0
  let rotate = false
  let retryAfter: string | undefined
  let hang = false
  let tokenCounter = 0
  let eventCounter = 0
  const scope = 'Calendars.ReadWrite User.Read profile openid email'

  function account(refreshToken: string): Account {
    let found = accounts.get(refreshToken)
    if (found === undefined) {
      found = { refreshToken, revoked: false, events: new Map(), busy: [], free: [] }
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
    if (
      form.get('client_id') !== OUTLOOK_CLIENT_ID ||
      form.get('client_secret') !== OUTLOOK_CLIENT_SECRET
    ) {
      return outlookJson(401, { error: 'invalid_client' })
    }
    if (form.get('grant_type') === 'authorization_code') {
      const refresh = allowedCodes.get(form.get('code') ?? '')
      if (refresh === undefined) {
        return outlookJson(400, { error: 'invalid_grant' })
      }
      allowedCodes.delete(form.get('code') ?? '')
      account(refresh)
      return outlookJson(200, {
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
      return outlookJson(400, { error: 'invalid_grant' })
    }
    if (rotate) {
      // Like Microsoft: a new refresh token with every refresh, the old one no longer good.
      const next = `${refresh.split('~')[0]}~${++tokenCounter}`
      accounts.delete(refresh)
      accounts.set(next, found)
      return outlookJson(200, {
        access_token: issue(next),
        refresh_token: next,
        expires_in: 3599,
        scope,
        token_type: 'Bearer',
      })
    }
    return outlookJson(200, {
      access_token: issue(refresh),
      expires_in: 3599,
      scope,
      token_type: 'Bearer',
    })
  }

  function shown(event: FakeEvent, names: string[] | undefined): Record<string, unknown> {
    const out: Record<string, unknown> = { ...event.json, id: event.id }
    if (names !== undefined) {
      out.singleValueExtendedProperties = [...event.properties]
        .filter(([id]) => names.some((n) => id.endsWith(` Name ${n}`)))
        .map(([id, value]) => ({ id, value }))
    }
    return out
  }

  function expandedNames(url: URL): string[] | undefined {
    const expand = url.searchParams.get('$expand')
    if (expand === null) {
      return undefined
    }
    return [...expand.matchAll(/ Name (\w+)'/g)].map((m) => m[1] as string)
  }

  function api(record: OutlookSeen): Response {
    const bearer = (record.headers.authorization ?? '').replace(/^Bearer /, '')
    const refresh = accessTokens.get(bearer)
    const owner = refresh === undefined ? undefined : accounts.get(refresh)
    if (owner === undefined || owner.revoked) {
      return outlookJson(401, { error: { code: 'InvalidAuthenticationToken' } })
    }
    const url = new URL(record.url)
    const body = record.body === '' ? {} : (JSON.parse(record.body) as Record<string, unknown>)
    const path = url.pathname.replace('/v1.0', '')
    if (/^\/me\/calendars?(?:\/[^/]+)?\/calendarView$/.test(path) && record.method === 'GET') {
      const from = Date.parse(url.searchParams.get('startDateTime') ?? '')
      const to = Date.parse(url.searchParams.get('endDateTime') ?? '')
      const all = [
        ...owner.busy.map((b) => ({ start: b.start, end: b.end, showAs: 'busy' })),
        ...[...owner.events.values()].map((e) => ({
          start: `${(e.json.start as { dateTime: string }).dateTime.slice(0, 23)}Z`,
          end: `${(e.json.end as { dateTime: string }).dateTime.slice(0, 23)}Z`,
          showAs: 'busy',
        })),
        ...owner.free.map((b) => ({ ...b, showAs: 'free' })),
      ]
        .filter((b) => Date.parse(b.end) > from && Date.parse(b.start) < to)
        .reverse()
      const skip = Number(url.searchParams.get('$skip') ?? '0')
      const slice = all.slice(skip, skip + PAGE)
      const next = new URL(record.url)
      next.searchParams.set('$skip', String(skip + PAGE))
      return outlookJson(200, {
        value: slice.map((b) => ({
          start: graphTime(new Date(b.start).toISOString()),
          end: graphTime(new Date(b.end).toISOString()),
          showAs: b.showAs,
          isCancelled: false,
        })),
        ...(skip + PAGE < all.length ? { '@odata.nextLink': next.toString() } : {}),
      })
    }
    const list = /^\/me\/calendars?(?:\/[^/]+)?\/events$/.exec(path)
    if (list !== null && record.method === 'GET') {
      const wanted = /ep\/value eq '([^']*)'/.exec(url.searchParams.get('$filter') ?? '')?.[1]
      const names = expandedNames(url)
      const value = [...owner.events.values()]
        .filter((e) => [...e.properties.values()].includes(wanted ?? '\u0000'))
        .map((e) => shown(e, names))
      return outlookJson(200, { value })
    }
    if (list !== null && record.method === 'POST') {
      const transactionId = typeof body.transactionId === 'string' ? body.transactionId : undefined
      const same =
        transactionId === undefined
          ? undefined
          : [...owner.events.values()].find((e) => e.transactionId === transactionId)
      if (same !== undefined) {
        return outlookJson(201, shown(same, undefined))
      }
      const id = `AAMkAGI2-${++eventCounter}-${randomUUID()}`
      const stored: Record<string, unknown> = {
        subject: body.subject,
        start: normaliseTime(body.start),
        end: normaliseTime(body.end),
        isCancelled: false,
        createdDateTime: now().toISOString(),
      }
      if (body.isOnlineMeeting === true) {
        stored.onlineMeeting = {
          joinUrl: `https://teams.example.test/l/meetup-join/${eventCounter}`,
        }
      }
      const properties = new Map<string, string>()
      for (const p of (body.singleValueExtendedProperties ?? []) as {
        id: string
        value: string
      }[]) {
        properties.set(p.id, p.value)
      }
      const event = { id, transactionId, json: stored, properties }
      owner.events.set(id, event)
      return outlookJson(201, shown(event, undefined))
    }
    const one = /^\/me\/events\/([^/]+)$/.exec(path)
    const id = one?.[1] === undefined ? undefined : decodeURIComponent(one[1])
    const event = id === undefined ? undefined : owner.events.get(id)
    if (one === null) {
      return graphError(404, 'ErrorInvalidUrl')
    }
    if (record.method === 'GET') {
      return event === undefined
        ? graphError(404, 'ErrorItemNotFound')
        : outlookJson(200, shown(event, expandedNames(url)))
    }
    if (record.method === 'PATCH') {
      if (event === undefined) {
        return graphError(404, 'ErrorItemNotFound')
      }
      for (const key of ['subject', 'location', 'attendees', 'body']) {
        if (body[key] !== undefined) {
          event.json[key] = body[key]
        }
      }
      for (const key of ['start', 'end']) {
        if (body[key] !== undefined) {
          event.json[key] = normaliseTime(body[key])
        }
      }
      for (const p of (body.singleValueExtendedProperties ?? []) as {
        id: string
        value: string
      }[]) {
        event.properties.set(p.id, p.value)
      }
      return outlookJson(200, shown(event, undefined))
    }
    if (record.method === 'DELETE') {
      if (event === undefined) {
        return graphError(404, 'ErrorItemNotFound')
      }
      owner.events.delete(event.id)
      return new Response(null, { status: 204 })
    }
    return graphError(405, 'notAllowed')
  }

  const fetchStub = async (input: string, init: RequestInit): Promise<Response> => {
    const form = new URLSearchParams(typeof init.body === 'string' ? init.body : '')
    const record: OutlookSeen = {
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
        const limited = graphError(429, 'TooManyRequests')
        if (retryAfter !== undefined) {
          limited.headers.set('retry-after', retryAfter)
          retryAfter = undefined
        }
        return limited
      }
      if (failure === 'fatal') {
        return graphError(403, 'ErrorAccessDenied')
      }
      const url = new URL(input)
      if (url.hostname === 'login.microsoftonline.com' && url.pathname.endsWith('/token')) {
        return token(form)
      }
      const response = api(record)
      if (lose > 0 && record.headers.authorization !== undefined && record.method !== 'GET') {
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
    addFree(refresh: string, interval: BusyInterval) {
      account(refresh).free.push(interval)
    },
    failNext(kind: 'retryable' | 'fatal', times: number) {
      for (let i = 0; i < times; i++) {
        failures.push(kind)
      }
    },
    /** From now on every refresh returns a new refresh token and retires the old one. */
    rotateRefresh() {
      rotate = true
    },
    /** The next retryable failure carries this `Retry-After` header value. */
    retryAfterNext(value: string) {
      retryAfter = value
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

/** Builds the adapter over a fake Microsoft. */
export function outlookHarness(extra: Partial<OutlookCalendarOptions> = {}) {
  const clock = createFixedClock('2026-03-01T00:00:00.000Z')
  const fake = fakeOutlook(() => clock.now())
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
  const port = createOutlookCalendar({
    clientId: OUTLOOK_CLIENT_ID,
    clientSecret: OUTLOOK_CLIENT_SECRET,
    reporter,
    logger,
    clock,
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    // Time passes with every request, as it does for real, so a replay is later than the first call.
    fetch: async (input, init) => {
      try {
        return await fake.fetch(input, init)
      } finally {
        clock.advance('10s')
      }
    },
    ...extra,
  })
  return { port, fake, reporter, logs, sleeps, clock }
}
