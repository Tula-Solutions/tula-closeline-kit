import { beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { ERRORS } from 'tula-closeline-contract'
import { createFixedClock } from '../clock'
import { isAppError, toErrorBody } from '../errors'
import { createMemoryLogger } from '../testing'
import { MAX_TOKEN_LENGTH } from './claims'
import { TokenVerificationError } from './errors'
import { createRemoteKeySet, createStaticKeySet } from './keys'
import { type AuthEnv, createAuthMiddleware } from './middleware'
import {
  createTestJwks,
  createTestKeyPair,
  mintTestToken,
  type TestKeyPair,
  testOrganizationId,
  testUserId,
} from './testing'
import { createTokenVerifier, type TokenVerifier } from './verifier'

const clock = createFixedClock('2026-06-01T12:00:00.000Z')
let pair: TestKeyPair
let verifier: TokenVerifier

function build(v: TokenVerifier = verifier, logClock = clock) {
  const logger = createMemoryLogger()
  const app = new Hono<AuthEnv>()
  app.onError((error, c) => {
    if (isAppError(error)) {
      return c.newResponse(JSON.stringify(toErrorBody(error)), error.status as 401 | 503, {
        'content-type': 'application/json',
      })
    }
    return c.newResponse('internal', 500)
  })
  app.use('*', createAuthMiddleware({ verifier: v, logger, clock: logClock }))
  app.get('/me', (c) =>
    c.json({
      organizationId: c.get('organizationId'),
      userId: c.get('userId'),
      role: c.get('role'),
      region: c.get('region'),
    })
  )
  return { app, logger }
}

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } })

beforeAll(async () => {
  pair = await createTestKeyPair('key-1')
  verifier = createTokenVerifier({
    issuer: 'https://auth.test',
    audience: 'closeline',
    keys: await createStaticKeySet(createTestJwks(pair)),
    clock,
  })
})

async function expectRejected(res: Response, code: string, status = 401) {
  expect(res.status).toBe(status)
  const body = (await res.json()) as { error: { code: string } }
  expect(body.error.code).toBe(code)
}

