import { callIdSchema, organizationIdSchema } from 'tula-closeline-contract'
import { STREAMING_TRANSCRIBE_ERROR_CODES, StreamingTranscribeError } from './errors'
import {
  DEFAULT_RECONNECT_POLICY,
  DEFAULT_STREAMING_TRANSCRIBE_TIMEOUT_MS,
  MAX_AUDIO_CHUNK_BYTES,
  MAX_STREAMING_TRANSCRIBE_TIMEOUT_MS,
  type OpenStreamRequest,
  type ReconnectPolicy,
  type ResolvedReconnectPolicy,
  type StreamingTranscribeOptions,
} from './port'

const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/
const SAMPLE_RATES = [8000, 16000, 24000, 48000]
const ENCODINGS = ['pcm_s16le', 'pcm_mulaw']
const TRACKS = ['rep', 'prospect']

/** Refuses with `streaming_transcribe.invalid_request`; `what` names the field, never its value. */
export function invalid(what: string): never {
  throw new StreamingTranscribeError(
    STREAMING_TRANSCRIBE_ERROR_CODES.invalidRequest,
    `${what} is not acceptable`
  )
}

function integerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

/** Checks an open request (not its listener's behaviour) and returns the policy to use. */
export function checkOpenRequest(request: OpenStreamRequest): ResolvedReconnectPolicy {
  if (typeof request !== 'object' || request === null) {
    return invalid('request')
  }
  if (!organizationIdSchema.safeParse(request.organizationId).success) {
    invalid('organizationId')
  }
  if (!callIdSchema.safeParse(request.callId).success) {
    invalid('callId')
  }
  if (!TRACKS.includes(request.track)) {
    invalid('track')
  }
  if (!ENCODINGS.includes(request.encoding)) {
    invalid('encoding')
  }
  if (!SAMPLE_RATES.includes(request.sampleRate)) {
    invalid('sampleRate')
  }
  if (
    request.language !== undefined &&
    !(typeof request.language === 'string' && LANGUAGE.test(request.language))
  ) {
    invalid('language')
  }
  if (typeof request.onEvent !== 'function') {
    invalid('onEvent')
  }
  return resolveReconnectPolicy(request.reconnect)
}

/** Fills in the defaults of a reconnect policy and refuses a value out of range. */
export function resolveReconnectPolicy(
  policy: ReconnectPolicy | undefined
): ResolvedReconnectPolicy {
  const maxAttempts = policy?.maxAttempts ?? DEFAULT_RECONNECT_POLICY.maxAttempts
  const baseDelayMs = policy?.baseDelayMs ?? DEFAULT_RECONNECT_POLICY.baseDelayMs
  const maxDelayMs = policy?.maxDelayMs ?? DEFAULT_RECONNECT_POLICY.maxDelayMs
  if (!integerIn(maxAttempts, 0, 10)) {
    invalid('reconnect.maxAttempts')
  }
  if (!integerIn(baseDelayMs, 1, 60_000)) {
    invalid('reconnect.baseDelayMs')
  }
  if (!integerIn(maxDelayMs, baseDelayMs, 60_000)) {
    invalid('reconnect.maxDelayMs')
  }
  return { maxAttempts, baseDelayMs, maxDelayMs }
}

/** Checks the open options and returns the timeout to use, in ms. */
export function resolveTimeout(options: StreamingTranscribeOptions | undefined): number {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_STREAMING_TRANSCRIBE_TIMEOUT_MS
  return integerIn(timeoutMs, 1, MAX_STREAMING_TRANSCRIBE_TIMEOUT_MS)
    ? timeoutMs
    : invalid('timeoutMs')
}

/** Checks one chunk of audio. */
export function checkChunk(chunk: unknown): Uint8Array {
  if (!(chunk instanceof Uint8Array) || chunk.length < 1 || chunk.length > MAX_AUDIO_CHUNK_BYTES) {
    return invalid('chunk')
  }
  return chunk
}
