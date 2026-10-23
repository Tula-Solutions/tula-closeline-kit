import { beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { API_KEY_SCOPES, ERRORS } from 'tula-closeline-contract'
import { createFixedClock } from '../clock'
import { isAppError, toErrorBody } from '../errors'
import { createMemoryLogger } from '../testing'
import { TokenVerificationError } from './errors'
import { createStaticKeySet } from './keys'
import { type AuthEnv, createAuthMiddleware, type ScopedAuthEnv } from './middleware'
import { requireScope } from './scope'
import {
  createTestJwks,
  createTestKeyPair,
  DEFAULT_TEST_ORGANIZATION_ID,
  mintTestApiKeyToken,
  mintTestToken,
  type TestKeyPair,
  testApiKeyId,
  testOrganizationId,
} from './testing'
import { createTokenVerifier, type TokenVerifier } from './verifier'

const clock = createFixedClock('2026-06-01T12:00:00.000Z')
let pair: TestKeyPair
let verifier: TokenVerifier

beforeAll(async () => {
  pair = await createTestKeyPair('key-1')
  verifier = createTokenVerifier({
    issuer: 'https://auth.test',
    audience: 'closeline',
    keys: await createStaticKeySet(createTestJwks(pair)),
    clock,
  })
})

const apiKey = (options: Partial<Parameters<typeof mintTestApiKeyToken>[0]> = {}) =>
  mintTestApiKeyToken({ keyPair: pair, clock, ...options })

async function invalid(token: string) {
  const error = await verifier.verify(token).then(
    () => undefined,
    (e: unknown) => e
  )
  expect(error).toBeInstanceOf(TokenVerificationError)
  expect((error as TokenVerificationError).reason).toBe('invalid')
}

describe('verifying an API key token', () => {
  test('yields the key, Organization, Region, scopes and times, and never a role', async () => {
    const org = testOrganizationId(4)
    const verified = await verifier.verify(
      await apiKey({
        apiKeyId: testApiKeyId(5),
        scopes: ['prospects:read', 'consent:write'],
        claims: { org, region: 'eu' },
        expiresInSeconds: 600,
      })
    )
    expect(verified.actor).toBe('api_key')
    if (verified.actor !== 'api_key') {
      throw new Error('expected an api_key token')
    }
    expect(verified.apiKeyId).toBe(testApiKeyId(5))
    expect(verified.organizationId).toBe(org)
    expect(verified.region).toBe('eu')
    expect(verified.scopes).toEqual(['prospects:read', 'consent:write'])
    expect(verified.expiresAt).toEqual(new Date('2026-06-01T12:10:00.000Z'))
    expect('role' in verified).toBe(false)
    expect('userId' in verified).toBe(false)
  })

  test('accepts every scope the contract lists', async () => {
    const verified = await verifier.verify(await apiKey({ scopes: [...API_KEY_SCOPES] }))
    expect(verified.actor === 'api_key' && verified.scopes.length).toBe(API_KEY_SCOPES.length)
  })

  test('a repeated scope is listed once', async () => {
    const verified = await verifier.verify(
      await apiKey({ scopes: ['prospects:read', 'prospects:read'] })
    )
    expect(verified.actor === 'api_key' && verified.scopes).toEqual(['prospects:read'])
  })

  test('is refused with a role claim', async () => {
    await invalid(await apiKey({ claims: { role: 'admin' } }))
  })

  test('is refused with no scopes, an empty list or an unknown scope', async () => {
    await invalid(await apiKey({ claims: { scp: undefined } }))
    await invalid(await apiKey({ claims: { scp: [] } }))
    await invalid(await apiKey({ claims: { scp: ['prospects:admin'] } }))
    await invalid(await apiKey({ claims: { scp: 'prospects:read' } }))
    await invalid(await apiKey({ claims: { scp: ['members:write'] } }))
  })

  test('is refused when sub is a user id rather than a key id', async () => {
    await invalid(await apiKey({ claims: { sub: 'usr_00000000000000000000000000000001' } }))
  })

  test('is refused without an Organization or Region', async () => {
    await invalid(await apiKey({ claims: { org: undefined } }))
    await invalid(await apiKey({ claims: { region: undefined } }))
  })

  test('an unknown actor is refused, whatever else the token carries', async () => {
    await invalid(await mintTestToken({ keyPair: pair, clock, claims: { act: 'service' } }))
    await invalid(await mintTestToken({ keyPair: pair, clock, claims: { act: 'member' } }))
    await invalid(await mintTestToken({ keyPair: pair, clock, claims: { act: null } }))
    await invalid(await apiKey({ claims: { act: 'API_KEY' } }))
  })

  test('a member token with scopes stays a member with its role', async () => {
    const verified = await verifier.verify(
      await mintTestToken({ keyPair: pair, clock, claims: { scp: ['prospects:read'] } })
    )
    expect(verified.actor).toBe('member')
    expect('scopes' in verified).toBe(false)
  })
})

describe('verifying a member token', () => {
  test('is a member with a role and no scopes', async () => {
    const verified = await verifier.verify(await mintTestToken({ keyPair: pair, clock }))
    expect(verified.actor).toBe('member')
    expect(verified.role).toBe('rep')
    expect(verified.organizationId).toBe(DEFAULT_TEST_ORGANIZATION_ID)
  })
})

function build() {
  const logger = createMemoryLogger()
  const app = new Hono<AuthEnv>()
  app.onError((error, c) => {
    if (isAppError(error)) {
      return c.newResponse(JSON.stringify(toErrorBody(error)), error.status as 401 | 403 | 503, {
        'content-type': 'application/json',
      })
    }
    return c.newResponse('internal', 500)
  })
  app.use('*', createAuthMiddleware({ verifier, logger, clock }))
  app.get('/member-only', (c) => c.json({ role: c.get('role'), actor: c.get('actor') }))
  const scoped = new Hono<ScopedAuthEnv>()
  scoped.get('/prospects', requireScope('prospects:read'), (c) =>
    c.json({
      actor: c.get('actor'),
      organizationId: c.get('organizationId'),
      role: c.get('role') ?? null,
      apiKeyId: c.get('apiKeyId') ?? null,
      scopes: c.get('scopes') ?? null,
    })
  )
  scoped.post('/prospects', requireScope('prospects:write'), (c) => c.json({ ok: true }))
  app.route('/v1', scoped)
  return { app, logger }
}

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } })

