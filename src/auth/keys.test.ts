import { beforeAll, describe, expect, test } from 'bun:test'
import { type Clock, createFixedClock } from '../clock'
import type { Logger } from '../logger'
import { createMemoryLogger } from '../testing'
import {
  createRemoteKeySet,
  createStaticKeySet,
  MAX_JWKS_BYTES,
  MAX_JWKS_KEYS,
  type RemoteKeySetOptions,
} from './keys'
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

  test('is always available, so an unknown kid is a bad token and never an outage', async () => {
    const set = await createStaticKeySet(createTestJwks(k1))
    expect(set.available()).toBe(true)
  })
})

function setup(options: Partial<RemoteKeySetOptions> = {}) {
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
  test('refuses a JWKS URL that is not https, and http even for localhost by default', () => {
    const clock = createFixedClock('2026-06-01T00:00:00Z')
    expect(() => createRemoteKeySet({ url: 'http://auth.test/jwks', clock })).toThrow(TypeError)
    expect(() => createRemoteKeySet({ url: 'ftp://auth.test/jwks', clock })).toThrow(TypeError)
    expect(() => createRemoteKeySet({ url: 'not a url', clock })).toThrow()
    expect(() => createRemoteKeySet({ url: 'http://localhost:4000/jwks', clock })).toThrow(
      TypeError
    )
    expect(() => createRemoteKeySet({ url: 'http://127.0.0.1:4000/jwks', clock })).toThrow(
      TypeError
    )
    expect(() => createRemoteKeySet({ url: 'https://auth.test/jwks', clock })).not.toThrow()
  })

  test('allowInsecureLocalhost permits http for localhost only', () => {
    const clock = createFixedClock('2026-06-01T00:00:00Z')
    const allow = { clock, allowInsecureLocalhost: true }
    expect(() => createRemoteKeySet({ url: 'http://localhost:4000/jwks', ...allow })).not.toThrow()
    expect(() => createRemoteKeySet({ url: 'http://127.0.0.1:4000/jwks', ...allow })).not.toThrow()
    expect(() => createRemoteKeySet({ url: 'http://auth.test/jwks', ...allow })).toThrow(TypeError)
    expect(() => createRemoteKeySet({ url: 'http://localhost.evil.test/jwks', ...allow })).toThrow(
      TypeError
    )
  })

  test.each([
    ['a user and password', 'https://user:pw@auth.test/jwks'],
    ['a user alone', 'https://user@auth.test/jwks'],
    ['credentials on an allowed local http URL', 'http://user:pw@localhost:4000/jwks'],
  ])('refuses a JWKS URL with %s, without echoing it', (_name, url) => {
    const clock = createFixedClock('2026-06-01T00:00:00Z')
    let message = ''
    try {
      createRemoteKeySet({ url, clock, allowInsecureLocalhost: true })
    } catch (error) {
      message = error instanceof TypeError ? error.message : 'wrong error'
    }
    expect(message).toContain('credentials')
    expect(message).not.toContain('pw')
  })

  test('refuses a stale limit that is not longer than the refresh age', () => {
    const clock = createFixedClock('2026-06-01T00:00:00Z')
    expect(() =>
      createRemoteKeySet({ url: URL_, clock, maxAgeMs: 60_000, maxStaleMs: 60_000 })
    ).toThrow(TypeError)
    expect(() => createRemoteKeySet({ url: URL_, clock, lookupDeadlineMs: 0 })).toThrow(TypeError)
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

  // The padding sits in a field the JWKS schema ignores, so each body would be accepted, k2
  // included, if the size cap did not refuse it first.
  describe('size caps that a parser alone would not enforce', () => {
    const padded = (extra: number) =>
      JSON.stringify({ keys: [k1.publicJwk, k2.publicJwk], pad: 'x'.repeat(extra) })

    test('a valid JWKS padded past the cap with a declared length is refused', async () => {
      const t = setup({ retries: 0 })
      await t.keys.getKey('k1')
      const body = padded(MAX_JWKS_BYTES)
      t.respond(() => new Response(body, { headers: { 'content-length': String(body.length) } }))
      t.clock.advance('31s')
      expect(await t.keys.getKey('k2')).toBeUndefined()
      expect(await t.keys.getKey('k1')).toBeDefined()
      expect(t.logger.entries.map((e) => e.message)).toEqual(['jwks refresh failed'])
    })

    test('a small valid JWKS that declares a length past the cap is refused', async () => {
      const t = setup({ retries: 0 })
      await t.keys.getKey('k1')
      t.respond(
        () => new Response(padded(0), { headers: { 'content-length': String(MAX_JWKS_BYTES + 1) } })
      )
      t.clock.advance('31s')
      expect(await t.keys.getKey('k2')).toBeUndefined()
      expect(await t.keys.getKey('k1')).toBeDefined()
      expect(t.logger.entries.map((e) => e.message)).toEqual(['jwks refresh failed'])
    })

    test('a valid JWKS streamed past the cap with no declared length is refused', async () => {
      const t = setup({ retries: 0 })
      await t.keys.getKey('k1')
      const bytes = new TextEncoder().encode(padded(MAX_JWKS_BYTES))
      t.respond(() => {
        let offset = 0
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset >= bytes.length) {
              controller.close()
              return
            }
            controller.enqueue(bytes.slice(offset, offset + 4096))
            offset += 4096
          },
        })
        return new Response(stream)
      })
      t.clock.advance('31s')
      expect(await t.keys.getKey('k2')).toBeUndefined()
      expect(await t.keys.getKey('k1')).toBeDefined()
      expect(t.logger.entries.map((e) => e.message)).toEqual(['jwks refresh failed'])
    })

    test('the same JWKS just under the cap is accepted', async () => {
      const t = setup({ retries: 0 })
      await t.keys.getKey('k1')
      const base = padded(0).length
      t.respond(() => new Response(padded(MAX_JWKS_BYTES - base)))
      t.clock.advance('31s')
      expect(await t.keys.getKey('k2')).toBeDefined()
    })
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

  test('skips unusable and private entries but keeps the good ones, and says how many', async () => {
    const t = setup()
    t.respond(() =>
      Response.json({ keys: [{ ...k1.publicJwk, d: 'c2VjcmV0' }, { kty: 'RSA' }, k2.publicJwk] })
    )
    expect(await t.keys.getKey('k1')).toBeUndefined()
    expect(await t.keys.getKey('k2')).toBeDefined()
    expect(t.logger.entries).toEqual([
      {
        level: 'error',
        message: 'jwks entry carries private key material',
        fields: { privateEntries: 1 },
      },
      {
        level: 'warn',
        message: 'jwks entries skipped',
        fields: { skipped: 2, received: 3 },
      },
    ])
    const logged = JSON.stringify(t.logger.entries)
    expect(logged).not.toContain('c2VjcmV0')
    expect(logged).not.toContain(k2.publicJwk.x)
  })

  test('a JWKS with no problems logs nothing', async () => {
    const t = setup()
    await t.keys.getKey('k1')
    expect(t.logger.entries).toEqual([])
  })

  test('with a repeated kid the first entry wins and the repeat is counted as skipped', async () => {
    const t = setup()
    t.respond(() => Response.json({ keys: [k1.publicJwk, { ...k2.publicJwk, kid: 'k1' }] }))
    const verifier = createTokenVerifier({
      issuer: 'https://auth.test',
      audience: 'closeline',
      keys: t.keys,
      clock: t.clock,
    })
    await expect(
      verifier.verify(await mintTestToken({ keyPair: k1, clock: t.clock }))
    ).resolves.toBeDefined()
    await expect(
      verifier.verify(await mintTestToken({ keyPair: k2, clock: t.clock, header: { kid: 'k1' } }))
    ).rejects.toMatchObject({ reason: 'invalid' })
    expect(t.logger.entries).toEqual([
      { level: 'warn', message: 'jwks entries skipped', fields: { skipped: 1, received: 2 } },
    ])
  })

  test('warm fetches immediately, ignoring the cooldown, and shares an in-flight fetch', async () => {
    const t = setup()
    await Promise.all([t.keys.warm(), t.keys.warm()])
    expect(t.calls).toHaveLength(1)
    await t.keys.warm()
    expect(t.calls).toHaveLength(2)
  })
})

