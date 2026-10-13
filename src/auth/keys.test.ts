import { beforeAll, describe, expect, test } from 'bun:test'
import { createFixedClock } from '../clock'
import { createMemoryLogger } from '../testing'
import { createRemoteKeySet, createStaticKeySet, MAX_JWKS_BYTES, MAX_JWKS_KEYS } from './keys'
import { createTestJwks, createTestKeyPair, mintTestToken, type TestKeyPair } from './testing'
import { createTokenVerifier } from './verifier'

const URL_ = 'https://auth.test/.well-known/jwks.json'
let k1: TestKeyPair
let k2: TestKeyPair
let k3: TestKeyPair

beforeAll(async () => {
  k1 = await createTestKeyPair('k1')
  k2 = await createTestKeyPair('k2')
  k3 = await createTestKeyPair('k3')
})

describe('createStaticKeySet', () => {
  test('refuses an empty JWKS', async () => {
    await expect(createStaticKeySet({ keys: [] })).rejects.toThrow(TypeError)
  })

  test('refuses more than the maximum number of keys', async () => {
    const keys = Array.from({ length: MAX_JWKS_KEYS + 1 }, () => k1.publicJwk)
    await expect(createStaticKeySet({ keys })).rejects.toThrow(TypeError)
  })

  test.each([
    ['a private key', () => ({ ...k1.publicJwk, d: 'c2VjcmV0' })],
    ['a key without a kid', () => ({ ...k1.publicJwk, kid: undefined })],
    ['an RSA key', () => ({ kty: 'RSA', n: 'abc', e: 'AQAB', kid: 'r' })],
    ['an EC key', () => ({ kty: 'EC', crv: 'P-256', x: 'a', y: 'b', kid: 'e' })],
    ['an X25519 key', () => ({ ...k1.publicJwk, crv: 'X25519' })],
    ['an encryption key', () => ({ ...k1.publicJwk, use: 'enc' })],
    ['a key for another algorithm', () => ({ ...k1.publicJwk, alg: 'RS256' })],
    ['a non-key', () => 'nope'],
    ['an x that is not a point', () => ({ ...k1.publicJwk, x: 'AAAA' })],
  ])('refuses %s', async (_name, make) => {
    await expect(createStaticKeySet({ keys: [make()] })).rejects.toThrow(TypeError)
  })

  test('refuses two keys with the same kid', async () => {
    await expect(createStaticKeySet({ keys: [k1.publicJwk, k1.publicJwk] })).rejects.toThrow(
      TypeError
    )
  })

  test('serves known kids and nothing else', async () => {
    const set = await createStaticKeySet(createTestJwks(k1, k2))
    expect(await set.getKey('k1')).toBeDefined()
    expect(await set.getKey('k2')).toBeDefined()
    expect(await set.getKey('k3')).toBeUndefined()
    expect(await set.getKey('__proto__')).toBeUndefined()
  })
})

function setup(options: { retries?: number; timeoutMs?: number; cooldownMs?: number } = {}) {
  const clock = createFixedClock('2026-06-01T12:00:00.000Z')
  const logger = createMemoryLogger()
  let body: () => Response = () => Response.json(createTestJwks(k1))
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const sleeps: number[] = []
  const fetchStub = (async (input: URL | string, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return body()
  }) as unknown as typeof fetch
  const keys = createRemoteKeySet({
    url: URL_,
    clock,
    logger,
    fetch: fetchStub,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    random: () => 0.5,
    ...options,
  })
  return {
    clock,
    logger,
    calls,
    sleeps,
    keys,
    respond: (next: () => Response) => {
      body = next
    },
  }
}

