import { AppError } from '../errors'

/** The `area.reason` codes the text-to-speech port and adapters throw. */
export const TTS_ERROR_CODES = {
  /** The Organization id, voice, format, limits, text or retry policy are not acceptable. Nothing was sent to the vendor. */
  invalidRequest: 'tts.invalid_request',
  /** The text written to one stream passed its maximum length. The text was not taken. */
  textTooLarge: 'tts.text_too_large',
  /** The stream was used after it was finished, cancelled or closed. */
  closed: 'tts.closed',
  /** The overall deadline or the time to the first chunk passed; the underlying request was aborted. */
  timeout: 'tts.timeout',
  /** The caller's own AbortSignal fired; the underlying request was aborted. */
  aborted: 'tts.aborted',
  /** The vendor refused for a reason a retry cannot fix (credentials, quota, terms, an unknown voice). */
  rejected: 'tts.rejected',
  /** The vendor could not be reached, was throttled or failed. Retried only before the first chunk. */
  unavailable: 'tts.unavailable',
  /** The vendor sent something this adapter cannot use. */
  badResponse: 'tts.bad_response',
} as const

/** One of {@link TTS_ERROR_CODES}'s values. */
export type TtsErrorCode = (typeof TTS_ERROR_CODES)[keyof typeof TTS_ERROR_CODES]

const STATUS: Record<TtsErrorCode, number> = {
  'tts.invalid_request': 400,
  'tts.text_too_large': 413,
  'tts.closed': 409,
  'tts.timeout': 504,
  'tts.aborted': 499,
  'tts.rejected': 502,
  'tts.unavailable': 503,
  'tts.bad_response': 502,
}

/**
 * What a text-to-speech adapter throws. Its message and details never hold the text, audio, a
 * credential or a vendor URL; they describe fields, counts and codes only.
 */
export class TtsError extends AppError {
  declare readonly code: TtsErrorCode

  constructor(
    code: TtsErrorCode,
    message: string,
    options: { cause?: unknown; details?: Record<string, unknown> } = {}
  ) {
    super({
      code,
      status: STATUS[code],
      message,
      ...(options.cause === undefined ? {} : { cause: options.cause }),
      ...(options.details === undefined ? {} : { details: options.details }),
    })
    this.name = 'TtsError'
  }
}
