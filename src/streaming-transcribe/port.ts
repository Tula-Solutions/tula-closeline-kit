import type { CallId, OrganizationId } from 'tula-closeline-contract'
import type { ErrorReporter } from '../reporting/port'

/** The default time opening a stream may take, in milliseconds. */
export const DEFAULT_STREAMING_TRANSCRIBE_TIMEOUT_MS = 10_000

/** The longest time a caller may allow opening a stream, in milliseconds. */
export const MAX_STREAMING_TRANSCRIBE_TIMEOUT_MS = 60_000

/** The most bytes one {@link TranscribeStream.sendAudio} chunk may hold. */
export const MAX_AUDIO_CHUNK_BYTES = 65_536

/** The most audio an adapter holds while it reconnects, in bytes; older audio is dropped first. */
export const MAX_REPLAY_AUDIO_BYTES = 524_288

/** The most words one turn event may carry. */
export const MAX_WORDS_PER_TURN = 2000

/** Which side of the Call a stream carries; the track tells the speaker, so no diarization is needed. */
export type StreamTrack = 'rep' | 'prospect'

/** How the audio is encoded: 16-bit signed little-endian PCM, or 8-bit mu-law (telephony). */
export type AudioEncoding = 'pcm_s16le' | 'pcm_mulaw'

/** The sample rates an adapter accepts, in Hz. */
export type SampleRate = 8000 | 16000 | 24000 | 48000

/** How an adapter retries a dropped stream. */
export interface ReconnectPolicy {
  /** The most reconnect attempts after one drop, 0 to 10; 0 never reconnects. Default 5. */
  maxAttempts?: number
  /** The base of the pause before an attempt, in ms, 1 to 60000; doubled each time and jittered. Default 250. */
  baseDelayMs?: number
  /** The longest pause before an attempt, in ms, before jitter, at least the base and at most 60000. Default 5000. */
  maxDelayMs?: number
}

/** One word with its timing. */
export interface TranscribedWord {
  /** The word as heard. Tenant data: never logged. */
  text: string
  /** When it starts, in ms from the start of the stream's audio (continuous across reconnects). */
  startMs: number
  /** When it ends, in ms from the start of the stream's audio; not before `startMs`. */
  endMs: number
  /** How sure the vendor is, 0 to 1, when it says. */
  confidence?: number
}

/** The words heard so far in a turn, interim or settled. */
export interface TurnEvent {
  /** Always `turn`. */
  type: 'turn'
  /** Identifies the turn within the stream; the same for every event of one turn, never reused. */
  turnId: string
  /** Counts the stream's turn events from 1, strictly increasing, so a consumer drops a late or repeated one. */
  sequence: number
  /** False while the text may still change (an interim); true once it is settled (a final). */
  isFinal: boolean
  /**
   * True when the speaker has finished the turn. Only ever on a final. After it the turn is over
   * and the next turn event has a new `turnId`. A final without it is a settled part of a turn
   * still going.
   */
  endOfTurn: boolean
  /** All the text of the turn so far, or of this settled part. Tenant data: never logged. */
  text: string
  /** The words of `text` with timings, at most {@link MAX_WORDS_PER_TURN}. */
  words: readonly TranscribedWord[]
}

/** The stream lost its connection and the adapter is trying again. Carries no text. */
export interface ReconnectingEvent {
  /** Always `reconnecting`. */
  type: 'reconnecting'
  /** Which attempt this is, from 1. */
  attempt: number
  /** The pause before it, in ms. */
  delayMs: number
}

/** The stream is back after a drop; audio sent while it was down, up to the replay bound, is replayed. */
export interface ReconnectedEvent {
  /** Always `reconnected`. */
  type: 'reconnected'
  /** How many attempts it took. */
  attempts: number
}

/** The stream failed for good: the terminal event, with no `closed` after it. Carries no text. */
export interface FailedEvent {
  /** Always `failed`. */
  type: 'failed'
  /** Why, as an `area.reason` code from the streaming transcribe errors. */
  code: string
  /** How many reconnect attempts were made. */
  attempts: number
}

/** The stream was closed by the caller: the terminal event. */
export interface ClosedEvent {
  /** Always `closed`. */
  type: 'closed'
}

/** Everything a stream tells its listener, in order. */
export type StreamEvent =
  | TurnEvent
  | ReconnectingEvent
  | ReconnectedEvent
  | FailedEvent
  | ClosedEvent

