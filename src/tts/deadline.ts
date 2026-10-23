import { type Sleep, systemSleep } from '../queue/sleep'
import { TTS_ERROR_CODES, TtsError } from './errors'
import { type ResolvedTtsRetryPolicy, ttsRetryDelayMs } from './port'

/** The overall time limit, the caller's signal and a local cancel of one stream, as one signal. */
export interface TtsDeadline {
  /** Aborts when the time limit passes, the caller's signal fires or `cancel` is called; hand it to the vendor request. */
  readonly signal: AbortSignal
  /** Throws `tts.timeout` or `tts.aborted` if the signal has fired; call it after anything awaited. */
  check(): void
  /** Aborts the vendor request now, as for a barge-in or a consumer that stopped reading. */
  cancel(): void
  /** Releases the timer and the listener; call it when the stream ends. */
  stop(): void
}

/** Starts the overall time limit of a stream. The caller's `signal` joins it. The timer never keeps the process alive. */
export function startTtsDeadline(timeoutMs: number, caller?: AbortSignal): TtsDeadline {
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
        throw new TtsError(TTS_ERROR_CODES.timeout, 'The stream took too long', {
          details: { phase: 'overall', timeoutMs },
        })
      }
      if (controller.signal.aborted) {
        throw new TtsError(TTS_ERROR_CODES.aborted, 'The stream was cancelled')
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

/** The time limit to the first chunk of one attempt. */
export interface FirstChunkWatch {
  /** Aborts when the first-chunk limit passes or any of the signals it joins fires. */
  readonly signal: AbortSignal
  /** Throws `tts.timeout` if the first-chunk limit (not another signal) is what fired. */
  check(): void
  /** Releases the timer; call it when the first chunk arrived or the attempt ended. */
  stop(): void
}

/** Starts the first-chunk limit of one attempt, joined with `signals` (normally the deadline's). */
export function watchFirstChunk(
  signals: readonly AbortSignal[],
  firstChunkTimeoutMs: number
): FirstChunkWatch {
  const own = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    own.abort()
  }, firstChunkTimeoutMs)
  return {
    signal: AbortSignal.any([own.signal, ...signals]),
    check() {
      if (timedOut) {
        throw new TtsError(TTS_ERROR_CODES.timeout, 'The first audio chunk took too long', {
          details: { phase: 'first_chunk', firstChunkTimeoutMs },
        })
      }
    },
    stop() {
      clearTimeout(timer)
    },
  }
}

/** True for the one error a retry can fix: `tts.unavailable`. */
export function isRetryableTtsError(error: unknown): boolean {
  return error instanceof TtsError && error.code === TTS_ERROR_CODES.unavailable
}

/** Options of {@link withTtsRetry}. */
export interface TtsRetryOptions {
  /** The retry policy. */
  policy: ResolvedTtsRetryPolicy
  /** The stream's deadline; a retry never outlives it. */
  deadline: TtsDeadline
  /** Pauses between attempts; real time by default. */
  sleep?: Sleep
  /** A number in `[0, 1)` for the jitter; `Math.random` by default. */
  random?: () => number
  /** Told before each retry, with its number and pause (metadata only). */
  onRetry?: (retry: number, delayMs: number) => void
}

/**
 * Runs `attempt` (everything up to and including the first chunk) and runs it again after a
 * bounded, jittered pause while it fails with `tts.unavailable` and retries remain and the
 * deadline has not passed. Any other error is thrown at once. Call it only for the part of a
 * stream before the first chunk is delivered: a failure after that is never retried.
 */
export async function withTtsRetry<T>(
  attempt: (attemptNumber: number) => Promise<T>,
  options: TtsRetryOptions
): Promise<T> {
  const sleep = options.sleep ?? systemSleep
  for (let n = 1; ; n++) {
    options.deadline.check()
    try {
      return await attempt(n)
    } catch (error) {
      options.deadline.check()
      if (!isRetryableTtsError(error) || n > options.policy.maxRetries) {
        throw error
      }
      const delayMs = ttsRetryDelayMs(n, options.policy, options.random)
      options.onRetry?.(n, delayMs)
      await sleep(delayMs, options.deadline.signal)
    }
  }
}
