import { ConverseCommand, ConverseCommandOutput, ConverseStreamCommand, ConverseStreamCommandOutput } from "@aws-sdk/client-bedrock-runtime";
/** Structured logger that redacts secrets, tokens, recordings and message bodies. */
interface Logger {
	/** Logs detail useful only while debugging. */
	debug(message: string, fields?: Record<string, unknown>): void;
	/** Logs a normal event. */
	info(message: string, fields?: Record<string, unknown>): void;
	/** Logs something unexpected that the service recovered from. */
	warn(message: string, fields?: Record<string, unknown>): void;
	/** Logs a failure. */
	error(message: string, fields?: Record<string, unknown>): void;
	/** Returns a logger that adds `fields` to every entry. */
	child(fields: Record<string, unknown>): Logger;
}
/**
* Waits `ms` milliseconds, or less when `signal` aborts. Resolves either way, never rejects, so a
* loop that sleeps checks its own stop flag. Injected so tests drive time by hand.
*/
type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
/** What a service knows about the failed request; the only fields an ErrorReporter sends. */
interface ErrorContext {
	/** The request's id, for finding the log lines. */
	requestId?: string;
	/** The Organization the request was for, so one customer's errors can be filtered. */
	organizationId?: string;
	/** HTTP method of the failed request. */
	method?: string;
	/** Request path without its query string. */
	path?: string;
	/** HTTP status the service answered with. */
	status?: number;
	/** Extra low-cardinality labels, such as `{ feature: 'import' }`; never values from a customer. */
	tags?: Record<string, string>;
}
/** The one way a service reports an unexpected error. No service imports an error tracker itself. */
interface ErrorReporter {
	/**
	* Reports an error if `shouldReportError` says it is unexpected. Returns at once, never throws
	* and never waits for the network.
	*/
	capture(error: unknown, context?: ErrorContext): void;
	/** Waits up to `timeoutMs` for reported errors to be delivered; true if all were. Call it on shutdown. */
	flush(timeoutMs: number): Promise<boolean>;
	/**
	* Delivers what is pending (up to `timeoutMs`; true if all was) and then releases what the
	* reporter holds, such as the process listeners of an error tracker. After it, `capture` does
	* nothing and `flush` resolves false. Call it once on shutdown, after the last `capture`.
	*/
	close(timeoutMs: number): Promise<boolean>;
}
import { OrganizationId } from "tula-closeline-contract";
import { z as z2 } from "zod";
/**
* The model class a caller wants, never a vendor model id: `fast` for the live loop (low latency,
* short answers) and `smart` for work that can wait longer for a better answer. An adapter maps
* each tier to the model ids it uses.
*/
type ModelTier = "fast" | "smart";
/** One turn of the conversation sent to the model. */
interface LlmMessage {
	/** Who said it. Instructions go in `system`, not here. */
	role: "user" | "assistant";
	/** The text. Tenant data: never logged. Prospect speech, Documents and web text are untrusted. */
	content: string;
}
/** How an adapter retries a retryable vendor error (`llm.unavailable`) before giving up. */
interface LlmRetryPolicy {
	/** The most retries after the first attempt, 0 to 5; 0 never retries. Default 2. */
	maxRetries?: number;
	/** The base of the pause before a retry, in ms, 1 to 60000; doubled each time and jittered. Default 200. */
	baseDelayMs?: number;
	/** The longest pause before a retry, in ms, before jitter, at least the base and at most 60000. Default 2000. */
	maxDelayMs?: number;
}
/** What every call states: whose it is, which model class, and the limits that bound it. */
interface LlmRequestBase {
	/** The Organization the call is for; it scopes metering and error context. */
	organizationId: OrganizationId;
	/** The model class. */
	tier: ModelTier;
	/** Instructions to the model. Tenant data: never logged. */
	system?: string;
	/** The conversation so far, 1 to {@link MAX_LLM_MESSAGES} messages, ending with a `user` message. */
	messages: readonly LlmMessage[];
	/**
	* The most time the whole call may take, retries and streaming included, in ms, 1 to
	* {@link MAX_LLM_TIMEOUT_MS}; default {@link DEFAULT_LLM_TIMEOUT_MS}. When it passes, the
	* underlying vendor request is aborted and the call fails with `llm.timeout`.
	*/
	timeoutMs?: number;
	/**
	* The most tokens the prompt (system plus messages) may hold, 1 to
	* {@link MAX_LLM_MAX_INPUT_TOKENS}; default {@link DEFAULT_LLM_MAX_INPUT_TOKENS}. A longer prompt
	* fails with `llm.input_too_large` before any vendor call.
	*/
	maxInputTokens?: number;
	/**
	* The most tokens the model may write, 1 to {@link MAX_LLM_MAX_OUTPUT_TOKENS}; default
	* {@link DEFAULT_LLM_MAX_OUTPUT_TOKENS}. It is passed to the vendor as the hard cap.
	*/
	maxOutputTokens?: number;
	/** Retries of retryable vendor errors; the defaults when absent. */
	retry?: LlmRetryPolicy;
	/** The caller's own cancellation. When it fires the vendor request is aborted and the call fails with `llm.aborted`. */
	signal?: AbortSignal;
}
/** A request for a value shaped by a schema. */
interface LlmCompleteRequest<S extends z2.ZodType = z2.ZodType> extends LlmRequestBase {
	/**
	* The shape the model must answer in. It is sent to the vendor as a JSON Schema
	* (`z.toJSONSchema`), and the model's output is checked against this schema again here, since
	* model output is untrusted. It must be representable as JSON Schema.
	*/
	schema: S;
	/** A name for the schema, 1 to 64 letters, digits, `_` or `-`; vendors use it as the tool name. */
	schemaName: string;
}
/** A request for free text, delivered as it is written. */
type LlmStreamRequest = LlmRequestBase;
/** What a call used, for metering. */
interface LlmUsage {
	/** Tokens in the prompt. */
	inputTokens: number;
	/** Tokens the model wrote. */
	outputTokens: number;
}
/** A structured answer. */
interface LlmCompletion<T> {
	/** The model's answer, parsed and valid for the schema. */
	value: T;
	/** The tokens the successful attempt used; a failed attempt that was retried is not counted. */
	usage: LlmUsage;
}
/** A piece of text from the model. Tenant data: never logged. */
interface LlmTextEvent {
	/** Always `text`. */
	type: "text";
	/** The next piece, in order. Never empty. */
	text: string;
}
/** The end of a stream: the last event of a stream that did not throw. */
interface LlmDoneEvent {
	/** Always `done`. */
	type: "done";
	/** Why the model stopped: it finished (`end`) or hit the output token budget (`max_tokens`). */
	stopReason: "end" | "max_tokens";
	/** The tokens used. */
	usage: LlmUsage;
}
/** Everything a stream yields, in order: any number of `text`, then one `done`. */
type LlmStreamEvent = LlmTextEvent | LlmDoneEvent;
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
interface LlmPort {
	/** Asks for one value shaped by `schema`. O(prompt + output tokens), one vendor call per attempt. */
	complete<S extends z2.ZodType>(request: LlmCompleteRequest<S>): Promise<LlmCompletion<z2.output<S>>>;
	/**
	* Streams free text. An unacceptable request throws `llm.invalid_request` or
	* `llm.input_too_large` from this call; every later failure is thrown from the iteration. The
	* stream ends with one `done` event. Leaving the loop early (`break`) aborts the vendor
	* request. The time limit covers the whole stream.
	*/
	stream(request: LlmStreamRequest): AsyncIterable<LlmStreamEvent>;
}
/** The Bedrock model id of the fast tier unless `models.fast` says otherwise: Claude Haiku 5.5. */
declare const DEFAULT_BEDROCK_FAST_MODEL = "anthropic.claude-haiku-5-5";
/** The Bedrock model id of the smart tier unless `models.smart` says otherwise: Claude Sonnet 5.5. */
declare const DEFAULT_BEDROCK_SMART_MODEL = "anthropic.claude-sonnet-5-5";
/** The time the SDK waits to connect, unless `connectTimeoutMs` says otherwise. */
declare const DEFAULT_BEDROCK_CONNECT_TIMEOUT_MS = 5e3;
/** The part of the SDK client the adapter uses; tests pass a scripted one. */
interface BedrockSender {
	/** Sends one Converse or ConverseStream command, aborting it when `abortSignal` fires. */
	send(command: ConverseCommand, options?: {
		abortSignal?: AbortSignal;
		requestTimeout?: number;
	}): Promise<ConverseCommandOutput>;
	send(command: ConverseStreamCommand, options?: {
		abortSignal?: AbortSignal;
		requestTimeout?: number;
	}): Promise<ConverseStreamCommandOutput>;
}
/** Options for {@link createBedrockLlm}. */
interface BedrockLlmOptions {
	/** The AWS Region the calls are made in, such as `eu-west-1`; every call stays in it. */
	region: string;
	/** The model id of each tier; the Haiku 5.5 and Sonnet 5.5 ids by default. A bare `anthropic.*` id is called through the `region` geography's inference profile; a profile id must carry the prefix of `region`'s geography. */
	models?: Partial<Record<ModelTier, string>>;
	/** Time the SDK waits to connect, in ms; 5000 by default. */
	connectTimeoutMs?: number;
	/** Receives the errors that mean the model or vendor failed; nothing if absent. */
	reporter?: ErrorReporter;
	/** Where retries are noted (metadata only); nothing if absent. */
	logger?: Logger;
	/** Pauses between retries; real time by default. */
	sleep?: Sleep;
	/** A number in `[0, 1)` for the jitter; `Math.random` by default. */
	random?: () => number;
	/** A client to use instead of building one; for tests. Production code leaves it out. */
	client?: BedrockSender;
}
/**
* Builds an {@link LlmPort} on Amazon Bedrock (Converse and ConverseStream) with Claude models,
* in one Region. `complete` forces a tool whose input schema is the caller's, so the answer
* arrives as JSON and is checked with Zod. Every call has the request's time limit and a bounded,
* jittered retry of `llm.unavailable` (the SDK's own retry is off). Nothing leaves `region`: the
* endpoint cannot be overridden and an inference profile for another geography is refused.
* Prompts, completions and credentials are never logged, reported or put in an error.
*/
declare function createBedrockLlm(options: BedrockLlmOptions): LlmPort;
export { BedrockLlmOptions, BedrockSender, DEFAULT_BEDROCK_CONNECT_TIMEOUT_MS, DEFAULT_BEDROCK_FAST_MODEL, DEFAULT_BEDROCK_SMART_MODEL, createBedrockLlm };
