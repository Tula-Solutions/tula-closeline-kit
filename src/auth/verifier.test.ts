import { beforeAll, describe, expect, test } from 'bun:test'
import { createFixedClock } from '../clock'
import { MAX_TOKEN_LENGTH } from './claims'
import { TokenVerificationError } from './errors'
import { createStaticKeySet, type KeySet } from './keys'
import {
  createTestJwks,
  createTestKeyPair,
  DEFAULT_TEST_ORGANIZATION_ID,
  DEFAULT_TEST_USER_ID,
  mintTestToken,
  type TestKeyPair,
  testOrganizationId,
} from './testing'
import { createTokenVerifier, type TokenVerifier } from './verifier'

const ISSUER = 'https://auth.test'
const AUDIENCE = 'closeline'

const clock = createFixedClock('2026-06-01T12:00:00.000Z')
let pair: TestKeyPair
let other: TestKeyPair
let lookups: string[]
let verifier: TokenVerifier

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const mint = (
  overrides: Parameters<typeof mintTestToken>[0] extends infer T ? Partial<T> : never
) => mintTestToken({ keyPair: pair, clock, ...overrides })

async function rejectedWith(
  token: string,
  reason: 'expired' | 'invalid' | 'unavailable' = 'invalid'
) {
  const error = await verifier.verify(token).then(
    () => undefined,
    (e: unknown) => e
  )
  expect(error).toBeInstanceOf(TokenVerificationError)
  expect((error as TokenVerificationError).reason).toBe(reason)
}

beforeAll(async () => {
  pair = await createTestKeyPair('key-1')
  other = await createTestKeyPair('key-2')
  const inner = await createStaticKeySet(createTestJwks(pair))
  lookups = []
  const keys: KeySet = {
    getKey: (kid) => {
      lookups.push(kid)
      return inner.getKey(kid)
    },
    available: () => inner.available(),
    confirmsAbsent: (kid) => inner.confirmsAbsent(kid),
  }
  verifier = createTokenVerifier({ issuer: ISSUER, audience: AUDIENCE, keys, clock })
})

describe('algorithm and header', () => {
  test.each([
    ['none', `${b64({ alg: 'none', kid: 'key-1' })}.${b64({ sub: 'x' })}.`],
    ['HS256', `${b64({ alg: 'HS256', kid: 'key-1' })}.${b64({ sub: 'x' })}.c2ln`],
    ['RS256', `${b64({ alg: 'RS256', kid: 'key-1' })}.${b64({ sub: 'x' })}.c2ln`],
    ['ES256', `${b64({ alg: 'ES256', kid: 'key-1' })}.${b64({ sub: 'x' })}.c2ln`],
    ['a missing alg', `${b64({ kid: 'key-1' })}.${b64({ sub: 'x' })}.c2ln`],
  ])('a token signed with %s is rejected before any key is looked up', async (_name, token) => {
    lookups.length = 0
    await rejectedWith(token)
    expect(lookups).toEqual([])
  })

  test('a token without a kid is rejected', async () => {
    await rejectedWith(await mint({ header: { kid: undefined } }))
  })

  test('a token with an empty or oversized kid is rejected', async () => {
    await rejectedWith(await mint({ header: { kid: '' } }))
    lookups.length = 0
    await rejectedWith(await mint({ header: { kid: 'k'.repeat(129) } }))
    expect(lookups).toEqual([])
  })

  test('a token with a kid that is not a string is rejected', async () => {
    await rejectedWith(await mint({ header: { kid: 7 } }))
  })

  test('a token with an unknown kid is rejected', async () => {
    await rejectedWith(await mint({ header: { kid: 'nobody' } }))
  })

  test('a token signed by a key that is not the one named by its kid is rejected', async () => {
    await rejectedWith(await mint({ keyPair: other, header: { kid: 'key-1' } }))
  })
})

