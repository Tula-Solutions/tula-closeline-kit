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
/** What the behaviour suite needs from an adapter under test. */
interface ObjectStoreSubject {
	/** The store under test, empty for the Organizations below. */
	store: ObjectStore;
	/** Three Organization ids the store accepts, none empty of data: B is unrelated, and `aExtended` starts with `a`. */
	organizations: {
		a: string;
		b: string;
		aExtended: string;
	};
	/** The store's `maxObjectBytes`, small (a few KiB) so the suite can cross it. */
	maxObjectBytes: number;
	/** Removes what the subject created. */
	close(): Promise<void>;
}
/**
* The behaviour every {@link ObjectStore} must show. Run it with {@link objectStoreBehaviour}
* against the memory adapter and against the S3 adapter on its stand-in; a change that passes for
* one and fails for the other is a bug in one of them.
*/
declare function objectStoreBehaviour(name: string, make: () => Promise<ObjectStoreSubject>, skip?: boolean): void;
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
	* for {@link Transcriber.getResult} and {@link Transcriber.delete}; the vendor's own id is never
	* required.
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
* **A blocker for the real adapter, unverified:** whether AssemblyAI lets the caller give a
* reference of its own, or look a transcript up by one, is not established (its transcript object
* has no such field in the documentation read so far). If it does not, the adapter owns a mapping
* store (a table of `(organizationId, clientReference) -> vendor id`, written before the vendor
* call and so recoverable after a crash) and `delete` and `list` run on that mapping plus the
* vendor's own list, which is a design of its own and not a thing this port can paper over. The
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
	* {@link waitForTranscription}. O(result size).
	*/
	getResult(organizationId: string, clientReference: string): Promise<TranscriptionResult | undefined>;
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
	* send made in between survives. O(1).
	*/
	delete(organizationId: string, clientReference: string): Promise<{
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
/** What the behaviour suite needs from an adapter under test. */
interface TranscriberSubject {
	/** The transcriber under test, with no sends for the Organizations below. */
	transcriber: Transcriber;
	/** Three Organization ids the transcriber accepts: B is unrelated, and `aExtended` starts with `a`. */
	organizations: {
		a: string;
		b: string;
		aExtended: string;
	};
	/** Milliseconds between reads while waiting for a result; default 0 (the stand-in answers at once). */
	pollIntervalMs?: number;
	/** Removes what the subject created, including every vendor copy. */
	close(): Promise<void>;
}
/**
* The behaviour every {@link Transcriber} must show. Run it with {@link transcriberBehaviour}
* against the memory adapter and against any real adapter (which has no local stand-in, so it runs
* in an integration test against a dev account with short sample audio and cleans up with `close`).
* It never assumes how fast a send finishes: a result may be pending, done or failed.
*/
declare function transcriberBehaviour(name: string, make: () => Promise<TranscriberSubject>, skip?: boolean): void;
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
/** What the behaviour suite needs from an adapter under test. */
interface VectorStoreSubject {
	/** The store under test, empty for the Organizations below, with at least 3 dimensions. */
	store: VectorStore;
	/** Three Organization ids the store accepts: B is unrelated, and `aExtended` starts with `a`. */
	organizations: {
		a: string;
		b: string;
		aExtended: string;
	};
	/** Removes what the subject created. */
	close(): Promise<void>;
}
/**
* The behaviour every {@link VectorStore} must show. Run it with {@link vectorStoreBehaviour}
* against the memory adapter and against any real adapter (a store with no local stand-in runs it
* in an integration test against a scratch namespace in a dev account).
*/
declare function vectorStoreBehaviour(name: string, make: () => Promise<VectorStoreSubject>, skip?: boolean): void;
export { ObjectStoreSubject, QueueSubject, StoreSubject, TranscriberSubject, VectorStoreSubject, objectStoreBehaviour, processedStoreBehaviour, queueBehaviour, transcriberBehaviour, vectorStoreBehaviour };