describe('createRemoteKeySet staleness', () => {
  test('keys that could not be refreshed for a day are dropped, with an error logged', async () => {
    const t = setup({ retries: 0 })
    expect(await t.keys.getKey('k1')).toBeDefined()
    t.respond(() => new Response('down', { status: 503 }))
    t.clock.advance('25h')
    expect(await t.keys.getKey('k1')).toBeUndefined()
    expect(t.keys.available()).toBe(false)
    expect(t.logger.entries.filter((e) => e.level === 'error')).toEqual([
      { level: 'error', message: 'jwks keys dropped as stale', fields: { maxStaleMs: 86_400_000 } },
    ])
  })

  test('keys are still served just inside the stale limit, and a late refresh revives them', async () => {
    const t = setup({ retries: 0 })
    await t.keys.getKey('k1')
    t.respond(() => new Response('down', { status: 503 }))
    t.clock.advance('1439m')
    expect(await t.keys.getKey('k1')).toBeDefined()
    expect(t.keys.available()).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    t.respond(() => Response.json(createTestJwks(k1)))
    t.clock.advance('2m')
    expect(await t.keys.getKey('k1')).toBeDefined()
    expect(t.keys.available()).toBe(true)
  })

  test('maxStaleMs is configurable', async () => {
    const t = setup({ retries: 0, maxAgeMs: 60_000, maxStaleMs: 600_000 })
    await t.keys.getKey('k1')
    t.respond(() => new Response('down', { status: 503 }))
    t.clock.advance('9m')
    expect(await t.keys.getKey('k1')).toBeDefined()
    t.clock.advance('2m')
    expect(await t.keys.getKey('k1')).toBeUndefined()
  })

  test('a well-formed empty JWKS withdraws every key, and that is not an outage', async () => {
    const t = setup()
    await t.keys.getKey('k1')
    t.respond(() => Response.json({ keys: [] }))
    t.clock.advance('31s')
    expect(await t.keys.getKey('unknown')).toBeUndefined()
    expect(await t.keys.getKey('k1')).toBeUndefined()
    expect(t.keys.available()).toBe(true)
    expect(t.logger.entries).toEqual([])
  })

  test('is unavailable until the first successful fetch', async () => {
    const t = setup({ retries: 0 })
    expect(t.keys.available()).toBe(false)
    t.respond(() => new Response('down', { status: 503 }))
    expect(await t.keys.getKey('k1')).toBeUndefined()
    expect(t.keys.available()).toBe(false)
    t.respond(() => Response.json(createTestJwks(k1)))
    t.clock.advance('31s')
    expect(await t.keys.getKey('k1')).toBeDefined()
    expect(t.keys.available()).toBe(true)
  })
})