describe('token type (RFC 9068)', () => {
  test('a token stamped at+jwt is accepted', async () => {
    await expect(verifier.verify(await mint({}))).resolves.toBeDefined()
  })

  test.each([
    ['a missing typ', undefined],
    ['a refresh token', 'refresh'],
    ['a plain JWT', 'JWT'],
    ['at+jwt in another letter case', 'AT+JWT'],
    ['the media-type form', 'application/at+jwt'],
    ['an empty typ', ''],
    ['a typ that is not a string', 7],
  ])('%s is rejected before any key is looked up', async (_name, typ) => {
    lookups.length = 0
    await rejectedWith(await mint({ header: { typ } }))
    expect(lookups).toEqual([])
  })
})

describe('an unavailable key set', () => {
  const unknownKid = () => mint({ header: { kid: 'nobody' } })

  test('is reported as unavailable, not as an invalid token', async () => {
    const v = createTokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      keys: { getKey: async () => undefined, available: () => false, confirmsAbsent: () => false },
      clock,
    })
    const error = await v.verify(await unknownKid()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TokenVerificationError)
    expect((error as TokenVerificationError).reason).toBe('unavailable')
  })

  test('a kid the loaded keys do not hold is still an invalid token', async () => {
    const v = createTokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      keys: { getKey: async () => undefined, available: () => true, confirmsAbsent: () => true },
      clock,
    })
    await expect(v.verify(await unknownKid())).rejects.toMatchObject({ reason: 'invalid' })
  })

  test('a loaded key set that cannot confirm the kid is absent is an outage, not a bad token', async () => {
    const v = createTokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      keys: { getKey: async () => undefined, available: () => true, confirmsAbsent: () => false },
      clock,
    })
    await expect(v.verify(await unknownKid())).rejects.toMatchObject({ reason: 'unavailable' })
  })

  test('a token that was malformed anyway is invalid, whatever the key set is doing', async () => {
    const v = createTokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      keys: { getKey: async () => undefined, available: () => false, confirmsAbsent: () => false },
      clock,
    })
    await expect(v.verify('not.a.token')).rejects.toMatchObject({ reason: 'invalid' })
  })
})

describe('malformed and oversized tokens', () => {
  test.each([
    ['an empty string', ''],
    ['not a JWT', 'hello'],
    ['two parts', 'abc.def'],
    ['four parts', 'a.b.c.d'],
    ['a non-JSON header', 'bm90anNvbg.e30.c2ln'],
    ['a header that is not an object', `${b64([1])}.e30.c2ln`],
    ['unicode noise', '\u0000☃.☃.☃'],
  ])('%s is rejected', async (_name, token) => {
    await rejectedWith(token)
  })

  test('a non-string is rejected', async () => {
    await rejectedWith(undefined as unknown as string)
  })

  test('a token over the length cap is rejected without a key lookup', async () => {
    const token = await mint({ claims: { pad: 'x'.repeat(MAX_TOKEN_LENGTH) } })
    expect(token.length).toBeGreaterThan(MAX_TOKEN_LENGTH)
    lookups.length = 0
    await rejectedWith(token)
    expect(lookups).toEqual([])
  })

  test('a token just under the cap is still verified', async () => {
    const small = await mint({})
    const pad = Math.floor((MAX_TOKEN_LENGTH - small.length) * 0.75) - 16
    const token = await mint({ claims: { pad: 'x'.repeat(pad) } })
    expect(token.length).toBeGreaterThan(MAX_TOKEN_LENGTH - 40)
    expect(token.length).toBeLessThanOrEqual(MAX_TOKEN_LENGTH)
    await expect(verifier.verify(token)).resolves.toBeDefined()
  })
})

