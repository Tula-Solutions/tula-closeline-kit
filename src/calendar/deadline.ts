import { type Sleep, systemSleep } from '../queue/sleep'
import { CALENDAR_ERROR_CODES, CalendarError } from './errors'
import { calendarRetryDelayMs, type ResolvedCalendarRetryPolicy } from './port'

/** The time limit and the caller's cancellation of one call, as one signal for the vendor request. */
export interface CalendarDeadline {
  /** Aborts when the time limit passes or the caller's signal fires; hand it to the vendor request. */
  readonly signal: AbortSignal
  /** Throws `calendar.timeout` or `calendar.aborted` if the signal has fired; call it after anything awaited. */
  check(): void
  /** Releases the timer and the listener; call it when the call ends. */
  stop(): void
}

/** Starts the time limit of a call. The caller's `signal` joins it. */
export function startCalendarDeadline(timeoutMs: number, caller?: AbortSignal): CalendarDeadline {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onCaller = () => controller.abort()
  if (caller?.aborted) {
    controller.abort()
  }
  caller?.addEventListener('abort', onCaller, { once: true })
  return {
    signal: controller.signal,
    check() {
      if (timedOut) {
        throw new CalendarError(CALENDAR_ERROR_CODES.timeout, 'The call took too long', {
          details: { timeoutMs },
        })
      }
      if (controller.signal.aborted) {
        throw new CalendarError(CALENDAR_ERROR_CODES.aborted, 'The call was cancelled')
      }
    },
    stop() {
      clearTimeout(timer)
      caller?.removeEventListener('abort', onCaller)
    },
  }
}

/** True for the one error a retry can fix: `calendar.unavailable`. */
export function isRetryableCalendarError(error: unknown): boolean {
  return error instanceof CalendarError && error.code === CALENDAR_ERROR_CODES.unavailable
}

/** Options of {@link withCalendarRetry}. */
export interface CalendarRetryOptions {
  /** The retry policy. */
  policy: ResolvedCalendarRetryPolicy
  /** The call's deadline; a retry never outlives it. */
  deadline: CalendarDeadline
  /** Pauses between attempts; real time by default. */
  sleep?: Sleep
  /** A number in `[0, 1)` for the jitter; `Math.random` by default. */
  random?: () => number
  /** Told before each retry, with its number and pause (metadata only). */
  onRetry?: (retry: number, delayMs: number) => void
}

/**
 * Runs `attempt`, and runs it again after a bounded, jittered pause while it fails with
 * `calendar.unavailable` and retries remain and the deadline has not passed. Any other error is
 * thrown at once. Safe for effects because every write carries a request id.
 */
export async function withCalendarRetry<T>(
  attempt: (attemptNumber: number) => Promise<T>,
  options: CalendarRetryOptions
): Promise<T> {
  const sleep = options.sleep ?? systemSleep
  for (let n = 1; ; n++) {
    options.deadline.check()
    try {
      return await attempt(n)
    } catch (error) {
      options.deadline.check()
      if (!isRetryableCalendarError(error) || n > options.policy.maxRetries) {
        throw error
      }
      const delayMs = calendarRetryDelayMs(n, options.policy, options.random)
      options.onRetry?.(n, delayMs)
      await sleep(delayMs, options.deadline.signal)
    }
  }
}
