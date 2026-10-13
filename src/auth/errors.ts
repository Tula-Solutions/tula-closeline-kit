/** Why a token was rejected. Deliberately coarse: it is safe to return to a client and to log. */
export type TokenRejection = 'expired' | 'invalid'

/** Thrown by a TokenVerifier for any token it will not accept; carries no token content. */
export class TokenVerificationError extends Error {
  readonly reason: TokenRejection

  constructor(reason: TokenRejection) {
    super(reason === 'expired' ? 'Token expired' : 'Token rejected')
    this.name = 'TokenVerificationError'
    this.reason = reason
  }
}
