import { organizationIdSchema } from 'tula-closeline-contract'
import { z } from 'zod'
import { LLM_ERROR_CODES, LlmError } from './errors'
import {
  DEFAULT_LLM_MAX_INPUT_TOKENS,
  DEFAULT_LLM_MAX_OUTPUT_TOKENS,
  DEFAULT_LLM_RETRY_POLICY,
  DEFAULT_LLM_TIMEOUT_MS,
  estimateTokens,
  type LlmCompleteRequest,
  type LlmRequestBase,
  type LlmRetryPolicy,
  MAX_LLM_MAX_INPUT_TOKENS,
  MAX_LLM_MAX_OUTPUT_TOKENS,
  MAX_LLM_MESSAGES,
  MAX_LLM_TIMEOUT_MS,
  MODEL_TIERS,
  type ResolvedLlmRetryPolicy,
} from './port'

const SCHEMA_NAME = /^[A-Za-z0-9_-]{1,64}$/

/** Refuses with `llm.invalid_request`; `what` names the field, never its value. */
export function invalid(what: string): never {
  throw new LlmError(LLM_ERROR_CODES.invalidRequest, `${what} is not acceptable`)
}

function integerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

/** A request with its defaults filled in and its prompt measured. */
export interface CheckedRequest {
  /** The time limit, in ms. */
  timeoutMs: number
  /** The input token budget. */
  maxInputTokens: number
  /** The output token budget. */
  maxOutputTokens: number
  /** The retry policy. */
  retry: ResolvedLlmRetryPolicy
  /** The estimated tokens of the prompt. */
  inputTokens: number
}

/** Fills in the defaults of a retry policy and refuses a value out of range. */
export function resolveRetryPolicy(policy: LlmRetryPolicy | undefined): ResolvedLlmRetryPolicy {
  const maxRetries = policy?.maxRetries ?? DEFAULT_LLM_RETRY_POLICY.maxRetries
  const baseDelayMs = policy?.baseDelayMs ?? DEFAULT_LLM_RETRY_POLICY.baseDelayMs
  const maxDelayMs = policy?.maxDelayMs ?? DEFAULT_LLM_RETRY_POLICY.maxDelayMs
  if (!integerIn(maxRetries, 0, 5)) {
    invalid('retry.maxRetries')
  }
  if (!integerIn(baseDelayMs, 1, 60_000)) {
    invalid('retry.baseDelayMs')
  }
  if (!integerIn(maxDelayMs, baseDelayMs, 60_000)) {
    invalid('retry.maxDelayMs')
  }
  return { maxRetries, baseDelayMs, maxDelayMs }
}

/**
 * Checks the parts every request shares, measures the prompt and enforces the input budget.
 * Throws `llm.invalid_request` or `llm.input_too_large`; nothing has gone to the vendor.
 */
export function checkRequest(request: LlmRequestBase): CheckedRequest {
  if (typeof request !== 'object' || request === null) {
    return invalid('request')
  }
  if (!organizationIdSchema.safeParse(request.organizationId).success) {
    invalid('organizationId')
  }
  if (!MODEL_TIERS.includes(request.tier)) {
    invalid('tier')
  }
  if (request.system !== undefined && typeof request.system !== 'string') {
    invalid('system')
  }
  const messages: unknown = request.messages
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_LLM_MESSAGES) {
    invalid('messages')
  }
  for (const message of messages as unknown[]) {
    const m = message as { role?: unknown; content?: unknown } | null
    if (
      typeof m !== 'object' ||
      m === null ||
      (m.role !== 'user' && m.role !== 'assistant') ||
      typeof m.content !== 'string' ||
      m.content.length < 1
    ) {
      invalid('messages')
    }
  }
  if ((messages as { role: string }[]).at(-1)?.role !== 'user') {
    invalid('messages')
  }
  const timeoutMs = request.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS
  if (!integerIn(timeoutMs, 1, MAX_LLM_TIMEOUT_MS)) {
    invalid('timeoutMs')
  }
  const maxInputTokens = request.maxInputTokens ?? DEFAULT_LLM_MAX_INPUT_TOKENS
  if (!integerIn(maxInputTokens, 1, MAX_LLM_MAX_INPUT_TOKENS)) {
    invalid('maxInputTokens')
  }
  const maxOutputTokens = request.maxOutputTokens ?? DEFAULT_LLM_MAX_OUTPUT_TOKENS
  if (!integerIn(maxOutputTokens, 1, MAX_LLM_MAX_OUTPUT_TOKENS)) {
    invalid('maxOutputTokens')
  }
  if (request.signal !== undefined && !(request.signal instanceof AbortSignal)) {
    invalid('signal')
  }
  const retry = resolveRetryPolicy(request.retry)
  const inputTokens =
    estimateTokens(request.system ?? '') +
    (messages as { content: string }[]).reduce((sum, m) => sum + estimateTokens(m.content), 0)
  if (inputTokens > maxInputTokens) {
    throw new LlmError(LLM_ERROR_CODES.inputTooLarge, 'The prompt is over the input token budget', {
      details: { maxInputTokens },
    })
  }
  return { timeoutMs, maxInputTokens, maxOutputTokens, retry, inputTokens }
}

/** Checks a structured request and returns its checked parts and the JSON Schema to send the vendor. */
export function checkCompleteRequest(request: LlmCompleteRequest): {
  checked: CheckedRequest
  jsonSchema: Record<string, unknown>
} {
  const checked = checkRequest(request)
  if (!(request.schema instanceof z.ZodType)) {
    invalid('schema')
  }
  if (typeof request.schemaName !== 'string' || !SCHEMA_NAME.test(request.schemaName)) {
    invalid('schemaName')
  }
  let jsonSchema: Record<string, unknown>
  try {
    jsonSchema = z.toJSONSchema(request.schema, { io: 'input' }) as Record<string, unknown>
  } catch {
    return invalid('schema')
  }
  return { checked, jsonSchema }
}

/**
 * Parses the model's text as JSON and checks it against `schema`. Model output is untrusted: text
 * that is not JSON or does not fit the schema is `llm.invalid_output`, and the error carries only
 * a count and the first issue's code, never any of the output.
 */
export function parseModelOutput<S extends z.ZodType>(schema: S, text: string): z.output<S> {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new LlmError(LLM_ERROR_CODES.invalidOutput, 'The model did not answer in JSON', {
      details: { reason: 'not_json' },
    })
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    throw new LlmError(LLM_ERROR_CODES.invalidOutput, 'The model answer does not fit the schema', {
      details: { reason: 'schema', issues: parsed.error.issues.length },
    })
  }
  return parsed.data
}