describe('createRemoteKeySet failure paths', () => {
  test('refuses a JWKS URL that is not https, unless it is local', () => {
    const clock = createFixedClock('2026-06-01T00:00:00Z')
    expect(() => createRemoteKeySet({ url: 'http://auth.test/jwks', clock })).toThrow(TypeError)
    expect(() => createRemoteKeySet({ url: 'ftp://auth.test/jwks', clock })).toThrow(TypeError)
    expect(() => createRemoteKeySet({ url: 'not a url', clock })).toThrow()
    expect(() => createRemoteKeySet({ url: 'http://localhost:4000/jwks', clock })).not.toThrow()
  })

  test('a failed refresh keeps serving the last good keys and logs a warning', async () => {
    const t = setup({ retries: 0 })
    expect(await t.keys.getKey('k1')).toBeDefined()
    t.respond(() => new Response('boom', { status: 500 }))
    t.clock.advance('31s')
    expect(await t.keys.getKey('unknown')).toBeUndefined()
    expect(t.calls).toHaveLength(2)
    expect(await t.keys.getKey('k1')).toBeDefined()
    expect(t.logger.entries.map((e) => [e.level, e.message])).toEqual([
      ['warn', 'jwks refresh failed'],
    ])
  })

  test.each([
    ['a 404', () => new Response('nope', { status: 404 })],
    ['invalid JSON', () => new Response('{not json')],
    ['a body that is not a JWKS', () => Response.json({ hello: 'world' })],
    ['an empty JWKS', () => Response.json({ keys: [] })],
    ['a JWKS of only unusable keys', () => Response.json({ keys: [{ kty: 'RSA', kid: 'r' }] })],
    [
      'too many keys',
      () => Response.json({ keys: Array.from({ length: MAX_JWKS_KEYS + 1 }, () => k2.publicJwk) }),
    ],
    ['an oversized body', () => new Response('x'.repeat(MAX_JWKS_BYTES + 1))],
    [
      'an oversized declared length',
      () => new Response('{}', { headers: { 'content-length': String(MAX_JWKS_BYTES + 1) } }),
    ],
  ])('%s keeps the last good keys', async (_name, bad) => {
    const t = setup({ retries: 0 })
    await t.keys.getKey('k1')
    t.respond(bad)
    t.clock.advance('31s')
    expect(await t.keys.getKey('k2')).toBeUndefined()
    expect(await t.keys.getKey('k1')).toBeDefined()
    expect(t.logger.entries).toHaveLength(1)
  })

  test('with nothing cached, a failed fetch leaves every kid unknown', async () => {
    const t = setup({ retries: 0 })
    t.respond(() => new Response('down', { status: 503 }))
    expect(await t.keys.getKey('k1')).toBeUndefined()
  })

  test('a network error and a 5xx are retried once with jitter; a 4xx is not', async () => {
    const t = setup()
    let n = 0
    t.respond(() => {
      n++
      return n === 1 ? new Response('x', { status: 502 }) : Response.json(createTestJwks(k1))
    })
    expect(await t.keys.getKey('k1')).toBeDefined()
    expect(t.calls).toHaveLength(2)
    expect(t.sleeps).toEqual([150])

    const u = setup()
    u.respond(() => new Response('no', { status: 403 }))
    await u.keys.getKey('k1')
    expect(u.calls).toHaveLength(1)
  })

  test('retries are bounded', async () => {
    const t = setup({ retries: 2 })
    t.respond(() => new Response('x', { status: 500 }))
    await t.keys.getKey('k1')
    expect(t.calls).toHaveLength(3)
  })

  test('a request that outlives the timeout is abandoned', async () => {
    const clock = createFixedClock('2026-06-01T12:00:00.000Z')
    const hang = ((_url: URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })) as unknown as typeof fetch
    const keys = createRemoteKeySet({ url: URL_, clock, fetch: hang, timeoutMs: 20, retries: 0 })
    const started = performance.now()
    expect(await keys.getKey('k1')).toBeUndefined()
    expect(performance.now() - started).toBeLessThan(1000)
  })

  test('each request carries a timeout signal and refuses redirects', async () => {
    const t = setup()
    await t.keys.getKey('k1')
    expect(t.calls[0]?.init?.signal).toBeInstanceOf(AbortSignal)
    expect(t.calls[0]?.init?.redirect).toBe('error')
  })
})

