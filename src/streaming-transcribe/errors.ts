import { AppError } from '../errors'

/** The `area.reason` codes the streaming transcribe port and adapters throw or report. */
export const STREAMING_TRANSCRIBE_ERROR_CODES = {
  /** An id, track, audio format, chunk, option or policy is not acceptable. Nothing was sent to the vendor. */
  invalidRequest: 'streaming_transcribe.invalid_request',
  /** A stream for this Call and track is already open. */
  conflict: 'streaming_transcribe.conflict',
  /** The stream has closed or failed, so audio can no longer be sent to it. */
  closed: 'streaming_transcribe.closed',
  /** The vendor refused the stream for a reason a retry cannot fix (credentials, quota, terms). */
  rejected: 'streaming_transcribe.rejected',
  /** The vendor could not be reached, or the stream could not be restored, after the bounded retries. */
  unavailable: 'streaming_transcribe.unavailable',
  /** The vendor sent something this adapter cannot use. */
  badResponse: 'streaming_transcribe.bad_response',
} as const

/** One of {@link STREAMING_TRANSCRIBE_ERROR_CODES}'s values. */
export type StreamingTranscribeErrorCode =
  (typeof STREAMING_TRANSCRIBE_ERROR_CODES)[keyof typeof STREAMING_TRANSCRIBE_ERROR_CODES]

const STATUS: Record<StreamingTranscribeErrorCode, number> = {
  'streaming_transcribe.invalid_request': 400,
  'streaming_transcribe.conflict': 409,
  'streaming_transcribe.closed': 409,
  'streaming_transcribe.rejected': 502,
  'streaming_transcribe.unavailable': 503,
  'streaming_transcribe.bad_response': 502,
}

/**
 * What a streaming transcribe adapter throws, and what it reports when a stream fails for good.
 * Its message and details never hold audio, transcript text, a credential or a vendor URL.
 */
export class StreamingTranscribeError extends AppError {
  declare readonly code: StreamingTranscribeErrorCode

  constructor(
    code: StreamingTranscribeErrorCode,
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
    this.name = 'StreamingTranscribeError'
  }
}
