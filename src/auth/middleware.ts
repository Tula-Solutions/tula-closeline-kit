import type { Context, MiddlewareHandler } from 'hono'
import type {
  ApiKeyId,
  ApiKeyScope,
  OrganizationId,
  Region,
  Role,
  UserId,
} from 'tula-closeline-contract'
import { type Clock, systemClock } from '../clock'
import { AppError } from '../errors'
import type { Logger } from '../logger'
import { MAX_TOKEN_LENGTH, type VerifiedIdentity } from './claims'
import { TokenVerificationError } from './errors'
import { isScopeGuard } from './scope'
import type { TokenVerifier } from './verifier'

/** The context variables the auth middleware sets; pass as `new Hono<AuthEnv>()`. */
export interface AuthEnv {
  Variables: AuthVariables
}

/**
 * The context variables on a route that has opted in to API keys with requireScope; pass as
 * `new Hono<ScopedAuthEnv>()`. The caller is a member or an API key, so `role` and `userId`
 * exist only for a member, and `apiKeyId` and `scopes` only for an API key.
 */
export interface ScopedAuthEnv {
  Variables: ScopedAuthVariables
}

/** The verified caller on a route behind requireScope; branch on `actor`. */
export interface ScopedAuthVariables {
  /** Who is calling: a signed-in member or an API key. */
  actor: 'member' | 'api_key'
  /** The Organization every query for this request must be scoped to. */
  organizationId: OrganizationId
  /** The Region the Organization lives in. */
  region: Region
  /** The signed-in user; set only when `actor` is `member`. */
  userId?: UserId
  /** The user's role; set only when `actor` is `member`, never for an API key. */
  role?: Role
  /** The API key; set only when `actor` is `api_key`. */
  apiKeyId?: ApiKeyId
  /** What the API key may do; set only when `actor` is `api_key`. */
  scopes?: readonly ApiKeyScope[]
}

/** The verified member behind a route, read with `c.get('organizationId')` and so on. */
export interface AuthVariables {
  /** Always a member here: the middleware refuses an API key on a route that has not opted in. */
  actor: 'member'
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
  /**
   * Receives a warning with only a coarse reason for each rejected request, and an error for each
   * request that failed because verification was unavailable or threw (error class name only).
   * Those errors are written at most once a second; the next line says how many were held back.
   */
  logger?: Logger
  /** Time source for the error log limit; defaults to the system clock. */
  clock?: Clock
}

const BEARER = /^Bearer ([^\s]+)$/i

function unauthenticated(): AppError {
  return new AppError({
    code: 'auth.unauthenticated',
    status: 401,
    message: 'Authentication is required.',
  })
}

// Only the class name is logged: a message or cause could carry the token or key material.
function errorClass(error: unknown): string {
  return error instanceof Error ? (error.constructor?.name ?? 'Error') : typeof error
}

function unavailable(): AppError {
  return new AppError({
    code: 'auth.unavailable',
    status: 503,
    message: 'Authentication is temporarily unavailable.',
  })
}

const ERROR_LOG_INTERVAL_MS = 1_000

/** Writes error lines at most once per interval, carrying the count of the lines it held back. */
function createErrorLimiter(logger: Logger | undefined, clock: Clock) {
  let lastWrittenAt: number | undefined
  let suppressed = 0
  return (message: string, fields: Record<string, unknown>): void => {
    if (logger === undefined) {
      return
    }
    const now = clock.now().getTime()
    // A clock that stepped backwards counts as elapsed, so the log is never silenced for long.
    const elapsed = lastWrittenAt === undefined ? Number.POSITIVE_INFINITY : now - lastWrittenAt
    if (elapsed >= 0 && elapsed < ERROR_LOG_INTERVAL_MS) {
      suppressed++
      return
    }
    lastWrittenAt = now
    logger.error(message, suppressed > 0 ? { ...fields, suppressed } : fields)
    suppressed = 0
  }
}

type ErrorLogger = ReturnType<typeof createErrorLimiter>

function toAppError(error: unknown, logger: Logger | undefined, logError: ErrorLogger): AppError {
  if (!(error instanceof TokenVerificationError)) {
    logError('token verification failed unexpectedly', { errorClass: errorClass(error) })
    return unavailable()
  }
  if (error.reason === 'unavailable') {
    logError('token verification unavailable', { reason: error.reason })
    return unavailable()
  }
  logger?.warn('request rejected', { reason: error.reason })
  return new AppError({
    code: error.reason === 'expired' ? 'auth.token_expired' : 'auth.token_invalid',
    status: 401,
    message:
      error.reason === 'expired'
        ? 'The access token has expired.'
        : 'The access token is not valid.',
  })
}

/**
 * Creates Hono middleware that requires a valid `Authorization: Bearer` access token. For a member
 * it sets actor, organizationId, userId, role and region. An API key token is refused with 403
 * `auth.forbidden` unless a matched route carries a requireScope guard, which opts the route in;
 * then it sets actor, organizationId, region, apiKeyId and scopes, and no role. On failure it
 * throws an AppError: 401 with `auth.unauthenticated`, `auth.token_expired` or
 * `auth.token_invalid`, or 503 with `auth.unavailable` when the signing keys could not be loaded
 * or verification threw.
 */
export function createAuthMiddleware(options: AuthMiddlewareOptions): MiddlewareHandler<AuthEnv> {
  const { verifier, logger } = options
  const logError = createErrorLimiter(logger, options.clock ?? systemClock)
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
    let verified: VerifiedIdentity
    try {
      verified = await verifier.verify(token)
    } catch (error) {
      throw toAppError(error, logger, logError)
    }
    if (verified.actor === 'api_key') {
      // Fail closed: an API key reaches only routes that name the scope they need.
      if (!c.req.matchedRoutes.some((route) => isScopeGuard(route.handler))) {
        logger?.warn('request rejected', { reason: 'forbidden' })
        throw new AppError({
          code: 'auth.forbidden',
          status: 403,
          message: 'You are not allowed to do this.',
        })
      }
      const scoped = c as unknown as Context<ScopedAuthEnv>
      scoped.set('actor', 'api_key')
      scoped.set('organizationId', verified.organizationId)
      scoped.set('region', verified.region)
      scoped.set('apiKeyId', verified.apiKeyId)
      scoped.set('scopes', verified.scopes)
      await next()
      return
    }
    c.set('actor', 'member')
    c.set('organizationId', verified.organizationId)
    c.set('userId', verified.userId)
    c.set('role', verified.role)
    c.set('region', verified.region)
    await next()
  }
}