describe('createRemoteKeySet refresh policy', () => {
  test('the first lookup fetches and later lookups of a cached kid do no I/O', async () => {
    const t = setup()
    for (let i = 0; i < 5; i++) {
      expect(await t.keys.getKey('k1')).toBeDefined()
    }
    expect(t.calls).toHaveLength(1)
    expect(t.calls[0]?.url).toBe(URL_)
  })

  test('unknown kids refresh at most once per cooldown window', async () => {
    const t = setup()
    await t.keys.getKey('k1')
    t.clock.advance('31s')
    for (let i = 0; i < 20; i++) {
      expect(await t.keys.getKey(`bad-${i}`)).toBeUndefined()
    }
    expect(t.calls).toHaveLength(2)
    t.clock.advance('29s')
    await t.keys.getKey('still-bad')
    expect(t.calls).toHaveLength(2)
    t.clock.advance('1s')
    await t.keys.getKey('still-bad')
    expect(t.calls).toHaveLength(3)
  })

  test('a failed attempt also starts the cooldown', async () => {
    const t = setup({ retries: 0 })
    t.respond(() => new Response('x', { status: 500 }))
    await t.keys.getKey('a')
    await t.keys.getKey('b')
    await t.keys.getKey('c')
    expect(t.calls).toHaveLength(1)
  })

  test('concurrent lookups share one in-flight request', async () => {
    const t = setup()
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => t.keys.getKey(i % 2 ? 'k1' : 'nope'))
    )
    expect(t.calls).toHaveLength(1)
    expect(results.filter((key) => key !== undefined)).toHaveLength(12)
  })

  test('a rotated-in key is picked up after the cooldown, on its first use', async () => {
    const t = setup()
    await t.keys.getKey('k1')
    t.respond(() => Response.json(createTestJwks(k1, k2)))
    t.clock.advance('31s')
    expect(await t.keys.getKey('k2')).toBeDefined()
    expect(await t.keys.getKey('k1')).toBeDefined()
  })

  test('a withdrawn key is dropped when the cache passes its maximum age, without blocking', async () => {
    const t = setup()
    await t.keys.getKey('k1')
    t.respond(() => Response.json(createTestJwks(k2)))
    t.clock.advance('61m')
    expect(await t.keys.getKey('k1')).toBeDefined()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(t.calls).toHaveLength(2)
    expect(await t.keys.getKey('k1')).toBeUndefined()
    expect(await t.keys.getKey('k2')).toBeDefined()
  })

  test('skips unusable and private entries but keeps the good ones', async () => {
    const t = setup()
    t.respond(() =>
      Response.json({ keys: [{ ...k1.publicJwk, d: 'c2VjcmV0' }, { kty: 'RSA' }, k2.publicJwk] })
    )
    expect(await t.keys.getKey('k1')).toBeUndefined()
    expect(await t.keys.getKey('k2')).toBeDefined()
  })

  test('warm fetches immediately, ignoring the cooldown, and shares an in-flight fetch', async () => {
    const t = setup()
    await Promise.all([t.keys.warm(), t.keys.warm()])
    expect(t.calls).toHaveLength(1)
    await t.keys.warm()
    expect(t.calls).toHaveLength(2)
  })
})

describe('createRemoteKeySet with a verifier', () => {
  test('verifying many tokens with a warm cache makes no further requests', async () => {
    const t = setup()
    await t.keys.warm()
    const verifier = createTokenVerifier({
      issuer: 'https://auth.test',
      audience: 'closeline',
      keys: t.keys,
      clock: t.clock,
    })
    const token = await mintTestToken({ keyPair: k1, clock: t.clock })
    for (let i = 0; i < 50; i++) {
      await verifier.verify(token)
    }
    expect(t.calls).toHaveLength(1)
  })

  test('a flood of tokens with unknown kids hits the auth service once per cooldown', async () => {
    const t = setup()
    await t.keys.warm()
    const verifier = createTokenVerifier({
      issuer: 'https://auth.test',
      audience: 'closeline',
      keys: t.keys,
      clock: t.clock,
    })
    t.clock.advance('31s')
    const token = await mintTestToken({ keyPair: k3, clock: t.clock })
    for (let i = 0; i < 100; i++) {
      await expect(verifier.verify(token)).rejects.toMatchObject({ reason: 'invalid' })
    }
    expect(t.calls).toHaveLength(2)
  })
})
