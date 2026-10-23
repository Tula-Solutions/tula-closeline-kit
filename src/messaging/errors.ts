import { AppError } from '../errors'

/** The `area.reason` codes the messaging port and adapters throw. */
export const MESSAGING_ERROR_CODES = {
  /** The Organization, Prospect, number, content, key, limits or retry policy are not acceptable. Nothing was sent. */
  invalidRequest: 'messaging.invalid_request',
  /** The Contact Check did not allow the message (ADR 0003); `details.code` is the `consent.*` code. Nothing was sent. */
  consentDenied: 'messaging.consent_denied',
  /** The provider says the recipient texted STOP to this sender, so it will not deliver. Not retryable. */
  recipientOptedOut: 'messaging.recipient_opted_out',
  /** A WhatsApp free-form message is outside the 24 hour window; only a template can start the conversation. */
  templateRequired: 'messaging.template_required',
  /** The overall deadline passed; the underlying request was aborted. */
  timeout: 'messaging.timeout',
  /** The caller's own AbortSignal fired; the underlying request was aborted. */
  aborted: 'messaging.aborted',
  /** The provider refused for a reason a retry cannot fix (credentials, quota, a bad number). */
  rejected: 'messaging.rejected',
  /** The provider could not be reached, was throttled or failed. The only retryable code. */
  unavailable: 'messaging.unavailable',
  /** The provider sent something this adapter cannot use. */
  badResponse: 'messaging.bad_response',
  /** A webhook has a wrong, missing or unverifiable signature, or a body that is not a message event. */
  webhookInvalid: 'messaging.webhook_invalid',
} as const

/** One of {@link MESSAGING_ERROR_CODES}'s values. */
export type MessagingErrorCode = (typeof MESSAGING_ERROR_CODES)[keyof typeof MESSAGING_ERROR_CODES]

const STATUS: Record<MessagingErrorCode, number> = {
  'messaging.invalid_request': 400,
  'messaging.consent_denied': 403,
  'messaging.recipient_opted_out': 409,
  'messaging.template_required': 409,
  'messaging.timeout': 504,
  'messaging.aborted': 499,
  'messaging.rejected': 502,
  'messaging.unavailable': 503,
  'messaging.bad_response': 502,
  'messaging.webhook_invalid': 401,
}

/**
 * What a messaging adapter throws. Its message is fixed text and its details hold only field
 * names, counts, codes, an HTTP status and the provider's numeric error code: never a message
 * body, a phone number, a URL, a signature or a credential.
 */
export class MessagingError extends AppError {
  declare readonly code: MessagingErrorCode

  constructor(
    code: MessagingErrorCode,
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
    this.name = 'MessagingError'
  }
}

/** True for the errors that mean the provider or an adapter failed, which are given to the ErrorReporter. */
export function isReportableMessagingError(error: unknown): error is MessagingError {
  return (
    error instanceof MessagingError &&
    (error.code === MESSAGING_ERROR_CODES.unavailable ||
      error.code === MESSAGING_ERROR_CODES.rejected ||
      error.code === MESSAGING_ERROR_CODES.badResponse)
  )
}
