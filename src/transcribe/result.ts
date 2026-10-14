import { TRANSCRIBER_ERROR_CODES, TranscriberError } from './errors'
import {
  MAX_SPEAKERS,
  MAX_TRANSCRIPT_TURNS,
  MAX_TURN_TEXT,
  type SpeakerMode,
  type TranscriptionFailure,
  type TranscriptionResult,
} from './port'

/**
 * How many bytes of a vendor's response a real adapter may read before it parses it (8 MiB). A
 * 3-hour Recording is a few hundred KiB of JSON, so a larger body is not a transcript: stop
 * reading, then answer `transcriber.bad_response`. Vendor output is untrusted data.
 */
export const MAX_TRANSCRIPT_RESPONSE_BYTES = 8 * 1024 * 1024

/** The longest audio a result may claim, in milliseconds (12 hours). */
export const MAX_AUDIO_MS = 12 * 60 * 60 * 1000

/** The most characters of text in one result, over all turns (4 million). */
export const MAX_TRANSCRIPT_CHARS = 4_000_000

/** The longest speaker label, in characters. */
export const MAX_SPEAKER_LABEL = 64

/** The most channels a split-channels result may name. */
export const MAX_CHANNELS = 8

/** The reasons a transcription can fail; the closed list of {@link TranscriptionFailure}. */
export const TRANSCRIPTION_FAILURES: readonly TranscriptionFailure[] = [
  'audio_unreachable',
  'audio_invalid',
  'no_speech',
  'too_long',
  'vendor_failed',
  'timed_out',
]

const bad = (message: string) => new TranscriberError(TRANSCRIBER_ERROR_CODES.badResponse, message)
const isMs = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0

/** What the request said, so the result can be checked against it. */
export interface ResultContext {
  /** How the speakers were to be told apart. */
  speakers: SpeakerMode
  /** The speaker cap that was asked for, if any. */
  maxSpeakers?: number | undefined
}

/**
 * Checks a result as a vendor produced it and returns a copy, or throws `transcriber.bad_response`
 * (its message never holds text or labels). **A real adapter must run every vendor result through
 * this**, after reading at most {@link MAX_TRANSCRIPT_RESPONSE_BYTES} of the response and parsing
 * it: vendor output is untrusted. It checks the status and the listed failure reasons; for a
 * `done` result a whole-millisecond duration of at most 12 hours, at most 50,000 turns and 4 million
 * characters of text, each turn with a speaker label of 1 to 64 characters, whole non-negative
 * `startMs` and `endMs` with the end not before the start and not after the audio, start times in
 * order, text of at most 20,000 characters, and at most `maxSpeakers` (else 10) distinct speakers.
 * With `context`, a `diarize` result has no channels and a `split_channels` result a channel from 0
 * on every turn. O(turns + text).
 */
export function checkTranscriptionResult(
  result: unknown,
  context?: ResultContext
): TranscriptionResult {
  if (typeof result !== 'object' || result === null) {
    throw bad('a result must be an object')
  }
  const raw = result as Record<string, unknown>
  if (raw.status === 'pending') {
    return { status: 'pending' }
  }
  if (raw.status === 'failed') {
    if (!TRANSCRIPTION_FAILURES.includes(raw.reason as TranscriptionFailure)) {
      throw bad('a failed result must give a listed reason')
    }
    return { status: 'failed', reason: raw.reason as TranscriptionFailure }
  }
  if (raw.status !== 'done') {
    throw bad('a result is pending, done or failed')
  }
  if (!isMs(raw.durationMs) || raw.durationMs > MAX_AUDIO_MS) {
    throw bad('the duration must be whole milliseconds, at most 12 hours')
  }
  if (!Array.isArray(raw.turns) || raw.turns.length > MAX_TRANSCRIPT_TURNS) {
    throw bad('the turns must be a list of at most 50000')
  }
  const cap = Math.min(context?.maxSpeakers ?? MAX_SPEAKERS, MAX_SPEAKERS)
  const speakers = new Set<string>()
  let previousStart = 0
  let characters = 0
  const turns = raw.turns.map((item: unknown) => {
    if (typeof item !== 'object' || item === null) {
      throw bad('a turn must be an object')
    }
    const turn = item as Record<string, unknown>
    if (
      typeof turn.speaker !== 'string' ||
      turn.speaker.length < 1 ||
      turn.speaker.length > MAX_SPEAKER_LABEL
    ) {
      throw bad('a speaker label is 1 to 64 characters')
    }
    if (!isMs(turn.startMs) || !isMs(turn.endMs) || turn.endMs < turn.startMs) {
      throw bad('a turn needs whole-millisecond times with the end not before the start')
    }
    if (turn.endMs > (raw.durationMs as number)) {
      throw bad('a turn ends after the audio')
    }
    if (turn.startMs < previousStart) {
      throw bad('turns must be in time order')
    }
    previousStart = turn.startMs
    if (typeof turn.text !== 'string' || turn.text.length > MAX_TURN_TEXT) {
      throw bad('the text of a turn is at most 20000 characters')
    }
    characters += turn.text.length
    if (characters > MAX_TRANSCRIPT_CHARS) {
      throw bad('the transcript is too long')
    }
    speakers.add(turn.speaker)
    if (speakers.size > cap) {
      throw bad('more speakers than allowed')
    }
    let channel: number | undefined
    if (turn.channel !== undefined) {
      if (
        typeof turn.channel !== 'number' ||
        !Number.isInteger(turn.channel) ||
        turn.channel < 0 ||
        turn.channel >= MAX_CHANNELS
      ) {
        throw bad('a channel is a whole number from 0 to 7')
      }
      channel = turn.channel
    }
    if (context?.speakers === 'diarize' && channel !== undefined) {
      throw bad('a diarized result has no channels')
    }
    if (context?.speakers === 'split_channels' && channel === undefined) {
      throw bad('a split-channels result names the channel of every turn')
    }
    return {
      speaker: turn.speaker,
      ...(channel === undefined ? {} : { channel }),
      startMs: turn.startMs,
      endMs: turn.endMs,
      text: turn.text,
    }
  })
  return { status: 'done', durationMs: raw.durationMs, turns }
}
