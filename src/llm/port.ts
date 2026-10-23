import type { OrganizationId } from 'tula-closeline-contract'
import type { z } from 'zod'

/** The default time a call may take, in milliseconds. */
export const DEFAULT_LLM_TIMEOUT_MS = 15_000

/** The longest time a caller may allow a call, in milliseconds. */
export const MAX_LLM_TIMEOUT_MS = 120_000

/** The default input token budget. */
export const DEFAULT_LLM_MAX_INPUT_TOKENS = 16_000

/** The largest input token budget a caller may ask for. */
export const MAX_LLM_MAX_INPUT_TOKENS = 200_000

/** The default output token budget. */
export const DEFAULT_LLM_MAX_OUTPUT_TOKENS = 1024

/** The largest output token budget a caller may ask for. */
export const MAX_LLM_MAX_OUTPUT_TOKENS = 8192

/** The most messages one request may carry. */
export const MAX_LLM_MESSAGES = 100

/**
 * The model class a caller wants, never a vendor model id: `fast` for the live loop (low latency,
 * short answers) and `smart` for work that can wait longer for a better answer. An adapter maps
 * each tier to the model ids it uses.
 */
export type ModelTier = 'fast' | 'smart'

/** Every {@link ModelTier}. */
export const MODEL_TIERS: readonly ModelTier[] = ['fast', 'smart']

/** One turn of the conversation sent to the model. */
export interface LlmMessage {
  /** Who said it. Instructions go in `system`, not here. */
  role: 'user' | 'assistant'
  /** The text. Tenant data: never logged. Prospect speech, Documents and web text are untrusted. */
  content: string
}

/** How an adapter retries a retryable vendor error (`llm.unavailable`) before giving up. */
export interface LlmRetryPolicy {
  /** The most retries after the first attempt, 0 to 5; 0 never retries. Default 2. */
  maxRetries?: number
  /** The base of the pause before a retry, in ms, 1 to 60000; doubled each time and jittered. Default 200. */
  baseDelayMs?: number
  /** The longest pause before a retry, in ms, before jitter, at least the base and at most 60000. Default 2000. */
  maxDelayMs?: number
}

/** What every call states: whose it is, which model class, and the limits that bound it. */
export interface LlmRequestBase {
  /** The Organization the call is for; it scopes metering and error context. */
  organizationId: OrganizationId
  /** The model class. */
  tier: ModelTier
  /** Instructions to the model. Tenant data: never logged. */
  system?: string
  /** The conversation so far, 1 to {@link MAX_LLM_MESSAGES} messages, ending with a `user` message. */
  messages: readonly LlmMessage[]
  /**
   * The most time the whole call may take, retries and streaming included, in ms, 1 to
   * {@link MAX_LLM_TIMEOUT_MS}; default {@link DEFAULT_LLM_TIMEOUT_MS}. When it passes, the
   * underlying vendor request is aborted and the call fails with `llm.timeout`.
   */
  timeoutMs?: number
  /**
   * The most tokens the prompt (system plus messages) may hold, 1 to
   * {@link MAX_LLM_MAX_INPUT_TOKENS}; default {@link DEFAULT_LLM_MAX_INPUT_TOKENS}. A longer prompt
   * fails with `llm.input_too_large` before any vendor call.
   */
  maxInputTokens?: number
  /**
   * The most tokens the model may write, 1 to {@link MAX_LLM_MAX_OUTPUT_TOKENS}; default
   * {@link DEFAULT_LLM_MAX_OUTPUT_TOKENS}. It is passed to the vendor as the hard cap.
   */
  maxOutputTokens?: number
  /** Retries of retryable vendor errors; the defaults when absent. */
  retry?: LlmRetryPolicy
  /** The caller's own cancellation. When it fires the vendor request is aborted and the call fails with `llm.aborted`. */
  signal?: AbortSignal
}

/** A request for a value shaped by a schema. */
export interface LlmCompleteRequest<S extends z.ZodType = z.ZodType> extends LlmRequestBase {
  /**
   * The shape the model must answer in. It is sent to the vendor as a JSON Schema
   * (`z.toJSONSchema`), and the model's output is checked against this schema again here, since
   * model output is untrusted. It must be representable as JSON Schema.
   */
  schema: S
  /** A name for the schema, 1 to 64 letters, digits, `_` or `-`; vendors use it as the tool name. */
  schemaName: string
}

