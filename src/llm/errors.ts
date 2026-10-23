import { AppError } from '../errors'

/** The `area.reason` codes the language model port and adapters throw. */
export const LLM_ERROR_CODES = {
  /** The Organization id, tier, messages, schema, limits or retry policy are not acceptable. Nothing was sent to the vendor. */
  invalidRequest: 'llm.invalid_request',
  /** The prompt is longer than the request's input token budget. Nothing was sent to the vendor. */
  inputTooLarge: 'llm.input_too_large',
  /** The model's output is not valid for the schema, or was cut off by the output token budget. Never a partial value. */
  invalidOutput: 'llm.invalid_output',
  /** The time limit passed; the underlying request was aborted. */
  timeout: 'llm.timeout',
  /** The caller's own AbortSignal fired; the underlying request was aborted. */
  aborted: 'llm.aborted',
  /** The vendor refused for a reason a retry cannot fix (credentials, quota, terms, content policy). */
  rejected: 'llm.rejected',
  /** The vendor could not be reached, was throttled or failed, after the bounded retries. The only retryable code. */
  unavailable: 'llm.unavailable',
  /** The vendor sent something this adapter cannot use. */
  badResponse: 'llm.bad_response',
} as const

/** One of {@link LLM_ERROR_CODES}'s values. */
export type LlmErrorCode = (typeof LLM_ERROR_CODES)[keyof typeof LLM_ERROR_CODES]

const STATUS: Record<LlmErrorCode, number> = {
  'llm.invalid_request': 400,
  'llm.input_too_large': 413,
  'llm.invalid_output': 502,
  'llm.timeout': 504,
  'llm.aborted': 499,
  'llm.rejected': 502,
  'llm.unavailable': 503,
  'llm.bad_response': 502,
}

/**
 * What a language model adapter throws. Its message and details never hold a prompt, a
 * completion, a credential or a vendor URL; model output is described by counts and codes only.
 */
export class LlmError extends AppError {
  declare readonly code: LlmErrorCode

  constructor(
    code: LlmErrorCode,
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
    this.name = 'LlmError'
  }
}
