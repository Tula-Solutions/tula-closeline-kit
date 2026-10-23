import { afterAll, describe, expect, test } from 'bun:test'
import { contactCheckRequestSchema, formatId } from 'tula-closeline-contract'
import { createMemoryLogger } from '../testing'
import { contactGuardBehaviour } from './behaviour'
import {
  CONTACT_GUARD_RETRY_DELAY_MS,
  CONTACT_GUARD_TIMEOUT_MS,
  createHttpContactGuard,
  type HttpContactGuard,
} from './http'
import { createMemoryContactGuard } from './memory'

const SECRET = 'sekret-marker-7f3a9c'
const EMAIL = 'pat.marker@example.com'
const org = formatId('org', 'a'.repeat(32))
const prospectId = formatId('prs', '1'.repeat(32))

type Seen = { url: string; headers: Headers; body: unknown }
type Responder = (count: number, body: unknown) => Response | Promise<Response>

const stops: Array<() => Promise<void>> = []
afterAll(async () => {
  await Promise.all(stops.map((stop) => stop()))
})

/** A receiver on a loopback port standing in for core; `respond` decides each answer. */
function stand(respond: Responder) {
  const seen: Seen[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body: unknown = await request.json().catch(() => undefined)
      seen.push({ url: request.url, headers: request.headers, body })
      return respond(seen.length, body)
    },
  })
  stops.push(async () => {
    await server.stop(true)
  })
  return { url: `http://127.0.0.1:${server.port}`, seen }
}

function build(url: string, extra: { random?: () => number } = {}) {
  const logger = createMemoryLogger()
  const pauses: number[] = []
  const guard: HttpContactGuard = createHttpContactGuard({
    baseUrl: url,
    secret: SECRET,
    environment: 'local',
    caller: 'voice',
    logger,
    sleep: async (ms) => {
      pauses.push(ms)
    },
    random: extra.random ?? (() => 0.5),
  })
  return { guard, logger, pauses }
}

const request = {
  organizationId: org,
  email: EMAIL,
  channel: 'email',
  purpose: 'agent_initiated',
} as const
const UNAVAILABLE = {
  allowed: false,
  checkId: null,
  code: 'consent.unavailable',
  suppressionReason: null,
} as const

contactGuardBehaviour('http adapter against a stand-in for core', async () => {
  const brain = createMemoryContactGuard()
  let down = false
  const core = stand(async (_n, body) => {
    if (down) {
      return new Response('{}', { status: 503 })
    }
    const { caller: _caller, ...rest } = contactCheckRequestSchema.parse(body)
    return Response.json(await brain.check(rest))
  })
  const { guard } = build(core.url)
  return {
    guard,
    allow: (target, channel) => void brain.allow(target, channel),
    deny: (target, channel, code, reason) => void brain.deny(target, channel, code, reason),
    makeUnavailable: () => {
      down = true
    },
    reached: () => brain.calls,
    close: async () => guard.close(),
  }
})

describe('the HTTP ContactGuard request', () => {
  test('posts the check with the bearer secret and names the caller', async () => {
    const core = stand(() =>
      Response.json({
        allowed: true,
        checkId: formatId('chk', '1'.repeat(32)),
        basis: 'email_no_suppression',
      })
    )
    const { guard } = build(core.url)
    const result = await guard.check(request)
    expect(result.allowed).toBe(true)
    const [seen] = core.seen
    expect(new URL(seen?.url ?? '').pathname).toBe('/internal/v1/contact-checks')
    expect(seen?.headers.get('authorization')).toBe(`Bearer ${SECRET}`)
    expect(seen?.body).toEqual({ ...request, caller: 'voice' })
    guard.close()
  })

  test('refuses a caller that is not a service name', () => {
    expect(() =>
      createHttpContactGuard({
        baseUrl: 'http://127.0.0.1:1',
        secret: SECRET,
        environment: 'local',
        caller: 'Voice Service',
        logger: createMemoryLogger(),
      })
    ).toThrow(TypeError)
  })
})

