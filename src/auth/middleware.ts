import type { MiddlewareHandler } from 'hono'
import type { OrganizationId, Region, Role, UserId } from 'tula-closeline-contract'
import { AppError } from '../errors'
import type { Logger } from '../logger'
import { MAX_TOKEN_LENGTH } from './claims'
import { TokenVerificationError } from './errors'
import type { TokenVerifier } from './verifier'

/** The context variables the auth middleware sets; pass as `new Hono<AuthEnv>()`. */
export interface AuthEnv {
  Variables: AuthVariables
}

/** The verified identity of the caller, read with `c.get('organizationId')` and so on. */
export interface AuthVariables {
  /** The Organization every query for this request must be scoped to. */
  organizationId: OrganizationId
  /** The signed-in user. */
  userId: UserId
  /** The user's role in that Organization. */
  role: Role
  /** The Region the Organization lives in. */
  region: Region
}

/** Options for createAuthMiddleware. */
export interface AuthMiddlewareOptions {
  /** Verifies the bearer token. */
  verifier: TokenVerifier
  /** Receives a warning, with only a coarse reason, for each rejected request. */
  logger?: Logger
}

const BEARER = /^Bearer ([^\s]+)$/i

function unauthenticated(): AppError {
  return new AppError({
    code: 'auth.unauthenticated',
    status: 401,
    message: 'Authentication is required.',
  })
}

/**
 * Creates Hono middleware that requires a valid `Authorization: Bearer` access token. On success
 * it sets organizationId, userId, role and region; on failure it throws a 401 AppError with
 * `auth.unauthenticated`, `auth.token_expired` or `auth.token_invalid`.
 */
export function createAuthMiddleware(options: AuthMiddlewareOptions): MiddlewareHandler<AuthEnv> {
  const { verifier, logger } = options
  return async (c, next) => {
    const header = c.req.header('authorization')
    const token =
      header !== undefined && header.length <= MAX_TOKEN_LENGTH + 7
        ? BEARER.exec(header)?.[1]
        : undefined
    if (token === undefined) {
      logger?.warn('request rejected', { reason: 'unauthenticated' })
      throw unauthenticated()
    }
    let verified: Awaited<ReturnType<TokenVerifier['verify']>>
    try {
      verified = await verifier.verify(token)
    } catch (error) {
      const reason = error instanceof TokenVerificationError ? error.reason : 'invalid'
      logger?.warn('request rejected', { reason })
      throw new AppError({
        code: reason === 'expired' ? 'auth.token_expired' : 'auth.token_invalid',
        status: 401,
        message:
          reason === 'expired' ? 'The access token has expired.' : 'The access token is not valid.',
      })
    }
    c.set('organizationId', verified.organizationId)
    c.set('userId', verified.userId)
    c.set('role', verified.role)
    c.set('region', verified.region)
    await next()
  }
}