describe('tampering', () => {
  test('a changed payload with the original signature is rejected', async () => {
    const [header, payload, signature] = (await mint({})).split('.')
    const claims = JSON.parse(Buffer.from(payload as string, 'base64url').toString())
    claims.role = 'owner'
    claims.org = testOrganizationId(2)
    await rejectedWith(`${header}.${b64(claims)}.${signature}`)
  })

  test('a changed signature is rejected', async () => {
    const [header, payload, signature] = (await mint({})).split('.')
    const flipped = (signature?.[0] === 'A' ? 'B' : 'A') + signature?.slice(1)
    await rejectedWith(`${header}.${payload}.${flipped}`)
  })

  test('a missing signature is rejected', async () => {
    const [header, payload] = (await mint({})).split('.')
    await rejectedWith(`${header}.${payload}.`)
  })

  test('a changed header with the original signature is rejected', async () => {
    const [, payload, signature] = (await mint({})).split('.')
    await rejectedWith(`${b64({ alg: 'EdDSA', kid: 'key-1', x: 1 })}.${payload}.${signature}`)
  })
})

describe('issuer and audience', () => {
  test('a wrong issuer is rejected', async () => {
    await rejectedWith(await mint({ issuer: 'https://evil.test' }))
  })

  test('a missing issuer is rejected', async () => {
    await rejectedWith(await mint({ claims: { iss: undefined } }))
  })

  test('a wrong audience is rejected', async () => {
    await rejectedWith(await mint({ audience: 'another-app' }))
  })

  test('a missing audience is rejected', async () => {
    await rejectedWith(await mint({ claims: { aud: undefined } }))
  })

  test('an audience list that includes ours is accepted', async () => {
    await expect(
      verifier.verify(await mint({ claims: { aud: ['x', AUDIENCE] } }))
    ).resolves.toBeDefined()
  })
})

describe('time', () => {
  test('an expired token is rejected as expired', async () => {
    await rejectedWith(await mint({ expiresInSeconds: -60 }), 'expired')
  })

  test('a token is accepted until its exp plus the tolerance and not after', async () => {
    await expect(
      verifier.verify(await mint({ issuedAtOffsetSeconds: -900, expiresInSeconds: -29 }))
    ).resolves.toBeDefined()
    await rejectedWith(
      await mint({ issuedAtOffsetSeconds: -900, expiresInSeconds: -30 }),
      'expired'
    )
  })

  test('a token that was valid becomes expired as the clock advances', async () => {
    const local = createFixedClock('2026-06-01T12:00:00.000Z')
    const v = createTokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      keys: await createStaticKeySet(createTestJwks(pair)),
      clock: local,
      clockToleranceSeconds: 0,
    })
    const token = await mintTestToken({ keyPair: pair, clock: local, expiresInSeconds: 900 })
    await expect(v.verify(token)).resolves.toBeDefined()
    local.advance('14m')
    await expect(v.verify(token)).resolves.toBeDefined()
    local.advance('1m')
    await expect(v.verify(token)).rejects.toMatchObject({ reason: 'expired' })
  })

  test('a token that is not yet valid is rejected', async () => {
    await rejectedWith(await mint({ notBeforeSeconds: 60 }))
  })

  test('a not-before inside the tolerance is accepted', async () => {
    await expect(verifier.verify(await mint({ notBeforeSeconds: 30 }))).resolves.toBeDefined()
  })

  test('a token issued in the future is rejected', async () => {
    await rejectedWith(await mint({ issuedAtOffsetSeconds: 60 }))
  })

  test('a token issued slightly in the future, within the tolerance, is accepted', async () => {
    await expect(verifier.verify(await mint({ issuedAtOffsetSeconds: 30 }))).resolves.toBeDefined()
  })

  test('a token that expires before it was issued is rejected', async () => {
    await rejectedWith(await mint({ issuedAtOffsetSeconds: 20, expiresInSeconds: 10 }))
  })

  test('a token without exp or iat is rejected', async () => {
    await rejectedWith(await mint({ claims: { exp: undefined } }))
    await rejectedWith(await mint({ claims: { iat: undefined } }))
  })

  test('exp and iat that are not numbers are rejected', async () => {
    await rejectedWith(await mint({ claims: { exp: '9999999999' } }))
    await rejectedWith(await mint({ claims: { iat: 'now' } }))
  })
})

