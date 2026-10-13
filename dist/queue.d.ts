import { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand, SendMessageBatchCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
/** The deployment environments a service can run in, from its `ENVIRONMENT` variable. */
declare const ENVIRONMENTS: readonly ["local", "dev", "staging", "prod"];
/** One of the deployment environments. */
type Environment = (typeof ENVIRONMENTS)[number];
import { z as z2 } from "zod";
/** `organization` messages belong to one Organization and carry its id; `global` ones never do. */
type MessageScope = "organization" | "global";
/** What one kind of message is: its name, its current version, its scope and its payload schema. */
interface MessageDefinition<
	T extends string = string,
	P extends z2.ZodType = z2.ZodType,
	S extends MessageScope = MessageScope
> {
	readonly type: T;
	readonly version: number;
	readonly scope: S;
	readonly payload: P;
	/** Older versions this consumer still accepts, each upcast to the current payload shape. */
	readonly previous?: readonly PreviousVersion[];
}
/**
* An older version of a message that is still accepted, so a rolling deploy does not bounce the
* messages in flight. The payload is validated with `payload` (the old shape), turned into the
* current shape by `upcast`, and then validated again with the current schema. The handler only
* ever sees the current shape, and the envelope it gets says the current version.
*/
interface PreviousVersion {
	/** The older version number; must differ from the definition's own. */
	version: number;
	/** The payload schema of that version. */
	payload: z2.ZodType;
	/** Turns a validated old payload into the current payload's input. A throw makes the message invalid. */
	upcast: (payload: unknown) => unknown;
}
/** A definition of any type, for code that accepts every kind. */
type AnyDefinition = MessageDefinition<string, z2.ZodType, MessageScope>;
/** The fields every envelope has. */
interface EnvelopeBase<
	T extends string,
	P
> {
	/** Unique id of this message; stays the same when the publisher retries, so consumers can dedupe. */
	id: string;
	/** The message type, such as `core.organization_created`. */
	type: T;
	/** The version of the type's definition this was written with. */
	version: number;
	/** When the thing happened, ISO 8601 UTC. */
	occurredAt: string;
	/** The request or trace id that caused it, for finding the log lines. */
	traceId: string;
	/** The validated payload. */
	payload: P;
}
type ScopeField<S> = S extends "organization" ? {
	organizationId: string;
} : {
	organizationId?: undefined;
};
/** The envelope of a definition, or the union of the envelopes of a union of definitions. */
type EnvelopeOf<D> = D extends MessageDefinition<infer T, infer P, infer S> ? EnvelopeBase<T, z2.output<P>> & ScopeField<S> : never;
/** The shape every envelope has, whatever its type. */
interface AnyEnvelope {
	id: string;
	type: string;
	version: number;
	occurredAt: string;
	organizationId?: string | undefined;
	traceId: string;
	payload: unknown;
}
/** What a publisher gives {@link MessageRegistry.create}; the registry adds the id and time. */
type CreateInput<D> = D extends MessageDefinition<infer T, infer P, infer S> ? {
	type: T;
	payload: z2.input<P>;
	traceId: string;
	/** Keep a fixed id across retries of one logical event; defaults to a new UUID. */
	id?: string;
	/** Defaults to the registry clock's now. */
	occurredAt?: Date;
} & ScopeField<S> : never;
/** Why a received body is not a message this registry accepts. */
declare const INVALID_REASONS: readonly ["malformed", "unknown_type", "unsupported_version", "invalid_scope", "invalid_payload"];
/** One of {@link INVALID_REASONS}. */
type InvalidReason = (typeof INVALID_REASONS)[number];
/** The outcome of {@link MessageRegistry.decode}. `issues` are field paths and codes, never values. */
type DecodeResult<E> = {
	ok: true;
	envelope: E;
} | {
	ok: false;
	reason: InvalidReason;
	issues: string[];
	messageId?: string;
};
/** Knows every message type a service handles; builds, encodes and decodes envelopes. */
interface MessageRegistry<D extends AnyDefinition> {
	/** The definitions, by type. */
	readonly definitions: ReadonlyMap<string, D>;
	/** Builds a validated envelope. Throws a ZodError when the payload does not fit its schema. */
	create(input: CreateInput<D>): EnvelopeOf<D>;
	/**
	* Validates an envelope and turns it into the JSON body to send. Throws a QueueError with code
	* `queue.invalid_message` for an unknown type, a wrong version or scope, or a bad payload.
	* Complexity O(body size).
	*/
	encode(envelope: EnvelopeOf<D>): string;
	/**
	* Parses and validates a received body. Never throws: a body that is not an accepted message
	* comes back as `ok: false` so the caller decides what happens to it. O(body size).
	*/
	decode(body: string): DecodeResult<EnvelopeOf<D>>;
}
/** Opaque handle for one delivery of a message; pass it back to acknowledge or change visibility. */
type Receipt = string;
/** A message that arrived and passed validation. */
interface ValidDelivery<E> {
	kind: "message";
	/** The validated envelope. */
	envelope: E;
	/** Handle for acknowledging this delivery. */
	receipt: Receipt;
	/** How many times the queue has handed this message out, this delivery included (1 on the first). */
	receiveCount: number;
}
/**
* A message that arrived but is not one this service accepts: not JSON, an unknown type, a
* different version, a wrong scope or a payload that fails its schema. It is handed to the caller
* rather than dropped, so it can be logged, reported and left to reach the dead-letter queue. It
* carries no body: only the reason, field paths and the envelope id when one could be read.
*/
interface InvalidDelivery {
	kind: "invalid";
	/** Why it was rejected. */
	reason: InvalidReason;
	/** Field paths and codes of what failed; never values. */
	issues: string[];
	/** The envelope's id, when the body had one. */
	messageId?: string;
	/** Handle for acknowledging, or delaying, this delivery. */
	receipt: Receipt;
	/** How many times the queue has handed this message out. */
	receiveCount: number;
}
/** One thing {@link Queue.receive} returns. */
type Delivery<E> = ValidDelivery<E> | InvalidDelivery;
/** What {@link Queue.receive} is asked for. */
interface ReceiveOptions {
	/** How many messages at most, 1 to 10. */
	maxMessages: number;
	/** How long the messages stay hidden from other receivers, in seconds, 0 to 43200. */
	visibilityTimeoutSeconds: number;
	/** How long to wait for a message when the queue is empty (long poll), in seconds, 0 to 20. */
	waitSeconds: number;
	/** Ends the wait early; the call then returns an empty list. */
	signal?: AbortSignal;
}
/** What {@link Queue.publishBatch} reports for one message that was not accepted. */
interface BatchFailure {
	/** The envelope id. */
	id: string;
	/** The queue's error code, such as `InternalError` or `ServiceUnavailable`. */
	code: string;
	/** True when the failure is the sender's fault (retrying the same message will not help). */
	senderFault: boolean;
}
/** The outcome of a batch publish: which envelope ids were accepted and which were not. */
interface BatchResult {
	/** Ids of the envelopes the queue accepted, in input order. */
	sent: string[];
	/** The ones it did not; the caller retries these (the same envelope, so the id is stable). */
	failed: BatchFailure[];
}
/**
* A queue of typed messages. Delivery is at-least-once and unordered: a message can be handed out
* more than once (a consumer that is slow, crashes, or a duplicate in the queue itself) and two
* messages can arrive in either order, so a handler must be idempotent (see
* {@link createConsumer}). An envelope is validated against the registry on the way in and on the
* way out. The queue holds the message until it is acknowledged; after the queue's
* `maxReceiveCount` deliveries it moves to the dead-letter queue instead of being delivered again.
*/
interface Queue<E extends AnyEnvelope = AnyEnvelope> {
	/**
	* Sends one message. Resolves when the queue has accepted it. Throws a QueueError: invalid
	* message, message too large, or unavailable (after the adapter's bounded, jittered retries).
	* A retry after an `unavailable` error can leave two copies in the queue with the same envelope
	* id; the idempotent consumer drops the second. O(message size).
	*/
	publish(envelope: E): Promise<void>;
	/**
	* Sends up to 10 messages (and up to 256 KiB in total) in one call. Everything is validated
	* before anything is sent. A message the queue refuses comes back in `failed`; the call throws
	* only when the whole request fails. O(total size).
	*/
	publishBatch(envelopes: readonly E[]): Promise<BatchResult>;
	/**
	* Receives up to `maxMessages` messages and hides them for `visibilityTimeoutSeconds`. With
	* `waitSeconds` above 0 it waits that long for a message when the queue is empty. Messages that
	* are not valid come back as `kind: 'invalid'`. O(batch size).
	*/
	receive(options: ReceiveOptions): Promise<Delivery<E>[]>;
	/**
	* Removes the message for good. Safe to call twice and for a delivery that was already
	* redelivered: it resolves either way.
	*/
	acknowledge(receipt: Receipt): Promise<void>;
	/**
	* Hides the message for `seconds` more from now (a lease extension, or a delay before retry).
	* Throws a QueueError `queue.receipt_invalid` when the message is no longer in flight.
	*/
	extendVisibility(receipt: Receipt, seconds: number): Promise<void>;
	/** Makes the message visible again at once, so another receive gets it. Same errors as extendVisibility. */
	release(receipt: Receipt): Promise<void>;
}
/** The one SDK method the adapter uses; a test passes a stub with this shape. */
interface SqsSender {
	/** Sends one SDK command, with an optional per-call timeout and abort signal. */
	send(command: SendMessageCommand | SendMessageBatchCommand | ReceiveMessageCommand | DeleteMessageCommand | ChangeMessageVisibilityCommand, options?: {
		requestTimeout?: number;
		abortSignal?: AbortSignal;
	}): Promise<unknown>;
}
/** Options for {@link createSqsQueue}. */
interface SqsQueueOptions<D extends AnyDefinition> {
	/** The queue's URL. */
	queueUrl: string;
	/** The AWS Region of the queue; each Closeline Region has its own queues (ADR 0001). */
	region: string;
	/** The `ENVIRONMENT` the service runs in. */
	environment: Environment;
	/** The message types the queue accepts and delivers. */
	registry: MessageRegistry<D>;
	/**
	* An endpoint to use instead of AWS, for ElasticMQ in local development (`http://127.0.0.1:9324`).
	* Accepted only when `environment` is `local`; anywhere else it throws at construction, so a
	* deployed service cannot be pointed away from AWS by a stray setting. Credentials are never an
	* option: they come from the SDK's default chain (the task role in AWS; for ElasticMQ, any
	* `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` values).
	*/
	endpoint?: string;
	/** Bound on one attempt's connect and request, in ms; default 5000. A long poll adds its wait. */
	timeoutMs?: number;
	/** Attempts per call, the first included, with the SDK's jittered exponential back-off; default 3. */
	maxAttempts?: number;
	/** A replacement for the SDK client, for unit tests with no network. */
	client?: SqsSender;
}
/** The default bound on one attempt, in milliseconds. */
declare const SQS_DEFAULT_TIMEOUT_MS = 5e3;
/** The default number of attempts per call. */
declare const SQS_DEFAULT_MAX_ATTEMPTS = 3;
/**
* Creates the SQS adapter, built on the AWS SDK v3 SQS client.
*
* Timeouts: every attempt has a connect and a request timeout (`timeoutMs`; a long poll adds its
* wait). Retries: the SDK's own, `maxAttempts` with the `standard` mode's jittered exponential
* back-off and retry quota; the adapter adds no second layer. A failed publish after the retries
* throws `queue.unavailable`; republishing the same envelope is safe because consumers dedupe on
* its id. Limits are checked before anything is sent. Message bodies are never logged: the
* adapter does not log, and its errors carry the SDK error as `cause` but never a body.
*
* Proxies: the SDK's Node HTTP handler is used with its default agents, which in Bun do not read
* `HTTP_PROXY`, `HTTPS_PROXY` or `ALL_PROXY` (proven by `aws-proxy.test.ts`). Queue traffic
* therefore never goes through a proxy named in the environment (ADR 0013). There is no option for
* a deliberate proxy yet; add one here, and a test, if infrastructure ever needs it.
*
* Complexity: publish O(message size); receive O(batch size); one HTTP call each.
*/
declare function createSqsQueue<const D extends AnyDefinition>(options: SqsQueueOptions<D>): Queue<EnvelopeOf<D>>;
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
/**
* Waits `ms` milliseconds, or less when `signal` aborts. Resolves either way, never rejects, so a
* loop that sleeps checks its own stop flag. Injected so tests drive time by hand.
*/
type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
/** Identifies one message for one consumer: what "already processed" is recorded against. */
interface ConsumedKey {
	/** The consumer's name, so two consumers of different queues in one service do not collide. */
	consumer: string;
	/** The Organization the message belongs to, or null for a global message. Part of the key on purpose. */
	organizationId: string | null;
	/** The envelope id. */
	messageId: string;
}
/**
* What {@link ProcessedStore.claim} answers. `busy` says how many whole seconds remain on the live
* claim's lease (at least 1), so the consumer can hide the message until then instead of
* redelivering it again and again.
*/
type ClaimResult = {
	status: "claimed";
	token: string;
} | {
	status: "done";
} | {
	status: "busy";
	retryAfterSeconds: number;
};
/**
* Where an idempotent consumer records which messages are done. In production it is a Postgres
* table in the service's own schema (see the README), never process memory, so any instance can be
* stopped and a redelivery to another instance is still recognised.
*/
interface ProcessedStore {
	/**
	* Tries to take the message for `leaseSeconds`. `claimed` returns a token that the claimant
	* must pass to `complete` or `release`; `done` means it was completed before; `busy` means
	* another claim is live. A claim whose lease ran out can be taken again, so a consumer that
	* died mid-handler does not block the message forever. Must be atomic (one statement).
	* Like every method here it must answer within a few seconds or fail; the consumer gives each
	* call `storeTimeoutMs` (10 s by default) and treats a timeout as a failure, so a hung database
	* cannot hold a slot for ever. A call that completes after its timeout may leave a claim behind;
	* its lease lapses by itself.
	*/
	claim(key: ConsumedKey, leaseSeconds: number): Promise<ClaimResult>;
	/**
	* Pushes the end of the claim's lease to `leaseSeconds` from now. Returns false if the claim was
	* lost (it lapsed and another took it, or it was released). The consumer calls it with every
	* visibility extension while a handler runs, so a live holder never loses its lease.
	*/
	renew(key: ConsumedKey, token: string, leaseSeconds: number): Promise<boolean>;
	/** Marks the message done. Returns false if the claim was lost (its lease ran out and another took it). */
	complete(key: ConsumedKey, token: string): Promise<boolean>;
	/** Gives up a claim without completing, so the next delivery can take it. A lost claim is ignored. */
	release(key: ConsumedKey, token: string): Promise<void>;
	/**
	* Deletes completed records older than `before` and lapsed claims, at most `limit` rows, and
	* returns how many. Call it from a periodic job. `before` must be older than the queue's message
	* retention (14 days at most), or a very late redelivery would run twice.
	*/
	purge(before: Date, limit: number): Promise<number>;
}
/** What a handler is told about the delivery it is processing. */
interface HandlerContext {
	/**
	* The Organization the message belongs to, taken from the validated envelope; undefined for a
	* global message. Scope every read and write to it. The same value is part of the idempotency
	* key, so another Organization's message with the same id is a different message.
	*/
	readonly organizationId: string | undefined;
	/** The request or trace id that caused the message. */
	readonly traceId: string;
	/** How many times the queue has delivered this message, this delivery included. */
	readonly receiveCount: number;
	/**
	* Aborts when the handler has run past `handlerTimeoutMs`, when the consumer lost the message
	* (its visibility ran out and it was handed to someone else) or when shutdown gave up waiting.
	* A handler checks it between steps and stops; one that ignores it may run alongside a retry.
	*/
	readonly signal: AbortSignal;
}
/** One handler per message type of the queue; the type of `message` follows the key. */
type Handlers<E extends AnyEnvelope> = { [T in E["type"]]? : (message: Extract<E, {
	type: T;
}>, context: HandlerContext) => Promise<void> };
/** Options for {@link createConsumer}. */
interface ConsumerOptions<E extends AnyEnvelope> {
	/** Names this consumer in the store and in logs, such as `playbook.ingestion`. */
	name: string;
	/** The queue to read. */
	queue: Queue<E>;
	/** Where finished messages are recorded; Postgres in production (see the README). */
	store: ProcessedStore;
	/** The handlers. A message whose type has none is treated like an invalid one. */
	handlers: Handlers<E>;
	/** Where problems are logged: ids, types and counts only, never a body or a payload. */
	logger: Logger;
	/** Where unexpected failures are reported; optional. */
	errorReporter?: ErrorReporter;
	/** Waits for the extend timer, the retry back-off and the shutdown deadline; defaults to real timers. */
	sleep?: Sleep;
	/** Random in [0, 1) for jitter; defaults to `Math.random`. */
	random?: () => number;
	/** Messages handled at once, 1 to 100; default 4. */
	concurrency?: number;
	/** Long-poll wait in seconds, 0 to 20; default 20. */
	waitSeconds?: number;
	/** Visibility timeout in seconds, 2 or more; default 30. The consumer extends it while a handler runs. */
	visibilityTimeoutSeconds?: number;
	/** How long one handler may run before its signal aborts, in ms; default 300000 (5 minutes). */
	handlerTimeoutMs?: number;
	/** First delay before a failed message is retried, in seconds; doubles per delivery; default 5. */
	retryBaseSeconds?: number;
	/** Longest retry delay in seconds; default 300. */
	retryMaxSeconds?: number;
	/**
	* How long an invalid or unhandled message stays hidden before the next look, in seconds;
	* default 60. A message of a version this consumer does not know starts here and doubles with
	* each delivery, up to `unsupportedVersionMaxSeconds`.
	*/
	invalidDelaySeconds?: number;
	/** Longest delay for a message of an unknown version, in seconds; default 3600. */
	unsupportedVersionMaxSeconds?: number;
	/** How long one call to the processed store may take, in ms; default 10000. A timeout counts as a failure. */
	storeTimeoutMs?: number;
}
/** What {@link Consumer.stop} did with the messages in flight. */
interface StopResult {
	/** Handlings that ran to an end without being abandoned, whatever their outcome (success, failure or timeout), over the consumer's life. */
	finished: number;
	/** Messages given back to the queue because the deadline passed. */
	abandoned: number;
}
/** A running (or runnable) message loop. */
interface Consumer {
	/** Starts receiving in the background. Calling it twice does nothing. */
	start(): void;
	/**
	* Stops receiving, waits up to `deadlineMs` for handlers in flight, then aborts their signals and
	* hands what is left back to the queue (claims released, visibility 0). Resolves when that is done.
	*/
	stop(deadlineMs: number): Promise<StopResult>;
	/** Receives one batch with no wait and handles it to the end; returns how many arrived. For tests and one-shot jobs. */
	pollOnce(): Promise<number>;
}
/**
* Wraps handlers so that each message has its effect once, on top of at-least-once delivery.
*
* Guarantees: a message completed before is acknowledged and not handled again; two consumers that
* receive the same message do not both run it (the second finds the claim and backs off); a
* handler that throws or times out leaves the message in the queue for a delayed retry, and the
* queue's `maxReceiveCount` sends it to the dead-letter queue; an invalid message or one without
* a handler is never acknowledged, never crashes the loop, and ends in the dead-letter queue; at
* most `concurrency` handlers run at once; the Organization id is the envelope's own and is part
* of the idempotency key.
*
* Not guaranteed: a crash between the handler's effect and `store.complete` runs the effect again
* after the lease. Keep the effect and the store record in one database transaction where you can,
* or make the effect itself idempotent.
*/
declare function createConsumer<E extends AnyEnvelope>(options: ConsumerOptions<E>): Consumer;
export { Consumer, ConsumerOptions, HandlerContext, Handlers, SQS_DEFAULT_MAX_ATTEMPTS, SQS_DEFAULT_TIMEOUT_MS, SqsQueueOptions, SqsSender, StopResult, createConsumer, createSqsQueue };
