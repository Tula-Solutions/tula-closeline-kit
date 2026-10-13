import { AppError } from '../errors'

/** The `area.reason` codes the object storage port and adapters throw. */
export const STORAGE_ERROR_CODES = {
  /** An Organization id, key, prefix, cursor, content type, limit or body is not acceptable. */
  invalidRequest: 'storage.invalid_request',
  /** An object is over the store's size limit. */
  objectTooLarge: 'storage.object_too_large',
  /** The store refused the call for a reason a retry cannot fix (no such bucket, access denied). */
  rejected: 'storage.rejected',
  /** The store did not answer, in time or at all, after the bounded retries. The only retryable code. */
  unavailable: 'storage.unavailable',
  /** The store answered with something this adapter cannot use. */
  badResponse: 'storage.bad_response',
} as const

/** One of {@link STORAGE_ERROR_CODES}'s values. */
export type StorageErrorCode = (typeof STORAGE_ERROR_CODES)[keyof typeof STORAGE_ERROR_CODES]

const STATUS: Record<StorageErrorCode, number> = {
  'storage.invalid_request': 400,
  'storage.object_too_large': 413,
  'storage.rejected': 500,
  'storage.unavailable': 503,
  'storage.bad_response': 502,
}

/** What an object store throws. Its message never holds an object body, a key or a URL. */
export class StorageError extends AppError {
  declare readonly code: StorageErrorCode

  constructor(
    code: StorageErrorCode,
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
    this.name = 'StorageError'
  }
}