describe('createRemoteKeySet with a logger that throws', () => {
  const throwingLogger = () => {
    const boom = () => {
      throw new Error('logger down')
    }
    const logger: Logger = { debug: boom, info: boom, warn: boom, error: boom, child: () => logger }
    return logger
  }

  test('getKey still resolves when the refresh fails', async () => {
    const t = setup({ retries: 0, logger: throwingLogger() })
    t.respond(() => new Response('down', { status: 503 }))
    await expect(t.keys.getKey('unknown')).resolves.toBeUndefined()
  })

  test('getKey still resolves when skipped entries are reported', async () => {
    const t = setup({ logger: throwingLogger() })
    t.respond(() => Response.json({ keys: [{ ...k1.publicJwk, d: 'c2VjcmV0' }, k2.publicJwk] }))
    await expect(t.keys.getKey('k2')).resolves.toBeDefined()
  })

  test('a background refresh from a cached hit raises no unhandled rejection', async () => {
    const t = setup({ retries: 0, logger: throwingLogger() })
    await t.keys.getKey('k1')
    t.respond(() => new Response('down', { status: 503 }))
    t.clock.advance('61m')
    const seen: unknown[] = []
    const listener = (reason: unknown) => seen.push(reason)
    process.on('unhandledRejection', listener)
    try {
      await expect(t.keys.getKey('k1')).resolves.toBeDefined()
      await new Promise((resolve) => setTimeout(resolve, 20))
    } finally {
      process.off('unhandledRejection', listener)
    }
    expect(seen).toEqual([])
    expect(t.calls).toHaveLength(2)
  })
})

