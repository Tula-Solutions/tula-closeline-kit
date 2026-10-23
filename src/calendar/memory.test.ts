import { describe, expect, test } from 'bun:test'
import { organizationIdSchema } from 'tula-closeline-contract'
import { CalendarConnection } from './connection'
import { CALENDAR_ERROR_CODES, CalendarError } from './errors'
import { createMemoryCalendar } from './memory'
import { calendarRetryDelayMs } from './port'

const org = organizationIdSchema.parse(`org_${'c'.repeat(32)}`)
const grant = { kind: 'refresh_token', refreshToken: 'tok' } as const
const opts = { retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 4 } }

describe('memory calendar', () => {
  test('a connection rebuilt from its stored credential keeps working', async () => {
    const calendar = createMemoryCalendar()
    calendar.allowGrant('tok')
    const first = await calendar.connect({ organizationId: org, grant }, opts)
    const restored = new CalendarConnection({
      organizationId: org,
      provider: first.provider,
      connectionId: first.connectionId,
      credential: first.unsafeCredential(),
    })
    expect(
      await calendar.busy(
        {
          organizationId: org,
          connection: restored,
          from: '2026-03-02T00:00:00Z',
          to: '2026-03-03T00:00:00Z',
        },
        opts
      )
    ).toEqual([])
  })

  test('a connection the adapter never issued is calendar.invalid_request', async () => {
    const calendar = createMemoryCalendar()
    const forged = new CalendarConnection({
      organizationId: org,
      provider: 'memory',
      connectionId: 'forged',
      credential: 'x',
    })
    const error = await calendar
      .busy(
        {
          organizationId: org,
          connection: forged,
          from: '2026-03-02T00:00:00Z',
          to: '2026-03-03T00:00:00Z',
        },
        opts
      )
      .catch((e) => e)
    expect(error).toBeInstanceOf(CalendarError)
    expect(error.code).toBe(CALENDAR_ERROR_CODES.invalidRequest)
  })

  test('a retry is logged with its number and pause only', async () => {
    const lines: string[] = []
    const logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (m: string, f?: Record<string, unknown>) => lines.push(JSON.stringify({ m, f })),
      error: () => undefined,
      child: () => logger,
    }
    const calendar = createMemoryCalendar({ logger })
    calendar.allowGrant('tok')
    calendar.failNext('calendar.unavailable', 1)
    await calendar.connect({ organizationId: org, grant }, opts)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '{}').f).toEqual({
      kind: 'connect',
      retry: 1,
      delayMs: expect.any(Number),
    })
  })

  test('the retry pause doubles, is capped and is jittered', () => {
    const policy = { maxRetries: 5, baseDelayMs: 100, maxDelayMs: 300 }
    expect(calendarRetryDelayMs(1, policy, () => 0.5)).toBe(100)
    expect(calendarRetryDelayMs(2, policy, () => 0.5)).toBe(200)
    expect(calendarRetryDelayMs(5, policy, () => 0.5)).toBe(300)
    expect(calendarRetryDelayMs(1, policy, () => 0)).toBe(50)
  })

  test('a connection needs a provider, an id and a credential', () => {
    expect(
      () =>
        new CalendarConnection({
          organizationId: org,
          provider: '',
          connectionId: 'a',
          credential: 'b',
        })
    ).toThrow(TypeError)
    expect(
      () =>
        new CalendarConnection({
          organizationId: org,
          provider: 'p',
          connectionId: 'a',
          credential: '',
        })
    ).toThrow(TypeError)
  })
})