describe('requests that must be turned away', () => {
  test('no Authorization header', async () => {
    await expectRejected(await build().app.request('/me'), 'auth.unauthenticated')
  })

  test.each([
    ['a different scheme', 'Basic dXNlcjpwYXNz'],
    ['no token', 'Bearer'],
    ['an empty token', 'Bearer '],
    ['two tokens', 'Bearer a.b.c d.e.f'],
    ['no scheme', 'a.b.c'],
    ['a token with a tab', 'Bearer a.b\t.c'],
  ])('%s', async (_name, value) => {
    await expectRejected(
      await build().app.request('/me', { headers: { authorization: value } }),
      'auth.unauthenticated'
    )
  })

  test('an oversized header is rejected without reaching the verifier', async () => {
    let called = false
    const spy: TokenVerifier = {
      verify: async () => {
        called = true
        throw new Error('unreachable')
      },
    }
    const res = await build(spy).app.request('/me', bearer('a'.repeat(MAX_TOKEN_LENGTH + 1)))
    await expectRejected(res, 'auth.unauthenticated')
    expect(called).toBe(false)
  })

  test('a token that is not valid', async () => {
    await expectRejected(
      await build().app.request('/me', bearer('not.a.token')),
      'auth.token_invalid'
    )
    const bad = await mintTestToken({ keyPair: pair, clock, claims: { role: 'god' } })
    await expectRejected(await build().app.request('/me', bearer(bad)), 'auth.token_invalid')
  })

  test('an expired token is told apart so the client can refresh', async () => {
    const token = await mintTestToken({ keyPair: pair, clock, expiresInSeconds: -300 })
    await expectRejected(await build().app.request('/me', bearer(token)), 'auth.token_expired')
  })

  test('a key set outage is a 503 that is not mistaken for a bad token', async () => {
    const down: TokenVerifier = {
      verify: async () => {
        throw new TokenVerificationError('unavailable')
      },
    }
    const t = build(down)
    const res = await t.app.request('/me', bearer('a.b.c'))
    await expectRejected(res, 'auth.unavailable', 503)
    expect(t.logger.entries).toEqual([
      {
        level: 'error',
        message: 'token verification unavailable',
        fields: { reason: 'unavailable' },
      },
    ])
  })

  test('a verifier that fails unexpectedly is a 503, logged by class name only', async () => {
    class KeyStoreError extends Error {}
    const token = 'a.b.c'
    const broken: TokenVerifier = {
      verify: async () => {
        throw new KeyStoreError(`key store exploded for ${token}`)
      },
    }
    const t = build(broken)
    const res = await t.app.request('/me', bearer(token))
    await expectRejected(res, 'auth.unavailable', 503)
    expect(t.logger.entries).toEqual([
      {
        level: 'error',
        message: 'token verification failed unexpectedly',
        fields: { errorClass: 'KeyStoreError' },
      },
    ])
    const logs = JSON.stringify(t.logger.entries)
    expect(logs).not.toContain('exploded')
    expect(logs).not.toContain(token)
  })

  test('a thrown value that is not an Error is still a 503 and logs no content', async () => {
    const broken: TokenVerifier = {
      verify: async () => {
        throw 'secret-string-token'
      },
    }
    const t = build(broken)
    await expectRejected(await t.app.request('/me', bearer('a.b.c')), 'auth.unavailable', 503)
    expect(JSON.stringify(t.logger.entries)).not.toContain('secret-string-token')
  })

  test('a token from a key set that is down for good ends as a 503 end to end', async () => {
    const keys = createRemoteKeySet({
      url: 'https://auth.test/.well-known/jwks.json',
      clock,
      retries: 0,
      fetch: (async () => new Response('down', { status: 503 })) as unknown as typeof fetch,
    })
    const real = createTokenVerifier({
      issuer: 'https://auth.test',
      audience: 'closeline',
      keys,
      clock,
    })
    const token = await mintTestToken({ keyPair: pair, clock })
    await expectRejected(
      await build(real).app.request('/me', bearer(token)),
      'auth.unavailable',
      503
    )
  })

  test('neither the response nor the logs hold the token or say which check failed', async () => {
    const t = build()
    const token = await mintTestToken({ keyPair: pair, clock, audience: 'other-app' })
    const res = await t.app.request('/me', bearer(token))
    const text = await res.text()
    const logs = JSON.stringify(t.logger.entries)
    for (const output of [text, logs]) {
      expect(output).not.toContain(token)
      expect(output).not.toContain(token.split('.')[1] as string)
      expect(output.toLowerCase()).not.toContain('audience')
      expect(output.toLowerCase()).not.toContain('signature')
    }
    expect(t.logger.entries).toEqual([
      { level: 'warn', message: 'request rejected', fields: { reason: 'invalid' } },
    ])
  })
})

describe("the codes it returns are the contract's", () => {
  // Drives the middleware to each rejection it can produce and checks the code is registered in
  // the contract with the status the middleware sends, so the two cannot drift.
  test('every rejection code exists in the registry with the status the middleware uses', async () => {
    const expired = await mintTestToken({ keyPair: pair, clock, expiresInSeconds: -300 })
    const down: TokenVerifier = {
      verify: async () => {
        throw new TokenVerificationError('unavailable')
      },
    }
    const cases: [string, () => Response | Promise<Response>][] = [
      ['auth.unauthenticated', () => build().app.request('/me')],
      ['auth.token_invalid', () => build().app.request('/me', bearer('not.a.token'))],
      ['auth.token_expired', () => build().app.request('/me', bearer(expired))],
      ['auth.unavailable', () => build(down).app.request('/me', bearer('a.b.c'))],
    ]
    expect(cases.map(([code]) => code).sort()).toEqual([
      'auth.token_expired',
      'auth.token_invalid',
      'auth.unauthenticated',
      'auth.unavailable',
    ])
    for (const [code, request] of cases) {
      const definition = (ERRORS as Record<string, { status: number } | undefined>)[code]
      expect(definition, `${code} is missing from the contract`).toBeDefined()
      const res = await request()
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe(code)
      expect(res.status).toBe(definition?.status as number)
    }
  })
})

