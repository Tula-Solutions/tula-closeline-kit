/** A source of the current time, so code under test never reads the real clock. */
interface Clock {
	/** Returns the current time as a new Date each call. */
	now(): Date;
}
/** A clock that can be moved forward by hand. */
interface FixedClock extends Clock {
	/** Moves the clock forward by a duration such as `500ms`, `30s`, `10m`, `2h` or `1d`. */
	advance(duration: string): void;
}
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
/** The deployment environments a service can run in, from its `ENVIRONMENT` variable. */
declare const ENVIRONMENTS: readonly ["local", "dev", "staging", "prod"];
/** One of the deployment environments. */
type Environment = (typeof ENVIRONMENTS)[number];
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
/** One error a MemoryErrorReporter recorded, with the context it was reported with. */
interface CapturedError {
	error: unknown;
	context: ErrorContext;
}
/** An ErrorReporter that keeps what it is given in memory so tests can assert on it. */
interface MemoryErrorReporter extends ErrorReporter {
	/** Every error that would have been sent, in order; expected (below 500) AppErrors are left out. */
	readonly captured: CapturedError[];
	/** The timeout of every flush, in order. */
	readonly flushes: number[];
	/** The timeout of every close, in order. */
	readonly closes: number[];
}
/** Creates an ErrorReporter that records reported errors in memory instead of sending them. */
declare function createMemoryErrorReporter(): MemoryErrorReporter;
/** A JSON Web Key Set as published by the auth service. */
interface Jwks {
	keys: readonly unknown[];
}
import { Id as Id_1tn } from "tula-closeline-contract";
/** An Ed25519 key pair for signing tokens in tests. */
interface TestKeyPair {
	/** The `kid` tokens signed with this pair carry. */
	kid: string;
	/** The private key; never leaves the test. */
	privateKey: CryptoKey;
	/** The public half as a JWK with `kid`, ready for a JWKS. */
	publicJwk: {
		kty: "OKP";
		crv: "Ed25519";
		x: string;
		kid: string;
		use: "sig";
		alg: "EdDSA";
	};
}
/** A user id for tests; `n` picks which one. */
declare const testUserId: (n?: number) => Id_1tn<"usr">;
/** An Organization id for tests; `n` picks which one. */
declare const testOrganizationId: (n?: number) => Id_1tn<"org">;
/** Generates an Ed25519 key pair for tests. */
declare function createTestKeyPair(kid?: string): Promise<TestKeyPair>;
/** Builds the JWKS an auth service would publish for these key pairs. */
declare function createTestJwks(...pairs: TestKeyPair[]): Jwks;
/** What to put in a test token; every field has a valid default. */
interface MintTokenOptions {
	/** The pair to sign with. */
	keyPair: TestKeyPair;
	/** Time source; `iat` and `exp` are relative to it. */
	clock: Clock;
	/** The `iss` claim; defaults to `https://auth.test`. */
	issuer?: string;
	/** The `aud` claim; defaults to `closeline`. */
	audience?: string;
	/** Seconds until expiry, negative for an already-expired token; defaults to 900. */
	expiresInSeconds?: number;
	/** Seconds from now before the token becomes valid, if it should carry `nbf`. */
	notBeforeSeconds?: number;
	/** Seconds to shift `iat` by, e.g. positive for a token issued in the future. */
	issuedAtOffsetSeconds?: number;
	/** Claims to add or override, e.g. `{ role: 'admin' }`; `undefined` removes a claim. */
	claims?: Record<string, unknown>;
	/**
	* Header fields to add or override, e.g. `{ kid: 'other' }`; `undefined` removes one. The
	* default header is `alg: EdDSA`, the key's `kid` and `typ: at+jwt`; `{ typ: undefined }`
	* omits the type and `{ typ: 'refresh' }` changes it.
	*/
	header?: Record<string, unknown>;
}
/** The default Organization id minted into test tokens. */
declare const DEFAULT_TEST_ORGANIZATION_ID: Id_1tn<"org">;
/** The default user id minted into test tokens. */
declare const DEFAULT_TEST_USER_ID: Id_1tn<"usr">;
/** Signs a valid access token for tests, with knobs to break one thing at a time. */
declare function mintTestToken(options: MintTokenOptions): Promise<string>;
import { ContactCheckResult as ContactCheckResult2, ContactDenialCode, SuppressionReason } from "tula-closeline-contract";
import { ContactCheckRequest, ContactCheckResult } from "tula-closeline-contract";
/**
* What a calling service gives the guard: the Contact Check body without `caller`, which the
* guard fills in with the service's own name. There is no field that waives the check (ADR 0003).
*/
type ContactGuardRequest = Omit<ContactCheckRequest, "caller">;
/** The answer of a Contact Check: an allowance with its basis, or a denial with a `consent.*` code. */
type ContactGuardResult = ContactCheckResult;
/**
* The question every channel asks before it contacts a Prospect: may I contact this Prospect, or
* this address, on this channel now, for this purpose (ADR 0003, ADR 0021)? It never throws and it
* fails closed: anything but a clear allowance is a denial, and a check that could not be answered
* is a denial with `consent.unavailable`. Only `allowed: true` permits a contact.
*/
interface ContactGuard {
	/** Asks the check; resolves with an allowance or a denial and never rejects. */
	check(request: ContactGuardRequest): Promise<ContactGuardResult>;
}
type Basis = Extract<ContactCheckResult2, {
	allowed: true;
}>["basis"];
/** Who a preset is about: an Organization and exactly one of a Prospect id or an address. */
type ContactTarget = Pick<ContactGuardRequest, "organizationId" | "prospectId" | "email" | "phone" | "linkedinUrl">;
/** A {@link ContactGuard} that tests configure, and that records what it was asked. */
interface MemoryContactGuard extends ContactGuard {
	/** Every valid request the guard answered, in order. */
	readonly calls: readonly ContactGuardRequest[];
	/** Allows contact with `target` on `channel` for any purpose. */
	allow(target: ContactTarget, channel: ContactGuardRequest["channel"], basis?: Basis): MemoryContactGuard;
	/** Denies contact with `target` on `channel` with `code`; a suppressed denial needs a reason. */
	deny(target: ContactTarget, channel: ContactGuardRequest["channel"], code?: Exclude<ContactDenialCode, "consent.unavailable">, suppressionReason?: SuppressionReason): MemoryContactGuard;
	/** Makes every check answer as if core could not be reached (or, with `false`, restores it). */
	setUnavailable(unavailable?: boolean): MemoryContactGuard;
	/** Forgets every preset and call. */
	reset(): void;
}
/**
* Builds a {@link ContactGuard} for tests. A target nobody presets is denied with
* `consent.missing`, as core denies an unknown Prospect. It validates requests as the HTTP guard
* does: an invalid one is denied with `consent.unavailable` and is not recorded. Not for production.
*/
declare function createMemoryContactGuard(): MemoryContactGuard;
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
	organizationIdSchema?: z2.ZodType<string>;
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
/**
* Waits `ms` milliseconds, or less when `signal` aborts. Resolves either way, never rejects, so a
* loop that sleeps checks its own stop flag. Injected so tests drive time by hand.
*/
type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
/** Options for {@link createMemoryQueue}. */
interface MemoryQueueOptions<D extends AnyDefinition> {
	/** The message types the queue accepts and delivers. */
	registry: MessageRegistry<D>;
	/** Time source for visibility timeouts; tests pass a FixedClock and advance it. */
	clock: Clock;
	/** Waits for long polls; defaults to the real timer. Tests pass a virtual one. */
	sleep?: Sleep;
	/** Deliveries before a message moves to the dead-letter list; defaults to 5 like the dev queue. */
	maxReceiveCount?: number;
	/**
	* Random in [0, 1). When given, receive picks among the visible messages at random instead of in
	* publish order, which SQS does not promise either; tests use it to prove a consumer does not
	* depend on order.
	*/
	random?: () => number;
}
/** A message the memory queue moved aside after `maxReceiveCount` deliveries. */
interface DeadLetter {
	/** The envelope id when the body had one. */
	messageId: string | undefined;
	/** How many times it was delivered. */
	receiveCount: number;
}
/** A {@link Queue} that keeps everything in the process, for tests. Not for production. */
interface MemoryQueue<D extends AnyDefinition> extends Queue<EnvelopeOf<D>> {
	/** Messages moved aside after `maxReceiveCount` deliveries, oldest first. */
	deadLetters(): readonly DeadLetter[];
	/** Counts of messages waiting and hidden right now. */
	depth(): {
		visible: number;
		inFlight: number;
	};
	/** Puts a raw body in the queue without validating it, to test how a consumer meets a bad one. */
	publishRaw(body: string): void;
}
/**
* Creates the in-memory queue. It follows SQS where it matters to a consumer: a received message
* is hidden until its visibility timeout passes on the injected clock, then comes back with a
* higher receive count; after `maxReceiveCount` deliveries it goes to the dead-letter list; a
* long poll returns when a message is published or the wait ends. By default it delivers in
* publish order and a short poll always sees every visible message; SQS promises neither (order is
* best effort and a short poll samples some servers), so do not write a test that depends on
* either. Pass `random` to deliver in random order. Complexity: publish O(message size); receive O(messages stored),
* because it scans for the visible ones (fine for tests).
*/
declare function createMemoryQueue<const D extends AnyDefinition>(options: MemoryQueueOptions<D>): MemoryQueue<D>;
import { z as z3 } from "zod";
/** Time that moves only when a test says so: a clock and a {@link Sleep} that share it. */
interface VirtualTime {
	/** The clock; pass it to the memory queue and store. */
	clock: FixedClock;
	/** A sleep that resolves when `advance` has moved the clock past its wake-up time (or its signal aborts). */
	sleep: Sleep;
	/** Moves time forward by `ms`, waking sleepers in order and letting their work run in between. */
	advance(ms: number): Promise<void>;
	/** Lets pending promise work run without moving time. */
	settle(): Promise<void>;
	/** How many sleeps are waiting. */
	pending(): number;
}
/** Creates {@link VirtualTime} starting at 2026-01-01T00:00:00.000Z. */
declare function createVirtualTime(): VirtualTime;
/** A message that belongs to an Organization, for tests and examples. */
declare const testPing: MessageDefinition<"test.ping", z3.ZodObject<{
	n: z3.ZodNumber;
}, z3.core.$strip>, "organization">;
/** A message that belongs to no Organization, for tests and examples. */
declare const testNote: MessageDefinition<"test.note", z3.ZodObject<{
	text: z3.ZodString;
}, z3.core.$strip>, "global">;
/** The definitions the behaviour suite uses. */
type TestDefinition = typeof testPing | typeof testNote;
/** An envelope of either test type. */
type TestEnvelope = EnvelopeOf<TestDefinition>;
/** Creates a registry of {@link testPing} and {@link testNote}. */
declare function createTestRegistry(options?: Parameters<typeof createMessageRegistry>[1]): MessageRegistry<TestDefinition>;
/** Decides whether a string is an Organization id this deployment accepts. */
type OrganizationIdCheck = (value: string) => boolean;
/** The bytes of a streamed put: a web stream or any async iterable of byte chunks. */
type ByteStream = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;
/** What a listing says about one object. */
interface ObjectEntry {
	/** The key, relative to the Organization. */
	key: string;
	/** The size in bytes. */
	size: number;
	/** When the object was last written. */
	lastModified: Date;
}
/** What {@link ObjectStore.head} says about one object. */
interface ObjectInfo extends ObjectEntry {
	/**
	* The content type as the store holds it, which is what the writer gave except that a store may
	* normalise insignificant whitespace in the parameters (`text/plain; charset=utf-8` can come back
	* as `text/plain;charset=utf-8`). Never compare it as a raw string, and never use it to decide
	* behaviour: it is informational and untrusted.
	*/
	contentType: string;
}
/** An object with its body. */
interface StoredObject extends ObjectInfo {
	/** The bytes. A copy: changing it does not change the store. */
	body: Uint8Array;
}
/** Options of {@link ObjectStore.put}. */
interface PutOptions {
	/** A `type/subtype` media type with optional parameters; default `application/octet-stream`. */
	contentType?: string;
}
/** Options of {@link ObjectStore.putStream}. */
interface PutStreamOptions extends PutOptions {
	/** The most bytes the stream may hold, 1 to 2 GiB; one byte more aborts the write. Required. */
	maxBytes: number;
	/** Aborts the write (and cleans up what it started) when it fires. */
	signal?: AbortSignal;
	/** How long the source may stay silent, in ms, 10 to 600000; default 30000. */
	idleTimeoutMs?: number;
}
/** What a finished streamed put reports. */
interface PutStreamResult {
	/** The bytes written. */
	size: number;
	/** The SHA-256 of the content, lower-case hex, computed while streaming. */
	sha256: string;
}
/** An object whose body is read as a stream, so it is never held whole in memory. */
interface ObjectStream extends ObjectInfo {
	/** The bytes, once. Cancel it if you stop reading, so the connection is released. */
	body: ReadableStream<Uint8Array>;
}
/** Options of {@link ObjectStore.presignGet}. */
interface PresignOptions {
	/** How long the URL works, a whole number of seconds from 1 to 900; default 300. */
	expiresInSeconds?: number;
}
/** Options of {@link ObjectStore.list}. */
interface ListOptions {
	/** Only keys that start with this, such as `documents/` or `documents/ab`; default all. */
	prefix?: string;
	/** The `nextCursor` of the previous page. */
	cursor?: string;
	/** Page size, 1 to 1000; default 100. */
	limit?: number;
}
/** One page of a listing. */
interface ListPage {
	/** Objects in ascending key order. */
	items: ObjectEntry[];
	/** Pass as `cursor` for the next page; absent on the last one. */
	nextCursor?: string;
}
/**
* Object storage scoped by Organization. Every call takes the Organization id first and can reach
* only that Organization's objects: the adapter derives the real location from the validated id,
* never from a string the caller built, so no key (`..`, a leading slash, an encoded separator, an
* id that starts with another id) can name another Organization's data. Keys are relative to the
* Organization and made of `/`-separated segments of letters, digits, `.`, `_` and `-`, none
* starting with `.`, at most 512 bytes and 16 segments. Content is untrusted bytes: the store
* keeps the content type as given (returned as the store holds it, see {@link ObjectInfo}) and never looks at the content. Bodies are held in memory, so an
* object is at most `maxObjectBytes` (25 MiB by default, 100 MiB at most). Throws
* {@link StorageError}; only `storage.unavailable` is worth retrying.
*/
interface ObjectStore {
	/**
	* Writes an object, replacing one with the same key. Idempotent: the same call twice leaves the
	* same object. O(object size).
	*/
	put(organizationId: string, key: string, body: Uint8Array, options?: PutOptions): Promise<void>;
	/**
	* Writes an object from a stream with a hard limit, for objects too large to hold (a 500 MB
	* recording). Memory stays bounded by a few parts, not by the object: the S3 adapter uploads in
	* parts of 8 MiB, two at a time. The limit is checked while streaming: when `maxBytes` is
	* exceeded, the source stalls for 30 s, the source fails or `signal` fires, the write is aborted,
	* its incomplete parts are aborted (the bucket must also expire incomplete multipart uploads), and
	* nothing becomes readable under the key; an object already there is left as it was. Returns the
	* size and the SHA-256 of the content. Objects written this way can be larger than
	* `maxObjectBytes`: read them with {@link ObjectStore.getStream}, because `get` refuses them with
	* `storage.object_too_large`. **Residual cases:** a throw after the last part was sent (the
	* completing request timed out or its answer was lost) means the content under the key is
	* unknown: the store may have finished. Retry the write (it is idempotent), or `head` and
	* `delete` before relying on the key being absent. Aborting the upload is best-effort, and a
	* create or a part request that timed out client-side but reached the store can leave an
	* incomplete upload that only the bucket's lifecycle rule removes: abort incomplete multipart
	* uploads one day after initiation (`AbortIncompleteMultipartUpload`, `DaysAfterInitiation: 1`).
	* Idempotent: the same stream twice leaves the same object. O(object
	* size) time, O(part size) memory on S3 (the memory adapter, for tests, holds the object).
	*/
	putStream(organizationId: string, key: string, body: ByteStream, options: PutStreamOptions): Promise<PutStreamResult>;
	/**
	* Reads an object as a stream, or returns `undefined` when there is none. Not limited by
	* `maxObjectBytes`. The caller must read or cancel the body. O(1) to open.
	*/
	getStream(organizationId: string, key: string): Promise<ObjectStream | undefined>;
	/**
	* Returns a short-lived URL that reads one object with a plain GET and no credentials, so the
	* playbook can hand a Recording to the transcriber as `audio.url` without the service re-sending
	* 500 MB. The URL is for the Organization's own object only (the same key under another
	* Organization is another location), expires after `expiresInSeconds` (1 to 900, default 300), and
	* is not checked against the object: a URL for a missing key is returned and answers 404. It is
	* **a bearer credential**: never log it, never put it in an error or a stored field, never show it
	* to a user, hand it only to the vendor, and sign a new one for a retry. 15 minutes is the cap
	* because a vendor fetches within seconds to minutes of being told, and a longer-lived URL
	* would only widen the window in which a leaked URL reads a customer's call. Signing makes no
	* request; O(1). **The URL lives for the shorter of `expiresInSeconds` and the remaining life of
	* the credentials that signed it** (a task-role session adds `X-Amz-Security-Token` and may end
	* sooner), so mint it immediately before `submit`, and mint a new one for a retry. Sign with the
	* service's own role holding only `s3:GetObject` on its prefix, never long-lived user keys. No
	* response content-type or content-disposition overrides are offered. The memory adapter returns an `http:` URL that its own `resolvePresigned` reads
	* back, which a transcriber accepts only in `local`.
	*/
	presignGet(organizationId: string, key: string, options?: PresignOptions): Promise<string>;
	/** Reads an object, or returns `undefined` when there is none. O(object size). */
	get(organizationId: string, key: string): Promise<StoredObject | undefined>;
	/**
	* Reads an object's metadata, or returns `undefined` when there is none. O(1). On S3 a HEAD of a
	* bucket that does not exist also reads as `undefined`, because a HEAD response carries no error
	* body to tell the two apart; `get`, `put`, `delete` and `list` do report a missing bucket as
	* `storage.rejected`.
	*/
	head(organizationId: string, key: string): Promise<ObjectInfo | undefined>;
	/** Deletes an object. Resolves when it is gone, including when it never existed. O(1). */
	delete(organizationId: string, key: string): Promise<void>;
	/**
	* Lists one page of the Organization's objects in key order. The page is at most `limit` items
	* (1000 at most), so a listing is never unbounded: follow `nextCursor` for more. Memory adapter
	* O(n log n) in the Organization's n objects; S3 adapter one request, O(limit).
	*/
	list(organizationId: string, options?: ListOptions): Promise<ListPage>;
}
/** Options for {@link createMemoryObjectStore}. */
interface MemoryObjectStoreOptions {
	/** Time source for `lastModified`; default the system clock. */
	clock?: Clock;
	/** Largest object in bytes; default 25 MiB. */
	maxObjectBytes?: number;
	/** Extra Organization id rule; the contract's format by default. */
	isOrganizationId?: OrganizationIdCheck;
}
/** An {@link ObjectStore} that keeps everything in the process, for tests. Not for production. */
interface MemoryObjectStore extends ObjectStore {
	/**
	* Safe to destructure (it does not use `this`). Reads the object a URL from this store's `presignGet` names, or returns `undefined` when the
	* URL is not this store's, was altered, has expired by the store's clock or names no object. For
	* tests: it stands in for the vendor's GET.
	*/
	resolvePresigned(url: string): Promise<StoredObject | undefined>;
}
/**
* Creates an {@link ObjectStore} in memory. Each Organization has its own map, so no key can reach
* another Organization's objects. Bodies are copied on the way in and out. Complexity: put and get
* O(object size), head and delete O(1), list O(n log n) in the Organization's n objects.
*/
declare function createMemoryObjectStore(options?: MemoryObjectStoreOptions): MemoryObjectStore;
import { CallId as CallId2, MembershipId as MembershipId2, OrganizationId as OrganizationId2, VoiceCallFailureReason as VoiceCallFailureReason2 } from "tula-closeline-contract";
/** The `area.reason` codes the telephony port and adapters throw. */
declare const TELEPHONY_ERROR_CODES: {
	/** An id, number, text, URL or option is not acceptable. Nothing was sent to the provider. */
	readonly invalidRequest: "telephony.invalid_request";
	/** The provider has no call or Recording with that id for this Organization (or it was deleted). */
	readonly notFound: "telephony.not_found";
	/** The provider call has already ended, so the operation cannot apply. */
	readonly callEnded: "telephony.call_ended";
	/** The Disclosure has not played on this call, so it cannot be bridged, recorded or forked (ADR 0003). */
	readonly disclosureRequired: "telephony.disclosure_required";
	/** The Recording is not finished yet; try again shortly. */
	readonly recordingNotReady: "telephony.recording_not_ready";
	/** The provider refused the operation for a reason a retry cannot fix (credentials, quota, number). */
	readonly rejected: "telephony.rejected";
	/** The provider did not answer in time or at all, after the bounded retries. The only retryable code. */
	readonly unavailable: "telephony.unavailable";
	/** The provider answered with something this adapter cannot use. */
	readonly badResponse: "telephony.bad_response";
};
/** One of {@link TELEPHONY_ERROR_CODES}'s values. */
type TelephonyErrorCode = (typeof TELEPHONY_ERROR_CODES)[keyof typeof TELEPHONY_ERROR_CODES];
import { CallId, MembershipId, OrganizationId, SoftphoneToken, VoiceCallFailureReason } from "tula-closeline-contract";
/** Options every operation of {@link TelephonyPort} accepts. */
interface TelephonyOptions {
	/**
	* The most time the operation may take, in ms, 1 to {@link MAX_TELEPHONY_TIMEOUT_MS}; default
	* {@link DEFAULT_TELEPHONY_TIMEOUT_MS}. When it passes the operation throws
	* `telephony.unavailable` and, as far as the adapter can tell, changed nothing.
	*/
	timeoutMs?: number;
}
/** Which Organization a provider call belongs to and which provider call it is. */
interface ProviderCallRef {
	/** The Organization. A call or Recording of another Organization is `telephony.not_found`. */
	organizationId: OrganizationId;
	/** The provider's id of the call leg to the Prospect: opaque, 1 to 128 of letters, digits, `.`, `_`, `:` and `-`. */
	providerCallId: string;
}
/** The call a service asks the provider to place to a Prospect. */
interface PlaceCallRequest {
	/** The Organization. */
	organizationId: OrganizationId;
	/** Our id of the Call, kept by the adapter as a tag on the provider call; it never leaves the provider as speech. */
	callId: CallId;
	/**
	* Required. The same key places exactly one provider call: a repeat returns the first one with
	* `created: false`. 1 to 128 of letters, digits, `.`, `_`, `:` and `-`.
	*/
	idempotencyKey: string;
	/** The Line's number the Prospect sees, in E.164. */
	from: string;
	/** The Prospect's number, in E.164. Tenant data: never logged. */
	to: string;
}
/** What {@link TelephonyPort.placeCall} reports. */
interface PlacedCall {
	/** The provider's id of the leg to the Prospect. */
	providerCallId: string;
	/** True when this call placed it; false when the same idempotency key had already placed it. */
	created: boolean;
}
/** An inbound call the provider has received, to be answered. */
interface AnswerCallRequest extends ProviderCallRef {
	/** Our id of the Call. */
	callId: CallId;
	/** The Reps' browser legs to ring, 1 to {@link MAX_RING_LEGS}; the first to answer is bridged. */
	ringIdentities: MembershipId[];
}
/** What {@link TelephonyPort.answerCall} reports. */
interface AnsweredCall {
	/** How many browser legs are ringing. */
	ringing: number;
}
/** The Disclosure to play to a connected call, before anything else happens on it. */
interface PlayDisclosureRequest extends ProviderCallRef {
	/** The version of the wording, 1 or more; the Call stores it (ADR 0003). */
	wordingVersion: number;
	/** The words spoken, 1 to {@link MAX_DISCLOSURE_TEXT_LENGTH} characters. Never logged. */
	text: string;
	/** Whether the wording also says an AI takes part. Forking tracks to an AI needs `true`. */
	aiAssisted: boolean;
}
/** What {@link TelephonyPort.playDisclosure} reports once the wording has finished playing. */
interface DisclosurePlayed {
	/** The wording version that played. */
	wordingVersion: number;
	/** Whether it said an AI takes part. */
	aiAssisted: boolean;
	/** When it finished playing, as an ISO 8601 UTC time. */
	playedAt: string;
}
/** A Rep's browser leg to join to a call. */
interface BridgeRequest extends ProviderCallRef {
	/** The Rep whose browser leg joins; if another leg is joined, it moves to this one. */
	repIdentity: MembershipId;
}
/** What {@link TelephonyPort.startRecording} reports. */
interface StartedRecording {
	/** The provider's id of the Recording: opaque, same shape as a provider call id. */
	recordingId: string;
	/** Always 2: channel 0 is the Prospect, channel 1 is the Rep. */
	channels: 2;
}
/** Where to fork the two audio tracks of a call. */
interface ForkTracksRequest extends ProviderCallRef {
	/** A `wss:` URL (`ws:` only for an adapter in `local`) the provider streams to; built by the service, never from a user. */
	destinationUrl: string;
}
/** What {@link TelephonyPort.forkTracks} reports. */
interface ForkedTracks {
	/** The provider's id of the stream. */
	streamId: string;
	/** The two tracks sent: the Rep's and the Prospect's, separately. */
	tracks: readonly ["rep", "prospect"];
}
/** Who asks to hang up. */
interface HangUpRequest extends ProviderCallRef {
	/** Who ends the call, for the event that follows; default `system`. */
	by?: "rep" | "system";
}
/** Names a provider-side Recording. */
interface RecordingRef {
	/** The Organization. */
	organizationId: OrganizationId;
	/** The provider's id of the Recording, from {@link StartedRecording.recordingId}. */
	recordingId: string;
}
/** A provider-side Recording, opened for reading. */
interface FetchedRecording {
	/** The audio, two channels. The caller must read or cancel it. */
	body: ByteStream;
	/** The media type, such as `audio/wav`. */
	contentType: string;
	/** The size in bytes when the provider says it, otherwise null. */
	sizeBytes: number | null;
	/** Always 2. */
	channels: 2;
}
/** A webhook request as the provider sent it, to be checked before anything is read from it. */
interface WebhookRequest {
	/** The full URL the provider called, as the provider saw it. */
	url: string;
	/** The raw body, unparsed, at most {@link MAX_WEBHOOK_BODY_BYTES} bytes. */
	body: string;
	/** The signature header, or null/undefined when the request had none. */
	signature: string | null | undefined;
}
/** What {@link TelephonyPort.mintBrowserToken} is asked for. */
interface BrowserTokenRequest {
	/** The Organization. */
	organizationId: OrganizationId;
	/** The Rep the token is for: the only identity it carries besides the Organization. */
	identity: MembershipId;
	/** How long it lives, in seconds, 60 to 3600; default 900. */
	ttlSeconds?: number;
}
/** What a provider tells us about a call, in the shape every adapter's webhooks are turned into. */
type TelephonyEventType = "ringing" | "answered" | "no_answer" | "busy" | "failed" | "completed" | "recording_ready";
/** One thing that happened on a provider call. Carries no number, text or audio. */
interface TelephonyEvent {
	/** The provider's id of this event: webhooks are idempotent by it. */
	eventId: string;
	/** The Organization. */
	organizationId: OrganizationId;
	/** The provider call. */
	providerCallId: string;
	/** What happened. */
	type: TelephonyEventType;
	/** When, as an ISO 8601 UTC time. */
	at: string;
	/** With `failed` (and `no_answer`, `busy`): why, as the contract names it. */
	failureReason?: VoiceCallFailureReason;
	/** With `completed`: who hung up. */
	endedBy?: "rep" | "prospect" | "system";
	/** With `recording_ready`: the Recording. */
	recordingId?: string;
}
/**
* Telephony behind a vendor (Twilio first, ADR to follow), scoped by Organization. Every call
* carries the Organization and reaches only that Organization's provider calls and Recordings; a
* real adapter must tag each provider call with it. Every operation is bounded by a timeout
* ({@link TelephonyOptions.timeoutMs}), every outbound request an adapter makes has its own
* timeout and a bounded, jittered retry, and only `telephony.unavailable` is worth retrying after
* that. Mutating operations are idempotent: repeating one leaves the same result.
*
* **The Disclosure cannot be skipped (ADR 0003).** There is no option, flag or setting that
* skips the Disclosure or the Recording. An adapter refuses `bridge`, `startRecording` and
* `forkTracks` on a call whose Disclosure has not played, with `telephony.disclosure_required`,
* and `forkTracks` (audio to an AI) also needs a Disclosure that said so (`aiAssisted: true`).
* Every recording has two channels. These checks are the adapter's second line of defence; the
* voice service's state machine is the first.
*
* Nothing here logs, returns in an error or reports a phone number, a Disclosure text, a token, a
* signature, a secret or audio. Provider events arrive as webhooks the service verifies with
* {@link TelephonyPort.verifyWebhook} and turns into {@link TelephonyEvent}s.
*/
interface TelephonyPort {
	/**
	* Places a call from a Line's number to a Prospect and returns at once with the provider's id;
	* progress arrives as events. Idempotent by `(organizationId, idempotencyKey)`; the same key
	* with another `to` or `from` is `telephony.invalid_request`. O(1).
	*/
	placeCall(request: PlaceCallRequest, options?: TelephonyOptions): Promise<PlacedCall>;
	/**
	* Answers an inbound call and rings the given browser legs. Repeating it for a call already
	* answered returns the same count. O(legs).
	*/
	answerCall(request: AnswerCallRequest, options?: TelephonyOptions): Promise<AnsweredCall>;
	/**
	* Plays the Disclosure into a connected call and resolves when it has finished playing. Nobody
	* else hears the call meanwhile. A call the Prospect has left is `telephony.call_ended`. Idempotent
	* per wording version: a Disclosure that has already played is reported again, not replayed. A
	* later version plays again and replaces the earlier one, including its `aiAssisted`.
	*/
	playDisclosure(request: PlayDisclosureRequest, options?: TelephonyOptions): Promise<DisclosurePlayed>;
	/**
	* Joins a Rep's browser leg to the call, or moves the call to another Rep's leg. Needs a played
	* Disclosure. Repeating it for the same Rep changes nothing.
	*/
	bridge(request: BridgeRequest, options?: TelephonyOptions): Promise<void>;
	/**
	* Starts the dual-channel Recording (Prospect and Rep apart). Needs a played Disclosure. There is
	* no single-channel or unrecorded mode. Repeating it returns the first Recording.
	*/
	startRecording(request: ProviderCallRef, options?: TelephonyOptions): Promise<StartedRecording>;
	/**
	* Forks the call's two audio tracks, the Rep's and the Prospect's separately, to a socket
	* (used by the Copilot). Needs a played Disclosure that said an AI takes part. Repeating it
	* returns the first stream.
	*/
	forkTracks(request: ForkTracksRequest, options?: TelephonyOptions): Promise<ForkedTracks>;
	/** Ends the call. Idempotent: a call that has ended already resolves without error. */
	hangUp(request: HangUpRequest, options?: TelephonyOptions): Promise<void>;
	/**
	* Opens the provider's copy of a Recording as a stream, once the call has ended and the Recording
	* is finished (before that, `telephony.recording_not_ready`). The timeout covers opening it. A
	* Recording deleted or never made is `telephony.not_found`. O(1) to open.
	*/
	fetchRecording(request: RecordingRef, options?: TelephonyOptions): Promise<FetchedRecording>;
	/**
	* Deletes the provider's copy of a Recording and resolves with whether it existed. Idempotent:
	* deleting again, or an id never issued, resolves with `existed: false`.
	*/
	deleteRecording(request: RecordingRef, options?: TelephonyOptions): Promise<{
		existed: boolean;
	}>;
	/**
	* Whether `request` really came from the provider, by its signature, compared in constant time.
	* A missing, malformed, wrong-length or wrong signature, or a body over
	* {@link MAX_WEBHOOK_BODY_BYTES}, is `false`; it never throws. It does no I/O (a local
	* computation on the body), so it needs no timeout and runs inside a webhook's budget. Check it
	* before reading anything from the body.
	*/
	verifyWebhook(request: WebhookRequest): boolean;
	/**
	* Mints a short-lived token the browser registers the Softphone with. It is issued for the Rep's
	* identity in the Organization (a real adapter binds both at the provider; the token text need
	* not show them), expires at `expiresAt`, and is a credential: never logged or
	* stored.
	*/
	mintBrowserToken(request: BrowserTokenRequest, options?: TelephonyOptions): Promise<SoftphoneToken>;
}
/** What a scripted Prospect does when the memory provider dials their number. */
type ScriptedProspect = {
	kind: "answers";
} | {
	kind: "no_answer";
} | {
	kind: "busy";
} | {
	kind: "hangs_up";
	when: "during_disclosure" | "after_bridge";
} | {
	kind: "carrier_failure";
	reason?: Extract<VoiceCallFailureReason2, "carrier_dropped" | "carrier_rejected" | "provider_error">;
	when?: "dial" | "after_bridge";
};
/** The operations a test can make fail or stall. */
type TelephonyOperation = "placeCall" | "answerCall" | "playDisclosure" | "bridge" | "startRecording" | "forkTracks" | "hangUp" | "fetchRecording" | "deleteRecording" | "mintBrowserToken";
/** Options for {@link createMemoryTelephony}. */
interface MemoryTelephonyOptions {
	/** The clock for event times and token expiry; the system clock by default. */
	clock?: Clock;
	/** The `ENVIRONMENT` to behave as: a `ws:` fork destination is accepted only in `local`; default `local`. */
	environment?: Environment;
	/** The secret webhooks are signed with, at least 16 characters; a fixed test value by default. */
	webhookSecret?: string;
	/** The timeout of an operation that names none, in ms; default {@link DEFAULT_TELEPHONY_TIMEOUT_MS}. */
	defaultTimeoutMs?: number;
	/** The bytes every Recording holds; a few bytes of fake audio by default. */
	recordingAudio?: Uint8Array;
}
/** What a test sees of a provider call (never a number or a Disclosure text). */
interface MemoryCallView {
	/** The Organization. */
	organizationId: OrganizationId2;
	/** The provider's id. */
	providerCallId: string;
	/** Our Call id, when the call was placed or answered with one. */
	callId: CallId2 | null;
	/** Placed by us, or received. */
	direction: "outbound" | "inbound";
	/** `incoming` until answered, `connected` while up, `ended` after. */
	state: "incoming" | "connected" | "ended";
	/** The Disclosure that played, if one has. */
	disclosure: DisclosurePlayed | null;
	/** The Rep whose browser leg is joined, if any. */
	bridgedTo: MembershipId2 | null;
	/** The Recording, if started. */
	recordingId: string | null;
	/** The fork stream, if started. */
	streamId: string | null;
	/** Who ended it, when it has ended. */
	endedBy: "rep" | "prospect" | "system" | null;
}
/** One operation the provider carried out, in order; the proof the Disclosure came first. */
interface MemoryOperationRecord {
	/** The operation. */
	operation: TelephonyOperation | "prospectHangsUp";
	/** The provider call it applied to, when it applied to one. */
	providerCallId: string | null;
}
/** A webhook request that carries a signature. */
interface SignedWebhook extends WebhookRequest {
	/** The valid signature. */
	signature: string;
}
/** A {@link TelephonyPort} that plays scripted Prospects in the process, for tests. Not for production. */
interface MemoryTelephony extends TelephonyPort {
	/** Sets what the Prospect at `number` (E.164) does when dialed; a later script replaces the earlier. */
	script(number: string, behaviour: ScriptedProspect): void;
	/** Receives an inbound call on a Line, as the provider's webhook would; returns the provider's call id. */
	receiveInbound(organizationId: OrganizationId2, from: string, to: string): string;
	/** Has the Prospect on this call hang up now; a call that has ended is left alone. */
	prospectHangsUp(organizationId: OrganizationId2, providerCallId: string): void;
	/** Makes the next `times` (default 1) calls of `operation` throw a TelephonyError with `code`, changing nothing. */
	failNext(operation: TelephonyOperation, code: TelephonyErrorCode, times?: number): void;
	/** Makes the next `times` (default 1) calls of `operation` never answer, so the timeout fires; changes nothing. */
	stallNext(operation: TelephonyOperation, times?: number): void;
	/** Every event so far, in order. */
	readonly events: readonly TelephonyEvent[];
	/** Returns the events not yet taken, in order, and forgets them. */
	takeEvents(): TelephonyEvent[];
	/** Every operation carried out, in order; failed, refused and timed-out ones are not in it. */
	readonly operations: readonly MemoryOperationRecord[];
	/** The calls, for one Organization or all, in the order they were made. */
	calls(organizationId?: string): MemoryCallView[];
	/** The webhook the provider would send for `event`: a URL, the JSON body and its valid signature. */
	webhookFor(event: TelephonyEvent): SignedWebhook;
	/** The valid signature for a URL and body. */
	sign(url: string, body: string): string;
	/** How many Recordings the provider still holds. */
	recordingCount(): number;
}
/**
* Builds a {@link TelephonyPort} for tests, which plays scripted Prospects: one who answers (the
* default), one who does not, one who is busy, one who hangs up and a carrier that fails. It keeps
* the same rules a real adapter must: Organization scoping, idempotent placing, the Disclosure
* before bridging, recording or forking, timeouts, and constant-time webhook verification. Events
* a real provider would send as webhooks are collected in `events`. Not for production.
*/
declare function createMemoryTelephony(options?: MemoryTelephonyOptions): MemoryTelephony;
/** The `area.reason` codes the transcriber port and adapters throw. */
declare const TRANSCRIBER_ERROR_CODES: {
	/** An Organization id, client reference, audio reference, option, prefix or cursor is not acceptable. */
	readonly invalidRequest: "transcriber.invalid_request";
	/** The client reference is already used by a send with a different mode, speaker cap or audio key. Never retryable. */
	readonly conflict: "transcriber.conflict";
	/** The vendor refused the call for a reason a retry cannot fix (bad credentials, no quota, terms). */
	readonly rejected: "transcriber.rejected";
	/** The vendor did not answer, in time or at all, after the bounded retries. The only retryable code. */
	readonly unavailable: "transcriber.unavailable";
	/** The vendor answered with something this adapter cannot use. */
	readonly badResponse: "transcriber.bad_response";
};
/** One of {@link TRANSCRIBER_ERROR_CODES}'s values. */
type TranscriberErrorCode = (typeof TRANSCRIBER_ERROR_CODES)[keyof typeof TRANSCRIBER_ERROR_CODES];
/** The audio to transcribe: a short-lived reference the vendor fetches, never the bytes. */
interface AudioReference {
	/**
	* An `https:` URL (`http:` only when the adapter runs with `ENVIRONMENT=local`) that stays valid until the vendor has
	* fetched the audio, typically a presigned GET of the object store, valid for minutes. It may
	* carry credentials in its query string, so it is never logged, never put in an error and never
	* stored. No user information (`user:pass@`) is accepted. The service builds this URL from its
	* own object store; it is never taken from a user, or the vendor becomes a way to fetch any URL.
	*/
	url: string;
}
/** How the speakers are told apart. */
type SpeakerMode = "split_channels" | "diarize";
/** A send. */
interface TranscribeRequest {
	/**
	* Chosen by the caller, unique per Organization, 1 to 128 of letters, digits, `.`, `_`, `:` and
	* `-`: the playbook service uses `<callId>:<sendNumber>`. It is the only key the caller needs
	* for {@link Transcriber.getResult} and {@link Transcriber.delete}; the vendor's id
	* ({@link Submission.vendorId}) is an optional shortcut, never required.
	*/
	clientReference: string;
	/** The audio. */
	audio: AudioReference;
	/** How speakers are told apart. */
	speakers: SpeakerMode;
	/** With `diarize`: the most speakers to find, 1 to 10. Not allowed with `split_channels`. */
	maxSpeakers?: number;
	/**
	* Required: a stable name for the audio itself, such as the object key and content hash
	* (`<key>:<sha256>`), 1 to 256 of letters, digits, `.`, `_`, `:`, `/` and `-`. The audio URL is
	* short-lived and a retry gets a new one, so the URL is not part of what makes two sends "the
	* same"; this is. Sending a reference again with a different `audioKey` is a conflict.
	*/
	audioKey: string;
	/**
	* Optional: an `https:` URL the vendor may call when the result is ready, to save polling. The
	* service builds it; it is never taken from a user. The
	* port never requires one: a result is always readable with {@link Transcriber.getResult}, and a
	* webhook is only a hint to look sooner. An adapter that cannot use it ignores it.
	*/
	callbackUrl?: string;
}
/** What {@link Transcriber.submit} reports. */
interface Submission {
	/** The client reference, as given. */
	clientReference: string;
	/** True when this call created the copy; false when the same send was already there. */
	created: boolean;
	/**
	* The vendor's id of the job: an opaque string of 1 to 128 letters, digits, `.`, `_`, `:` and `-`
	* (never parse it). Present whenever the vendor accepted the job, including `created: false`,
	* where it is the existing copy's id. **The caller stores it** beside its own record of the send
	* and passes it back as the `vendorId` hint of {@link Transcriber.getResult} and
	* {@link Transcriber.delete}. It is an identifier, not a secret, but it is not logged either.
	*/
	vendorId: string;
}
/** The optional hint of {@link Transcriber.getResult} and {@link Transcriber.delete}. */
interface VendorIdHint {
	/**
	* The id {@link Submission.vendorId} returned. With it the adapter goes straight to that job
	* and scans nothing. It is only a hint, and a wrong one is **ignored, not refused**: an id that
	* names a job with another client reference, another Organization's job, or no job at all makes
	* the call behave exactly as if no hint had been given (found by the client reference and no
	* other), so a stale or mixed-up id can neither act on a job the call is not about nor tell a
	* caller whether another Organization's job exists. Only an id of the wrong shape is refused
	* (`transcriber.invalid_request`).
	*
	* **How an adapter honours a hint safely:** "straight to the job" means one vendor read of the
	* hinted job, never acting unchecked. The adapter reads that job and confirms that its stored
	* client reference and Organization equal the call's before it returns its result or deletes it;
	* if they differ, or the job is gone, it ignores the hint and looks up by reference. If the
	* vendor cannot store the reference and the Organization on a job, the adapter must ignore
	* hints entirely.
	*/
	vendorId?: string;
}
/** Why a transcription failed. A closed list; none says more than the reason. */
type TranscriptionFailure = "audio_unreachable" | "audio_invalid" | "no_speech" | "too_long" | "vendor_failed" | "timed_out";
/** One stretch of speech by one speaker. */
interface TranscriptTurn {
	/**
	* Who spoke, as a label: `A`, `B`... for `diarize`; for `split_channels` a label the vendor
	* assigns per channel (see `channel`). Labels are data, never instructions, and are not logged.
	*/
	speaker: string;
	/** With `split_channels`: the 0-based channel this turn came from. Absent with `diarize`. */
	channel?: number;
	/** Start, in milliseconds from the start of the audio. */
	startMs: number;
	/** End, in milliseconds; not before `startMs`. */
	endMs: number;
	/** What was said, at most 20,000 characters. Untrusted text. */
	text: string;
}
/** The state of one send. */
type TranscriptionResult = {
	status: "pending";
} | {
	status: "done";
	/** The audio's length in milliseconds, as the vendor measured it (what it bills). */
	durationMs: number;
	/** Turns in time order, at most 50,000. */
	turns: TranscriptTurn[];
} | {
	status: "failed";
	reason: TranscriptionFailure;
};
/** One send in a listing. */
interface TranscriptionEntry {
	/** The client reference. */
	clientReference: string;
	/** The vendor's id of this copy, as {@link Submission.vendorId} returned it. */
	vendorId: string;
	/** `pending`, `done` or `failed`. */
	status: TranscriptionResult["status"];
}
/** Options of {@link Transcriber.list}. */
interface TranscriptionListOptions {
	/**
	* Only references that start with this; default all. End the prefix with the separator
	* (`call_1:`): `call_1` also matches `call_10:`.
	*/
	prefix?: string;
	/** The `nextCursor` of the previous page. */
	cursor?: string;
	/** Page size, 1 to 1000; default 100. */
	limit?: number;
}
/** One page of a listing. */
interface TranscriptionPage {
	/** Entries in ascending reference order. */
	items: TranscriptionEntry[];
	/** Pass as `cursor` for the next page; absent on the last one. */
	nextCursor?: string;
}
/**
* Batch speech-to-text behind a vendor (ADR 0010: AssemblyAI), scoped by Organization. Every call
* takes the Organization id first and reaches only that Organization's sends: a real adapter must
* put the validated id into the reference it gives the vendor (`<organizationId>/<clientReference>`)
* so a second Organization's identical reference is a different send and can never be read or
* deleted. Audio is given by reference (a short-lived URL the vendor fetches), never as bytes: a
* 500 MB Recording is never buffered by the service, and the URL is the "short-lived presigned
* URL" of ADR 0018. Results are read by polling; a webhook is only an optional hint.
*
* What every adapter must do: give every vendor call a timeout and a bounded, jittered retry
* (only `transcriber.unavailable` is retryable by the caller after that), make `submit` idempotent
* by client reference, throw {@link TranscriberError} with a code from the closed set, read at most
* `MAX_TRANSCRIPT_RESPONSE_BYTES` of any response before parsing it and run every result through
* `checkTranscriptionResult` (vendor output is untrusted), and never log, throw or report audio,
* an audio URL, transcript text, speaker labels or a vendor id. Audio and text are personal data
* of Prospects; the vendor must not train on them and must delete them (see `delete`).
*
* **The vendor id (decided, hub issue 75):** `submit` returns the vendor's job id, the caller
* stores it beside its own record of the send (the playbook service keeps it next to
* `vendor_send_seq`), and passes it back as a hint so a read or delete goes straight to the job: one vendor read that
* confirms the job's stored client reference and Organization equal the call's (see
* {@link VendorIdHint}), never an unchecked act.
* The adapter owns no storage of its own: no mapping table. The fallback for a crash after the
* vendor accepted the job and before the caller stored the id is `list`, which finds every copy
* for a client reference, so `getResult` and `delete` still work with the reference alone.
*
* **A blocker for the real adapter, unverified:** whether AssemblyAI lets the caller give a
* reference of its own, or list its jobs by one (for example through metadata or a webhook query
* parameter echoed on the job), is not established; its transcript object has no such field in the
* documentation read so far. The fallback above needs exactly that listing, so until it is shown
* to work against the vendor no real adapter may be written, and this port cannot paper over it. The
* same holds for the hint check: the vendor must be able to store the reference and the
* Organization on a job, or hints are ignored. The
* other open questions (ADR 0018, "before real audio"): can a stereo file be transcribed per
* channel with its own speaker label (`multichannel`) and what does it bill, the EU endpoint for
* the EU Region, and how soon after a delete the vendor's copy is gone and whether it confirms
* it. Until all are answered, no real adapter may run outside `local`.
*/
interface Transcriber {
	/**
	* Starts a transcription. Idempotent by `(organizationId, clientReference)`: repeating the same
	* request returns `created: false` and starts nothing, so a caller that crashed before storing
	* anything can send again safely; the same reference with a different mode, speaker cap or
	* `audioKey` is `transcriber.conflict`. Concurrent submits of one reference create it at most
	* once: at most one of them answers `created: true`. The audio URL is not compared (a retry presigns a new
	* one), so without an `audioKey` the audio itself is not checked. An adapter validates with the
	* shared checks and its `ENVIRONMENT`: plain `http:` URLs only in `local`. Everything is validated before anything is sent. O(1).
	*/
	submit(organizationId: string, request: TranscribeRequest): Promise<Submission>;
	/**
	* Reads one send's state, or returns `undefined` when there is no send with that reference (never
	* submitted, or deleted). A `done` result is final and can be read again. Poll with
	* {@link waitForTranscription}. With a `vendorId` hint the adapter reads that job directly (see
	* {@link VendorIdHint}: a wrong id is ignored); without one it finds the copy through `list`.
	* O(result size) with the hint, O(the Organization's size) without it on a real vendor.
	*/
	getResult(organizationId: string, clientReference: string, hint?: VendorIdHint): Promise<TranscriptionResult | undefined>;
	/**
	* Deletes the vendor's copy (audio, transcript and metadata) of the send with this reference,
	* every copy that carries it, and returns `existed: true` when at least one was found and
	* removed (or cancelled). Idempotent: deleting again, or a reference never sent, resolves with
	* `existed: false`. It works with the client reference alone, including for a send whose vendor
	* id the caller never stored (a crash between the vendor accepting it and the caller recording
	* its id), which is why {@link Transcriber.list} exists. A send still processing is cancelled,
	* or waited for a bounded time; if the vendor can do neither within that time the call throws
	* `transcriber.unavailable` (retryable) and the caller retries: a purge is not done until
	* `delete` has resolved for every reference. It resolves only when the vendor confirmed the
	* deletion. **The caller must stop new submits for a Call before it lists and deletes**, or a
	* send made in between survives. With a `vendorId` hint the adapter deletes that job directly (a
	* wrong id is ignored, see {@link VendorIdHint}); the reference is still deleted, so a hint never
	* narrows a purge. O(1) with the hint.
	*
	* **A purge retries.** `transcriber.unavailable` is the one retryable code: a purge retries each
	* `delete` with exponential backoff and jitter for at least the vendor's longest processing time
	* (a send still processing may only be deletable after it ends), then escalates, for example by
	* reporting the Call as not purged and alerting an operator, rather than dropping it. A failed
	* `delete` changes nothing, so the retry is always safe.
	*/
	delete(organizationId: string, clientReference: string, hint?: VendorIdHint): Promise<{
		existed: boolean;
	}>;
	/**
	* Lists the Organization's sends by reference prefix, **for background jobs only**: it may scan
	* the vendor's account, so it is slow and never on a request path. The order is stable (by
	* reference) and the cursor is opaque, valid only for the same Organization and prefix. A page
	* may be shorter than `limit`, even empty, and still have a `nextCursor`: follow the cursor until
	* it is absent. A purge lists `<callId>:` and deletes each entry, so a send the caller has no
	* record of is still removed. Work proportional to the Organization's size.
	*/
	list(organizationId: string, options?: TranscriptionListOptions): Promise<TranscriptionPage>;
}
/** What a scripted send ends as. */
interface ScriptedOutcome {
	/** How many reads answer `pending` before the result; default 1. */
	pendingReads?: number;
	/** The final state. */
	result: {
		status: "done";
		durationMs: number;
		turns: TranscriptTurn[];
	} | {
		status: "failed";
		reason: TranscriptionFailure;
	};
}
/** A copy the stand-in still holds, as a test sees it (never the audio URL or the text). */
interface HeldCopy {
	/** The Organization. */
	organizationId: string;
	/** The client reference. */
	clientReference: string;
	/** The stand-in's own id for it, which a caller may never have stored. */
	vendorId: string;
	/** Its state now, without consuming a pending read. */
	status: "pending" | "done" | "failed";
}
/** The operations a test can make fail. */
type TranscriberOperation = "submit" | "getResult" | "delete" | "list";
/** Options for {@link createMemoryTranscriber}. */
interface MemoryTranscriberOptions {
	/** Extra Organization id rule; the contract's format by default. */
	isOrganizationId?: OrganizationIdCheck;
	/** The `ENVIRONMENT` to behave as: plain `http:` URLs are accepted only in `local`; default `local`. */
	environment?: Environment;
	/** Chooses what a send ends as when no outcome was scripted for its reference. */
	outcome?: (request: {
		speakers: "split_channels" | "diarize";
		maxSpeakers?: number;
	}) => ScriptedOutcome;
}
/** A {@link Transcriber} in the process with scripting and inspection, for tests. Not for production. */
interface MemoryTranscriber extends Transcriber {
	/**
	* Sets what the send with this reference ends as, before or after it is submitted (a later script
	* replaces the earlier one and restarts the pending reads). Validated like a send.
	*/
	script(organizationId: string, clientReference: string, outcome: ScriptedOutcome): void;
	/** Makes the next `times` (default 1) calls of `operation` throw a TranscriberError with `code`, changing nothing. */
	failNext(operation: TranscriberOperation, code: TranscriberErrorCode, times?: number): void;
	/**
	* Makes the next `times` (default 1) submits accept the send, keep the copy, and then throw
	* `transcriber.unavailable`: the vendor has the audio and the caller never learned it.
	*/
	acceptThenFailNext(times?: number): void;
	/** The copies still held, for one Organization or all, in Organization then reference order. */
	copies(organizationId?: string): HeldCopy[];
}
/**
* Creates a {@link Transcriber} in memory. Deterministic: a send answers `pending` for its
* scripted number of reads (one by default) and then a fixed four-turn conversation, or whatever
* was scripted. Each Organization has its own map, so no reference can reach another Organization's
* sends. Complexity: submit, getResult and delete O(1); list O(n log n) in the Organization's n
* sends.
*/
declare function createMemoryTranscriber(options?: MemoryTranscriberOptions): MemoryTranscriber;
/** One attribute value. Attributes are flat: no arrays, no nesting, no null. */
type AttributeValue = string | number | boolean;
/**
* Named values stored with a vector and matched by filters, such as `{ document_id: 'doc_1' }`.
* Names are lower-case snake_case; `id` and `vector` are reserved. A name should always carry the
* same kind of value (string, number or boolean): a vendor that infers a column's type from its
* first value refuses a later value of another type.
*/
type VectorAttributes = Readonly<Record<string, AttributeValue>>;
/** A vector to store. */
interface VectorRecord {
	/** Unique within the Organization, 1 to 64 of letters, digits, `.`, `_`, `:` and `-`; storing an id again replaces the vector. */
	id: string;
	/** Exactly the store's `dimensions` finite numbers, not all zero. */
	vector: ArrayLike<number>;
	/** Optional attributes (at most 16). */
	attributes?: VectorAttributes;
}
/** A similarity search. */
interface SearchQuery {
	/** The query vector, the store's `dimensions` long. */
	vector: ArrayLike<number>;
	/** How many hits at most, 1 to 100. */
	topK: number;
	/** Keep only vectors whose attributes equal every entry here. */
	filter?: VectorAttributes;
}
/** One search result. */
interface SearchHit {
	/** The vector's id. */
	id: string;
	/** Cosine similarity to the query, -1 to 1; higher is closer. */
	score: number;
	/** The vector's attributes (empty when it had none). */
	attributes: VectorAttributes;
}
/**
* Vector storage scoped by Organization. Every call takes the Organization id first and reaches
* only that Organization's vectors: an adapter derives its namespace or filter from the validated
* id, never from a caller's string, so a search, an upsert or a delete cannot touch another
* Organization. A store is created for one embedding model's dimension count; a vector of any
* other length is `vector.dimension_mismatch`, which no retry fixes. Scores are cosine similarity.
* Throws {@link VectorError}; only `vector.unavailable` is worth retrying. Text and vectors are
* data, never instructions, and no operation logs them.
*/
interface VectorStore {
	/** The length every vector and query must have. */
	readonly dimensions: number;
	/**
	* Tells the store to get an Organization's index ready for low-latency search, as ADR 0010
	* wants done when a call starts. Resolves when the hint is accepted, not when the index is warm.
	* Never changes data; harmless to repeat or to send for an Organization with no vectors. O(1).
	*/
	warm(organizationId: string): Promise<void>;
	/**
	* Deletes every vector the Organization has (offboarding). Idempotent: an Organization with
	* none resolves. Work proportional to the Organization's size: call it from a queued job.
	*/
	deleteAll(organizationId: string): Promise<void>;
	/**
	* Stores up to 500 vectors, replacing any with the same id. Idempotent: the same call twice
	* leaves the same data. Everything is validated before anything is written, so a bad record
	* writes nothing. Memory adapter O(batch × dimensions).
	*/
	upsert(organizationId: string, records: readonly VectorRecord[]): Promise<void>;
	/**
	* Returns the `topK` closest vectors that match the filter, best first (the order of equal scores is not promised). Memory
	* adapter O(n × dimensions + n log n) in the Organization's n vectors (a scan, for tests only).
	*/
	search(organizationId: string, query: SearchQuery): Promise<SearchHit[]>;
	/**
	* Changes attributes on up to 500 existing vectors without touching or needing their vectors,
	* and returns the ids it did not find, in the order given (empty when every id was found), so a
	* caller can tell a complete update from a partial one. It merges: each attribute in
	* `attributes` is set (replacing a value of the same name) and every other attribute of the
	* vector stays. `attributes` has at least one entry and the same names and values `upsert`
	* accepts; a vector that would end with more than 16 attributes makes the whole call
	* `vector.invalid_request`. It never creates a vector: a missing id is only reported. Ids must
	* be valid and distinct; a bad call writes nothing. Idempotent: the same call twice leaves the
	* same data and reports the same ids. Memory adapter O(ids). A real adapter must patch
	* attributes by id in the vendor's store (turbopuffer: a patch by id) and must not resend or
	* re-embed vectors; a vendor that cannot patch has no business behind this port.
	*/
	setAttributes(organizationId: string, ids: readonly string[], attributes: VectorAttributes): Promise<string[]>;
	/** Deletes up to 500 vectors by id. Ids that do not exist are ignored. Idempotent. O(ids). */
	delete(organizationId: string, ids: readonly string[]): Promise<void>;
	/**
	* Deletes every vector whose attributes equal every entry of `filter` (at least one entry, so it
	* cannot empty an Organization by accident). Idempotent. Memory adapter O(n). Work proportional
	* to the Organization's size: call it from a queued job, not a request.
	*/
	deleteByFilter(organizationId: string, filter: VectorAttributes): Promise<void>;
}
/** Options for {@link createMemoryVectorStore}. */
interface MemoryVectorStoreOptions {
	/** The dimension count of the embedding model, 1 to 4096. */
	dimensions: number;
	/** Extra Organization id rule; the contract's format by default. */
	isOrganizationId?: OrganizationIdCheck;
}
/** A {@link VectorStore} that keeps everything in the process, for tests. Not for production. */
type MemoryVectorStore = VectorStore;
/**
* Creates a {@link VectorStore} in memory. Each Organization has its own map, so no query can
* reach another Organization's vectors. Complexity: upsert O(batch × dimensions); search
* O(n × dimensions + n log n) in the Organization's n vectors, an exact scan; delete O(ids);
* setAttributes O(ids); deleteByFilter O(n); warm O(1); deleteAll O(1).
*/
declare function createMemoryVectorStore(options: MemoryVectorStoreOptions): MemoryVectorStore;
/** One recorded log call, with fields already redacted. */
interface LogEntry {
	level: "debug" | "info" | "warn" | "error";
	message: string;
	fields: Record<string, unknown>;
}
/** A Logger that keeps its entries in memory so tests can assert on them. */
interface MemoryLogger extends Logger {
	/** Every entry logged through this logger or its children, in order, after redaction. */
	readonly entries: LogEntry[];
}
/** The dependencies most services take, as test doubles. */
interface TestDeps {
	clock: FixedClock;
	logger: MemoryLogger;
	errorReporter: MemoryErrorReporter;
}
/** Creates a Logger that records redacted entries in memory instead of writing them. */
declare function createMemoryLogger(): MemoryLogger;
/** Creates test deps: a clock fixed at 2026-01-01T00:00:00.000Z, a memory logger and a memory error reporter. */
declare function createTestDeps(overrides?: Partial<TestDeps>): TestDeps;
export { CapturedError, ContactTarget, DEFAULT_TEST_ORGANIZATION_ID, DEFAULT_TEST_USER_ID, DeadLetter, HeldCopy, LogEntry, MemoryCallView, MemoryContactGuard, MemoryErrorReporter, MemoryLogger, MemoryObjectStore, MemoryObjectStoreOptions, MemoryOperationRecord, MemoryQueue, MemoryQueueOptions, MemoryTelephony, MemoryTelephonyOptions, MemoryTranscriber, MemoryTranscriberOptions, MemoryVectorStore, MemoryVectorStoreOptions, MintTokenOptions, ScriptedOutcome, ScriptedProspect, SignedWebhook, TelephonyOperation, TestDefinition, TestDeps, TestEnvelope, TestKeyPair, TranscriberOperation, VirtualTime, createMemoryContactGuard, createMemoryErrorReporter, createMemoryLogger, createMemoryObjectStore, createMemoryQueue, createMemoryTelephony, createMemoryTranscriber, createMemoryVectorStore, createTestDeps, createTestJwks, createTestKeyPair, createTestRegistry, createVirtualTime, mintTestToken, testNote, testOrganizationId, testPing, testUserId };
