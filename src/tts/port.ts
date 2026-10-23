import type { OrganizationId } from 'tula-closeline-contract'
import type { AudioEncoding, SampleRate } from '../streaming-transcribe/port'
import type { TtsAudioChunk } from './audio'

/** The default overall deadline of one stream, from `open` to the last chunk, in milliseconds. */
export const DEFAULT_TTS_TIMEOUT_MS = 30_000

/** The longest overall deadline a caller may allow, in milliseconds. */
export const MAX_TTS_TIMEOUT_MS = 120_000

/** The default time from the first text to the first audio chunk, in milliseconds. */
export const DEFAULT_TTS_FIRST_CHUNK_TIMEOUT_MS = 2_000

/** The longest time to the first chunk a caller may allow, in milliseconds. */
export const MAX_TTS_FIRST_CHUNK_TIMEOUT_MS = 30_000

/** The default most characters one stream may be given in all. */
export const DEFAULT_TTS_MAX_TEXT_CHARS = 5_000

/** The largest text length a caller may allow one stream. */
export const MAX_TTS_MAX_TEXT_CHARS = 20_000

/** The most bytes one {@link TtsAudioChunk} may hold. */
export const MAX_TTS_AUDIO_CHUNK_BYTES = 65_536

/** How an adapter retries a retryable vendor error (`tts.unavailable`) before the first chunk. */
export interface TtsRetryPolicy {
  /** The most retries after the first attempt, 0 to 5; 0 never retries. Default 1. */
  maxRetries?: number
  /** The base of the pause before a retry, in ms, 1 to 60000; doubled each time and jittered. Default 50. */
  baseDelayMs?: number
  /** The longest pause before a retry, in ms, before jitter, at least the base and at most 60000. Default 250. */
  maxDelayMs?: number
}

/** The retry policy with its defaults filled in. */
export interface ResolvedTtsRetryPolicy {
  /** The most retries after the first attempt. */
  maxRetries: number
  /** The base pause, in ms. */
  baseDelayMs: number
  /** The longest pause before jitter, in ms. */
  maxDelayMs: number
}

/** The policy used when a request names none: one retry after 50 ms (a live call cannot wait long). */
export const DEFAULT_TTS_RETRY_POLICY: ResolvedTtsRetryPolicy = {
  maxRetries: 1,
  baseDelayMs: 50,
  maxDelayMs: 250,
}

/**
 * The pause before retry `retry` (from 1): the base doubled each time up to the maximum, then
 * scaled by a jitter between 0.5 and 1.5 from `random()` (a number in `[0, 1)`).
 */
export function ttsRetryDelayMs(
  retry: number,
  policy: ResolvedTtsRetryPolicy,
  random: () => number = Math.random
): number {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (retry - 1))
  return Math.max(1, Math.floor(exponential * (0.5 + random())))
}

/** What opening a stream states: whose it is, the voice and format, and the limits that bound it. */
export interface TtsOpenRequest {
  /** The Organization the stream is for; it scopes metering and error context. */
  organizationId: OrganizationId
  /** A stock voice style of the vendor, 1 to 128 characters of `A-Z a-z 0-9 _ . : -`. Voice cloning is out of scope. */
  voice: string
  /** How the audio is encoded: `pcm_mulaw` for telephony, `pcm_s16le` otherwise. */
  encoding: AudioEncoding
  /** The sample rate of the audio, in Hz. */
  sampleRate: SampleRate
  /**
   * The most time the whole stream may take from `open`, retries included, in ms, 1 to
   * {@link MAX_TTS_TIMEOUT_MS}; default {@link DEFAULT_TTS_TIMEOUT_MS}. When it passes, the vendor
   * request is aborted and iteration fails with `tts.timeout`.
   */
  timeoutMs?: number
  /**
   * The most time from the first text being written (and the stream being read) to the first
   * chunk, per attempt, in ms, 1 to {@link MAX_TTS_FIRST_CHUNK_TIMEOUT_MS}; default
   * {@link DEFAULT_TTS_FIRST_CHUNK_TIMEOUT_MS}. When it passes, iteration fails with `tts.timeout`.
   */
  firstChunkTimeoutMs?: number
  /**
   * The most characters all `write` calls of this stream may add up to, 1 to
   * {@link MAX_TTS_MAX_TEXT_CHARS}; default {@link DEFAULT_TTS_MAX_TEXT_CHARS}. A write that would
   * pass it fails with `tts.text_too_large` and adds nothing.
   */
  maxTextChars?: number
  /** Retries of `tts.unavailable` before the first chunk; the defaults when absent. */
  retry?: TtsRetryPolicy
  /** The caller's own cancellation. When it fires the vendor request is aborted and iteration fails with `tts.aborted`. */
  signal?: AbortSignal
}

/**
 * One text-to-speech request in flight: text goes in with {@link TtsStream.write}, audio chunks
 * come out in order by iterating the stream. Iterate it once.
 *
 * The consumer pulls: the next chunk is produced only when the loop asks for it, so a slow
 * consumer holds at most one chunk and the text it was given (bounded by `maxTextChars`), never a
 * growing queue. Leaving the loop early (`break`) cancels the stream.
 */
export interface TtsStream extends AsyncIterable<TtsAudioChunk> {
  /**
   * Adds text to speak, in order. Empty text is ignored. Throws `tts.text_too_large` when the
   * stream's total would pass its maximum, `tts.closed` after `finish`, `cancel` or `close`, and
   * `tts.timeout` or `tts.aborted` once the deadline or the caller's signal has fired. Synchronous
   * and O(text length); it never waits for the vendor.
   */
  write(text: string): void
  /** Says no more text is coming, so the stream ends after the last chunk. Idempotent. */
  finish(): void
  /**
   * Stops now: the vendor request is aborted, no further chunk is delivered (a pending read ends
   * as done) and unspoken text is dropped. Idempotent, and a no-op once the stream has ended or
   * is closed. This is barge-in.
   */
  cancel(): void
  /**
   * Cancels and releases everything the stream holds (timer, listeners, buffered text, the vendor
   * connection). Idempotent. Any later `write`, `finish` or read fails with `tts.closed`.
   */
  close(): Promise<void>
}

/**
 * A text-to-speech engine behind a vendor (Cartesia Sonic first, stock voice styles only). It is
 * on the live call path, so it is built for latency: text streams in as the model writes it and
 * audio streams out as the vendor makes it.
 *
 * Every stream has an overall deadline and a time-to-first-chunk limit that abort the vendor
 * request. A retryable vendor error (`tts.unavailable`) is retried with a bounded, jittered pause
 * only before the first chunk has been delivered; once a chunk is out the failure is thrown from
 * the iteration, never retried, so the listener never hears a repeat. Failures are `TtsError`s
 * with `tts.*` codes; `tts.unavailable`, `tts.rejected` and `tts.bad_response` are also given to
 * the ErrorReporter (metadata only).
 *
 * The text and the audio are tenant data: they are never logged, reported or put in an error, and
 * do not appear in the string, JSON or inspect form of any object the port returns.
 */
export interface TtsPort {
  /** Opens a stream. An unacceptable request throws `tts.invalid_request` here; nothing is sent to the vendor until text is written. */
  open(request: TtsOpenRequest): TtsStream
}
