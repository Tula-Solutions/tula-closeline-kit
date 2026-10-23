import { AppError } from '../errors'

/** The `area.reason` codes the audit recorder throws. */
export const AUDIT_ERROR_CODES = {
  /** The entry has a field, key, value or shape the recorder does not accept. Nothing was recorded. */
  invalidEntry: 'audit.invalid_entry',
  /** The serialised entry is over the size cap. Nothing was recorded. */
  entryTooLarge: 'audit.entry_too_large',
  /** The queue did not take the event, after its own bounded retries. A retry with the same event id is safe. */
  unavailable: 'audit.unavailable',
} as const

/** One of {@link AUDIT_ERROR_CODES}'s values. */
export type AuditErrorCode = (typeof AUDIT_ERROR_CODES)[keyof typeof AUDIT_ERROR_CODES]

const STATUS: Record<AuditErrorCode, number> = {
  'audit.invalid_entry': 422,
  'audit.entry_too_large': 413,
  'audit.unavailable': 503,
}

/**
 * What the audit recorder throws. Its message is fixed text and its details hold only field
 * paths, issue codes and sizes: never a metadata value.
 */
export class AuditError extends AppError {
  declare readonly code: AuditErrorCode

  constructor(
    code: AuditErrorCode,
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
    this.name = 'AuditError'
  }
}
