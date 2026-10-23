import { describe, expect, test } from 'bun:test'
import { organizationIdSchema } from 'tula-closeline-contract'
import { CALENDAR_ERROR_CODES, CalendarError } from './errors'
import { createOutlookCalendar, OUTLOOK_CALENDAR_SCOPES } from './outlook'
import { OUTLOOK_CLIENT_SECRET, outlookHarness, outlookJson } from './outlook.harness'

const org = organizationIdSchema.parse(`org_${'a'.repeat(32)}`)
const from = '2026-03-02T00:00:00.000Z'
const to = '2026-03-03T00:00:00.000Z'
const opts = { retry: { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 400 } }
const event = {
  title: 'Discovery call',
  start: '2026-03-02T10:00:00.000Z',
  end: '2026-03-02T10:30:00.000Z',
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
    return undefined
  } catch (error) {
    return error instanceof CalendarError ? error.code : `other: ${String(error)}`
  }
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>

/** A connected adapter whose fetch is `wrap(fake)`: the fake serves what `wrap` lets through. */
async function connectedVia(
  wrap: (real: Fetch) => Fetch = (real) => real,
  tick = '10s',
  extra: Parameters<typeof outlookHarness>[0] = {}
) {
  const fake = outlookHarness()
  // The wrapped fetch bypasses the harness' own clock tick, so tick both clocks here.
  const ticking: Fetch = async (input, init) => {
    try {
      return await fake.fake.fetch(input, init)
    } finally {
      fake.clock.advance(tick)
      h.clock.advance(tick)
    }
  }
  const h = outlookHarness({ ...extra, fetch: wrap(ticking) })
  fake.fake.allowRefresh('refresh-1')
  const connection = await h.port.connect(
    { organizationId: org, grant: { kind: 'refresh_token', refreshToken: 'refresh-1' } },
    opts
  )
  return { h, fake, base: { organizationId: org, connection } }
}

