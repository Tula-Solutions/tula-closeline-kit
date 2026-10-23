import type { MiddlewareHandler } from 'hono'
import { COMPOSED_HANDLER } from 'hono/utils/constants'
import { type ApiKeyScope, apiKeyScopeSchema } from 'tula-closeline-contract'
import { AppError } from '../errors'
import type { ScopedAuthEnv } from './middleware'

const SCOPE_GUARD = Symbol('tula-closeline-kit.requireScope')

/** True for a handler made by requireScope; the auth middleware reads it to let an API key in. */
export function isScopeGuard(handler: unknown): boolean {
  if (typeof handler !== 'function') {
    return false
  }
  const marked = handler as unknown as Record<string | symbol, unknown>
  // Hono wraps a handler mounted through a sub-app with its own error handler; it keeps the original.
  return marked[SCOPE_GUARD] === true || isScopeGuard(marked[COMPOSED_HANDLER])
}

function forbidden(): AppError {
  return new AppError({
    code: 'auth.forbidden',
    status: 403,
    message: 'You are not allowed to do this.',
  })
}

/**
 * Creates a route guard that opts the route in to API key tokens. A member token passes unchanged
 * (a member's access is governed by role, as on every other route); an API key token passes only
 * if its scopes include exactly `scope` (`write` does not imply `read`), else `auth.forbidden`.
 * Mount it on the route itself, before the handler and after the auth middleware: the middleware
 * refuses an API key on any route where it finds no guard, and a guard on a prefix opts in every
 * method beneath it, so guard each method's route separately. Throws a TypeError for a name the contract does not list.
 */
export function requireScope(scope: ApiKeyScope): MiddlewareHandler<ScopedAuthEnv> {
  if (!apiKeyScopeSchema.safeParse(scope).success) {
    throw new TypeError('requireScope needs a scope from the contract')
  }
  const guard: MiddlewareHandler<ScopedAuthEnv> = async (c, next) => {
    const actor = c.get('actor')
    if (actor === 'member') {
      return next()
    }
    if (actor === 'api_key') {
      if (c.get('scopes')?.includes(scope) === true) {
        return next()
      }
      throw forbidden()
    }
    // The auth middleware did not run: nothing proves who is asking.
    throw new AppError({
      code: 'auth.unauthenticated',
      status: 401,
      message: 'Authentication is required.',
    })
  }
  Object.defineProperty(guard, SCOPE_GUARD, { value: true })
  return guard
}
