import { decodeProtectedHeader, errors as joseErrors, jwtVerify } from 'jose'
import type { Clock } from '../clock'
import { accessTokenClaimsSchema, MAX_TOKEN_LENGTH, type VerifiedToken } from './claims'
import { type TokenRejection, TokenVerificationError } from './errors'
import type { KeySet } from './keys'

/** The only signature algorithm Closeline access tokens use. */
const ALGORITHM = 'EdDSA'
/** The header `typ` of every access token (RFC 9068), so no other JWT can pass as one. */
const TOKEN_TYPE = 'at+jwt'
const MAX_KID_LENGTH = 128
const MAX_CLOCK_TOLERANCE_SECONDS = 120

/** Options for createTokenVerifier. */
export interface TokenVerifierOptions {
  /** The `iss` claim every token must carry. */
  issuer: string
  /** The `aud` claim every token must carry. */
  audience: string
  /** Where signing keys come from. */
  keys: KeySet
  /** Time source for `exp`, `nbf` and `iat`; never the real clock in tests. */
  clock: Clock
  /** Allowed clock skew in seconds, at most 120; defaults to 30. */
  clockToleranceSeconds?: number
}

/** Checks access tokens offline against a key set. */
export interface TokenVerifier {
  /**
   * Returns the identity in a valid token, or throws a TokenVerificationError: `expired` or
   * `invalid` for the token, `unavailable` when the signing keys could not be loaded.
   */
  verify(token: string): Promise<VerifiedToken>
}

function reject(reason: TokenRejection = 'invalid'): never {
  throw new TokenVerificationError(reason)
}

/**
 * Creates a verifier for EdDSA access tokens. Complexity per call is O(token length) with one
 * Ed25519 verification and one Map lookup; with a cached key it does no I/O.
 */
export function createTokenVerifier(options: TokenVerifierOptions): TokenVerifier {
  const { issuer, audience, keys, clock } = options
  const toleranceSeconds = options.clockToleranceSeconds ?? 30
  if (issuer === '' || audience === '') {
    throw new TypeError('issuer and audience are required')
  }
  if (
    !Number.isFinite(toleranceSeconds) ||
    toleranceSeconds < 0 ||
    toleranceSeconds > MAX_CLOCK_TOLERANCE_SECONDS
  ) {
    throw new TypeError(`clockToleranceSeconds must be 0 to ${MAX_CLOCK_TOLERANCE_SECONDS}`)
  }

  function readKid(token: string): string {
    let header: ReturnType<typeof decodeProtectedHeader>
    try {
      header = decodeProtectedHeader(token)
    } catch {
      return reject()
    }
    // The algorithm is checked before any key is looked up, so `none` and HMAC never get that far.
    if (header.alg !== ALGORITHM) {
      return reject()
    }
    // Exactly `at+jwt`, checked here so a refresh token or other JWT never costs a key lookup.
    if (header.typ !== TOKEN_TYPE) {
      return reject()
    }
    const kid = header.kid
    if (typeof kid !== 'string' || kid === '' || kid.length > MAX_KID_LENGTH) {
      return reject()
    }
    return kid
  }

  return {
    async verify(token) {
      if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
        return reject()
      }
      const kid = readKid(token)
      const key = await keys.getKey(kid)
      if (key === undefined) {
        // A bad token only if the issuer last answered in full and lacked this kid; otherwise a
        // forged kid cannot be told from a newly rotated key, so it is our outage.
        return reject(keys.confirmsAbsent(kid) ? 'invalid' : 'unavailable')
      }
      const now = clock.now()
      let payload: unknown
      try {
        const result = await jwtVerify(token, key, {
          algorithms: [ALGORITHM],
          typ: TOKEN_TYPE,
          issuer,
          audience,
          clockTolerance: toleranceSeconds,
          currentDate: now,
          requiredClaims: ['exp', 'iat', 'sub'],
        })
        payload = result.payload
      } catch (error) {
        return reject(error instanceof joseErrors.JWTExpired ? 'expired' : 'invalid')
      }
      const claims = accessTokenClaimsSchema.safeParse(payload)
      if (!claims.success) {
        return reject()
      }
      const { sub, org, role, region, iat, exp } = claims.data
      // jose does not look at `iat`: a token claiming to be from the future, or to expire before
      // it began, was not minted by a clock we trust.
      if (iat > now.getTime() / 1000 + toleranceSeconds || exp <= iat) {
        return reject()
      }
      return {
        userId: sub,
        organizationId: org,
        role,
        region,
        issuedAt: new Date(iat * 1000),
        expiresAt: new Date(exp * 1000),
      }
    },
  }
}
