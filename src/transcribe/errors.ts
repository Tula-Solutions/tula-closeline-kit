import { AppError } from '../errors'

/** The `area.reason` codes the transcriber port and adapters throw. */
export const TRANSCRIBER_ERROR_CODES = {
  /** An Organization id, client reference, audio reference, option, prefix or cursor is not acceptable. */
  invalidRequest: 'transcriber.invalid_request',
  /** The client reference is already used by a send with a different mode, speaker cap or audio key. Never retryable. */
  conflict: 'transcriber.conflict',
  /** The vendor refused the call for a reason a retry cannot fix (bad credentials, no quota, terms). */
  rejected: 'transcriber.rejected',
  /** The vendor did not answer, in time or at all, after the bounded retries. The only retryable code. */
  unavailable: 'transcriber.unavailable',
  /** The vendor answered with something this adapter cannot use. */
  badResponse: 'transcriber.bad_response',
} as const

/** One of {@link TRANSCRIBER_ERROR_CODES}'s values. */
export type TranscriberErrorCode =
  (typeof TRANSCRIBER_ERROR_CODES)[keyof typeof TRANSCRIBER_ERROR_CODES]

const STATUS: Record<TranscriberErrorCode, number> = {
  'transcriber.invalid_request': 400,
  'transcriber.conflict': 409,
  'transcriber.rejected': 500,
  'transcriber.unavailable': 503,
  'transcriber.bad_response': 502,
}

/** What a transcriber throws. Its message never holds audio, an audio URL, text or a speaker name. */
export class TranscriberError extends AppError {
  declare readonly code: TranscriberErrorCode

  constructor(
    code: TranscriberErrorCode,
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
    this.name = 'TranscriberError'
  }
}
