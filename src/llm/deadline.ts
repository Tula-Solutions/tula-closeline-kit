import { type Sleep, systemSleep } from '../queue/sleep'
import { LLM_ERROR_CODES, LlmError } from './errors'
import { llmRetryDelayMs, type ResolvedLlmRetryPolicy } from './port'

/** The time limit and the caller's cancellation of one call, as one signal for the vendor request. */
export interface Deadline {
  /** Aborts when the time limit passes or the caller's signal fires; hand it to the vendor request. */
  readonly signal: AbortSignal
  /** Throws `llm.timeout` or `llm.aborted` if the signal has fired; call it after anything awaited. */
  check(): void
  /** Aborts the vendor request now, as when the consumer of a stream stops reading. */
  cancel(): void
  /** Releases the timer and the listener; call it when the call ends. */
  stop(): void
}

/** Starts the time limit of a call. The caller's `signal` joins it. */
export function startDeadline(timeoutMs: number, caller?: AbortSignal): Deadline {
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
        throw new LlmError(LLM_ERROR_CODES.timeout, 'The call took too long', {
          details: { timeoutMs },
        })
      }
      if (controller.signal.aborted) {
        throw new LlmError(LLM_ERROR_CODES.aborted, 'The call was cancelled')
      }
    },
    cancel() {
      controller.abort()
    },
    stop() {
      clearTimeout(timer)
      caller?.removeEventListener('abort', onCaller)
    },
  }
}

/** True for the one error a retry can fix: `llm.unavailable`. */
export function isRetryableLlmError(error: unknown): boolean {
  return error instanceof LlmError && error.code === LLM_ERROR_CODES.unavailable
}

/** Options of {@link withLlmRetry}. */
export interface RetryOptions {
  /** The retry policy. */
  policy: ResolvedLlmRetryPolicy
  /** The call's deadline; a retry never outlives it. */
  deadline: Deadline
  /** Pauses between attempts; real time by default. */
  sleep?: Sleep
  /** A number in `[0, 1)` for the jitter; `Math.random` by default. */
  random?: () => number
  /** Told before each retry, with its number and pause (metadata only). */
  onRetry?: (retry: number, delayMs: number) => void
}

/**
 * Runs `attempt`, and runs it again after a bounded, jittered pause while it fails with a
 * retryable error and retries remain and the deadline has not passed. Any other error is thrown
 * at once. When the retries run out the last `llm.unavailable` is thrown.
 */
export async function withLlmRetry<T>(
  attempt: (attemptNumber: number) => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const sleep = options.sleep ?? systemSleep
  for (let n = 1; ; n++) {
    options.deadline.check()
    try {
      return await attempt(n)
    } catch (error) {
      options.deadline.check()
      if (!isRetryableLlmError(error) || n > options.policy.maxRetries) {
        throw error
      }
      const delayMs = llmRetryDelayMs(n, options.policy, options.random)
      options.onRetry?.(n, delayMs)
      await sleep(delayMs, options.deadline.signal)
    }
  }
}
