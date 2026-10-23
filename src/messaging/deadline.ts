import { type Sleep, systemSleep } from '../queue/sleep'
import { MESSAGING_ERROR_CODES, MessagingError } from './errors'
import { messagingRetryDelayMs, type ResolvedMessagingRetryPolicy } from './port'

/** The overall time limit and the caller's signal for one send, as one signal. */
export interface MessagingDeadline {
  /** Aborts when the time limit passes or the caller's signal fires; hand it to the vendor request. */
  readonly signal: AbortSignal
  /** Throws `messaging.timeout` or `messaging.aborted` if the signal has fired; call it after anything awaited. */
  check(): void
  /** Releases the timer and the listener; call it when the send ends. */
  stop(): void
}

/** Starts the overall time limit of a send. The caller's `signal` joins it. The timer never keeps the process alive. */
export function startMessagingDeadline(timeoutMs: number, caller?: AbortSignal): MessagingDeadline {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  timer.unref?.()
  const onCaller = () => controller.abort()
  if (caller?.aborted) {
    controller.abort()
  }
  caller?.addEventListener('abort', onCaller, { once: true })
  return {
    signal: controller.signal,
    check() {
      if (timedOut) {
        throw new MessagingError(MESSAGING_ERROR_CODES.timeout, 'The send took too long', {
          details: { timeoutMs },
        })
      }
      if (controller.signal.aborted) {
        throw new MessagingError(MESSAGING_ERROR_CODES.aborted, 'The send was cancelled')
      }
    },
    stop() {
      clearTimeout(timer)
      caller?.removeEventListener('abort', onCaller)
    },
  }
}

/** Thrown by {@link raceAbort} when the signal wins; callers turn it into a timeout, an abort or a retry. */
export class AttemptAborted extends Error {
  constructor() {
    super('The attempt was aborted')
    this.name = 'AttemptAborted'
  }
}

/** Settles with `promise`, or rejects with {@link AttemptAborted} as soon as `signal` fires, even if `promise` never settles. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      promise.catch(() => undefined)
      reject(new AttemptAborted())
      return
    }
    const onAbort = () => reject(new AttemptAborted())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

/** True for the one error a retry can fix: `messaging.unavailable`. */
export function isRetryableMessagingError(error: unknown): boolean {
  return error instanceof MessagingError && error.code === MESSAGING_ERROR_CODES.unavailable
}

/** Options of {@link withMessagingRetry}. */
export interface MessagingRetryOptions {
  /** The retry policy. */
  policy: ResolvedMessagingRetryPolicy
  /** The send's deadline; a retry never outlives it. */
  deadline: MessagingDeadline
  /** Pauses between attempts; real time by default. */
  sleep?: Sleep
  /** A number in `[0, 1)` for the jitter; `Math.random` by default. */
  random?: () => number
  /** Told before each retry, with its number and pause (metadata only). */
  onRetry?: (retry: number, delayMs: number) => void
}

/**
 * Runs `attempt` and runs it again after a bounded, jittered pause while it fails with
 * `messaging.unavailable` and retries remain and the deadline has not passed. Any other error is
 * thrown at once. Every attempt carries the same idempotency key, so a retry never sends twice.
 */
export async function withMessagingRetry<T>(
  attempt: (attemptNumber: number) => Promise<T>,
  options: MessagingRetryOptions
): Promise<T> {
  const sleep = options.sleep ?? systemSleep
  for (let n = 1; ; n++) {
    options.deadline.check()
    try {
      return await attempt(n)
    } catch (error) {
      options.deadline.check()
      if (!isRetryableMessagingError(error) || n > options.policy.maxRetries) {
        throw error
      }
      const delayMs = messagingRetryDelayMs(n, options.policy, options.random)
      options.onRetry?.(n, delayMs)
      await sleep(delayMs, options.deadline.signal)
    }
  }
}
