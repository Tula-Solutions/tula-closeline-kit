import type { MiddlewareHandler } from 'hono'
import type { OrganizationId, Region, Role, UserId } from 'tula-closeline-contract'
import { type Clock, systemClock } from '../clock'
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
 * Creates Hono middleware that requires a valid `Authorization: Bearer` access token. On success
 * it sets organizationId, userId, role and region; on failure it throws an AppError: 401 with
 * `auth.unauthenticated`, `auth.token_expired` or `auth.token_invalid`, or 503 with
 * `auth.unavailable` when the signing keys could not be loaded or verification threw.
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
    let verified: Awaited<ReturnType<TokenVerifier['verify']>>
    try {
      verified = await verifier.verify(token)
    } catch (error) {
      throw toAppError(error, logger, logError)
    }
    c.set('organizationId', verified.organizationId)
    c.set('userId', verified.userId)
    c.set('role', verified.role)
    c.set('region', verified.region)
    await next()
  }
}