/** A request for free text, delivered as it is written. */
export type LlmStreamRequest = LlmRequestBase

/** What a call used, for metering. */
export interface LlmUsage {
  /** Tokens in the prompt. */
  inputTokens: number
  /** Tokens the model wrote. */
  outputTokens: number
}

/** A structured answer. */
export interface LlmCompletion<T> {
  /** The model's answer, parsed and valid for the schema. */
  value: T
  /** The tokens the successful attempt used; a failed attempt that was retried is not counted. */
  usage: LlmUsage
}

/** A piece of text from the model. Tenant data: never logged. */
export interface LlmTextEvent {
  /** Always `text`. */
  type: 'text'
  /** The next piece, in order. Never empty. */
  text: string
}

/** The end of a stream: the last event of a stream that did not throw. */
export interface LlmDoneEvent {
  /** Always `done`. */
  type: 'done'
  /** Why the model stopped: it finished (`end`) or hit the output token budget (`max_tokens`). */
  stopReason: 'end' | 'max_tokens'
  /** The tokens used. */
  usage: LlmUsage
}

/** Everything a stream yields, in order: any number of `text`, then one `done`. */
export type LlmStreamEvent = LlmTextEvent | LlmDoneEvent

/**
 * A language model behind a vendor (Claude on Amazon Bedrock first), shared by the Copilot and
 * the Inbound Agent. Model choice is a {@link ModelTier}; the adapter maps it to model ids.
 *
 * Every call has a hard timeout and token budgets. Retryable vendor errors (throttling, 5xx,
 * connection loss) are retried with a bounded, jittered pause ({@link llmRetryDelayMs}) inside
 * the call's time limit; nothing else is retried, and a stream is retried only before its first
 * text. A call has no effects, so retrying it is always safe. Failures are `LlmError`s with
 * `llm.*` codes; `llm.unavailable`, `llm.rejected`, `llm.bad_response` and `llm.invalid_output`
 * are also given to the ErrorReporter (metadata only).
 *
 * **Model output is untrusted data.** `complete` returns only a value the schema accepts; text
 * that is not JSON, does not fit, or was cut off is `llm.invalid_output`, never a partial value.
 * What the model says is never an instruction to the caller.
 *
 * Nothing here logs, reports or puts in an error a prompt or a completion (tenant data).
 */
export interface LlmPort {
  /** Asks for one value shaped by `schema`. O(prompt + output tokens), one vendor call per attempt. */
  complete<S extends z.ZodType>(request: LlmCompleteRequest<S>): Promise<LlmCompletion<z.output<S>>>
  /**
   * Streams free text. An unacceptable request throws `llm.invalid_request` or
   * `llm.input_too_large` from this call; every later failure is thrown from the iteration. The
   * stream ends with one `done` event. Leaving the loop early (`break`) aborts the vendor
   * request. The time limit covers the whole stream.
   */
  stream(request: LlmStreamRequest): AsyncIterable<LlmStreamEvent>
}

/** The characters one token is assumed to hold when estimating, low on purpose so the estimate runs high. */
export const ESTIMATED_CHARS_PER_TOKEN = 3

/**
 * A conservative token estimate for `text` (never below the real count for ordinary prose), used
 * for the input budget before a call and by the memory adapter. An adapter prefers the vendor's
 * own count for usage.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN)
}

/** The retry policy with its defaults filled in. */
export interface ResolvedLlmRetryPolicy {
  /** The most retries after the first attempt. */
  maxRetries: number
  /** The base pause, in ms. */
  baseDelayMs: number
  /** The longest pause before jitter, in ms. */
  maxDelayMs: number
}

/** The policy used when a request names none: two retries, 200 ms doubling to 2 s. */
export const DEFAULT_LLM_RETRY_POLICY: ResolvedLlmRetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 200,
  maxDelayMs: 2000,
}

/**
 * The pause before retry `retry` (from 1): the base doubled each time up to the maximum, then
 * scaled by a jitter between 0.5 and 1.5 from `random()` (a number in `[0, 1)`).
 */
export function llmRetryDelayMs(
  retry: number,
  policy: ResolvedLlmRetryPolicy,
  random: () => number = Math.random
): number {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (retry - 1))
  return Math.max(1, Math.floor(exponential * (0.5 + random())))
}
