import { describe, expect, test } from 'bun:test'
import { organizationIdSchema } from 'tula-closeline-contract'
import { CALENDAR_ERROR_CODES, CalendarError } from './errors'
import { GOOGLE_CALENDAR_SCOPES } from './google'
import { CLIENT_SECRET, googleHarness, json } from './google.harness'

const org = organizationIdSchema.parse(`org_${'a'.repeat(32)}`)
const from = '2026-03-02T00:00:00.000Z'
const to = '2026-03-03T00:00:00.000Z'
const opts = { retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 4 } }

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
    return undefined
  } catch (error) {
    return error instanceof CalendarError ? error.code : `other: ${String(error)}`
  }
}

async function connected(extra = {}) {
  const h = googleHarness(extra)
  h.fake.allowRefresh('refresh-1')
  const connection = await h.port.connect(
    { organizationId: org, grant: { kind: 'refresh_token', refreshToken: 'refresh-1' } },
    opts
  )
  return { h, connection, base: { organizationId: org, connection } }
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>

/** A connected adapter whose fetch is `wrap(fake)`: the fake serves what `wrap` lets through. */
async function connectedVia(wrap: (real: Fetch) => Fetch) {
  const fake = googleHarness()
  const h = googleHarness({ fetch: wrap(fake.fake.fetch) })
  fake.fake.allowRefresh('refresh-1')
  const connection = await h.port.connect(
    { organizationId: org, grant: { kind: 'refresh_token', refreshToken: 'refresh-1' } },
    opts
  )
  return { h, fake, request: { organizationId: org, connection, from, to } }
}

describe('Google Calendar adapter', () => {
  test('asks for the least scopes: free/busy and the events it writes', () => {
    expect([...GOOGLE_CALENDAR_SCOPES]).toEqual([
      'https://www.googleapis.com/auth/calendar.freebusy',
      'https://www.googleapis.com/auth/calendar.events',
    ])
  })

  test('a code is exchanged with the client secret and the PKCE verifier; the refresh token is the credential', async () => {
    const h = googleHarness()
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
    expect(request?.url).toBe('https://oauth2.googleapis.com/token')
    expect(request?.form.get('grant_type')).toBe('authorization_code')
    expect(request?.form.get('code_verifier')).toBe('v'.repeat(50))
    expect(request?.form.get('redirect_uri')).toBe('https://app.example.test/cb')
    expect(request?.form.get('client_secret')).toBe(CLIENT_SECRET)
    expect(connection.provider).toBe('google')
    expect(connection.unsafeCredential()).toBe(refresh)
  })

  test('an answer without a refresh token is calendar.rejected', async () => {
    const h = googleHarness({
      fetch: async () => json(200, { access_token: 'a', expires_in: 3600 }),
    })
    const code = await codeOf(
      h.port.connect(
        {
          organizationId: org,
          grant: {
            kind: 'authorization_code',
            code: 'c',
            redirectUri: 'https://app.example.test/cb',
          },
        },
        opts
      )
    )
    expect(code).toBe(CALENDAR_ERROR_CODES.rejected)
  })

  test('a grant that lacks a required scope is calendar.rejected', async () => {
    const h = googleHarness({
      fetch: async () =>
        json(200, {
          access_token: 'a',
          refresh_token: 'r',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/calendar.freebusy',
        }),
    })
    expect(
      await codeOf(
        h.port.connect(
          {
            organizationId: org,
            grant: {
              kind: 'authorization_code',
              code: 'c',
              redirectUri: 'https://app.example.test/cb',
            },
          },
          opts
        )
      )
    ).toBe(CALENDAR_ERROR_CODES.rejected)
  })

  test('the access token is reused until it nears expiry, then refreshed', async () => {
    const { h, base } = await connected()
    const tokenCalls = () => h.fake.seen.filter((r) => r.url.endsWith('/token')).length
    expect(tokenCalls()).toBe(1)
    await h.port.busy({ ...base, from, to }, opts)
    await h.port.busy({ ...base, from, to }, opts)
    expect(tokenCalls()).toBe(1)
    h.clock.advance('59m')
    await h.port.busy({ ...base, from, to }, opts)
    expect(tokenCalls()).toBe(2)
  })

  test('a 401 drops the cached token and the call is retried once with a new one', async () => {
    let first = true
    const { h, fake, request } = await connectedVia((real) => async (input, init) => {
      if (first && input.includes('/freeBusy')) {
        first = false
        return json(401, { error: { code: 401 } })
      }
      return real(input, init)
    })
    expect(await h.port.busy(request, opts)).toEqual([])
    expect(fake.fake.seen.filter((r) => r.url.endsWith('/token')).length).toBe(2)
  })

  test('busy sends the range to the free/busy endpoint with a bearer token and no event titles', async () => {
    const { h, base } = await connected()
    await h.port.busy({ ...base, from, to }, opts)
    const request = h.fake.seen.at(-1)
    expect(request?.url).toBe('https://www.googleapis.com/calendar/v3/freeBusy')
    expect(request?.method).toBe('POST')
    expect(request?.headers.authorization).toMatch(/^Bearer access-/)
    expect(JSON.parse(request?.body ?? '{}')).toEqual({
      timeMin: from,
      timeMax: to,
      timeZone: 'UTC',
      items: [{ id: 'primary' }],
    })
  })

  test('create sends a client-chosen event id, notifies attendees and asks for a Meet link', async () => {
    const { h, base } = await connected()
    await h.port.createEvent(
      {
        ...base,
        requestId: 'req-1',
        event: {
          title: 'Call',
          start: '2026-03-02T10:00:00.000Z',
          end: '2026-03-02T10:30:00.000Z',
          attendees: [{ email: 'p@example.com', name: 'P' }],
          conferencing: 'video',
        },
      },
      opts
    )
    const request = h.fake.seen.at(-1)
    expect(request?.url).toContain('sendUpdates=all')
    expect(request?.url).toContain('conferenceDataVersion=1')
    const body = JSON.parse(request?.body ?? '{}')
    expect(body.id).toMatch(/^[a-v0-9]{20,}$/)
    expect(body.attendees).toEqual([{ email: 'p@example.com', displayName: 'P' }])
    expect(body.conferenceData.createRequest.conferenceSolutionKey.type).toBe('hangoutsMeet')
  })

  test('a cancelled event found by a duplicate id is calendar.rejected, not recreated', async () => {
    const { h, request } = await connectedVia((real) => async (input, init) => {
      if (init.method === 'POST' && input.includes('/events')) {
        return json(409, { error: { errors: [{ reason: 'duplicate' }] } })
      }
      if (init.method === 'GET' && input.includes('/events/')) {
        return json(200, { id: 'x', status: 'cancelled' })
      }
      return real(input, init)
    })
    const error = await h.port
      .createEvent(
        {
          organizationId: org,
          connection: request.connection,
          requestId: 'req-1',
          event: { title: 'T', start: '2026-03-02T10:00:00.000Z', end: '2026-03-02T10:30:00.000Z' },
        },
        opts
      )
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CalendarError)
    expect((error as CalendarError).code).toBe(CALENDAR_ERROR_CODES.rejected)
    expect((error as CalendarError).details).toMatchObject({ reason: 'event_deleted' })
  })

  test('a rate-limit 403 is retried, another 403 is not', async () => {
    let reason = 'rateLimitExceeded'
    let calls = 0
    const { h, request } = await connectedVia((real) => async (input, init) => {
      if (input.includes('/freeBusy')) {
        calls++
        return json(403, { error: { errors: [{ reason }] } })
      }
      return real(input, init)
    })
    expect(await codeOf(h.port.busy(request, opts))).toBe(CALENDAR_ERROR_CODES.unavailable)
    expect(calls).toBe(3)
    reason = 'forbidden'
    calls = 0
    expect(await codeOf(h.port.busy(request, opts))).toBe(CALENDAR_ERROR_CODES.rejected)
    expect(calls).toBe(1)
  })

  test('a response that is too large or not JSON is calendar.rejected and carries none of its text', async () => {
    let mode: 'big' | 'html' = 'big'
    const { h, request } = await connectedVia((real) => async (input, init) => {
      if (input.includes('/freeBusy')) {
        return mode === 'big'
          ? new Response('x'.repeat(3_000_000), { status: 200 })
          : new Response('<html>SECRET-BODY-MARKER</html>', { status: 200 })
      }
      return real(input, init)
    })
    expect(await codeOf(h.port.busy(request, opts))).toBe(CALENDAR_ERROR_CODES.rejected)
    mode = 'html'
    const error = await h.port.busy(request, opts).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CalendarError)
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error as object))).not.toContain(
      'SECRET-BODY-MARKER'
    )
  })

  test('the client secret and refresh token never reach a log, error or report', async () => {
    const { h, connection, base } = await connected()
    h.fake.failNext('retryable', 5)
    const error = await h.port.busy({ ...base, from, to }, opts).catch((e: unknown) => e)
    const seen = [
      ...h.logs,
      JSON.stringify(h.reporter.captured),
      JSON.stringify(error, Object.getOwnPropertyNames(error as object)),
    ].join('\n')
    expect(seen).not.toContain(CLIENT_SECRET)
    expect(seen).not.toContain(connection.unsafeCredential())
  })

  test('revoke posts the token to Google and forgets the cached access token', async () => {
    const { h, base } = await connected()
    await h.port.revoke(base, opts)
    const request = h.fake.seen.at(-1)
    expect(request?.url).toBe('https://oauth2.googleapis.com/revoke')
    expect(request?.form.get('token')).toBe('refresh-1')
    expect(await codeOf(h.port.busy({ ...base, from, to }, opts))).toBe(
      CALENDAR_ERROR_CODES.revoked
    )
  })

  test('options are checked at creation', () => {
    expect(() => googleHarness({ clientId: '' })).toThrow(TypeError)
    expect(() => googleHarness({ clientSecret: '' })).toThrow(TypeError)
    expect(() => googleHarness({ attemptTimeoutMs: 0 })).toThrow(TypeError)
    expect(() => googleHarness({ calendarId: '' })).toThrow(TypeError)
  })

  test('one slow request is cut by its own time limit and retried, within the call deadline', async () => {
    const h = googleHarness({
      attemptTimeoutMs: 20,
      fetch: async (_input, init) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    })
    const started = Date.now()
    const code = await codeOf(
      h.port.connect(
        { organizationId: org, grant: { kind: 'refresh_token', refreshToken: 'r' } },
        { timeoutMs: 5000, retry: opts.retry }
      )
    )
    expect(code).toBe(CALENDAR_ERROR_CODES.unavailable)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test('a reason text from Google that is long or free-form is not copied into the error', async () => {
    const { h, request } = await connectedVia((real) => async (input, init) => {
      if (input.includes('/freeBusy')) {
        return json(403, {
          error: { errors: [{ reason: 'mail bob@example.com now '.repeat(10) }] },
        })
      }
      return real(input, init)
    })
    const error = (await h.port.busy(request, opts).catch((e: unknown) => e)) as CalendarError
    expect(error.code).toBe(CALENDAR_ERROR_CODES.rejected)
    expect(JSON.stringify(error.details)).not.toContain('bob@example.com')
  })

  test('revoke succeeds on invalid_token but a different 400 is calendar.rejected', async () => {
    const { h, request } = await connectedVia((real) => async (input, init) => {
      if (input.includes('/revoke')) {
        return json(400, { error: 'invalid_request' })
      }
      return real(input, init)
    })
    expect(
      await codeOf(h.port.revoke({ organizationId: org, connection: request.connection }, opts))
    ).toBe(CALENDAR_ERROR_CODES.rejected)
  })

  test('a delete whose response was lost reports deleted:true on the retry', async () => {
    let dropped = false
    const { h, request } = await connectedVia((real) => async (input, init) => {
      const response = await real(input, init)
      if (init.method === 'DELETE' && !dropped) {
        dropped = true
        throw new TypeError('connection reset')
      }
      return response
    })
    const made = await h.port.createEvent(
      {
        organizationId: org,
        connection: request.connection,
        requestId: 'req-1',
        event: { title: 'T', start: '2026-03-02T10:00:00.000Z', end: '2026-03-02T10:30:00.000Z' },
      },
      opts
    )
    expect(
      await h.port.deleteEvent(
        {
          organizationId: org,
          connection: request.connection,
          eventId: made.eventId,
          requestId: 'del-1',
        },
        opts
      )
    ).toEqual({ deleted: true })
  })
})