describe('Outlook calendar adapter', () => {
  test('asks for the least scopes: a refresh token and calendar read/write', () => {
    expect([...OUTLOOK_CALENDAR_SCOPES]).toEqual(['offline_access', 'Calendars.ReadWrite'])
  })

  test('a code is exchanged at the tenant token endpoint with the secret and the PKCE verifier', async () => {
    const h = outlookHarness({ tenant: 'contoso.example' })
    const refresh = h.fake.allowCode('the-code')
    const connection = await h.port.connect(
      {
        organizationId: org,
        grant: {
          kind: 'authorization_code',
          code: 'the-code',
          redirectUri: 'https://app.example.test/cb',
          codeVerifier: 'v'.repeat(50),
        },
      },
      opts
    )
    const request = h.fake.seen[0]
    expect(request?.url).toBe('https://login.microsoftonline.com/contoso.example/oauth2/v2.0/token')
    expect(request?.form.get('grant_type')).toBe('authorization_code')
    expect(request?.form.get('code_verifier')).toBe('v'.repeat(50))
    expect(request?.form.get('client_secret')).toBe(OUTLOOK_CLIENT_SECRET)
    expect(request?.form.get('scope')).toBe('offline_access Calendars.ReadWrite')
    expect(connection.provider).toBe('microsoft')
    expect(connection.unsafeCredential()).toBe(refresh)
  })

  test('options are validated', () => {
    const base = { clientId: 'a', clientSecret: 'b' }
    expect(() => createOutlookCalendar({ ...base, clientId: '' })).toThrow(TypeError)
    expect(() => createOutlookCalendar({ ...base, tenant: 'a/b' })).toThrow(TypeError)
    expect(() => createOutlookCalendar({ ...base, attemptTimeoutMs: 0 })).toThrow(TypeError)
  })

  test('a token answer without a refresh token, or without calendar write scope, is calendar.rejected', async () => {
    const grant = {
      kind: 'authorization_code' as const,
      code: 'c',
      redirectUri: 'https://app.example.test/cb',
    }
    const noRefresh = outlookHarness({
      fetch: async () => outlookJson(200, { access_token: 'a', expires_in: 3600 }),
    })
    expect(await codeOf(noRefresh.port.connect({ organizationId: org, grant }, opts))).toBe(
      CALENDAR_ERROR_CODES.rejected
    )
    const readOnly = outlookHarness({
      fetch: async () =>
        outlookJson(200, {
          access_token: 'a',
          refresh_token: 'r',
          expires_in: 3600,
          scope: 'Calendars.Read User.Read',
        }),
    })
    expect(await codeOf(readOnly.port.connect({ organizationId: org, grant }, opts))).toBe(
      CALENDAR_ERROR_CODES.rejected
    )
  })

  test('the access token is reused until it nears expiry, then refreshed', async () => {
    const { h, fake, base } = await connectedVia()
    const tokens = () => fake.fake.seen.filter((r) => r.url.endsWith('/token')).length
    await h.port.busy({ ...base, from, to }, opts)
    await h.port.busy({ ...base, from, to }, opts)
    expect(tokens()).toBe(1)
    h.clock.advance('59m')
    await h.port.busy({ ...base, from, to }, opts)
    expect(tokens()).toBe(2)
  })

  test('a 401 refreshes the token once and retries; a second 401 is calendar.revoked', async () => {
    let calls = 0
    const { h, fake, base } = await connectedVia((real) => async (input, init) => {
      if (input.includes('/calendarView') && calls++ === 0) {
        return outlookJson(401, { error: { code: 'InvalidAuthenticationToken' } })
      }
      return real(input, init)
    })
    expect(await h.port.busy({ ...base, from, to }, opts)).toEqual([])
    expect(fake.fake.seen.filter((r) => r.url.endsWith('/token')).length).toBe(2)

    const always = await connectedVia(
      (real) => async (input, init) =>
        input.includes('/calendarView')
          ? outlookJson(401, { error: { code: 'InvalidAuthenticationToken' } })
          : real(input, init)
    )
    const seen = always.fake.fake.seen.length
    expect(await codeOf(always.h.port.busy({ ...always.base, from, to }, opts))).toBe(
      CALENDAR_ERROR_CODES.revoked
    )
    // Not retried as unavailable: one token refresh and one more request.
    expect(always.fake.fake.seen.length - seen).toBeLessThanOrEqual(2)
  })

  test('invalid_grant at the token endpoint is calendar.revoked', async () => {
    const { h, fake, base } = await connectedVia()
    fake.fake.revokeAt('refresh-1')
    h.clock.advance('2h')
    expect(await codeOf(h.port.busy({ ...base, from, to }, opts))).toBe(
      CALENDAR_ERROR_CODES.revoked
    )
  })

  test('429 and 5xx are retried with jittered, bounded, doubling backoff, then calendar.unavailable', async () => {
    let calls = 0
    const { h, base } = await connectedVia((real) => async (input, init) => {
      if (input.includes('/calendarView')) {
        calls++
        return calls % 2 === 0
          ? outlookJson(503, { error: { code: 'ErrorServerBusy' } })
          : outlookJson(429, { error: { code: 'TooManyRequests' } })
      }
      return real(input, init)
    })
    expect(await codeOf(h.port.busy({ ...base, from, to }, opts))).toBe(
      CALENDAR_ERROR_CODES.unavailable
    )
    expect(calls).toBe(3)
    // random() is 0.5, so the jitter factor is 1: 100 ms, then 200 ms.
    expect(h.sleeps).toEqual([100, 200])
    expect(h.reporter.captured.length).toBeGreaterThan(0)
  })

  test('Graph throttling codes on other statuses are retryable; other 4xx are calendar.rejected', async () => {
    let calls = 0
    const throttled = await connectedVia((real) => async (input, init) => {
      if (input.includes('/calendarView')) {
        calls++
        return outlookJson(403, { error: { code: 'ApplicationThrottled' } })
      }
      return real(input, init)
    })
    expect(await codeOf(throttled.h.port.busy({ ...throttled.base, from, to }, opts))).toBe(
      CALENDAR_ERROR_CODES.unavailable
    )
    expect(calls).toBe(3)

    let denied = 0
    const refused = await connectedVia((real) => async (input, init) => {
      if (input.includes('/calendarView')) {
        denied++
        return outlookJson(403, { error: { code: 'ErrorAccessDenied' } })
      }
      return real(input, init)
    })
    expect(await codeOf(refused.h.port.busy({ ...refused.base, from, to }, opts))).toBe(
      CALENDAR_ERROR_CODES.rejected
    )
    expect(denied).toBe(1)
  })

  test('a request that outlives attemptTimeoutMs is aborted and retried, then calendar.unavailable', async () => {
    let hung = 0
    const fake = outlookHarness()
    fake.fake.allowRefresh('refresh-1')
    const h = outlookHarness({
      attemptTimeoutMs: 20,
      fetch: (input, init) => {
        if (input.includes('/calendarView')) {
          hung++
          return new Promise<Response>((_, reject) =>
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          )
        }
        return fake.fake.fetch(input, init)
      },
    })
    const connection = await h.port.connect(
      { organizationId: org, grant: { kind: 'refresh_token', refreshToken: 'refresh-1' } },
      opts
    )
    expect(await codeOf(h.port.busy({ organizationId: org, connection, from, to }, opts))).toBe(
      CALENDAR_ERROR_CODES.unavailable
    )
    expect(hung).toBe(3)
  })

  test('the whole call times out with calendar.timeout', async () => {
    const { h, base } = await connectedVia(
      (real) => (input, init) =>
        input.includes('/calendarView')
          ? new Promise<Response>((_, reject) =>
              init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
            )
          : real(input, init)
    )
    expect(await codeOf(h.port.busy({ ...base, from, to }, { ...opts, timeoutMs: 30 }))).toBe(
      CALENDAR_ERROR_CODES.timeout
    )
  })

  test('busy follows @odata.nextLink across pages, merges, ignores free time and cancelled events', async () => {
    const { h, fake, base } = await connectedVia()
    const refresh = 'refresh-1'
    const hour = (n: number) => new Date(Date.parse(from) + n * 3600_000).toISOString()
    for (const n of [1, 3, 5, 7, 9]) {
      fake.fake.addBusy(refresh, { start: hour(n), end: hour(n + 1) })
    }
    fake.fake.addBusy(refresh, { start: hour(2), end: hour(3) })
    fake.fake.addFree(refresh, { start: hour(12), end: hour(13) })
    const got = await h.port.busy({ ...base, from, to }, opts)
    expect(got).toEqual([
      { start: hour(1), end: hour(4) },
      { start: hour(5), end: hour(6) },
      { start: hour(7), end: hour(8) },
      { start: hour(9), end: hour(10) },
    ])
    const views = fake.fake.seen.filter((r) => r.url.includes('/calendarView'))
    expect(views.length).toBe(4) // seven events at two per page
    expect(views[0]?.url).toContain('$select=start,end,showAs,isCancelled')
    expect(views[0]?.headers.prefer).toBe('outlook.timezone="UTC"')
  })

  test('a nextLink that leaves Graph is refused and the access token is not sent to it', async () => {
    const urls: string[] = []
    const { h, base } = await connectedVia((real) => async (input, init) => {
      urls.push(input)
      if (input.includes('/calendarView')) {
        return outlookJson(200, { value: [], '@odata.nextLink': 'https://evil.example.test/x' })
      }
      return real(input, init)
    })
    expect(await codeOf(h.port.busy({ ...base, from, to }, opts))).toBe(
      CALENDAR_ERROR_CODES.rejected
    )
    expect(urls.some((u) => u.includes('evil.example.test'))).toBe(false)
  })

  test('endless pages are cut off as calendar.rejected, not followed forever', async () => {
    let pages = 0
    const { h, base } = await connectedVia((real) => async (input, init) => {
      if (input.includes('/calendarView')) {
        pages++
        return outlookJson(200, {
          value: [],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendar/calendarView?x=1',
        })
      }
      return real(input, init)
    })
    expect(await codeOf(h.port.busy({ ...base, from, to }, opts))).toBe(
      CALENDAR_ERROR_CODES.rejected
    )
    expect(pages).toBeLessThanOrEqual(50)
  })

  test('createEvent maps the event to Graph, with a transactionId, Teams for video and invitations by attendees', async () => {
    const { h, fake, base } = await connectedVia()
    const made = await h.port.createEvent(
      {
        ...base,
        requestId: 'req-1',
        event: {
          ...event,
          description: 'Dial 555',
          location: 'Room 1',
          attendees: [{ email: 'p@example.test', name: 'P Q' }],
          conferencing: 'video',
        },
      },
      opts
    )
    expect(made).toMatchObject({ created: true, start: event.start, end: event.end })
    expect(made.joinUrl?.startsWith('https://')).toBe(true)
    const post = fake.fake.seen.find((r) => r.method === 'POST' && r.url.endsWith('/events'))
    const body = JSON.parse(post?.body ?? '{}')
    expect(body).toMatchObject({
      subject: 'Discovery call',
      start: { dateTime: '2026-03-02T10:00:00.000', timeZone: 'UTC' },
      end: { dateTime: '2026-03-02T10:30:00.000', timeZone: 'UTC' },
      body: { contentType: 'text', content: 'Dial 555' },
      location: { displayName: 'Room 1' },
      attendees: [{ emailAddress: { address: 'p@example.test', name: 'P Q' }, type: 'required' }],
      isOnlineMeeting: true,
      onlineMeetingProvider: 'teamsForBusiness',
    })
    expect(body.transactionId).toMatch(/^[0-9a-f]{64}$/)
  })

  test('the transactionId is stable per connection and request id and differs between them', async () => {
    const { h, fake, base } = await connectedVia()
    const ids = async (requestId: string, start = event.start, end = event.end) => {
      await codeOf(
        h.port.createEvent({ ...base, requestId, event: { ...event, start, end } }, opts)
      )
      const posts = fake.fake.seen.filter((r) => r.method === 'POST' && r.url.endsWith('/events'))
      return JSON.parse(posts.at(-1)?.body ?? '{}').transactionId as string
    }
    const a = await ids('req-a')
    const again = await ids('req-a')
    const b = await ids('req-b')
    expect(again).toBe(a)
    expect(b).not.toBe(a)
  })

  test('a repeated create returns the same event with created false; a different event under the id is refused', async () => {
    const { h, base } = await connectedVia()
    const first = await h.port.createEvent({ ...base, requestId: 'req-1', event }, opts)
    const again = await h.port.createEvent({ ...base, requestId: 'req-1', event }, opts)
    expect(again).toMatchObject({ eventId: first.eventId, created: false })
    expect(
      await codeOf(
        h.port.createEvent(
          { ...base, requestId: 'req-1', event: { ...event, description: 'other notes' } },
          opts
        )
      )
    ).toBe(CALENDAR_ERROR_CODES.invalidRequest)
  })

  test('a replay inside the skew window with a different event is calendar.invalid_request', async () => {
    const { h, base } = await connectedVia(undefined, '1s')
    await h.port.createEvent({ ...base, requestId: 'req-1', event }, opts)
    expect(
      await codeOf(
        h.port.createEvent(
          { ...base, requestId: 'req-1', event: { ...event, title: 'Another meeting' } },
          opts
        )
      )
    ).toBe(CALENDAR_ERROR_CODES.invalidRequest)
  })

  test('a lost create response is retried with the same transactionId and makes one event', async () => {
    const { h, fake, base } = await connectedVia()
    fake.fake.loseNext(1)
    const made = await h.port.createEvent({ ...base, requestId: 'req-1', event }, opts)
    expect(fake.fake.eventCount('refresh-1')).toBe(1)
    expect(made.eventId.length).toBeGreaterThan(0)
    const posts = fake.fake.seen.filter((r) => r.method === 'POST' && r.url.endsWith('/events'))
    expect(posts.length).toBe(2)
    expect(JSON.parse(posts[0]?.body ?? '{}').transactionId).toBe(
      JSON.parse(posts[1]?.body ?? '{}').transactionId
    )
  })

  test('updateEvent patches only what changed and a replay of its request id changes nothing more', async () => {
    const { h, fake, base } = await connectedVia()
    const made = await h.port.createEvent({ ...base, requestId: 'req-1', event }, opts)
    const update = {
      ...base,
      eventId: made.eventId,
      requestId: 'req-2',
      changes: { start: '2026-03-02T11:00:00.000Z', end: '2026-03-02T11:30:00.000Z' },
    }
    const moved = await h.port.updateEvent(update, opts)
    expect(moved.start).toBe('2026-03-02T11:00:00.000Z')
    const patches = () => fake.fake.seen.filter((r) => r.method === 'PATCH')
    expect(JSON.parse(patches()[0]?.body ?? '{}').subject).toBeUndefined()
    await h.port.updateEvent(update, opts)
    expect(patches().length).toBe(1)
    expect(await codeOf(h.port.updateEvent({ ...update, changes: { title: 'other' } }, opts))).toBe(
      CALENDAR_ERROR_CODES.invalidRequest
    )
  })

  test('a missing event is calendar.not_found on update and deleted false on delete', async () => {
    const { h, base } = await connectedVia()
    expect(
      await codeOf(
        h.port.updateEvent(
          { ...base, eventId: 'gone', requestId: 'req-1', changes: { title: 'x' } },
          opts
        )
      )
    ).toBe(CALENDAR_ERROR_CODES.notFound)
    expect(
      await h.port.deleteEvent({ ...base, eventId: 'gone', requestId: 'req-2' }, opts)
    ).toEqual({
      deleted: false,
    })
  })

  test('revoke validates and calls nothing: it keeps no revoked state and core deletes the credential', async () => {
    const { h, fake, base } = await connectedVia()
    const before = fake.fake.seen.length
    await h.port.revoke(base, opts)
    await h.port.revoke(base, opts)
    expect(fake.fake.seen.length).toBe(before)
    expect(await h.port.busy({ ...base, from, to }, opts)).toEqual([])
    expect(await codeOf(h.port.revoke({ ...base, organizationId: 'org_x' as never }, opts))).toBe(
      CALENDAR_ERROR_CODES.invalidRequest
    )
  })

  test('a rotated refresh token is handed to onCredentialRotated and used by the next refresh', async () => {
    const rotatedTo: string[] = []
    const { h, fake, base } = await connectedVia(undefined, '10s', {
      onCredentialRotated: (_connection, credential) => {
        rotatedTo.push(credential)
      },
    })
    fake.fake.rotateRefresh()
    h.clock.advance('2h')
    await h.port.busy({ ...base, from, to }, opts)
    expect(rotatedTo.length).toBe(1)
    expect(rotatedTo[0]).not.toBe('refresh-1')
    h.clock.advance('2h')
    // The old token no longer works at the fake, so this only succeeds on the rotated one.
    await h.port.busy({ ...base, from, to }, opts)
    expect(rotatedTo.length).toBe(2)
    const refreshes = fake.fake.seen.filter((r) => r.form.get('grant_type') === 'refresh_token')
    expect(refreshes.at(-1)?.form.get('refresh_token')).toBe(rotatedTo[0])
    expect(JSON.stringify(h.logs)).not.toContain(rotatedTo[0] ?? 'x')
  })

  test('a throwing onCredentialRotated does not fail the call', async () => {
    const { h, fake, base } = await connectedVia(undefined, '10s', {
      onCredentialRotated: () => {
        throw new Error('db down')
      },
    })
    fake.fake.rotateRefresh()
    h.clock.advance('2h')
    expect(await h.port.busy({ ...base, from, to }, opts)).toEqual([])
  })

  test('Retry-After in seconds or as an HTTP date replaces the backoff, capped at a minute', async () => {
    const pause = async (header: string) => {
      const { h, fake, base } = await connectedVia()
      fake.fake.retryAfterNext(header)
      fake.fake.failNext('retryable', 1)
      await h.port.busy({ ...base, from, to }, opts)
      return h.sleeps[0]
    }
    expect(await pause('3')).toBe(3000)
    expect(await pause('86400')).toBe(60_000)
    expect(await pause('garbage')).toBe(100) // falls back to the jittered backoff
    const { h, fake, base } = await connectedVia()
    const inSeven = new Date(h.clock.now().getTime() + 7_000 + 10_000).toUTCString()
    fake.fake.retryAfterNext(inSeven)
    fake.fake.failNext('retryable', 1)
    await h.port.busy({ ...base, from, to }, opts)
    expect(h.sleeps[0]).toBeGreaterThanOrEqual(6000)
    expect(h.sleeps[0]).toBeLessThanOrEqual(7000)
  })

  test('Retry-After does not lift the retry limit or the deadline', async () => {
    const { h, fake, base } = await connectedVia()
    fake.fake.retryAfterNext('1')
    fake.fake.failNext('retryable', 5)
    expect(await codeOf(h.port.busy({ ...base, from, to }, opts))).toBe(
      CALENDAR_ERROR_CODES.unavailable
    )
    expect(h.sleeps.length).toBe(2)
  })

  test('a response over the size limit is calendar.rejected', async () => {
    const { h, base } = await connectedVia(
      (real) => async (input, init) =>
        input.includes('/calendarView')
          ? new Response('x'.repeat(2_200_000), { status: 200 })
          : real(input, init)
    )
    expect(await codeOf(h.port.busy({ ...base, from, to }, opts))).toBe(
      CALENDAR_ERROR_CODES.rejected
    )
  })
})
