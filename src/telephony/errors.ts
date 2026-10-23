import { AppError } from '../errors'

/** The `area.reason` codes the telephony port and adapters throw. */
export const TELEPHONY_ERROR_CODES = {
  /** An id, number, text, URL or option is not acceptable. Nothing was sent to the provider. */
  invalidRequest: 'telephony.invalid_request',
  /** The provider has no call or Recording with that id for this Organization (or it was deleted). */
  notFound: 'telephony.not_found',
  /** The provider call has already ended, so the operation cannot apply. */
  callEnded: 'telephony.call_ended',
  /** The Disclosure has not played on this call, so it cannot be bridged, recorded or forked (ADR 0003). */
  disclosureRequired: 'telephony.disclosure_required',
  /** The Recording is not finished yet; try again shortly. */
  recordingNotReady: 'telephony.recording_not_ready',
  /** The provider refused the operation for a reason a retry cannot fix (credentials, quota, number). */
  rejected: 'telephony.rejected',
  /** The provider did not answer in time or at all, after the bounded retries. The only retryable code. */
  unavailable: 'telephony.unavailable',
  /** The provider answered with something this adapter cannot use. */
  badResponse: 'telephony.bad_response',
} as const

/** One of {@link TELEPHONY_ERROR_CODES}'s values. */
export type TelephonyErrorCode = (typeof TELEPHONY_ERROR_CODES)[keyof typeof TELEPHONY_ERROR_CODES]

const STATUS: Record<TelephonyErrorCode, number> = {
  'telephony.invalid_request': 400,
  'telephony.not_found': 404,
  'telephony.call_ended': 409,
  'telephony.disclosure_required': 409,
  'telephony.recording_not_ready': 409,
  'telephony.rejected': 502,
  'telephony.unavailable': 503,
  'telephony.bad_response': 502,
}

/**
 * What a telephony adapter throws. Its message never holds a phone number, a token, a signature,
 * a secret, a Disclosure text or audio: those are tenant data or credentials.
 */
export class TelephonyError extends AppError {
  declare readonly code: TelephonyErrorCode

  constructor(
    code: TelephonyErrorCode,
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
    this.name = 'TelephonyError'
  }
}
