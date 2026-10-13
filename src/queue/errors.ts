import { AppError } from '../errors'

/** The `area.reason` codes the queue adapters throw. */
export const QUEUE_ERROR_CODES = {
  /** An envelope failed validation before sending. */
  invalidMessage: 'queue.invalid_message',
  /** A message body is over the 256 KiB limit. */
  messageTooLarge: 'queue.message_too_large',
  /** A batch has more than 10 messages or more than 256 KiB in total. */
  batchTooLarge: 'queue.batch_too_large',
  /** A call argument is outside what the queue accepts (batch size, visibility, wait). */
  invalidRequest: 'queue.invalid_request',
  /** The receipt is not for a message that is in flight any more. */
  receiptInvalid: 'queue.receipt_invalid',
  /** The queue refused the call for a reason a retry cannot fix (no such queue, access denied). */
  rejected: 'queue.rejected',
  /** The queue did not answer, in time or at all, after the bounded retries. */
  unavailable: 'queue.unavailable',
  /** The queue answered with something this adapter cannot use. */
  badResponse: 'queue.bad_response',
} as const

/** One of {@link QUEUE_ERROR_CODES}'s values. */
export type QueueErrorCode = (typeof QUEUE_ERROR_CODES)[keyof typeof QUEUE_ERROR_CODES]

const STATUS: Record<QueueErrorCode, number> = {
  'queue.invalid_message': 422,
  'queue.message_too_large': 413,
  'queue.batch_too_large': 413,
  'queue.invalid_request': 400,
  'queue.receipt_invalid': 409,
  'queue.rejected': 500,
  'queue.unavailable': 503,
  'queue.bad_response': 502,
}

/** What a queue port or adapter throws. Its message never holds a message body. */
export class QueueError extends AppError {
  declare readonly code: QueueErrorCode

  constructor(
    code: QueueErrorCode,
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
    this.name = 'QueueError'
  }
}