/** The audio format and listener of one stream. */
export interface OpenStreamRequest {
  /** The Organization. */
  organizationId: OrganizationId
  /** Our id of the Call; with the track it names the stream: a second live stream for both is `streaming_transcribe.conflict`. */
  callId: CallId
  /** The side of the Call this stream carries. */
  track: StreamTrack
  /** How the audio sent is encoded. */
  encoding: AudioEncoding
  /** The sample rate of the audio sent, in Hz. */
  sampleRate: SampleRate
  /** A BCP 47 tag such as `en` or `en-US`; the vendor's default when absent. */
  language?: string
  /** How to retry a dropped stream; the defaults when absent. */
  reconnect?: ReconnectPolicy
  /**
   * Receives every event, one at a time and in order. It must return quickly and must not throw;
   * if it does, the adapter reports the error (metadata only) and goes on. It may be called
   * before `open` resolves.
   */
  onEvent: (event: StreamEvent) => void
}

/** Options of {@link StreamingTranscribePort.open}. */
export interface StreamingTranscribeOptions {
  /** The most time opening may take, in ms, 1 to {@link MAX_STREAMING_TRANSCRIBE_TIMEOUT_MS}; default {@link DEFAULT_STREAMING_TRANSCRIBE_TIMEOUT_MS}. */
  timeoutMs?: number
}

/** One open stream for one audio track. */
export interface TranscribeStream {
  /** The adapter's id of this stream. */
  readonly streamId: string
  /**
   * Pushes audio, 1 to {@link MAX_AUDIO_CHUNK_BYTES} bytes, in order and in real time. Returns at
   * once; while the connection is down the adapter holds up to {@link MAX_REPLAY_AUDIO_BYTES} and
   * drops the oldest beyond that. On a stream that has closed or failed it throws
   * `streaming_transcribe.closed`. The audio is never logged.
   */
  sendAudio(chunk: Uint8Array): void
  /**
   * Ends the stream: the vendor is asked to settle what it has (a last final turn may still
   * arrive), then `closed` is the last event. Idempotent. A stream that already failed resolves
   * without a further event. Bounded by the adapter's own timeout.
   */
  close(): Promise<void>
}

/**
 * Live speech-to-text behind a vendor (AssemblyAI first), scoped by Organization. One stream
 * carries one track of a Call, so the speaker is known without diarization.
 *
 * Per stream, the events arrive in order: `turn` events with an increasing `sequence`; within a
 * turn any number of interims, then a final; the final that ends the turn has `endOfTurn: true`.
 * A dropped connection is retried with a bounded, jittered pause ({@link reconnectDelayMs}) and
 * shown as `reconnecting` then `reconnected`; word times stay continuous. When the attempts run
 * out the stream ends with one `failed` event and the error is given to the
 * {@link ErrorReporter} (metadata only): it is never thrown at the caller, because nothing is
 * calling. Exactly one of `closed` or `failed` ends a stream, and nothing follows it.
 *
 * Nothing here logs, reports or puts in an error any audio or any transcript text (tenant data).
 */
export interface StreamingTranscribePort {
  /**
   * Opens a stream and resolves once the vendor accepted it. Not idempotent: it opens one stream,
   * and a second for the same Call and track while the first is live is
   * `streaming_transcribe.conflict`. A vendor that cannot be reached is `unavailable` after the
   * bounded retries. O(1).
   */
  open(request: OpenStreamRequest, options?: StreamingTranscribeOptions): Promise<TranscribeStream>
}

/** The retry policy with its defaults filled in. */
export interface ResolvedReconnectPolicy {
  /** The most attempts after one drop. */
  maxAttempts: number
  /** The base pause, in ms. */
  baseDelayMs: number
  /** The longest pause before jitter, in ms. */
  maxDelayMs: number
}

/** The policy used when a request names none: five attempts, 250 ms doubling to 5 s. */
export const DEFAULT_RECONNECT_POLICY: ResolvedReconnectPolicy = {
  maxAttempts: 5,
  baseDelayMs: 250,
  maxDelayMs: 5000,
}

/**
 * The pause before reconnect attempt `attempt` (from 1): the base doubled each time up to the
 * maximum, then scaled by a jitter between 0.5 and 1.5 from `random()` (a number in `[0, 1)`).
 */
export function reconnectDelayMs(
  attempt: number,
  policy: ResolvedReconnectPolicy,
  random: () => number = Math.random
): number {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1))
  return Math.max(1, Math.floor(exponential * (0.5 + random())))
}