describe('an authenticated request', () => {
  test('sees the Organization, user, role and Region from the token', async () => {
    const org = testOrganizationId(7)
    const user = testUserId(3)
    const token = await mintTestToken({
      keyPair: pair,
      clock,
      claims: { org, sub: user, role: 'admin', region: 'eu' },
    })
    const res = await build().app.request('/me', bearer(token))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      organizationId: org,
      userId: user,
      role: 'admin',
      region: 'eu',
    })
  })

  test('accepts the scheme in any letter case', async () => {
    const token = await mintTestToken({ keyPair: pair, clock })
    const res = await build().app.request('/me', { headers: { authorization: `bearer ${token}` } })
    expect(res.status).toBe(200)
  })

  test('a second Organization is never mistaken for the first, and headers cannot override it', async () => {
    const first = testOrganizationId(1)
    const second = testOrganizationId(2)
    const t = build()
    const a = await mintTestToken({ keyPair: pair, clock, claims: { org: first } })
    const b = await mintTestToken({ keyPair: pair, clock, claims: { org: second } })
    const resA = await t.app.request('/me', {
      headers: { authorization: `Bearer ${a}`, 'x-organization-id': second },
    })
    const resB = await t.app.request('/me', { headers: { authorization: `Bearer ${b}` } })
    expect(((await resA.json()) as { organizationId: string }).organizationId).toBe(first)
    expect(((await resB.json()) as { organizationId: string }).organizationId).toBe(second)
  })

  test('does not log anything for a good request', async () => {
    const t = build()
    await t.app.request('/me', bearer(await mintTestToken({ keyPair: pair, clock })))
    expect(t.logger.entries).toEqual([])
  })
})

describe('the outage log under a flood', () => {
  const down: TokenVerifier = {
    verify: async () => {
      throw new TokenVerificationError('unavailable')
    },
  }
  const errorLines = (t: ReturnType<typeof build>) =>
    t.logger.entries.filter((e) => e.level === 'error')

  test('1,000 requests inside a second write one error line, and every one still gets a 503', async () => {
    const t = build(down, createFixedClock('2026-06-01T12:00:00.000Z'))
    for (let i = 0; i < 1_000; i++) {
      await expectRejected(await t.app.request('/me', bearer('a.b.c')), 'auth.unavailable', 503)
    }
    expect(errorLines(t)).toHaveLength(1)
    expect(errorLines(t)[0]?.fields).toEqual({ reason: 'unavailable' })
  })

  test('the next line after a second carries the count of lines that were held back', async () => {
    const logClock = createFixedClock('2026-06-01T12:00:00.000Z')
    const t = build(down, logClock)
    for (let i = 0; i < 5; i++) {
      await t.app.request('/me', bearer('a.b.c'))
    }
    logClock.advance('999ms')
    await t.app.request('/me', bearer('a.b.c'))
    expect(errorLines(t)).toHaveLength(1)
    logClock.advance('1ms')
    await t.app.request('/me', bearer('a.b.c'))
    expect(errorLines(t)).toHaveLength(2)
    expect(errorLines(t)[1]?.fields).toEqual({ reason: 'unavailable', suppressed: 5 })
    logClock.advance('1s')
    await t.app.request('/me', bearer('a.b.c'))
    expect(errorLines(t)[2]?.fields).toEqual({ reason: 'unavailable' })
  })

  test('unexpected verifier failures share the limit and are still logged by class name only', async () => {
    class Boom extends Error {}
    const broken: TokenVerifier = {
      verify: async () => {
        throw new Boom('x')
      },
    }
    const t = build(broken, createFixedClock('2026-06-01T12:00:00.000Z'))
    for (let i = 0; i < 20; i++) {
      await t.app.request('/me', bearer('a.b.c'))
    }
    expect(errorLines(t)).toEqual([
      {
        level: 'error',
        message: 'token verification failed unexpectedly',
        fields: { errorClass: 'Boom' },
      },
    ])
  })

  test('each middleware instance keeps its own limit, and warnings are not limited', async () => {
    const logClock = createFixedClock('2026-06-01T12:00:00.000Z')
    const a = build(down, logClock)
    const b = build(down, logClock)
    await a.app.request('/me', bearer('a.b.c'))
    await b.app.request('/me', bearer('a.b.c'))
    expect(errorLines(a)).toHaveLength(1)
    expect(errorLines(b)).toHaveLength(1)
    for (let i = 0; i < 10; i++) {
      await a.app.request('/me')
    }
    expect(a.logger.entries.filter((e) => e.level === 'warn')).toHaveLength(10)
  })

  test('a clock that steps backwards does not silence the log', async () => {
    const stepped = { t: Date.parse('2026-06-01T12:00:00.000Z') }
    const t = build(down, { now: () => new Date(stepped.t) } as typeof clock)
    await t.app.request('/me', bearer('a.b.c'))
    stepped.t -= 60_000
    await t.app.request('/me', bearer('a.b.c'))
    expect(errorLines(t)).toHaveLength(2)
  })
})