describe('claims shape', () => {
  test.each([
    ['no sub', { sub: undefined }],
    ['a sub that is not a user id', { sub: testOrganizationId(1) }],
    ['a sub that is a number', { sub: 7 }],
    ['no org', { org: undefined }],
    ['an org that is a user id', { org: DEFAULT_TEST_USER_ID }],
    ['an org that is not an id', { org: 'acme' }],
    ['no role', { role: undefined }],
    ['an unknown role', { role: 'superuser' }],
    ['a role that is not a string', { role: ['owner'] }],
    ['no region', { region: undefined }],
    ['an unknown region', { region: 'mars' }],
  ])('a token with %s is rejected', async (_name, claims) => {
    await rejectedWith(await mint({ claims }))
  })
})

describe('a valid token', () => {
  test('yields the user, Organization, role, Region and times it carries', async () => {
    const org = testOrganizationId(9)
    const verified = await verifier.verify(
      await mint({ claims: { org, role: 'manager', region: 'eu' }, expiresInSeconds: 600 })
    )
    expect(verified.organizationId).toBe(org)
    expect(verified.userId).toBe(DEFAULT_TEST_USER_ID)
    expect(verified.role).toBe('manager')
    expect(verified.region).toBe('eu')
    expect(verified.issuedAt).toEqual(new Date('2026-06-01T12:00:00.000Z'))
    expect(verified.expiresAt).toEqual(new Date('2026-06-01T12:10:00.000Z'))
  })

  test('is accepted with extra claims it does not know', async () => {
    const verified = await verifier.verify(await mint({ claims: { jti: 'abc', sid: 'ses_1' } }))
    expect(verified.organizationId).toBe(DEFAULT_TEST_ORGANIZATION_ID)
  })
})

describe('key rotation', () => {
  test('tokens from both the old and the new key verify while both are published', async () => {
    const v = createTokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      keys: await createStaticKeySet(createTestJwks(pair, other)),
      clock,
    })
    await expect(v.verify(await mint({}))).resolves.toBeDefined()
    await expect(v.verify(await mint({ keyPair: other }))).resolves.toBeDefined()
  })

  test('tokens from a key that was withdrawn are rejected', async () => {
    const v = createTokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      keys: await createStaticKeySet(createTestJwks(other)),
      clock,
    })
    await expect(v.verify(await mint({}))).rejects.toBeInstanceOf(TokenVerificationError)
    await expect(v.verify(await mint({ keyPair: other }))).resolves.toBeDefined()
  })
})

describe('configuration', () => {
  test('an empty issuer or audience is refused', async () => {
    const keys = await createStaticKeySet(createTestJwks(pair))
    expect(() => createTokenVerifier({ issuer: '', audience: AUDIENCE, keys, clock })).toThrow(
      TypeError
    )
    expect(() => createTokenVerifier({ issuer: ISSUER, audience: '', keys, clock })).toThrow(
      TypeError
    )
  })

  test.each([-1, 121, Number.NaN])(
    'a clock tolerance of %p is refused',
    async (clockToleranceSeconds) => {
      const keys = await createStaticKeySet(createTestJwks(pair))
      expect(() =>
        createTokenVerifier({
          issuer: ISSUER,
          audience: AUDIENCE,
          keys,
          clock,
          clockToleranceSeconds,
        })
      ).toThrow(TypeError)
    }
  )

  test('a rejection never carries the token', async () => {
    const token = await mint({ audience: 'another-app' })
    const error = await verifier.verify(token).catch((e: Error) => e)
    expect(JSON.stringify(error)).not.toContain(token)
    expect((error as Error).message).not.toContain(token)
    expect((error as Error).message).not.toContain('audience')
  })
})
