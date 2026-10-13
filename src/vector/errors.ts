import { AppError } from '../errors'

/** The `area.reason` codes the vector store port and adapters throw. */
export const VECTOR_ERROR_CODES = {
  /** An Organization id, vector id, attribute, filter, batch or `topK` is not acceptable. */
  invalidRequest: 'vector.invalid_request',
  /** A vector's length is not the store's dimension count. Never retryable: the caller or the model changed. */
  dimensionMismatch: 'vector.dimension_mismatch',
  /** The store refused the call for a reason a retry cannot fix (access denied, wrong index). */
  rejected: 'vector.rejected',
  /** The store did not answer, in time or at all, after the bounded retries. The only retryable code. */
  unavailable: 'vector.unavailable',
  /** The store answered with something this adapter cannot use. */
  badResponse: 'vector.bad_response',
} as const

/** One of {@link VECTOR_ERROR_CODES}'s values. */
export type VectorErrorCode = (typeof VECTOR_ERROR_CODES)[keyof typeof VECTOR_ERROR_CODES]

const STATUS: Record<VectorErrorCode, number> = {
  'vector.invalid_request': 400,
  'vector.dimension_mismatch': 422,
  'vector.rejected': 500,
  'vector.unavailable': 503,
  'vector.bad_response': 502,
}

/** What a vector store throws. Its message never holds a vector, an attribute value or query text. */
export class VectorError extends AppError {
  declare readonly code: VectorErrorCode

  constructor(
    code: VectorErrorCode,
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
    this.name = 'VectorError'
  }
}
