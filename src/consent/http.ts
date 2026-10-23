import {
  CONSENT_ROUTES,
  contactCheckRequestSchema,
  contactCheckResultSchema,
} from 'tula-closeline-contract'
import {
  createInternalClient,
  InternalCallError,
  type InternalClient,
  type InternalClientOptions,
} from '../http/internal'
import type { Logger } from '../logger'
import { type Sleep, systemSleep } from '../queue/sleep'
import {
  CONTACT_UNAVAILABLE,
  type ContactGuard,
  type ContactGuardRequest,
  type ContactGuardResult,
  withCaller,
} from './port'

/** The bound on one attempt of a Contact Check, in milliseconds (ADR 0021). */
export const CONTACT_GUARD_TIMEOUT_MS = 500

/** The base of the pause before the one retry; the pause is jittered between half and one and a half of it. */
export const CONTACT_GUARD_RETRY_DELAY_MS = 50

/** Options for {@link createHttpContactGuard}. There is deliberately no option that turns the check off. */
export type HttpContactGuardOptions = Pick<
  InternalClientOptions,
  'baseUrl' | 'secret' | 'environment' | 'ca' | 'keepAlive'
> & {
  /** The calling service's name, such as `voice` or `outbound`: lower-case letters, digits, `_` and `-`. */
  caller: string
  /** Where failures are noted: fixed words, a failure kind, a status and counts only. */
  logger: Pick<Logger, 'warn'>
  /** Injected for tests; the pause before the retry. */
  sleep?: Sleep
  /** Injected for tests; a number in `[0, 1)`. */
  random?: () => number
}

/** A {@link ContactGuard} that can release its connections. */
export interface HttpContactGuard extends ContactGuard {
  /** Closes the connections the guard holds; safe to call more than once. */
  close(): void
}

type Attempt =
  | { kind: 'answer'; result: ContactGuardResult }
  | { kind: 'failed'; reason: string; retry: boolean; status?: number }

async function attempt(client: InternalClient, body: unknown): Promise<Attempt> {
  const route = CONSENT_ROUTES.contactCheck
  try {
    const response = await client.request({
      method: route.method,
      path: route.path,
      body,
      timeoutMs: CONTACT_GUARD_TIMEOUT_MS,
    })
    if (response.status >= 500) {
      return { kind: 'failed', reason: 'http_5xx', retry: true, status: response.status }
    }
    if (response.status !== 200) {
      return { kind: 'failed', reason: 'http_unexpected', retry: false, status: response.status }
    }
    const parsed = contactCheckResultSchema.safeParse(response.json)
    return parsed.success
      ? { kind: 'answer', result: parsed.data }
      : { kind: 'failed', reason: 'malformed_response', retry: false }
  } catch (error) {
    return {
      kind: 'failed',
      reason: error instanceof InternalCallError ? error.failure : 'error',
      retry: true,
    }
  }
}

/**
 * Builds a {@link ContactGuard} that asks core's internal Contact Check over HTTP with the shared
 * secret the kit's other internal calls use (ADR 0013). Each attempt is bounded at 500 ms and a
 * timeout, a network error or a 5xx is tried once more after a jittered pause. It fails closed: if
 * both attempts fail, or the answer is not a valid result, the guard answers denied with
 * `consent.unavailable`. A denial from core is passed through as it came. Logs carry fixed words,
 * the failure kind, a status, the channel and the purpose; never the secret, an address or a body.
 */
export function createHttpContactGuard(options: HttpContactGuardOptions): HttpContactGuard {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(options.caller)) {
    throw new TypeError('the caller must be a short lower-case service name')
  }
  const { caller, logger } = options
  const sleep = options.sleep ?? systemSleep
  const random = options.random ?? Math.random
  const client = createInternalClient({
    baseUrl: options.baseUrl,
    secret: options.secret,
    environment: options.environment,
    userAgent: `closeline-${caller}`,
    timeoutMs: CONTACT_GUARD_TIMEOUT_MS,
    retry: { maxAttempts: 1 },
    ...(options.ca === undefined ? {} : { ca: options.ca }),
    ...(options.keepAlive === undefined ? {} : { keepAlive: options.keepAlive }),
  })

  return {
    async check(request: ContactGuardRequest): Promise<ContactGuardResult> {
      const body = withCaller(request, caller)
      const valid = contactCheckRequestSchema.safeParse(body)
      if (!valid.success) {
        logger.warn('contact check refused: the request is not valid, contact denied', {
          reason: 'invalid_request',
        })
        return CONTACT_UNAVAILABLE
      }
      const where = { channel: valid.data.channel, purpose: valid.data.purpose }
      for (let n = 1; n <= 2; n++) {
        const outcome = await attempt(client, valid.data)
        if (outcome.kind === 'answer') {
          return outcome.result
        }
        const again = n === 1 && outcome.retry
        logger.warn(
          again
            ? 'contact check failed, retrying once'
            : 'contact check failed, contact denied as unavailable',
          {
            reason: outcome.reason,
            attempt: n,
            ...(outcome.status === undefined ? {} : { status: outcome.status }),
            ...where,
          }
        )
        if (!again) {
          break
        }
        await sleep(Math.floor(CONTACT_GUARD_RETRY_DELAY_MS * (0.5 + random())))
      }
      return CONTACT_UNAVAILABLE
    },
    close: () => client.close(),
  }
}