describe('createRemoteKeySet time handling', () => {
  test('a clock that steps backwards does not stall refreshes', async () => {
    let at = new Date('2026-06-01T12:00:00.000Z').getTime()
    const clock: Clock = { now: () => new Date(at) }
    let fetches = 0
    const keys = createRemoteKeySet({
      url: URL_,
      clock,
      retries: 0,
      fetch: (async () => {
        fetches++
        return Response.json(createTestJwks(k1))
      }) as unknown as typeof fetch,
    })
    await keys.getKey('k1')
    at -= 3_600_000
    await keys.getKey('unknown')
    expect(fetches).toBe(2)
  })

  test('one lookup waits no longer than the overall deadline for a slow key server', async () => {
    const clock = createFixedClock('2026-06-01T12:00:00.000Z')
    const logger = createMemoryLogger()
    let calls = 0
    const stuck = (() => {
      calls++
      return new Promise<Response>(() => {})
    }) as unknown as typeof fetch
    const keys = createRemoteKeySet({
      url: URL_,
      clock,
      logger,
      fetch: stuck,
      timeoutMs: 60_000,
      lookupDeadlineMs: 30,
    })
    const started = performance.now()
    const results = await Promise.all([keys.getKey('a'), keys.getKey('b')])
    expect(results).toEqual([undefined, undefined])
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(calls).toBe(1)
    expect(logger.entries.map((e) => e.message)).toContain('jwks lookup deadline exceeded')
  })

  test('the deadline does not cut short a refresh that finishes in time', async () => {
    const t = setup({ lookupDeadlineMs: 1_000 })
    expect(await t.keys.getKey('k1')).toBeDefined()
    expect(t.logger.entries).toEqual([])
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

  test('an outage with nothing cached is unavailable, not an invalid token', async () => {
    const t = setup({ retries: 0 })
    t.respond(() => new Response('down', { status: 503 }))
    const verifier = createTokenVerifier({
      issuer: 'https://auth.test',
      audience: 'closeline',
      keys: t.keys,
      clock: t.clock,
    })
    const token = await mintTestToken({ keyPair: k1, clock: t.clock })
    await expect(verifier.verify(token)).rejects.toMatchObject({ reason: 'unavailable' })
  })

  test('a key set gone stale is unavailable, and an unknown kid on a fresh set is invalid', async () => {
    const t = setup({ retries: 0 })
    await t.keys.warm()
    const verifier = createTokenVerifier({
      issuer: 'https://auth.test',
      audience: 'closeline',
      keys: t.keys,
      clock: t.clock,
    })
    const unknown = await mintTestToken({ keyPair: k3, clock: t.clock })
    await expect(verifier.verify(unknown)).rejects.toMatchObject({ reason: 'invalid' })
    t.respond(() => new Response('down', { status: 503 }))
    t.clock.advance('25h')
    const token = await mintTestToken({ keyPair: k1, clock: t.clock })
    await expect(verifier.verify(token)).rejects.toMatchObject({ reason: 'unavailable' })
  })
})

describe('when an unknown kid is a bad token and when it is an outage', () => {
  async function loadedVerifier(options: Partial<RemoteKeySetOptions> = {}) {
    const t = setup({ retries: 0, ...options })
    await t.keys.warm()
    const verifier = createTokenVerifier({
      issuer: 'https://auth.test',
      audience: 'closeline',
      keys: t.keys,
      clock: t.clock,
    })
    return {
      ...t,
      verifier,
      forged: () => mintTestToken({ keyPair: k3, clock: t.clock }),
      valid: () => mintTestToken({ keyPair: k1, clock: t.clock }),
    }
  }

  test('a failed refresh makes an unknown kid an outage; a later good one makes it invalid', async () => {
    const t = await loadedVerifier()
    t.respond(() => new Response('down', { status: 503 }))
    t.clock.advance('31s')
    await expect(t.verifier.verify(await t.forged())).rejects.toMatchObject({
      reason: 'unavailable',
    })
    t.respond(() => Response.json(createTestJwks(k1)))
    t.clock.advance('31s')
    await expect(t.verifier.verify(await t.forged())).rejects.toMatchObject({ reason: 'invalid' })
  })

  test('a refresh cut off by the lookup deadline is an outage, not a bad token', async () => {
    const clock = createFixedClock('2026-06-01T12:00:00.000Z')
    let calls = 0
    const keys = createRemoteKeySet({
      url: URL_,
      clock,
      fetch: (async () => {
        calls++
        return calls === 1 ? Response.json(createTestJwks(k1)) : new Promise<Response>(() => {})
      }) as unknown as typeof fetch,
      timeoutMs: 60_000,
      lookupDeadlineMs: 20,
    })
    await keys.warm()
    clock.advance('31s')
    const verifier = createTokenVerifier({
      issuer: 'https://auth.test',
      audience: 'closeline',
      keys,
      clock,
    })
    const forged = await mintTestToken({ keyPair: k3, clock })
    await expect(verifier.verify(forged)).rejects.toMatchObject({ reason: 'unavailable' })
    expect(calls).toBe(2)
  })

  test('a refresh blocked by the cooldown inherits the outcome of the attempt that started it', async () => {
    const t = await loadedVerifier()
    t.clock.advance('31s')
    // The attempt that starts the cooldown succeeds and lacks the kid: invalid, then still invalid.
    await expect(t.verifier.verify(await t.forged())).rejects.toMatchObject({ reason: 'invalid' })
    await expect(t.verifier.verify(await t.forged())).rejects.toMatchObject({ reason: 'invalid' })
    expect(t.calls).toHaveLength(2)
    // The attempt that starts the next cooldown fails: unavailable, and still unavailable.
    t.respond(() => new Response('down', { status: 503 }))
    t.clock.advance('31s')
    await expect(t.verifier.verify(await t.forged())).rejects.toMatchObject({
      reason: 'unavailable',
    })
    await expect(t.verifier.verify(await t.forged())).rejects.toMatchObject({
      reason: 'unavailable',
    })
    expect(t.calls).toHaveLength(3)
  })

  test('a failed warm-up leaves an unknown kid an outage even though keys were loaded before', async () => {
    const t = await loadedVerifier()
    t.respond(() => new Response('down', { status: 503 }))
    await t.keys.warm()
    await expect(t.verifier.verify(await t.forged())).rejects.toMatchObject({
      reason: 'unavailable',
    })
  })

  test('a flood of forged kids during an outage never turns cached-key traffic into 503s', async () => {
    const t = await loadedVerifier()
    t.respond(() => new Response('down', { status: 503 }))
    t.clock.advance('31s')
    const forged = await t.forged()
    const valid = await t.valid()
    const fetchesBefore = t.calls.length
    for (let i = 0; i < 100; i++) {
      await expect(t.verifier.verify(forged)).rejects.toMatchObject({ reason: 'unavailable' })
      await expect(t.verifier.verify(valid)).resolves.toMatchObject({ role: 'rep' })
    }
    expect(t.calls.length - fetchesBefore).toBe(1)
  })

  test('the static key set always confirms that an unknown kid is absent', async () => {
    const set = await createStaticKeySet(createTestJwks(k1))
    expect(set.confirmsAbsent('nobody')).toBe(true)
  })
})

describe('createRemoteKeySet bookkeeping', () => {
  test('the lookup deadline timer is cleared when the refresh finishes first', async () => {
    const deadlineMs = 1_234
    const pending = new Set<unknown>()
    const realSet = globalThis.setTimeout
    const realClear = globalThis.clearTimeout
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      const id = realSet(fn, ms, ...rest)
      if (ms === deadlineMs) {
        pending.add(id)
      }
      return id
    }) as unknown as typeof setTimeout
    globalThis.clearTimeout = ((id?: Parameters<typeof clearTimeout>[0]) => {
      pending.delete(id)
      realClear(id)
    }) as typeof clearTimeout
    try {
      const t = setup({ lookupDeadlineMs: deadlineMs })
      expect(await t.keys.getKey('k1')).toBeDefined()
      expect(pending.size).toBe(0)
    } finally {
      globalThis.setTimeout = realSet
      globalThis.clearTimeout = realClear
      for (const id of pending) {
        realClear(id as Parameters<typeof clearTimeout>[0])
      }
    }
  })

  test('available() drops keys that have gone stale without any lookup in between', async () => {
    const t = setup()
    await t.keys.warm()
    expect(t.keys.available()).toBe(true)
    t.clock.advance('25h')
    expect(t.keys.available()).toBe(false)
    expect(t.logger.entries.map((e) => e.message)).toContain('jwks keys dropped as stale')
  })
})
