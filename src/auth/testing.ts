import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { formatId } from 'tula-closeline-contract'
import type { Clock } from '../clock'
import type { Jwks } from './keys'

/** An Ed25519 key pair for signing tokens in tests. */
export interface TestKeyPair {
  /** The `kid` tokens signed with this pair carry. */
  kid: string
  /** The private key; never leaves the test. */
  privateKey: CryptoKey
  /** The public half as a JWK with `kid`, ready for a JWKS. */
  publicJwk: { kty: 'OKP'; crv: 'Ed25519'; x: string; kid: string; use: 'sig'; alg: 'EdDSA' }
}

/** A user id for tests; `n` picks which one. */
export const testUserId = (n = 1) => formatId('usr', n.toString(16).padStart(32, '0'))
/** An Organization id for tests; `n` picks which one. */
export const testOrganizationId = (n = 1) => formatId('org', n.toString(16).padStart(32, '0'))

/** Generates an Ed25519 key pair for tests. */
export async function createTestKeyPair(kid = 'test-key-1'): Promise<TestKeyPair> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' })
  const jwk = await exportJWK(publicKey)
  if (jwk.x === undefined) {
    throw new Error('Ed25519 public key has no x')
  }
  return {
    kid,
    privateKey,
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid, use: 'sig', alg: 'EdDSA' },
  }
}

/** Builds the JWKS an auth service would publish for these key pairs. */
export function createTestJwks(...pairs: TestKeyPair[]): Jwks {
  return { keys: pairs.map((pair) => pair.publicJwk) }
}

/** What to put in a test token; every field has a valid default. */
export interface MintTokenOptions {
  /** The pair to sign with. */
  keyPair: TestKeyPair
  /** Time source; `iat` and `exp` are relative to it. */
  clock: Clock
  /** The `iss` claim; defaults to `https://auth.test`. */
  issuer?: string
  /** The `aud` claim; defaults to `closeline`. */
  audience?: string
  /** Seconds until expiry, negative for an already-expired token; defaults to 900. */
  expiresInSeconds?: number
  /** Seconds from now before the token becomes valid, if it should carry `nbf`. */
  notBeforeSeconds?: number
  /** Seconds to shift `iat` by, e.g. positive for a token issued in the future. */
  issuedAtOffsetSeconds?: number
  /** Claims to add or override, e.g. `{ role: 'admin' }`; `undefined` removes a claim. */
  claims?: Record<string, unknown>
  /** Header fields to add or override, e.g. `{ kid: 'other' }`; `undefined` removes one. */
  header?: Record<string, unknown>
}

/** The default Organization id minted into test tokens. */
export const DEFAULT_TEST_ORGANIZATION_ID = testOrganizationId(1)
/** The default user id minted into test tokens. */
export const DEFAULT_TEST_USER_ID = testUserId(1)

/** Signs a valid access token for tests, with knobs to break one thing at a time. */
export async function mintTestToken(options: MintTokenOptions): Promise<string> {
  const nowSeconds = Math.floor(options.clock.now().getTime() / 1000)
  const iat = nowSeconds + (options.issuedAtOffsetSeconds ?? 0)
  const payload: Record<string, unknown> = {
    iss: options.issuer ?? 'https://auth.test',
    aud: options.audience ?? 'closeline',
    sub: DEFAULT_TEST_USER_ID,
    org: DEFAULT_TEST_ORGANIZATION_ID,
    role: 'rep',
    region: 'us',
    iat,
    exp: nowSeconds + (options.expiresInSeconds ?? 900),
    ...(options.notBeforeSeconds === undefined
      ? {}
      : { nbf: nowSeconds + options.notBeforeSeconds }),
    ...options.claims,
  }
  const header: Record<string, unknown> = {
    alg: 'EdDSA',
    kid: options.keyPair.kid,
    ...options.header,
  }
  const jwt = new SignJWT(
    Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined))
  )
  jwt.setProtectedHeader(
    Object.fromEntries(Object.entries(header).filter(([, value]) => value !== undefined)) as {
      alg: string
    }
  )
  return jwt.sign(options.keyPair.privateKey)
}
