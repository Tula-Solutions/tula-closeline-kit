import { organizationIdSchema } from 'tula-closeline-contract'
import { TTS_ERROR_CODES, TtsError } from './errors'
import {
  DEFAULT_TTS_FIRST_CHUNK_TIMEOUT_MS,
  DEFAULT_TTS_MAX_TEXT_CHARS,
  DEFAULT_TTS_RETRY_POLICY,
  DEFAULT_TTS_TIMEOUT_MS,
  MAX_TTS_FIRST_CHUNK_TIMEOUT_MS,
  MAX_TTS_MAX_TEXT_CHARS,
  MAX_TTS_TIMEOUT_MS,
  type ResolvedTtsRetryPolicy,
  type TtsOpenRequest,
  type TtsRetryPolicy,
} from './port'

const VOICE = /^[A-Za-z0-9_.:-]{1,128}$/
const ENCODINGS: readonly unknown[] = ['pcm_s16le', 'pcm_mulaw']
const SAMPLE_RATES: readonly unknown[] = [8000, 16000, 24000, 48000]

/** Refuses with `tts.invalid_request`; `what` names the field, never its value. */
export function invalid(what: string): never {
  throw new TtsError(TTS_ERROR_CODES.invalidRequest, `${what} is not acceptable`)
}

function integerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

/** A request with its defaults filled in. */
export interface CheckedOpenRequest {
  /** The overall deadline, in ms. */
  timeoutMs: number
  /** The time to the first chunk, in ms. */
  firstChunkTimeoutMs: number
  /** The most characters the stream takes. */
  maxTextChars: number
  /** The retry policy. */
  retry: ResolvedTtsRetryPolicy
}

/** Fills in the defaults of a retry policy and refuses a value out of range. */
export function resolveTtsRetryPolicy(policy: TtsRetryPolicy | undefined): ResolvedTtsRetryPolicy {
  const maxRetries = policy?.maxRetries ?? DEFAULT_TTS_RETRY_POLICY.maxRetries
  const baseDelayMs = policy?.baseDelayMs ?? DEFAULT_TTS_RETRY_POLICY.baseDelayMs
  const maxDelayMs = policy?.maxDelayMs ?? DEFAULT_TTS_RETRY_POLICY.maxDelayMs
  if (!integerIn(maxRetries, 0, 5)) {
    invalid('retry.maxRetries')
  }
  if (!integerIn(baseDelayMs, 1, 60_000)) {
    invalid('retry.baseDelayMs')
  }
  if (!integerIn(maxDelayMs, baseDelayMs, 60_000)) {
    invalid('retry.maxDelayMs')
  }
  return { maxRetries, baseDelayMs, maxDelayMs }
}

/** Checks an open request and fills in its defaults. Throws `tts.invalid_request`; nothing has gone to the vendor. */
export function checkOpenRequest(request: TtsOpenRequest): CheckedOpenRequest {
  if (typeof request !== 'object' || request === null) {
    return invalid('request')
  }
  if (!organizationIdSchema.safeParse(request.organizationId).success) {
    invalid('organizationId')
  }
  if (typeof request.voice !== 'string' || !VOICE.test(request.voice)) {
    invalid('voice')
  }
  if (!ENCODINGS.includes(request.encoding)) {
    invalid('encoding')
  }
  if (!SAMPLE_RATES.includes(request.sampleRate)) {
    invalid('sampleRate')
  }
  const timeoutMs = request.timeoutMs ?? DEFAULT_TTS_TIMEOUT_MS
  if (!integerIn(timeoutMs, 1, MAX_TTS_TIMEOUT_MS)) {
    invalid('timeoutMs')
  }
  const firstChunkTimeoutMs = request.firstChunkTimeoutMs ?? DEFAULT_TTS_FIRST_CHUNK_TIMEOUT_MS
  if (!integerIn(firstChunkTimeoutMs, 1, MAX_TTS_FIRST_CHUNK_TIMEOUT_MS)) {
    invalid('firstChunkTimeoutMs')
  }
  const maxTextChars = request.maxTextChars ?? DEFAULT_TTS_MAX_TEXT_CHARS
  if (!integerIn(maxTextChars, 1, MAX_TTS_MAX_TEXT_CHARS)) {
    invalid('maxTextChars')
  }
  if (request.signal !== undefined && !(request.signal instanceof AbortSignal)) {
    invalid('signal')
  }
  return {
    timeoutMs,
    firstChunkTimeoutMs,
    maxTextChars,
    retry: resolveTtsRetryPolicy(request.retry),
  }
}
