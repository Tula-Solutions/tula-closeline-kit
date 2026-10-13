import { z } from "zod";
/** A source of the current time, so code under test never reads the real clock. */
interface Clock {
	/** Returns the current time as a new Date each call. */
	now(): Date;
}
/** `organization` messages belong to one Organization and carry its id; `global` ones never do. */
type MessageScope = "organization" | "global";
/** What one kind of message is: its name, its current version, its scope and its payload schema. */
interface MessageDefinition<
	T extends string = string,
	P extends z.ZodType = z.ZodType,
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
	payload: z.ZodType;
	/** Turns a validated old payload into the current payload's input. A throw makes the message invalid. */
	upcast: (payload: unknown) => unknown;
}
/** A definition of any type, for code that accepts every kind. */
type AnyDefinition = MessageDefinition<string, z.ZodType, MessageScope>;
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
type EnvelopeOf<D> = D extends MessageDefinition<infer T, infer P, infer S> ? EnvelopeBase<T, z.output<P>> & ScopeField<S> : never;
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
	payload: z.input<P>;
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
/** Options for {@link createMessageRegistry}. */
interface MessageRegistryOptions {
	/** Time source for `occurredAt`; defaults to the system clock. */
	clock?: Clock;
	/** Id source; defaults to `crypto.randomUUID`. */
	newId?: () => string;
	/**
	* The shape of an Organization id, checked for `organization` messages on the way in and out.
	* Defaults to the contract's `organizationIdSchema` (`org_` and 32 lower-case hex digits).
	*/
	organizationIdSchema?: z.ZodType<string>;
}
/**
* Builds a registry from the message definitions a service knows. Two definitions with the same
* type are a mistake and throw.
*/
declare function createMessageRegistry<const D extends AnyDefinition>(definitions: readonly D[], options?: MessageRegistryOptions): MessageRegistry<D>;
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
import { z as z2 } from "zod";
/** A message that belongs to an Organization, for tests and examples. */
declare const testPing: MessageDefinition<"test.ping", z2.ZodObject<{
	n: z2.ZodNumber;
}, z2.core.$strip>, "organization">;
/** A message that belongs to no Organization, for tests and examples. */
declare const testNote: MessageDefinition<"test.note", z2.ZodObject<{
	text: z2.ZodString;
}, z2.core.$strip>, "global">;
/** The definitions the behaviour suite uses. */
type TestDefinition = typeof testPing | typeof testNote;
/** An envelope of either test type. */
type TestEnvelope = EnvelopeOf<TestDefinition>;
/** Creates a registry of {@link testPing} and {@link testNote}. */
declare function createTestRegistry(options?: Parameters<typeof createMessageRegistry>[1]): MessageRegistry<TestDefinition>;
/** What the behaviour suite needs from an adapter under test. */
interface QueueSubject {
	/** The queue under test, empty, built over {@link createTestRegistry}. */
	queue: Queue<TestEnvelope>;
	/** The registry the queue was built with. */
	registry: ReturnType<typeof createTestRegistry>;
	/** The queue's visibility timeout for plain receives in the suite, in seconds (small). */
	visibilitySeconds: number;
	/** Seconds a receive that expects nothing waits: 0 is enough for memory; SQS needs a long poll to be sure. */
	emptyWaitSeconds: number;
	/** Deliveries before the dead-letter queue takes a message. */
	maxReceiveCount: number;
	/** Lets `seconds` of the queue's time go by: advances a virtual clock, or really waits. */
	pass(seconds: number): Promise<void>;
	/** Puts a raw body in the queue without validating it. */
	injectRaw(body: string): Promise<void>;
	/** Envelope ids that reached the dead-letter queue; undefined when the subject cannot see it. */
	deadLetterIds(): Promise<string[] | undefined>;
	/** Releases what the subject created. */
	close(): Promise<void>;
}
/**
* The behaviour every {@link Queue} must show. Run it with {@link queueBehaviour} against the
* memory adapter and against the SQS adapter on ElasticMQ; a change that passes for one and fails
* for the other is a bug in one of them.
*/
declare function queueBehaviour(name: string, make: () => Promise<QueueSubject>, skip?: boolean): void;
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
/** What the store behaviour suite needs from an implementation under test. */
interface StoreSubject {
	/** The store under test, empty. */
	store: ProcessedStore;
	/** Lets `seconds` go by for leases: advances a virtual clock, or really waits. */
	pass(seconds: number): Promise<void>;
	/** The store's current time, as `purge` compares it. */
	now(): Date;
	/** Releases what the subject created (rows, connections). */
	close(): Promise<void>;
}
/**
* The behaviour every {@link ProcessedStore} must show. A service runs it against its Postgres
* store (`tula-closeline-kit/testing/behaviour`); the memory store runs it in this repo.
* Leases are 60 seconds, so a subject that really waits should scale them or fake the database clock.
*/
declare function processedStoreBehaviour(name: string, make: () => Promise<StoreSubject>): void;
export { QueueSubject, StoreSubject, processedStoreBehaviour, queueBehaviour };
