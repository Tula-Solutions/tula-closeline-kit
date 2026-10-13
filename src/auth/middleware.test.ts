import { beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createFixedClock } from '../clock'
import { isAppError, toErrorBody } from '../errors'
import { createMemoryLogger } from '../testing'
import { MAX_TOKEN_LENGTH } from './claims'
import { createStaticKeySet } from './keys'
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

function build(v: TokenVerifier = verifier) {
  const logger = createMemoryLogger()
  const app = new Hono<AuthEnv>()
  app.onError((error, c) => {
    if (isAppError(error)) {
      return c.newResponse(JSON.stringify(toErrorBody(error)), error.status as 401, {
        'content-type': 'application/json',
      })
    }
    return c.newResponse('internal', 500)
  })
  app.use('*', createAuthMiddleware({ verifier: v, logger }))
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

async function expectRejected(res: Response, code: string) {
  expect(res.status).toBe(401)
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

  test('a verifier that fails unexpectedly still ends in a 401', async () => {
    const broken: TokenVerifier = {
      verify: async () => {
        throw new Error('key store exploded')
      },
    }
    const res = await build(broken).app.request('/me', bearer('a.b.c'))
    await expectRejected(res, 'auth.token_invalid')
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