describe('the HTTP ContactGuard fails closed', () => {
  test('a timeout is tried once more, then denied as unavailable, and the log holds no secret', async () => {
    const core = stand(async () => {
      await Bun.sleep(CONTACT_GUARD_TIMEOUT_MS * 3)
      return Response.json({})
    })
    const { guard, logger, pauses } = build(core.url)
    const started = performance.now()
    const result = await guard.check({ ...request, prospectId: undefined })
    expect(result).toEqual(UNAVAILABLE)
    expect(core.seen).toHaveLength(2)
    expect(performance.now() - started).toBeLessThan(CONTACT_GUARD_TIMEOUT_MS * 2 + 600)
    expect(pauses).toHaveLength(1)
    expectCleanLog(logger.entries, 'timeout')
    guard.close()
  })

  test('a 5xx is tried once more, then denied as unavailable, and the log holds no secret', async () => {
    const core = stand(() => new Response(`boom ${SECRET} ${EMAIL}`, { status: 500 }))
    const { guard, logger } = build(core.url)
    expect(await guard.check(request)).toEqual(UNAVAILABLE)
    expect(core.seen).toHaveLength(2)
    expectCleanLog(logger.entries, 'http_5xx')
    guard.close()
  })

  test('a 5xx followed by an answer is the answer, after one jittered pause', async () => {
    const core = stand((n) =>
      n === 1
        ? new Response('', { status: 503 })
        : Response.json({
            allowed: false,
            checkId: formatId('chk', '2'.repeat(32)),
            code: 'consent.withdrawn',
            suppressionReason: null,
          })
    )
    const { guard, pauses } = build(core.url, { random: () => 0 })
    expect(await guard.check(request)).toMatchObject({ code: 'consent.withdrawn' })
    expect(core.seen).toHaveLength(2)
    expect(pauses).toEqual([CONTACT_GUARD_RETRY_DELAY_MS / 2])
    guard.close()
  })

  test('the pause is jittered between half and one and a half of the base', async () => {
    const core = stand((n) => (n === 1 ? new Response('', { status: 502 }) : Response.json({})))
    const { guard, pauses } = build(core.url, { random: () => 0.999 })
    await guard.check(request)
    expect(pauses[0]).toBeGreaterThanOrEqual(CONTACT_GUARD_RETRY_DELAY_MS * 0.5)
    expect(pauses[0]).toBeLessThan(CONTACT_GUARD_RETRY_DELAY_MS * 1.5)
    guard.close()
  })

  test('a refused connection is denied as unavailable after one retry', async () => {
    const dead = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
    const url = `http://127.0.0.1:${dead.port}`
    await dead.stop(true)
    const { guard, logger } = build(url)
    expect(await guard.check(request)).toEqual(UNAVAILABLE)
    expectCleanLog(logger.entries, 'connection')
    guard.close()
  })

  test.each([
    ['not an object', 'nope'],
    ['an allowance without a basis', { allowed: true, checkId: formatId('chk', '1'.repeat(32)) }],
    [
      'an unknown code',
      { allowed: false, checkId: null, code: 'consent.maybe', suppressionReason: null },
    ],
    ['an empty object', {}],
  ])('a malformed 200 (%s) is denied as unavailable without a retry', async (_name, answer) => {
    const core = stand(() => Response.json(answer))
    const { guard, logger } = build(core.url)
    expect(await guard.check(request)).toEqual(UNAVAILABLE)
    expect(core.seen).toHaveLength(1)
    expectCleanLog(logger.entries, 'malformed_response')
    guard.close()
  })

  test('an unexpected 4xx is denied as unavailable without a retry', async () => {
    const core = stand(() =>
      Response.json({ error: { code: 'auth.unauthorized' } }, { status: 401 })
    )
    const { guard, logger } = build(core.url)
    expect(await guard.check(request)).toEqual(UNAVAILABLE)
    expect(core.seen).toHaveLength(1)
    expectCleanLog(logger.entries, 'http_unexpected')
    guard.close()
  })

  test('an invalid request is denied before any call', async () => {
    const core = stand(() => Response.json({}))
    const { guard } = build(core.url)
    expect(await guard.check({ ...request, prospectId })).toEqual(UNAVAILABLE)
    expect(core.seen).toHaveLength(0)
    guard.close()
  })
})

/** The log names the failure and the channel, and holds no secret, address or id. */
function expectCleanLog(entries: ReturnType<typeof createMemoryLogger>['entries'], reason: string) {
  expect(entries.length).toBeGreaterThan(0)
  const text = JSON.stringify(entries)
  expect(text).toContain(reason)
  expect(text).toContain('email')
  for (const secret of [SECRET, EMAIL, 'marker', prospectId, 'Bearer']) {
    expect(text).not.toContain(secret)
  }
  expect(entries.every((entry) => entry.level === 'warn')).toBe(true)
}
