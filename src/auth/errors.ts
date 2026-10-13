/**
 * Why a token was not accepted. Deliberately coarse: it is safe to return to a client and to log.
 * `unavailable` means the signing keys could not be loaded, which says nothing about the token.
 */
export type TokenRejection = 'expired' | 'invalid' | 'unavailable'

const MESSAGES: Record<TokenRejection, string> = {
  expired: 'Token expired',
  invalid: 'Token rejected',
  unavailable: 'Token verification unavailable',
}

/** Thrown by a TokenVerifier for any token it will not accept, or cannot check; carries no token content. */
export class TokenVerificationError extends Error {
  readonly reason: TokenRejection

  constructor(reason: TokenRejection) {
    super(MESSAGES[reason])
    this.name = 'TokenVerificationError'
    this.reason = reason
  }
}