async function forbidden(res: Response) {
  expect(res.status).toBe(403)
  const body = (await res.json()) as { error: { code: string } }
  expect(body.error.code).toBe('auth.forbidden')
  expect((ERRORS as Record<string, { status: number }>)['auth.forbidden']?.status).toBe(403)
}

describe('the auth middleware and API key tokens', () => {
  test('refuses an API key token on a route that has not opted in', async () => {
    const res = await build().app.request('/member-only', bearer(await apiKey()))
    await forbidden(res)
  })

  test('refuses an API key token on a route that does not exist', async () => {
    const res = await build().app.request('/nope', bearer(await apiKey()))
    expect(res.status).toBe(403)
  })

  test('a member keeps role, actor and everything else on a member-only route', async () => {
    const res = await build().app.request(
      '/member-only',
      bearer(await mintTestToken({ keyPair: pair, clock, claims: { role: 'admin' } }))
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ role: 'admin', actor: 'member' })
  })

  test('logs only a coarse reason for the refusal, never the scopes or the key', async () => {
    const t = build()
    const token = await apiKey({ scopes: ['playbook:write'] })
    await t.app.request('/member-only', bearer(token))
    const text = JSON.stringify(t.logger.entries)
    expect(text).not.toContain('playbook')
    expect(text).not.toContain(token)
    expect(text).not.toContain(testApiKeyId(1))
  })
})

describe('requireScope', () => {
  test('lets an API key token with that exact scope through, with no role', async () => {
    const res = await build().app.request(
      '/v1/prospects',
      bearer(
        await apiKey({ apiKeyId: testApiKeyId(8), scopes: ['prospects:read', 'consent:read'] })
      )
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      actor: 'api_key',
      organizationId: DEFAULT_TEST_ORGANIZATION_ID,
      role: null,
      apiKeyId: testApiKeyId(8),
      scopes: ['prospects:read', 'consent:read'],
    })
  })

  test('refuses an API key token without the scope', async () => {
    await forbidden(
      await build().app.request('/v1/prospects', bearer(await apiKey({ scopes: ['consent:read'] })))
    )
  })

  test('write does not imply read, and read does not imply write', async () => {
    const t = build()
    await forbidden(
      await t.app.request('/v1/prospects', bearer(await apiKey({ scopes: ['prospects:write'] })))
    )
    await forbidden(
      await t.app.request('/v1/prospects', {
        method: 'POST',
        ...bearer(await apiKey({ scopes: ['prospects:read'] })),
      })
    )
    const ok = await t.app.request('/v1/prospects', {
      method: 'POST',
      ...bearer(await apiKey({ scopes: ['prospects:write'] })),
    })
    expect(ok.status).toBe(200)
  })

  test('accepts a member token unchanged, whatever the scope', async () => {
    const res = await build().app.request(
      '/v1/prospects',
      bearer(await mintTestToken({ keyPair: pair, clock, claims: { role: 'manager' } }))
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ actor: 'member', role: 'manager', scopes: null })
  })

  test('refuses as unauthenticated when no auth middleware ran before it', async () => {
    const app = new Hono<ScopedAuthEnv>()
    app.onError((error, c) =>
      isAppError(error)
        ? c.newResponse(JSON.stringify(toErrorBody(error)), error.status as 401 | 403, {
            'content-type': 'application/json',
          })
        : c.newResponse('internal', 500)
    )
    app.get('/x', requireScope('prospects:read'), (c) => c.json({ ok: true }))
    const res = await app.request('/x')
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'auth.unauthenticated'
    )
  })

  test('rejects a scope the contract does not list when the guard is built', () => {
    // @ts-expect-error not a scope
    expect(() => requireScope('members:write')).toThrow(TypeError)
  })

  test('an API key token is still refused where the guard is not on the matched route', async () => {
    const t = build()
    const res = await t.app.request('/v1/other', bearer(await apiKey()))
    expect(res.status).toBe(403)
  })

  test('finds the guard on a route in a sub-app that has its own error handler', async () => {
    const t = build()
    const sub = new Hono<ScopedAuthEnv>()
    sub.onError((error) => {
      throw error
    })
    sub.get('/calls', requireScope('calls:read'), (c) => c.json({ ok: true }))
    t.app.route('/v2', sub)
    const res = await t.app.request('/v2/calls', bearer(await apiKey({ scopes: ['calls:read'] })))
    expect(res.status).toBe(200)
  })
})
