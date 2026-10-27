import { z } from "zod";
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
/** The real clock, for production wiring. */
declare const systemClock: Clock;
/** Creates a clock frozen at `start` that only moves when `advance` is called. */
declare function createFixedClock(start: Date | string): FixedClock;
/** The bounds on an audit entry. */
declare const AUDIT_LIMITS: {
	/** Most keys in `metadata`. */
	readonly maxMetadataKeys: 20;
	/** Longest string value in `metadata`, in characters. */
	readonly maxStringChars: 200;
	/** Largest serialised entry, in UTF-8 bytes. */
	readonly maxEntryBytes: 4096;
};
/** Metadata keys that are refused in any case, because they would carry content or credentials. */
declare const AUDIT_DENIED_METADATA_KEYS: readonly ["body", "content", "text", "message", "transcript", "token", "secret", "password", "email"];
/** Flat metadata of ids and labels: at most 20 keys, strings of at most 200 characters, numbers and booleans. */
declare const auditMetadataSchema: z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>;
/** Who or what acted. */
declare const auditActorSchema: z.ZodObject<{
	kind: z.ZodEnum<{
		agent: "agent";
		api_key: "api_key";
		member: "member";
		system: "system";
	}>;
	id: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
/** What the action was done to. */
declare const auditSubjectSchema: z.ZodObject<{
	type: z.ZodString;
	id: z.ZodString;
}, z.core.$strict>;
/** The fields of an audit entry other than its event id and Organization. */
declare const auditEventPayloadSchema: z.ZodObject<{
	actor: z.ZodObject<{
		kind: z.ZodEnum<{
			agent: "agent";
			api_key: "api_key";
			member: "member";
			system: "system";
		}>;
		id: z.ZodOptional<z.ZodString>;
	}, z.core.$strict>;
	action: z.ZodString;
	subject: z.ZodObject<{
		type: z.ZodString;
		id: z.ZodString;
	}, z.core.$strict>;
	instructionVersion: z.ZodOptional<z.ZodNumber>;
	prospectId: z.ZodOptional<z.ZodNullable<z.core.$ZodBranded<z.ZodString, "prs", "out">>>;
	requestId: z.ZodOptional<z.ZodString>;
	occurredAt: z.ZodOptional<z.ZodISODateTime>;
	metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>>;
}, z.core.$strict>;
/** The shape of one audit entry; unknown fields are refused. */
declare const auditEntrySchema: z.ZodObject<{
	actor: z.ZodObject<{
		kind: z.ZodEnum<{
			agent: "agent";
			api_key: "api_key";
			member: "member";
			system: "system";
		}>;
		id: z.ZodOptional<z.ZodString>;
	}, z.core.$strict>;
	action: z.ZodString;
	subject: z.ZodObject<{
		type: z.ZodString;
		id: z.ZodString;
	}, z.core.$strict>;
	instructionVersion: z.ZodOptional<z.ZodNumber>;
	prospectId: z.ZodOptional<z.ZodNullable<z.core.$ZodBranded<z.ZodString, "prs", "out">>>;
	requestId: z.ZodOptional<z.ZodString>;
	occurredAt: z.ZodOptional<z.ZodISODateTime>;
	metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>>;
	id: z.ZodString;
	organizationId: z.core.$ZodBranded<z.ZodString, "org", "out">;
}, z.core.$strict>;
/** A validated audit entry. */
type AuditEntry = z.output<typeof auditEntrySchema>;
/** What a caller gives {@link AuditRecorder.record}. */
type AuditEntryInput = z.input<typeof auditEntrySchema>;
/**
* Validates an entry, fills `occurredAt` from the clock when absent, and checks the serialised
* size of the result (so the cap holds for what is stored). Throws an AuditError `audit.invalid_entry`
* or `audit.entry_too_large`; neither holds a value from the entry. O(entry size).
*/
declare function parseAuditEntry(input: unknown, clock?: Clock): AuditEntry & {
	occurredAt: string;
};
/** Everything needed to build an AppError. */
interface AppErrorInit {
	/** Stable machine-readable code of the form `area.reason`, e.g. `auth.token_expired`. */
	code: string;
	/** HTTP status the error maps to. */
	status: number;
	/** Human-readable message that is safe to return to a client. */
	message: string;
	/** Extra plain data that is safe to return to a client. */
	details?: Record<string, unknown>;
	/** The underlying error, kept for logs and never returned to a client. */
	cause?: unknown;
}
/** The JSON body a service returns for a failed request. */
interface ErrorBody {
	error: {
		code: string;
		message: string;
		details?: Record<string, unknown>;
	};
}
/** An expected failure with a stable `area.reason` code and the HTTP status it maps to. */
declare class AppError extends Error {
	readonly code: string;
	readonly status: number;
	readonly details?: Record<string, unknown>;
	constructor(init: AppErrorInit);
}
/** Narrows an unknown value to an AppError. */
declare function isAppError(value: unknown): value is AppError;
/** Builds the client-facing JSON body for an AppError, leaving out `details` when there are none. */
declare function toErrorBody(error: AppError): ErrorBody;
/** The `area.reason` codes the audit recorder throws. */
declare const AUDIT_ERROR_CODES: {
	/** The entry has a field, key, value or shape the recorder does not accept. Nothing was recorded. */
	readonly invalidEntry: "audit.invalid_entry";
	/** The serialised entry is over the size cap. Nothing was recorded. */
	readonly entryTooLarge: "audit.entry_too_large";
	/** The queue did not take the event, after its own bounded retries. A retry with the same event id is safe. */
	readonly unavailable: "audit.unavailable";
};
/** One of {@link AUDIT_ERROR_CODES}'s values. */
type AuditErrorCode = (typeof AUDIT_ERROR_CODES)[keyof typeof AUDIT_ERROR_CODES];
/**
* What the audit recorder throws. Its message is fixed text and its details hold only field
* paths, issue codes and sizes: never a metadata value.
*/
declare class AuditError extends AppError {
	readonly code: AuditErrorCode;
	constructor(code: AuditErrorCode, message: string, options?: {
		cause?: unknown;
		details?: Record<string, unknown>;
	});
}
import { z as z2 } from "zod";
/** The largest message body SQS accepts, in bytes (256 KiB). Every adapter enforces it. */
declare const MAX_MESSAGE_BYTES = 262144;
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
/**
* Declares a message type. `type` looks like `area.event_name` (`core.organization_created`);
* `version` is a positive integer you raise when the payload changes incompatibly. A consumer
* accepts its current version and the `previous` versions it lists (each upcast to the current
* shape); any other version waits in the queue with a growing delay, and reaches the dead-letter
* queue if no consumer that understands it is deployed in time. Roll out a new version by deploying
* consumers that list it as current (or the old one as `previous`) before publishers send it.
*/
declare function defineMessage<
	const T extends string,
	P extends z2.ZodType,
	const S extends MessageScope
>(definition: {
	type: T;
	version: number;
	scope: S;
	payload: P;
	previous?: readonly PreviousVersion[];
}): MessageDefinition<T, P, S>;
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
import { MessageDefinition as MessageDefinition_xp6xd2 } from "..";
import { ZodObject as ZodObject_qx5az2 } from "zod";
import { ZodEnum as ZodEnum_piue6o } from "zod";
import { ZodOptional as ZodOptional_csos33 } from "zod";
import { ZodString as ZodString_t3dacg } from "zod";
import { $strict as $strict_gffh7x } from "zod/v4/core";
import { ZodNumber as ZodNumber_qqlmmw } from "zod";
import { ZodNullable as ZodNullable_hf13o0 } from "zod";
import { $ZodBranded as $ZodBranded_7i43x7 } from "zod/v4/core";
import { ZodISODateTime as ZodISODateTime_n0rd9r } from "zod";
import { ZodRecord as ZodRecord_sdtasg } from "zod";
import { ZodUnion as ZodUnion_a4q2qo } from "zod";
import { ZodBoolean as ZodBoolean_aoutmh } from "zod";
/** The `audit.recorded` message: one audit event. The envelope id is the event id. */
declare const auditRecordedMessage: MessageDefinition_xp6xd2<"audit.recorded", ZodObject_qx5az2<{
	actor: ZodObject_qx5az2<{
		kind: ZodEnum_piue6o<{
			agent: "agent";
			api_key: "api_key";
			member: "member";
			system: "system";
		}>;
		id: ZodOptional_csos33<ZodString_t3dacg>;
	}, $strict_gffh7x>;
	action: ZodString_t3dacg;
	subject: ZodObject_qx5az2<{
		type: ZodString_t3dacg;
		id: ZodString_t3dacg;
	}, $strict_gffh7x>;
	instructionVersion: ZodOptional_csos33<ZodNumber_qqlmmw>;
	prospectId: ZodOptional_csos33<ZodNullable_hf13o0<$ZodBranded_7i43x7<ZodString_t3dacg, "prs", "out">>>;
	requestId: ZodOptional_csos33<ZodString_t3dacg>;
	occurredAt: ZodOptional_csos33<ZodISODateTime_n0rd9r>;
	metadata: ZodOptional_csos33<ZodRecord_sdtasg<ZodString_t3dacg, ZodUnion_a4q2qo<readonly [ZodString_t3dacg, ZodNumber_qqlmmw, ZodBoolean_aoutmh]>>>;
}, $strict_gffh7x>, "organization">;
/** The envelope of {@link auditRecordedMessage}. */
type AuditRecordedEnvelope = EnvelopeOf<typeof auditRecordedMessage>;
/**
* Records one audit event: who or what did what to which subject. An entry holds ids, labels and
* an action code, never a message body, transcript, secret or address. Core consumes the events
* (`audit.recorded`) and writes the log.
*/
interface AuditRecorder {
	/**
	* Records the entry. Idempotent per `entry.id`: recording the same id again changes nothing. Throws
	* an AuditError: `audit.invalid_entry`, `audit.entry_too_large` or, for the queue adapter,
	* `audit.unavailable` (retry with the same id). O(entry size), at most 4 KiB.
	*/
	record(entry: AuditEntryInput): Promise<void>;
}
/** Where log lines go: anything with a `write` that takes one newline-terminated JSON line. */
interface LogDestination {
	write(line: string): void;
}
/** The lowest severity a logger writes, or `silent` to write nothing. */
type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
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
/** Options for createLogger. */
interface LoggerOptions {
	/** Service name written on every line. */
	service: string;
	/** Lowest severity to write; defaults to `info`. */
	level?: LogLevel;
	/** Where lines are written; defaults to stdout. */
	destination?: LogDestination;
}
/** Creates a JSON-lines logger for one service that redacts sensitive fields at any depth. */
declare function createLogger(options: LoggerOptions): Logger;
/** Opaque handle for one delivery of a message; pass it back to acknowledge or change visibility. */
type Receipt = string;
/** The largest batch SQS takes or gives. */
declare const MAX_BATCH_SIZE = 10;
/** The longest long-poll wait SQS allows, in seconds. */
declare const MAX_WAIT_SECONDS = 20;
/** The longest visibility timeout SQS allows, in seconds (12 hours). */
declare const MAX_VISIBILITY_SECONDS = 43200;
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
/** Throws the QueueError for a `receive` call whose numbers are out of range. */
declare function assertReceiveOptions(options: ReceiveOptions): void;
/** Throws the QueueError for a visibility timeout outside 0 to 43200 whole seconds. */
declare function assertVisibility(seconds: number): void;
/** Throws the QueueError for a batch of 0 or more than 10 messages. */
declare function assertBatchCount(count: number): void;
/** Options for {@link createQueueAuditRecorder}. */
interface QueueAuditRecorderOptions {
	/** Where `audit.recorded` is published; a queue that accepts that message type. */
	queue: Pick<Queue<AuditRecordedEnvelope>, "publish">;
	/** Time source for entries without `occurredAt`. */
	clock?: Clock;
	/** Receives one line per entry with ids and counts, never metadata values. */
	logger?: Logger;
}
/**
* Creates the recorder that publishes `audit.recorded`. The event id is the envelope id, so a
* retry or a second call sends a message the consumer drops as a duplicate. O(entry size) and one
* queue call.
*/
declare function createQueueAuditRecorder(options: QueueAuditRecorderOptions): AuditRecorder;
import { ApiKeyId, ApiKeyScope, OrganizationId, Region, Role, UserId } from "tula-closeline-contract";
import { z as z3 } from "zod";
/** The longest access token, in characters, that verification will look at. */
declare const MAX_TOKEN_LENGTH = 4096;
/** The claims of a member's access token, besides the registered `iss`, `aud`, `exp`. It has no `act`. */
declare const accessTokenClaimsSchema: z3.ZodObject<{
	act: z3.ZodOptional<z3.ZodUndefined>;
	sub: z3.core.$ZodBranded<z3.ZodString, "usr", "out">;
	org: z3.core.$ZodBranded<z3.ZodString, "org", "out">;
	role: z3.ZodEnum<{
		admin: "admin";
		manager: "manager";
		owner: "owner";
		rep: "rep";
	}>;
	region: z3.ZodEnum<{
		eu: "eu";
		us: "us";
	}>;
	iat: z3.ZodNumber;
	exp: z3.ZodNumber;
}, z3.core.$strip>;
/** The `act` claim of a token minted for an API key. */
declare const API_KEY_ACTOR = "api_key";
/** The claims of an API key's access token: no `role`, and a closed, non-empty list of scopes. */
declare const apiKeyTokenClaimsSchema: z3.ZodObject<{
	act: z3.ZodLiteral<"api_key">;
	sub: z3.core.$ZodBranded<z3.ZodString, "akey", "out">;
	org: z3.core.$ZodBranded<z3.ZodString, "org", "out">;
	role: z3.ZodOptional<z3.ZodUndefined>;
	region: z3.ZodEnum<{
		eu: "eu";
		us: "us";
	}>;
	scp: z3.ZodArray<z3.ZodEnum<{
		"bookings:read": "bookings:read";
		"bookings:write": "bookings:write";
		"calls:read": "calls:read";
		"calls:write": "calls:write";
		"campaigns:read": "campaigns:read";
		"campaigns:write": "campaigns:write";
		"consent:read": "consent:read";
		"consent:write": "consent:write";
		"enrichment:read": "enrichment:read";
		"enrichment:write": "enrichment:write";
		"messaging:read": "messaging:read";
		"messaging:write": "messaging:write";
		"playbook:read": "playbook:read";
		"playbook:write": "playbook:write";
		"prospects:read": "prospects:read";
		"prospects:write": "prospects:write";
	}>>;
	iat: z3.ZodNumber;
	exp: z3.ZodNumber;
}, z3.core.$strip>;
/** The identity a verified member's access token proves. */
interface VerifiedToken {
	/** A signed-in user acting through a Membership. */
	actor: "member";
	/** The signed-in user. */
	userId: UserId;
	/** The Organization every query for this request must be scoped to. */
	organizationId: OrganizationId;
	/** The user's role in that Organization. */
	role: Role;
	/** The Region the Organization lives in. */
	region: Region;
	/** When the token was issued. */
	issuedAt: Date;
	/** When the token stops being valid. */
	expiresAt: Date;
	/** Never present: a member's token has no scopes. */
	scopes?: never;
	/** Never present: a member's token is not an API key's. */
	apiKeyId?: never;
}
/** The identity a verified API key token proves. It has no user and never a role. */
interface VerifiedApiKeyToken {
	/** An API key acting for an Organization. */
	actor: "api_key";
	/** The API key. */
	apiKeyId: ApiKeyId;
	/** What the key may do; `write` does not include `read`. */
	scopes: readonly ApiKeyScope[];
	/** The Organization every query for this request must be scoped to. */
	organizationId: OrganizationId;
	/** The Region the Organization lives in. */
	region: Region;
	/** When the token was issued. */
	issuedAt: Date;
	/** When the token stops being valid. */
	expiresAt: Date;
	/** Never present: an API key has no Membership. */
	role?: never;
	/** Never present: an API key is not a user. */
	userId?: never;
}
/** What a verified access token proves: a member, or an API key; branch on `actor`. */
type VerifiedIdentity = VerifiedToken | VerifiedApiKeyToken;
/**
* Why a token was not accepted. Deliberately coarse: it is safe to return to a client and to log.
* `unavailable` means the signing keys could not be loaded, which says nothing about the token.
*/
type TokenRejection = "expired" | "invalid" | "unavailable";
/** Thrown by a TokenVerifier for any token it will not accept, or cannot check; carries no token content. */
declare class TokenVerificationError extends Error {
	readonly reason: TokenRejection;
	constructor(reason: TokenRejection);
}
/** The most keys a JWKS may hold; a larger set is refused outright. */
declare const MAX_JWKS_KEYS = 20;
/** The largest JWKS response body, in bytes, that the remote key set will read. */
declare const MAX_JWKS_BYTES: number;
/** Where a TokenVerifier finds the public key for a token's `kid`. */
interface KeySet {
	/** Returns the key for `kid`, or undefined when it is unknown. Never throws. */
	getKey(kid: string): Promise<CryptoKey | undefined>;
	/** Whether the set currently holds loaded keys that are not stale. Never throws. */
	available(): boolean;
	/**
	* Whether the issuer has answered in full, most recently, without `kid`: only then is a `kid`
	* that getKey did not find a bad token. False means the set cannot tell a forged `kid` from a
	* newly rotated key (no answer yet, the last refresh failed, or one is still running). Call it
	* right after getKey. Never throws.
	*/
	confirmsAbsent(kid: string): boolean;
}
/** A JSON Web Key Set as published by the auth service. */
interface Jwks {
	keys: readonly unknown[];
}
/** Creates a key set from a JWKS given at boot. Throws when any key is not a public Ed25519 key. */
declare function createStaticKeySet(jwks: Jwks): Promise<KeySet>;
/** Options for createRemoteKeySet. */
interface RemoteKeySetOptions {
	/** The issuer's JWKS URL; must be https, carry no credentials, and not be http unless allowed. */
	url: string;
	/** Allows an http URL when the host is localhost or 127.0.0.1; defaults to false. Local only. */
	allowInsecureLocalhost?: boolean;
	/** Time source for the cooldown and cache age. */
	clock: Clock;
	/** Receives a warning when a refresh fails. Never receives token content. */
	logger?: Logger;
	/** Fetch implementation; defaults to the global one. */
	fetch?: typeof fetch;
	/** Per-attempt timeout; defaults to 3000. */
	timeoutMs?: number;
	/** Retries after a network error, timeout or 5xx within one refresh; defaults to 1. */
	retries?: number;
	/** Minimum gap between refresh attempts, successful or not; defaults to 30000. */
	cooldownMs?: number;
	/** Age after which a cached key set is refreshed in the background; defaults to 3600000. */
	maxAgeMs?: number;
	/**
	* Age after which the cached keys are dropped if no refresh has succeeded; defaults to 86400000.
	* Must exceed `maxAgeMs`. Lookups then find nothing and `available()` is false.
	*/
	maxStaleMs?: number;
	/** The longest one lookup waits for a refresh before giving up; defaults to 5000. */
	lookupDeadlineMs?: number;
	/** Waits before a retry; defaults to a timer. Tests inject a no-op. */
	sleep?: (ms: number) => Promise<void>;
	/** Source of jitter in [0, 1); defaults to Math.random. */
	random?: () => number;
}
/** A KeySet that fetches and caches the issuer's JWKS. */
interface RemoteKeySet extends KeySet {
	/** Fetches the JWKS now, ignoring the cooldown, so the first request needn't pay for it. */
	warm(): Promise<void>;
}
/**
* Creates a key set backed by the issuer's JWKS URL. Lookups of a cached `kid` do no I/O. An
* unknown `kid` triggers at most one refresh per cooldown window, shared by concurrent callers,
* and no lookup waits longer than the deadline. A failed refresh keeps serving the last good keys
* until they are `maxStaleMs` old, after which they are dropped and `available()` is false.
* `confirmsAbsent(kid)` is true only when the most recent refresh succeeded and lacked `kid`.
*/
declare function createRemoteKeySet(options: RemoteKeySetOptions): RemoteKeySet;
import { MiddlewareHandler } from "hono";
import { ApiKeyId as ApiKeyId2, ApiKeyScope as ApiKeyScope2, OrganizationId as OrganizationId2, Region as Region2, Role as Role2, UserId as UserId2 } from "tula-closeline-contract";
/** Options for createTokenVerifier. */
interface TokenVerifierOptions {
	/** The `iss` claim every token must carry. */
	issuer: string;
	/** The `aud` claim every token must carry. */
	audience: string;
	/** Where signing keys come from. */
	keys: KeySet;
	/** Time source for `exp`, `nbf` and `iat`; never the real clock in tests. */
	clock: Clock;
	/** Allowed clock skew in seconds, at most 120; defaults to 30. */
	clockToleranceSeconds?: number;
}
/** Checks access tokens offline against a key set. */
interface TokenVerifier {
	/**
	* Returns the identity in a valid token, or throws a TokenVerificationError: `expired` or
	* `invalid` for the token, `unavailable` when the signing keys could not be loaded.
	*/
	verify(token: string): Promise<VerifiedIdentity>;
}
/**
* Creates a verifier for EdDSA access tokens. Complexity per call is O(token length) with one
* Ed25519 verification and one Map lookup; with a cached key it does no I/O.
*/
declare function createTokenVerifier(options: TokenVerifierOptions): TokenVerifier;
/** The context variables the auth middleware sets; pass as `new Hono<AuthEnv>()`. */
interface AuthEnv {
	Variables: AuthVariables;
}
/**
* The context variables on a route that has opted in to API keys with requireScope; pass as
* `new Hono<ScopedAuthEnv>()`. The caller is a member or an API key, so `role` and `userId`
* exist only for a member, and `apiKeyId` and `scopes` only for an API key.
*/
interface ScopedAuthEnv {
	Variables: ScopedAuthVariables;
}
/** The verified caller on a route behind requireScope; branch on `actor`. */
interface ScopedAuthVariables {
	/** Who is calling: a signed-in member or an API key. */
	actor: "member" | "api_key";
	/** The Organization every query for this request must be scoped to. */
	organizationId: OrganizationId2;
	/** The Region the Organization lives in. */
	region: Region2;
	/** The signed-in user; set only when `actor` is `member`. */
	userId?: UserId2;
	/** The user's role; set only when `actor` is `member`, never for an API key. */
	role?: Role2;
	/** The API key; set only when `actor` is `api_key`. */
	apiKeyId?: ApiKeyId2;
	/** What the API key may do; set only when `actor` is `api_key`. */
	scopes?: readonly ApiKeyScope2[];
}
/** The verified member behind a route, read with `c.get('organizationId')` and so on. */
interface AuthVariables {
	/** Always a member here: the middleware refuses an API key on a route that has not opted in. */
	actor: "member";
	/** The Organization every query for this request must be scoped to. */
	organizationId: OrganizationId2;
	/** The signed-in user. */
	userId: UserId2;
	/** The user's role in that Organization. */
	role: Role2;
	/** The Region the Organization lives in. */
	region: Region2;
}
/** Options for createAuthMiddleware. */
interface AuthMiddlewareOptions {
	/** Verifies the bearer token. */
	verifier: TokenVerifier;
	/**
	* Receives a warning with only a coarse reason for each rejected request, and an error for each
	* request that failed because verification was unavailable or threw (error class name only).
	* Those errors are written at most once a second; the next line says how many were held back.
	*/
	logger?: Logger;
	/** Time source for the error log limit; defaults to the system clock. */
	clock?: Clock;
}
/**
* Creates Hono middleware that requires a valid `Authorization: Bearer` access token. For a member
* it sets actor, organizationId, userId, role and region. An API key token is refused with 403
* `auth.forbidden` unless a matched route carries a requireScope guard, which opts the route in;
* then it sets actor, organizationId, region, apiKeyId and scopes, and no role. On failure it
* throws an AppError: 401 with `auth.unauthenticated`, `auth.token_expired` or
* `auth.token_invalid`, or 503 with `auth.unavailable` when the signing keys could not be loaded
* or verification threw.
*/
declare function createAuthMiddleware(options: AuthMiddlewareOptions): MiddlewareHandler<AuthEnv>;
import { MiddlewareHandler as MiddlewareHandler2 } from "hono";
import { ApiKeyScope as ApiKeyScope3 } from "tula-closeline-contract";
/** True for a handler made by requireScope; the auth middleware reads it to let an API key in. */
declare function isScopeGuard(handler: unknown): boolean;
/**
* Creates a route guard that opts the route in to API key tokens. A member token passes unchanged
* (a member's access is governed by role, as on every other route); an API key token passes only
* if its scopes include exactly `scope` (`write` does not imply `read`), else `auth.forbidden`.
* Mount it on the route itself, before the handler and after the auth middleware: the middleware
* refuses an API key on any route where it finds no guard, and a guard on a prefix opts in every
* method beneath it, so guard each method's route separately. Throws a TypeError for a name the contract does not list.
*/
declare function requireScope(scope: ApiKeyScope3): MiddlewareHandler2<ScopedAuthEnv>;
import { OrganizationId as OrganizationId3 } from "tula-closeline-contract";
/** What {@link CalendarConnection}'s constructor takes. */
interface CalendarConnectionInit {
	/** The Organization the Rep belongs to. */
	organizationId: OrganizationId3;
	/** The vendor, such as `google` or `microsoft`; `memory` for the test adapter. */
	provider: string;
	/** A stable, non-secret id of this connection; safe to log and to use as a database key. */
	connectionId: string;
	/** The secret the adapter needs to call the vendor (a refresh token or a sealed blob). Never logged. */
	credential: string;
}
/**
* A Rep's authorised link to their calendar, as the adapter handed it back from `connect`. It is
* opaque: the OAuth credential is held in a private field, so it is not in `JSON.stringify`, a
* spread, `String()`, a log line or a console dump; only `connectionId`, `provider` and the
* Organization are. core stores {@link CalendarConnection.unsafeCredential} encrypted at rest and
* rebuilds the connection with `new CalendarConnection(...)`; only an adapter reads it for any
* other reason.
*/
declare class CalendarConnection {
	private;
	/** The Organization the connection belongs to. */
	readonly organizationId: OrganizationId3;
	/** The vendor name. */
	readonly provider: string;
	/** The non-secret id of the connection. */
	readonly connectionId: string;
	constructor(init: CalendarConnectionInit);
	/** The vendor credential. For the adapter that issued the connection and for encrypted storage only; never log it. */
	unsafeCredential(): string;
	/** The non-secret parts, for `JSON.stringify`. */
	toJSON(): {
		organizationId: OrganizationId3;
		provider: string;
		connectionId: string;
	};
	/** A readable label without the credential. */
	toString(): string;
}
/** The `area.reason` codes the calendar port and adapters throw. */
declare const CALENDAR_ERROR_CODES: {
	/** The Organization id, connection, request id, times, event fields, grant, options or retry policy are not acceptable. Nothing was sent to the vendor. */
	readonly invalidRequest: "calendar.invalid_request";
	/** The Rep revoked access (or Closeline did): the connection can no longer be used and must be connected again. */
	readonly revoked: "calendar.revoked";
	/** The event does not exist on this connection's calendar. */
	readonly notFound: "calendar.not_found";
	/** The vendor refused for a reason a retry cannot fix (a refused grant, quota, a policy, a rejected event). */
	readonly rejected: "calendar.rejected";
	/** The vendor could not be reached, was throttled or failed, after the bounded retries. The only retryable code. */
	readonly unavailable: "calendar.unavailable";
	/** The time limit passed; the underlying request was aborted. */
	readonly timeout: "calendar.timeout";
	/** The caller's own AbortSignal fired; the underlying request was aborted. */
	readonly aborted: "calendar.aborted";
};
/** One of {@link CALENDAR_ERROR_CODES}'s values. */
type CalendarErrorCode = (typeof CALENDAR_ERROR_CODES)[keyof typeof CALENDAR_ERROR_CODES];
/**
* What a calendar adapter throws. Its message and details never hold a token, a grant, an event
* title, description or attendee, or a vendor URL; they describe fields and codes only.
*/
declare class CalendarError extends AppError {
	readonly code: CalendarErrorCode;
	constructor(code: CalendarErrorCode, message: string, options?: {
		cause?: unknown;
		details?: Record<string, unknown>;
	});
}
/**
* Waits `ms` milliseconds, or less when `signal` aborts. Resolves either way, never rejects, so a
* loop that sleeps checks its own stop flag. Injected so tests drive time by hand.
*/
type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
/** The real {@link Sleep}, on `setTimeout`. */
declare const systemSleep: Sleep;
import { Region as Region3 } from "tula-closeline-contract";
import { z as z4 } from "zod";
/** The deployment environments a service can run in, from its `ENVIRONMENT` variable. */
declare const ENVIRONMENTS: readonly ["local", "dev", "staging", "prod"];
/** One of the deployment environments. */
type Environment = (typeof ENVIRONMENTS)[number];
/** Zod schema for the `ENVIRONMENT` variable. */
declare const environmentSchema: z4.ZodEnum<{
	dev: "dev";
	local: "local";
	prod: "prod";
	staging: "staging";
}>;
/**
* True for a string the Sentry SDK takes as a DSN: `https://<public key>@<host>/<project id>`, with
* an optional secret, port and path prefix and no trailing slash. A DSN with the `http:` scheme
* passes only when `environment` is `local`, so events and the project key are never sent in clear
* text from a deployed service. It checks the shape only; whether the project exists, and in which
* data region, is Sentry's.
*/
declare function isSentryDsn(value: string, environment: Environment): boolean;
/**
* Zod schema for `SENTRY_DSN`: a Sentry DSN, where an empty string means "not set". Surrounding
* whitespace (a trailing newline from a secret file) is trimmed, as `createErrorReporter` does, so
* the value a service boots with is the one the reporter uses.
*/
declare const sentryDsnSchema: z4.ZodPreprocess<z4.ZodOptional<z4.ZodString>, unknown>;
/**
* Refinement for a service's env object: `SENTRY_DSN` may be missing in `local` and must be set in
* `dev`, `staging` and `prod`, where it must use `https:`. Use it as `z.object({ ENVIRONMENT, SENTRY_DSN, ... }).superRefine(requireSentryDsn)`
* so boot fails when a deployed service has no error tracker.
*/
declare function requireSentryDsn(env: {
	ENVIRONMENT: Environment;
	SENTRY_DSN?: string | undefined;
}, ctx: z4.RefinementCtx): void;
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
/** Options for createErrorReporter. */
interface ErrorReporterOptions {
	/** The Sentry DSN of this Region's project; no DSN gives a reporter that sends nothing. */
	dsn?: string | undefined;
	/** Service name, sent as the `service` tag. */
	service: string;
	/** The `ENVIRONMENT` the service runs in, sent as the `environment` tag. */
	environment: Environment;
	/** The Region this deployment serves, sent as the `region` tag. */
	region: Region3;
	/** The git SHA of the running build, sent as the event's release. */
	release?: string | undefined;
	/** Where the reporter says that it is off or that a send failed; errors themselves never go here. */
	logger: Logger;
}
/**
* True for an error worth reporting: any unknown error, and an AppError with status 500 or above.
* An AppError below 500 is an expected outcome (bad input, expired token) and is never sent.
*/
declare function shouldReportError(error: unknown): boolean;
import { OrganizationId as OrganizationId4 } from "tula-closeline-contract";
/** The default time a call may take, in milliseconds. */
declare const DEFAULT_CALENDAR_TIMEOUT_MS = 1e4;
/** The longest time a caller may allow a call, in milliseconds. */
declare const MAX_CALENDAR_TIMEOUT_MS = 6e4;
/** The longest range `busy` may ask for, in milliseconds (62 days). */
declare const MAX_BUSY_RANGE_MS: number;
/** The most intervals `busy` returns; an adapter whose calendar has more fails with `calendar.rejected`, never a cut-off list. */
declare const MAX_BUSY_INTERVALS = 5e3;
/** The longest an event may be, in milliseconds (7 days). */
declare const MAX_EVENT_DURATION_MS: number;
/** The most attendees one event may carry. */
declare const MAX_EVENT_ATTENDEES = 20;
/** How an adapter retries a retryable vendor error (`calendar.unavailable`) before giving up. */
interface CalendarRetryPolicy {
	/** The most retries after the first attempt, 0 to 5; 0 never retries. Default 2. */
	maxRetries?: number;
	/** The base of the pause before a retry, in ms, 1 to 60000; doubled each time and jittered. Default 200. */
	baseDelayMs?: number;
	/** The longest pause before a retry, in ms, before jitter, at least the base and at most 60000. Default 2000. */
	maxDelayMs?: number;
}
/** The retry policy with its defaults filled in. */
interface ResolvedCalendarRetryPolicy {
	/** The most retries after the first attempt. */
	maxRetries: number;
	/** The base pause, in ms. */
	baseDelayMs: number;
	/** The longest pause before jitter, in ms. */
	maxDelayMs: number;
}
/** The policy used when a call names none: two retries, 200 ms doubling to 2 s. */
declare const DEFAULT_CALENDAR_RETRY_POLICY: ResolvedCalendarRetryPolicy;
/**
* The pause before retry `retry` (from 1): the base doubled each time up to the maximum, then
* scaled by a jitter between 0.5 and 1.5 from `random()` (a number in `[0, 1)`).
*/
declare function calendarRetryDelayMs(retry: number, policy: ResolvedCalendarRetryPolicy, random?: () => number): number;
/** Limits every call states. */
interface CalendarCallOptions {
	/**
	* The most time the whole call may take, retries included, in ms, 1 to
	* {@link MAX_CALENDAR_TIMEOUT_MS}; default {@link DEFAULT_CALENDAR_TIMEOUT_MS}. When it passes
	* the vendor request is aborted and the call fails with `calendar.timeout`.
	*/
	timeoutMs?: number;
	/** Retries of `calendar.unavailable`; the defaults when absent. */
	retry?: CalendarRetryPolicy;
	/** The caller's own cancellation. When it fires the vendor request is aborted and the call fails with `calendar.aborted`. */
	signal?: AbortSignal;
}
/**
* What a Rep authorises. The vendor is told the grant, never this library: `authorization_code`
* is the code from the OAuth redirect (with the PKCE verifier and the redirect URI it was issued
* for); `refresh_token` stores a grant the Rep already gave. Both are secrets: never logged.
*/
type CalendarGrant = {
	/** Exchange the one-time code from the redirect. */
	kind: "authorization_code";
	/** The code. Secret. */
	code: string;
	/** The redirect URI the code was issued for. */
	redirectUri: string;
	/** The PKCE verifier, when the flow used one. Secret. */
	codeVerifier?: string;
} | {
	/** Store a grant the Rep already gave. */
	kind: "refresh_token";
	/** The refresh token. Secret. */
	refreshToken: string;
};
/** A time during which the calendar is busy. */
interface BusyInterval {
	/** The start, an ISO 8601 instant in UTC (`2026-03-02T15:00:00.000Z`). */
	start: string;
	/** The end, after the start, in the same form. */
	end: string;
}
/** One person invited to an event. Tenant data: never logged. */
interface CalendarAttendee {
	/** The email address the invitation goes to. */
	email: string;
	/** The display name. */
	name?: string;
}
/** The fields of a new event. Tenant data (Prospect names and addresses): never logged. */
interface CalendarEventInput {
	/** The title, 1 to 256 characters. */
	title: string;
	/** The start, an ISO 8601 instant with `Z` or an offset. */
	start: string;
	/** The end, after the start and at most {@link MAX_EVENT_DURATION_MS} later. */
	end: string;
	/** Notes, up to 8192 characters, such as a phone number to dial. */
	description?: string;
	/** A place, up to 512 characters. */
	location?: string;
	/** Up to {@link MAX_EVENT_ATTENDEES} invitees; the vendor sends the invitations. */
	attendees?: readonly CalendarAttendee[];
	/** `video` asks the vendor for a join link (Google Meet, Teams); `none` (default) adds none. */
	conferencing?: "video" | "none";
}
/** The fields an update may change; at least one. Attendees replace the list. */
interface CalendarEventChanges {
	/** The new title. */
	title?: string;
	/** The new start. */
	start?: string;
	/** The new end. */
	end?: string;
	/** The new notes. */
	description?: string;
	/** The new place. */
	location?: string;
	/** The new invitee list. */
	attendees?: readonly CalendarAttendee[];
}
/** What an adapter says about an event. */
interface CalendarEventRef {
	/** The vendor's id of the event; opaque, 1 to 256 characters. */
	eventId: string;
	/** The start, an ISO 8601 UTC instant. */
	start: string;
	/** The end, an ISO 8601 UTC instant. */
	end: string;
	/** The join link, when `conferencing: 'video'` was asked for and the vendor made one. */
	joinUrl?: string;
}
/** What `createEvent` returns. */
interface CalendarEventCreated extends CalendarEventRef {
	/** True when this call made the event, false when the request id had already made it. */
	created: boolean;
}
/** What every call after `connect` names: whose it is and which calendar. */
interface CalendarRequestBase {
	/** The Organization the call is for; it must be the connection's. */
	organizationId: OrganizationId4;
	/** The connection to use. */
	connection: CalendarConnection;
}
/** A request to connect a calendar. */
interface CalendarConnectRequest {
	/** The Organization the Rep belongs to. */
	organizationId: OrganizationId4;
	/** What the Rep authorised. */
	grant: CalendarGrant;
}
/** A request for the busy times of a range. */
interface CalendarBusyRequest extends CalendarRequestBase {
	/** The start of the range, an ISO 8601 instant. */
	from: string;
	/** The end of the range, after `from` and at most {@link MAX_BUSY_RANGE_MS} later. */
	to: string;
}
/** A request to create an event. */
interface CalendarCreateRequest extends CalendarRequestBase {
	/**
	* Makes the call idempotent: 1 to 128 characters of `A-Z a-z 0-9 _ . : -`. The same id with the
	* same event returns the same event with `created: false`; the same id with a different event is
	* `calendar.invalid_request`.
	*/
	requestId: string;
	/** The event. */
	event: CalendarEventInput;
}
/** A request to change an event. */
interface CalendarUpdateRequest extends CalendarRequestBase {
	/** The event to change. */
	eventId: string;
	/** Makes the call idempotent, like {@link CalendarCreateRequest.requestId}: a replay returns the first result. */
	requestId: string;
	/** What to change. */
	changes: CalendarEventChanges;
}
/** A request to remove an event. */
interface CalendarDeleteRequest extends CalendarRequestBase {
	/** The event to remove. */
	eventId: string;
	/** Makes the call idempotent: a replay returns the first result. */
	requestId: string;
}
/**
* A Rep's calendar behind a vendor (Google Calendar first, Microsoft Graph next), used by core to
* keep busy blocks and to write Bookings. Nothing vendor-specific is in the port.
*
* Every call has a hard timeout (see {@link CalendarCallOptions}) that aborts the vendor request.
* Retryable vendor errors (throttling, 5xx, connection loss) are retried with a bounded, jittered
* pause inside the time limit; nothing else is. Retrying is safe because every write carries a
* request id the vendor (or the adapter) uses to recognise a repeat. `connect` is the
* exception and is never retried (an authorization code is single-use); the caller retries with a
* new grant. Failures are `CalendarError`s
* with `calendar.*` codes; `calendar.unavailable` and `calendar.rejected` are also given to the
* ErrorReporter (metadata only).
*
* **Secrets and tenant data.** A grant and a {@link CalendarConnection}'s credential are never
* logged, reported or put in an error, and never appear in the connection's string or JSON form.
* Event titles, notes, places and attendees are tenant data and are held to the same rule. Text a
* calendar returns is untrusted data, never an instruction.
*/
interface CalendarPort {
	/**
	* Exchanges or stores the grant and returns the opaque connection. A grant the vendor refuses is
	* `calendar.rejected`. One vendor call.
	*/
	connect(request: CalendarConnectRequest, options?: CalendarCallOptions): Promise<CalendarConnection>;
	/**
	* The times the calendar is busy within `[from, to)`: sorted, merged where they touch or
	* overlap, and clipped to the range. At most {@link MAX_BUSY_INTERVALS}. O(events in the range).
	*/
	busy(request: CalendarBusyRequest, options?: CalendarCallOptions): Promise<BusyInterval[]>;
	/** Makes an event, once per request id. One vendor call, plus the invitation the vendor sends. */
	createEvent(request: CalendarCreateRequest, options?: CalendarCallOptions): Promise<CalendarEventCreated>;
	/** Changes an event, once per request id. A missing event is `calendar.not_found`. */
	updateEvent(request: CalendarUpdateRequest, options?: CalendarCallOptions): Promise<CalendarEventRef>;
	/**
	* Removes an event, once per request id. An event that is already gone is not an error: the
	* answer is `deleted: false`, so a cancel is idempotent by end state.
	*/
	deleteEvent(request: CalendarDeleteRequest, options?: CalendarCallOptions): Promise<{
		deleted: boolean;
	}>;
	/**
	* Ends the grant at the vendor and makes the connection unusable (`calendar.revoked`). Revoking
	* a connection that is already revoked succeeds. Events already written stay on the calendar.
	* Where a vendor has no per-grant revoke (Outlook), this only validates the request: the caller
	* must delete the stored credential, which is what ends access.
	*/
	revoke(request: CalendarRequestBase, options?: CalendarCallOptions): Promise<void>;
}
/** The least scopes the adapter needs: free/busy times and the events it writes. Ask for exactly these in the consent URL (with `access_type=offline`). */
declare const GOOGLE_CALENDAR_SCOPES: readonly string[];
/** The HTTP client the adapter uses: `fetch`, injected for tests. */
type GoogleCalendarFetch = (input: string, init: RequestInit) => Promise<Response>;
/** Options for {@link createGoogleCalendar}. The kit takes options, not environment variables. */
interface GoogleCalendarOptions {
	/** The OAuth client id of the Closeline Google Cloud project. */
	clientId: string;
	/** The OAuth client secret. Never logged. */
	clientSecret: string;
	/** The calendar read and written; the Rep's primary calendar by default. */
	calendarId?: string;
	/** The HTTP client; the global `fetch` by default. For tests. */
	fetch?: GoogleCalendarFetch;
	/** The time limit of one HTTP request, in ms, 1 to 60000; default 5000. The call's own deadline still applies. */
	attemptTimeoutMs?: number;
	/** Receives the errors that mean Google failed; nothing if absent. */
	reporter?: ErrorReporter;
	/** Where retries are noted (metadata only); nothing if absent. */
	logger?: Logger;
	/** The time source for access-token expiry; the system clock by default. */
	clock?: Clock;
	/** Pauses between retries; real time by default. */
	sleep?: Sleep;
	/** A number in `[0, 1)` for the jitter; `Math.random` by default. */
	random?: () => number;
}
/**
* Creates the {@link CalendarPort} on the Google Calendar REST API (v3) with OAuth 2.0.
*
* Scopes are the least that work ({@link GOOGLE_CALENDAR_SCOPES}): `calendar.freebusy` for busy
* times (the Rep's event titles are never read) and `calendar.events` for the events it writes. The
* credential of a {@link CalendarConnection} is the Rep's refresh token; access tokens are
* short-lived, held in a bounded in-process cache and refreshed when they near expiry. A refresh
* Google refuses with `invalid_grant` is `calendar.revoked`.
*
* Every HTTP request has its own time limit and each call an overall deadline that aborts the
* request; a network error, 429, 5xx and Google's rate-limit 403s are retried a bounded number of
* times with jitter, any other failure never, and `connect` never (a code is single-use). A write
* is idempotent by request id: `createEvent` sends a client-chosen event id derived from the
* connection and request id, and a duplicate (409) is read back and compared by a fingerprint kept
* in the event's private extended properties; `updateEvent` keeps the last request id and
* fingerprint the same way (a late replay of an older update is applied again, not recognised). Nothing is logged but retry metadata, and no token, title, note,
* address or URL is put in an error, a log line or a report. Text Google returns is data.
*/
declare function createGoogleCalendar(options: GoogleCalendarOptions): CalendarPort;
/** The least scopes the adapter needs: read and write the Rep's calendar, and a refresh token (`offline_access`). Ask for exactly these in the consent URL. */
declare const OUTLOOK_CALENDAR_SCOPES: readonly string[];
/** The HTTP client the adapter uses: `fetch`, injected for tests. */
type OutlookCalendarFetch = (input: string, init: RequestInit) => Promise<Response>;
/** Options for {@link createOutlookCalendar}. The kit takes options, not environment variables. */
interface OutlookCalendarOptions {
	/** The application (client) id of the Closeline app registration in Microsoft Entra. */
	clientId: string;
	/** The client secret. Never logged. */
	clientSecret: string;
	/** The Entra tenant that signs the Rep in: `common` (default), `organizations`, `consumers`, a tenant id or a verified domain. */
	tenant?: string;
	/** The calendar read and written, by Graph id; the Rep's default calendar when absent. */
	calendarId?: string;
	/** The HTTP client; the global `fetch` by default. For tests. */
	fetch?: OutlookCalendarFetch;
	/** The time limit of one HTTP request, in ms, 1 to 60000; default 5000. The call's own deadline still applies. */
	attemptTimeoutMs?: number;
	/** Receives the errors that mean Microsoft failed; nothing if absent. */
	reporter?: ErrorReporter;
	/** Where retries are noted (metadata only); nothing if absent. */
	logger?: Logger;
	/** The time source for access-token expiry; the system clock by default. */
	clock?: Clock;
	/** Pauses between retries; real time by default. */
	sleep?: Sleep;
	/** A number in `[0, 1)` for the jitter; `Math.random` by default. */
	random?: () => number;
	/**
	* Told when Microsoft rotates a refresh token: `credential` is the newest one, which core must
	* store in place of the connection's (the old one stops working after a while). Called with the
	* secret itself, so never log it. A throw is swallowed so the calendar call still completes.
	*/
	onCredentialRotated?: (connection: CalendarConnection, credential: string) => void | Promise<void>;
}
/**
* Creates the {@link CalendarPort} on Microsoft Graph (v1.0) with OAuth 2.0 against the Microsoft
* identity platform, using plain `fetch`.
*
* Scopes are {@link OUTLOOK_CALENDAR_SCOPES}. The credential of a {@link CalendarConnection} is
* the Rep's refresh token; access tokens are short-lived, held in a bounded in-process cache and
* refreshed when they near expiry. A token request Microsoft refuses with `invalid_grant`, and a
* 401 that survives one token refresh, are `calendar.revoked`: the Rep must connect again.
*
* Busy times are the Rep's `calendarView` of the range, following `@odata.nextLink` (only links
* on Graph's own host), counting every state except free and working-elsewhere as busy; titles
* are never selected. Every HTTP request has its own time limit and each call an overall deadline
* that aborts the request; a network error, 429, 5xx and Graph's throttling codes are retried a
* bounded number of times with jittered backoff, any other failure never, and `connect` never.
*
* Writes are idempotent by request id. `createEvent` sends a hash of the connection and request
* id as Graph's `transactionId`, so a repeat (a retry after a lost response, or a replay) gets the
* first event back instead of a second one. An event Graph reports as created more than 5 s before
* the attempt began is a replay: it is read back and its fingerprint (a single-value extended
* property) compared, so a different event under the same id is refused, and `created` is false.
* A replay inside that 5 s skew window is reported `created: true` (one event exists either way). `updateEvent`
* keeps the last request id and change fingerprint the same way (a late replay of an older update
* is applied again, not recognised).
*
* Microsoft has no call that revokes one refresh token (only all of a user's sign-in sessions,
* which would sign the Rep out everywhere, so it is not used). `revoke` therefore validates the
* request and drops the cached access token, nothing more: it keeps no revoked state, in this
* process or at Microsoft. Core deleting the stored credential is what ends access, and the Rep
* can withdraw the app's access in their Microsoft account (later refreshes then fail with
* `calendar.revoked`).
*
* Microsoft rotates the refresh token. When a token answer carries a new one, it is used for later
* refreshes in this process and handed to `onCredentialRotated`, which core must use to replace the
* stored credential. `Retry-After` on a 429 or 5xx (seconds or an HTTP date, at most 60 s) replaces
* the computed backoff for that retry; the retry count and the call's deadline still bound it.
*
* Nothing is logged but retry metadata, and no token, title, note, address or URL is put in an
* error, a log line or a report. Text Graph returns is data.
*/
declare function createOutlookCalendar(options: OutlookCalendarOptions): CalendarPort;
/** The header that carries a call's idempotency key. */
declare const INTERNAL_IDEMPOTENCY_HEADER = "Idempotency-Key";
/** The default bound on one attempt, connecting to the last byte of the answer. */
declare const INTERNAL_DEFAULT_TIMEOUT_MS = 5e3;
/** The default most connections one client keeps open to its receiver; calls beyond it queue. */
declare const INTERNAL_DEFAULT_MAX_SOCKETS = 32;
/** The default most idle connections one client keeps for reuse. */
declare const INTERNAL_DEFAULT_MAX_FREE_SOCKETS = 8;
/**
* The default time an idle connection is kept before the client closes it. It is below the 5 s
* keep-alive timeout of a Node `http` server (and of Bun's, which is 10 s), and far below a load
* balancer's (60 s on an AWS ALB, 75 s on nginx), so the client, not the server, ends an idle
* connection and a reused one is rarely dead.
*/
declare const INTERNAL_DEFAULT_IDLE_TIMEOUT_MS = 4e3;
/** The default largest answer that is read; a longer one fails the call, it is not truncated. */
declare const INTERNAL_DEFAULT_MAX_RESPONSE_BYTES: number;
/** The largest request body the client will send. */
declare const INTERNAL_MAX_REQUEST_BYTES: number;
/** The default retry policy of {@link createInternalClient}. */
declare const INTERNAL_DEFAULT_RETRY: {
	readonly maxAttempts: 3;
	readonly baseDelayMs: 100;
	readonly maxDelayMs: 2000;
	readonly retryAfterCapMs: 5000;
};
/** The statuses an idempotent call is retried on. Other statuses are answers, not faults. */
declare const INTERNAL_RETRY_STATUSES: readonly number[];
/**
* Every way {@link InternalClient.request} can reject. `response_invalid` is a 2xx answer whose
* non-empty body is not JSON (an HTML error or login page); it is never retried.
* `stale_connection` is a kept connection that the receiver had already closed: the write failed
* with `ECONNRESET` or `EPIPE` before any byte of an answer. The request may or may not have
* reached the receiver, so it is retried only like a `connection` failure (a safe method or an
* idempotency key), at once on a fresh connection; otherwise the caller sees it and decides.
*/
declare const INTERNAL_CALL_FAILURES: readonly ["connection", "stale_connection", "timeout", "aborted", "redirect", "response_too_large", "response_invalid"];
/** The most attempts a call may be given, the first included. */
declare const INTERNAL_MAX_ATTEMPTS = 10;
/** The HTTP methods the client sends. */
type InternalMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
/** Why an internal call produced no usable answer. */
type InternalCallFailure = (typeof INTERNAL_CALL_FAILURES)[number];
/**
* An internal call that produced no answer. The message is fixed text plus the method, path (no
* query), status and attempt count; the secret, the request body, the response body and the
* underlying error are never kept, so nothing here can leak them into a log.
*/
declare class InternalCallError extends Error {
	readonly failure: InternalCallFailure;
	readonly method: string;
	readonly path: string;
	readonly status: number | undefined;
	readonly attempts: number;
	constructor(init: {
		failure: InternalCallFailure;
		method: string;
		path: string;
		status?: number;
		attempts: number;
	});
}
/** How a call is retried. Every field has a default in {@link INTERNAL_DEFAULT_RETRY}. */
type InternalRetryPolicy = {
	/** Attempts in all, the first included: an integer from 1 to {@link INTERNAL_MAX_ATTEMPTS}. */
	maxAttempts?: number;
	/** The first pause's ceiling; each later pause doubles it, up to `maxDelayMs`. */
	baseDelayMs?: number;
	/** The largest ceiling of a jittered pause. */
	maxDelayMs?: number;
	/** The longest a `Retry-After` of seconds is honoured; a larger one is cut to this. */
	retryAfterCapMs?: number;
};
/** Options for {@link createInternalClient}. */
type InternalClientOptions = {
	/** The receiver's origin, `http` or `https`, with no userinfo, query or fragment. */
	baseUrl: string;
	/** The shared secret sent as `Authorization: Bearer`. Never logged or put in an error. */
	secret: string;
	/** Where this deployment runs; plain `http` to a non-loopback host is allowed only in `local`. */
	environment: Environment;
	/** The caller's name, sent as `User-Agent`. */
	userAgent?: string;
	/** One attempt's bound; defaults to {@link INTERNAL_DEFAULT_TIMEOUT_MS}. */
	timeoutMs?: number;
	/** The largest answer read; defaults to {@link INTERNAL_DEFAULT_MAX_RESPONSE_BYTES}. */
	maxResponseBytes?: number;
	/**
	* Reuse connections (keep-alive). Off by default: every call then opens its own connection,
	* as in 0.6, with no queue and no `stale_connection`. Turning it on changes how a service
	* behaves under load and when a receiver restarts, so it is a decision for the consumer,
	* made after measuring (`bench/internal.bench.ts`). The three options below are valid only
	* when this is `true`; passing one without it is a `TypeError`.
	*/
	keepAlive?: boolean;
	/**
	* The most connections kept open to the receiver at once: an integer of 1 or more; defaults to
	* {@link INTERNAL_DEFAULT_MAX_SOCKETS}. A call beyond it waits for a free one, and the wait
	* counts against its timeout; it never opens another connection.
	*/
	maxSockets?: number;
	/**
	* The most idle connections kept for reuse: an integer from 1 to `maxSockets` (Bun treats 0 as no limit, so 0 is
	* refused); defaults to {@link INTERNAL_DEFAULT_MAX_FREE_SOCKETS} or `maxSockets` if that is smaller.
	*/
	maxFreeSockets?: number;
	/** How long an idle connection is kept; defaults to {@link INTERNAL_DEFAULT_IDLE_TIMEOUT_MS}. */
	idleTimeoutMs?: number;
	/** The retry policy; see {@link InternalRetryPolicy}. */
	retry?: InternalRetryPolicy;
	/** Extra certificate authority (PEM) to trust besides the system's. Verification stays on. */
	ca?: string;
	/** Where a retry is noted: fixed words, a status or failure kind and an attempt number only. */
	logger?: Pick<Logger, "warn">;
	/** Injected for tests; defaults to a timer. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** Injected for tests; a number in `[0, 1)`; defaults to `Math.random`. */
	random?: () => number;
};
/** One call. */
type InternalRequest = {
	method: InternalMethod;
	/** Starts with `/`; it is appended to the base URL. A query string is allowed. */
	path: string;
	/** Sent as JSON. Not allowed on `GET` and `HEAD`. */
	body?: unknown;
	/** Extra headers; `Authorization`, `Host` and the like are the client's and are refused. */
	headers?: Record<string, string>;
	/** Sent as `Idempotency-Key`, and makes a `POST` or `PATCH` safe to retry. */
	idempotencyKey?: string;
	/** This call's attempt bound instead of the client's. */
	timeoutMs?: number;
	/** Stops the call, retries and pauses included. */
	signal?: AbortSignal;
};
/** What came back: the status, and the body parsed as JSON when it was JSON. */
type InternalResponse = {
	status: number;
	/** The parsed body, or `undefined` when it was empty, or not JSON on a non-2xx answer. */
	json: unknown;
	/** Attempts made, the first included. */
	attempts: number;
	/**
	* The answer's `Retry-After` in milliseconds, when the header was whole seconds (1 to 9 digits;
	* the date form is ignored). It is not capped: the client's own retry cuts it at `retryAfterCapMs`,
	* but this is the server's number, and the caller applies its own cap. Absent when there was no
	* such header. No other header is exposed.
	*/
	retryAfterMs?: number;
};
/** A client for calls from one Closeline service to another. */
interface InternalClient {
	/**
	* Sends the call and resolves with any answer that was not a redirect, including 4xx and 5xx.
	* Rejects with {@link InternalCallError} when there is none. Retries only a connection failure,
	* a timeout, 429, 502, 503 and 504, and only when the method is idempotent or a key is given.
	*/
	request(call: InternalRequest): Promise<InternalResponse>;
	/**
	* Closes every connection this client holds, fails calls in flight or waiting for a connection
	* with `aborted`, and refuses later calls with a `TypeError`. Safe to call more than once. A
	* process need not call it to exit (idle connections do not hold it open), but a test or a
	* graceful shutdown should.
	*/
	close(): void;
}
/**
* Builds the client for calls from this service to one other service (ADR 0013).
*
* It uses `node:http` and `node:https` with its own `Agent`, never `fetch`: Bun's `fetch` sends a
* request to the proxy named by `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` (and their lower-case
* forms) unless `NO_PROXY` names the host, and the bearer secret would travel with it. The
* `node:` transport reads no proxy variable, so nothing in the environment can reroute a call.
* `proxy.test.ts` pins this for the Bun version in use.
*
* By default every call opens its own connection (`agent: false`). With `keepAlive: true`
* connections are reused: the client owns one private keep-alive `Agent` (never the global one,
* never one passed in; an `Agent` reads no proxy variable either, which the probe checks over
* several calls on one client), capped at `maxSockets`
* connections with `maxFreeSockets` kept idle for `idleTimeoutMs`. The cap is enforced by the
* client's own queue, so a call waiting for a connection is bounded by its timeout and an aborted
* one never reaches the wire. Two clients share nothing. A kept connection the receiver closed
* fails as `stale_connection` (see {@link INTERNAL_CALL_FAILURES}). Call `close()` to end them.
* Memory is bounded by `maxResponseBytes`. Redirects are never followed. TLS
* certificates are verified: every https request sets `rejectUnauthorized: true` itself, so
* `NODE_TLS_REJECT_UNAUTHORIZED=0` has no effect on it, and the client is not built at all
* while that variable is `0` outside `local`. `NODE_EXTRA_CA_CERTS` still adds trusted
* authorities, as it does for every process; that is an operator's choice, not a way to skip checks.
*/
declare function createInternalClient(options: InternalClientOptions): InternalClient;
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
/** The denial of a check that was not answered in time, or not at all (no logged check). */
declare const CONTACT_UNAVAILABLE: ContactGuardResult;
/** Whether `request` is a well-formed Contact Check body once the caller is named. */
declare function isContactGuardRequest(request: unknown, caller: string): boolean;
/** The request as the wire body: the caller added to a copy, never to the caller's object. */
declare function withCaller(request: unknown, caller: string): unknown;
/** The bound on one attempt of a Contact Check, in milliseconds (ADR 0021). */
declare const CONTACT_GUARD_TIMEOUT_MS = 500;
/** The base of the pause before the one retry; the pause is jittered between half and one and a half of it. */
declare const CONTACT_GUARD_RETRY_DELAY_MS = 50;
/** Options for {@link createHttpContactGuard}. There is deliberately no option that turns the check off. */
type HttpContactGuardOptions = Pick<InternalClientOptions, "baseUrl" | "secret" | "environment" | "ca" | "keepAlive"> & {
	/** The calling service's name, such as `voice` or `outbound`: lower-case letters, digits, `_` and `-`. */
	caller: string;
	/** Where failures are noted: fixed words, a failure kind, a status and counts only. */
	logger: Pick<Logger, "warn">;
	/** Injected for tests; the pause before the retry. */
	sleep?: Sleep;
	/** Injected for tests; a number in `[0, 1)`. */
	random?: () => number;
};
/** A {@link ContactGuard} that can release its connections. */
interface HttpContactGuard extends ContactGuard {
	/** Closes the connections the guard holds; safe to call more than once. */
	close(): void;
}
/**
* Builds a {@link ContactGuard} that asks core's internal Contact Check over HTTP with the shared
* secret the kit's other internal calls use (ADR 0013). Each attempt is bounded at 500 ms and a
* timeout, a network error or a 5xx is tried once more after a jittered pause. It fails closed: if
* both attempts fail, or the answer is not a valid result, the guard answers denied with
* `consent.unavailable`. A denial from core is passed through as it came. Logs carry fixed words,
* the failure kind, a status, the channel and the purpose; never the secret, an address or a body.
*/
declare function createHttpContactGuard(options: HttpContactGuardOptions): HttpContactGuard;
/**
* `fetch` for adapters that send credentials, and it never uses a proxy named in the environment
* (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and their lower-case forms). Bun's `fetch` follows
* them, and Bun 1.4.2 has no per-request opt-out (`proxy: false` arrived in 1.4.3), so this goes
* through `node:http(s)` with `agent: false`, which reads no proxy variable. `proxy.test.ts` pins it.
* It takes string, `URLSearchParams` or byte bodies, answers uncompressed (no `Accept-Encoding`),
* and follows redirects itself only for `redirect: 'follow'`, dropping credentials on a new origin.
*/
declare function directFetch(input: string, init?: RequestInit): Promise<Response>;
/** The `area.reason` codes the language model port and adapters throw. */
declare const LLM_ERROR_CODES: {
	/** The Organization id, tier, messages, schema, limits or retry policy are not acceptable. Nothing was sent to the vendor. */
	readonly invalidRequest: "llm.invalid_request";
	/** The prompt is longer than the request's input token budget. Nothing was sent to the vendor. */
	readonly inputTooLarge: "llm.input_too_large";
	/** The model's output is not valid for the schema, or was cut off by the output token budget. Never a partial value. */
	readonly invalidOutput: "llm.invalid_output";
	/** The time limit passed; the underlying request was aborted. */
	readonly timeout: "llm.timeout";
	/** The caller's own AbortSignal fired; the underlying request was aborted. */
	readonly aborted: "llm.aborted";
	/** The vendor refused for a reason a retry cannot fix (credentials, quota, terms, content policy). */
	readonly rejected: "llm.rejected";
	/** The vendor could not be reached, was throttled or failed, after the bounded retries. The only retryable code. */
	readonly unavailable: "llm.unavailable";
	/** The vendor sent something this adapter cannot use. */
	readonly badResponse: "llm.bad_response";
};
/** One of {@link LLM_ERROR_CODES}'s values. */
type LlmErrorCode = (typeof LLM_ERROR_CODES)[keyof typeof LLM_ERROR_CODES];
/**
* What a language model adapter throws. Its message and details never hold a prompt, a
* completion, a credential or a vendor URL; model output is described by counts and codes only.
*/
declare class LlmError extends AppError {
	readonly code: LlmErrorCode;
	constructor(code: LlmErrorCode, message: string, options?: {
		cause?: unknown;
		details?: Record<string, unknown>;
	});
}
import { OrganizationId as OrganizationId5 } from "tula-closeline-contract";
import { z as z5 } from "zod";
/** The default time a call may take, in milliseconds. */
declare const DEFAULT_LLM_TIMEOUT_MS = 15e3;
/** The longest time a caller may allow a call, in milliseconds. */
declare const MAX_LLM_TIMEOUT_MS = 12e4;
/** The default input token budget. */
declare const DEFAULT_LLM_MAX_INPUT_TOKENS = 16e3;
/** The largest input token budget a caller may ask for. */
declare const MAX_LLM_MAX_INPUT_TOKENS = 2e5;
/** The default output token budget. */
declare const DEFAULT_LLM_MAX_OUTPUT_TOKENS = 1024;
/** The largest output token budget a caller may ask for. */
declare const MAX_LLM_MAX_OUTPUT_TOKENS = 8192;
/** The most messages one request may carry. */
declare const MAX_LLM_MESSAGES = 100;
/**
* The model class a caller wants, never a vendor model id: `fast` for the live loop (low latency,
* short answers) and `smart` for work that can wait longer for a better answer. An adapter maps
* each tier to the model ids it uses.
*/
type ModelTier = "fast" | "smart";
/** Every {@link ModelTier}. */
declare const MODEL_TIERS: readonly ModelTier[];
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
	organizationId: OrganizationId5;
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
interface LlmCompleteRequest<S extends z5.ZodType = z5.ZodType> extends LlmRequestBase {
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
	complete<S extends z5.ZodType>(request: LlmCompleteRequest<S>): Promise<LlmCompletion<z5.output<S>>>;
	/**
	* Streams free text. An unacceptable request throws `llm.invalid_request` or
	* `llm.input_too_large` from this call; every later failure is thrown from the iteration. The
	* stream ends with one `done` event. Leaving the loop early (`break`) aborts the vendor
	* request. The time limit covers the whole stream.
	*/
	stream(request: LlmStreamRequest): AsyncIterable<LlmStreamEvent>;
}
/** The characters one token is assumed to hold when estimating, low on purpose so the estimate runs high. */
declare const ESTIMATED_CHARS_PER_TOKEN = 3;
/**
* A conservative token estimate for `text` (never below the real count for ordinary prose), used
* for the input budget before a call and by the memory adapter. An adapter prefers the vendor's
* own count for usage.
*/
declare function estimateTokens(text: string): number;
/** The retry policy with its defaults filled in. */
interface ResolvedLlmRetryPolicy {
	/** The most retries after the first attempt. */
	maxRetries: number;
	/** The base pause, in ms. */
	baseDelayMs: number;
	/** The longest pause before jitter, in ms. */
	maxDelayMs: number;
}
/** The policy used when a request names none: two retries, 200 ms doubling to 2 s. */
declare const DEFAULT_LLM_RETRY_POLICY: ResolvedLlmRetryPolicy;
/**
* The pause before retry `retry` (from 1): the base doubled each time up to the maximum, then
* scaled by a jitter between 0.5 and 1.5 from `random()` (a number in `[0, 1)`).
*/
declare function llmRetryDelayMs(retry: number, policy: ResolvedLlmRetryPolicy, random?: () => number): number;
/** The `area.reason` codes the messaging port and adapters throw. */
declare const MESSAGING_ERROR_CODES: {
	/** The Organization, Prospect, number, content, key, limits or retry policy are not acceptable. Nothing was sent. */
	readonly invalidRequest: "messaging.invalid_request";
	/** The Contact Check did not allow the message (ADR 0003); `details.code` is the `consent.*` code. Nothing was sent. */
	readonly consentDenied: "messaging.consent_denied";
	/** The provider says the recipient texted STOP to this sender, so it will not deliver. Not retryable. */
	readonly recipientOptedOut: "messaging.recipient_opted_out";
	/** A WhatsApp free-form message is outside the 24 hour window; only a template can start the conversation. */
	readonly templateRequired: "messaging.template_required";
	/** The overall deadline passed; the underlying request was aborted. */
	readonly timeout: "messaging.timeout";
	/** The caller's own AbortSignal fired; the underlying request was aborted. */
	readonly aborted: "messaging.aborted";
	/** The provider refused for a reason a retry cannot fix (credentials, quota, a bad number). */
	readonly rejected: "messaging.rejected";
	/** The provider could not be reached, was throttled or failed. The only retryable code. */
	readonly unavailable: "messaging.unavailable";
	/** The provider sent something this adapter cannot use. */
	readonly badResponse: "messaging.bad_response";
	/** A webhook has a wrong, missing or unverifiable signature, or a body that is not a message event. */
	readonly webhookInvalid: "messaging.webhook_invalid";
};
/** One of {@link MESSAGING_ERROR_CODES}'s values. */
type MessagingErrorCode = (typeof MESSAGING_ERROR_CODES)[keyof typeof MESSAGING_ERROR_CODES];
/**
* What a messaging adapter throws. Its message is fixed text and its details hold only field
* names, counts, codes, an HTTP status and the provider's numeric error code: never a message
* body, a phone number, a URL, a signature or a credential.
*/
declare class MessagingError extends AppError {
	readonly code: MessagingErrorCode;
	constructor(code: MessagingErrorCode, message: string, options?: {
		cause?: unknown;
		details?: Record<string, unknown>;
	});
}
/** True for the errors that mean the provider or an adapter failed, which are given to the ErrorReporter. */
declare function isReportableMessagingError(error: unknown): error is MessagingError;
import { ContactCheckId, OrganizationId as OrganizationId6, ProspectId } from "tula-closeline-contract";
/** The default overall deadline of one send, retries included, in milliseconds. */
declare const DEFAULT_MESSAGING_TIMEOUT_MS = 1e4;
/** The longest overall deadline a caller may allow, in milliseconds. */
declare const MAX_MESSAGING_TIMEOUT_MS = 6e4;
/** The most characters of a text message body (Twilio's limit). */
declare const MAX_MESSAGE_BODY_CHARS = 1600;
/** The most variables one template message may carry. */
declare const MAX_TEMPLATE_VARIABLES = 20;
/** The most characters of one template variable value. */
declare const MAX_TEMPLATE_VARIABLE_CHARS = 1024;
/** The most bytes of a webhook body {@link MessagingPort.receive} reads; a longer body is refused. */
declare const MAX_MESSAGING_WEBHOOK_BYTES = 262144;
/** The channels a message can be sent on. */
declare const MESSAGING_CHANNELS: readonly ["sms", "whatsapp"];
/** One of {@link MESSAGING_CHANNELS}. */
type MessagingChannel = (typeof MESSAGING_CHANNELS)[number];
/** Why a message is sent; the Contact Check decides on it. A Rep's own message is not sent through this port. */
declare const MESSAGING_PURPOSES: readonly ["agent_initiated", "reply"];
/** One of {@link MESSAGING_PURPOSES}. */
type MessagingPurpose = (typeof MESSAGING_PURPOSES)[number];
/** How an adapter retries a retryable provider error (`messaging.unavailable`). */
interface MessagingRetryPolicy {
	/** The most retries after the first attempt, 0 to 5; 0 never retries. Default 2. */
	maxRetries?: number;
	/** The base of the pause before a retry, in ms, 1 to 60000; doubled each time and jittered. Default 200. */
	baseDelayMs?: number;
	/** The longest pause before a retry, in ms, before jitter, at least the base and at most 60000. Default 2000. */
	maxDelayMs?: number;
}
/** The retry policy with its defaults filled in. */
interface ResolvedMessagingRetryPolicy {
	/** The most retries after the first attempt. */
	maxRetries: number;
	/** The base pause, in ms. */
	baseDelayMs: number;
	/** The longest pause before jitter, in ms. */
	maxDelayMs: number;
}
/** The policy used when a request names none: two retries after about 200 ms and 400 ms. */
declare const DEFAULT_MESSAGING_RETRY_POLICY: ResolvedMessagingRetryPolicy;
/**
* The pause before retry `retry` (from 1): the base doubled each time up to the maximum, then
* scaled by a jitter between 0.5 and 1.5 from `random()` (a number in `[0, 1)`).
*/
declare function messagingRetryDelayMs(retry: number, policy: ResolvedMessagingRetryPolicy, random?: () => number): number;
/** What a message says: free text, or an approved template (WhatsApp only). */
type MessageContent = {
	/** Free text. */
	kind: "text";
	/** The text, 1 to {@link MAX_MESSAGE_BODY_CHARS} characters. Tenant data: never logged. */
	body: string;
} | {
	/** An approved template; the only way to start a WhatsApp conversation outside the 24 hour window. */
	kind: "template";
	/** The template's Twilio Content SID: `HX` and 32 hex digits. */
	templateId: string;
	/** The template's variables by name or position, at most {@link MAX_TEMPLATE_VARIABLES}. Tenant data: never logged. */
	variables?: Readonly<Record<string, string>>;
};
/**
* One message to send. There is no field that skips or replaces the Contact Check: the adapter
* asks its `ContactGuard` once, about (`organizationId`, `prospectId`, `phone: to`, `channel`,
* `purpose`), on every call, and an unknown field is refused. The check binds `to` to the
* Prospect's stored identities, so a number that is not the Prospect's is `consent.missing`, and a
* suppressed number is not texted even when the Prospect is allowed.
*/
interface SendMessageRequest {
	/** The Organization the message is sent for. */
	organizationId: OrganizationId6;
	/** The Prospect the message is for; one Contact Check is about this Prospect, one about `to`. */
	prospectId: ProspectId;
	/** SMS or WhatsApp. */
	channel: MessagingChannel;
	/** Why it is sent. */
	purpose: MessagingPurpose;
	/** The recipient's number, E.164. Never logged. */
	to: string;
	/** What to say. */
	content: MessageContent;
	/**
	* Makes a retry, or a repeat of this call, send one message only: 1 to 200 characters of
	* `A-Z a-z 0-9 _ . : -`, unique per message you mean to send. The Twilio adapter sends a keyed
	* hash of it (with the Organization) as `I-Twilio-Idempotency-Token`; the memory adapter
	* returns the first result for a repeat and refuses the same key with other content.
	*/
	idempotencyKey: string;
	/** The most time the whole send may take, retries included, in ms, 1 to 60000; default 10000. */
	timeoutMs?: number;
	/** Retries of `messaging.unavailable`; the defaults when absent. */
	retry?: MessagingRetryPolicy;
	/** The caller's own cancellation. When it fires the provider request is aborted and the send fails with `messaging.aborted`. */
	signal?: AbortSignal;
}
/** What a send returns: the provider accepted the message. Delivery is reported later as a status event. */
interface SentMessage {
	/** The id of the one Contact Check, about the Prospect and the number together, that allowed this message: proof of consent (ADR 0003). */
	consentCheckId: ContactCheckId;
	/** The same id as `consentCheckId`, kept so existing readers work: there is one check per send now. */
	numberConsentCheckId: ContactCheckId;
	/** The provider's id for the message; a status event names the same id. */
	providerMessageId: string;
	/** The channel it went on. */
	channel: MessagingChannel;
	/** `queued` when the provider has taken it, `sent` when it has already left the provider. */
	status: "queued" | "sent";
	/** The key the send was made with. */
	idempotencyKey: string;
}
/** What a recipient's text means to the sender, from Twilio's standard English keywords. */
type MessageIntent = "stop" | "start" | "help" | "message";
/** The fields of an {@link InboundMessage}. */
interface InboundMessageFields {
	/** The channel it arrived on. */
	channel: MessagingChannel;
	/** The sender's number, E.164 (any `whatsapp:` prefix removed). */
	from: string;
	/** Our number, E.164. */
	to: string;
	/** The provider's id for the message. */
	providerMessageId: string;
	/** The text. May be empty when only media was sent. */
	body: string;
	/** When the adapter received it, ISO 8601. */
	receivedAt: string;
	/** What the text means; see {@link classifyMessageIntent}. */
	intent: MessageIntent;
	/** How many media items came with it (they are not fetched). */
	mediaCount: number;
}
/**
* A message the recipient sent. Its `body`, `from` and `to` are tenant data: they are read
* properties of the class (not own enumerable ones), so `String()`, `JSON.stringify`, a spread
* and `util.inspect` show the channel, intent and id, and the length of the text, never the text
* or the numbers.
*/
declare class InboundMessage {
	private;
	readonly kind: "message";
	readonly channel: MessagingChannel;
	readonly providerMessageId: string;
	readonly receivedAt: string;
	readonly intent: MessageIntent;
	readonly mediaCount: number;
	constructor(fields: InboundMessageFields);
	/** The sender's number, E.164. */
	get from(): string;
	/** Our number, E.164. */
	get to(): string;
	/** The text the recipient sent. */
	get body(): string;
	/** The metadata for `JSON.stringify`: no text and no numbers. */
	toJSON(): Record<string, unknown>;
	/** A readable label without the text or the numbers. */
	toString(): string;
}
/** The state of a message the provider reports on. */
type MessageDeliveryStatus = "queued" | "sent" | "delivered" | "undelivered" | "failed" | "read";
/** The provider reporting how a message it took is doing. Carries no text and no numbers. */
interface StatusEvent {
	/** Tells a status event from a message. */
	kind: "status";
	/** The id a send returned. */
	providerMessageId: string;
	/** The state. */
	status: MessageDeliveryStatus;
	/** The provider's numeric error code, present on `failed` and `undelivered`. */
	errorCode?: number;
}
/** What a verified webhook carries: a message from a recipient, or a status report. */
type InboundEvent = InboundMessage | StatusEvent;
/** A webhook as the HTTP route received it. */
interface MessagingWebhookRequest {
	/** The full URL the provider called, as the provider saw it (a proxy may have rewritten it). */
	url: string;
	/** The `X-Twilio-Signature` header, or null/undefined when the request had none. */
	signature: string | null | undefined;
	/** The raw form body, unparsed, at most {@link MAX_MESSAGING_WEBHOOK_BYTES} bytes. */
	body: string;
	/** The `Content-Type` header, when known; if given it must be a form. */
	contentType?: string | null | undefined;
}
/**
* SMS and WhatsApp messaging behind a vendor (Twilio first), with the consent proof built in.
*
* **Consent (ADR 0003).** Every adapter is built with a `ContactGuard` and has no way to run
* without one. `send` asks it first, every time, about the Prospect and the number together, which the
* check binds (a number that is not the Prospect's is `consent.missing`); only an
* `allowed: true` answer lets a request reach the vendor, and asking counts against the send's
* deadline. Any denial, including `consent.unavailable`, throws `messaging.consent_denied` with the
* `consent.*` code in `details.code`, and the vendor is not called. A sent message returns the
* check's id as `consentCheckId` (and as `numberConsentCheckId`).
*
* **STOP.** `receive` reports a recipient's STOP as an `InboundMessage` with `intent: 'stop'`
* (the whole text, ignoring case, spaces, punctuation, emoji and invisible characters, is one of Twilio's keywords). The port does not
* revoke consent, because the kit has no way to write to core: the consumer must withdraw the
* Prospect's consent through core when it sees `intent: 'stop'`. Twilio also blocks further sends
* to that number by itself, which shows as `messaging.recipient_opted_out`.
*
* Every send has an overall deadline that aborts the vendor request. `messaging.unavailable` is
* retried with a bounded, jittered pause and the same idempotency key, so a retry never texts
* twice. `rejected`, `unavailable` and `bad_response` are also given to the ErrorReporter
* (metadata only). The message text, the numbers and the credentials are tenant data or secrets:
* they are never logged, reported or put in an error.
*
* Webhooks can arrive more than once: the consumer must handle them idempotently, keyed on
* `providerMessageId` (with the status for a status event).
*/
interface MessagingPort {
	/**
	* Sends one message once the Contact Check allows it. An unacceptable request throws
	* `messaging.invalid_request` and a denial `messaging.consent_denied`; neither reaches the vendor.
	*/
	send(request: SendMessageRequest): Promise<SentMessage>;
	/**
	* Verifies a webhook by its signature, in constant time, and parses it. A missing or wrong
	* signature, a body over {@link MAX_MESSAGING_WEBHOOK_BYTES}, a body that is not a form or not a
	* message or status event, is `messaging.webhook_invalid`. Verify before using anything in it.
	*/
	receive(request: MessagingWebhookRequest): Promise<InboundEvent>;
}
/**
* Signs a webhook the way Twilio does (`X-Twilio-Signature`): HMAC-SHA1 with the Auth Token over
* the URL followed by each form field's name and value in sorted order, in base64. For tests and
* for simulating Twilio; the adapters themselves only verify.
*/
declare function signTwilioRequest(authToken: string, url: string, params?: Readonly<Record<string, string>> | readonly (readonly [string, string])[]): string;
import { CallId, MembershipId, OrganizationId as OrganizationId7, SoftphoneToken, VoiceCallFailureReason } from "tula-closeline-contract";
/** The longest key, in bytes. */
declare const MAX_KEY_BYTES = 512;
/** The most `/`-separated segments a key can have. */
declare const MAX_KEY_SEGMENTS = 16;
/** The default largest object, in bytes (25 MiB). */
declare const DEFAULT_MAX_OBJECT_BYTES: number;
/** The largest `maxObjectBytes` a store can be configured with (100 MiB): bodies are held in memory. */
declare const MAX_OBJECT_BYTES_LIMIT: number;
/** The default page size of {@link ObjectStore.list}. */
declare const DEFAULT_LIST_LIMIT = 100;
/** The largest page size of {@link ObjectStore.list}. */
declare const MAX_LIST_LIMIT = 1e3;
/** The content type stored when the caller gives none. */
declare const DEFAULT_CONTENT_TYPE = "application/octet-stream";
/** The largest `maxBytes` of a streamed put (2 GiB); streamed bodies are never held whole in memory. */
declare const MAX_STREAM_BYTES_LIMIT: number;
/** The longest a presigned read may stay valid, in seconds (15 minutes). */
declare const MAX_PRESIGN_SECONDS = 900;
/** How long a presigned read stays valid when the caller gives no expiry, in seconds (5 minutes). */
declare const DEFAULT_PRESIGN_SECONDS = 300;
/** The longest a source stream may stay silent before a streamed put gives up, in ms. */
declare const STREAM_IDLE_TIMEOUT_MS = 3e4;
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
/** The default time any telephony operation may take, in milliseconds. */
declare const DEFAULT_TELEPHONY_TIMEOUT_MS = 1e4;
/** The longest time a caller may allow one telephony operation, in milliseconds. */
declare const MAX_TELEPHONY_TIMEOUT_MS = 6e4;
/** The longest Disclosure text, in characters. */
declare const MAX_DISCLOSURE_TEXT_LENGTH = 1e3;
/** The most browser legs one inbound call may ring at once. */
declare const MAX_RING_LEGS = 50;
/** The most bytes of a webhook body {@link TelephonyPort.verifyWebhook} reads; a longer body is refused. */
declare const MAX_WEBHOOK_BODY_BYTES = 262144;
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
	organizationId: OrganizationId7;
	/** The provider's id of the call leg to the Prospect: opaque, 1 to 128 of letters, digits, `.`, `_`, `:` and `-`. */
	providerCallId: string;
}
/** The call a service asks the provider to place to a Prospect. */
interface PlaceCallRequest {
	/** The Organization. */
	organizationId: OrganizationId7;
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
	organizationId: OrganizationId7;
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
	organizationId: OrganizationId7;
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
	organizationId: OrganizationId7;
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
/**
* What a telephony adapter throws. Its message never holds a phone number, a token, a signature,
* a secret, a Disclosure text or audio: those are tenant data or credentials.
*/
declare class TelephonyError extends AppError {
	readonly code: TelephonyErrorCode;
	constructor(code: TelephonyErrorCode, message: string, options?: {
		cause?: unknown;
		details?: Record<string, unknown>;
	});
}
/** The HTTP client the adapter uses: `fetch`, injected for tests. */
type TwilioFetch = (input: string, init: RequestInit) => Promise<Response>;
/** The Twilio regions this adapter knows, as Twilio names them in a host (`api.dublin.ie1.twilio.com`). */
declare const TWILIO_REGIONS: readonly ["us1", "ie1", "au1"];
/** One of {@link TWILIO_REGIONS}. */
type TwilioRegion = (typeof TWILIO_REGIONS)[number];
/** The edge Twilio serves each region from by default. */
declare const TWILIO_DEFAULT_EDGES: Readonly<Record<TwilioRegion, string>>;
/** What the adapter remembers about one provider call, since Twilio has no tag to hold it. */
interface TwilioCallRecord {
	/** The Organization the call belongs to. */
	organizationId: string;
	/** Our Call id, when known. */
	callId: string | null;
	/** Placed by us, or received. */
	direction: "outbound" | "inbound";
	/** The Disclosure that has played on the call, or null. */
	disclosure: DisclosurePlayed | null;
	/** The Rep whose browser leg the call is bridged to, or null. */
	bridgedTo: string | null;
	/** True once a Disclosure has started to play, so the hold is never sent over it. */
	disclosureStarted?: boolean;
	/** The Reps the inbound call was meant to ring. */
	ringIdentities: readonly string[];
	/** The Recording started on the call, or null. */
	recordingId: string | null;
	/** The stream forked from the call, or null. */
	streamId: string | null;
}
/** What the adapter remembers about a placement, to answer a repeated idempotency key. */
interface TwilioPlacement {
	/** The provider call the key placed. */
	providerCallId: string;
	/** A keyed hash of the numbers; a repeat with other numbers is refused. Never the numbers. */
	fingerprint: string;
}
/**
* Where the adapter keeps the Organization of each provider call, the state of its Disclosure and
* its idempotency keys. Twilio holds none of it, and the port promises that one Organization never
* reaches another's calls, so a production service must pass a durable store (Postgres, in its own
* schema). Omitting it (in process memory) is allowed only in the `local` and `dev` environments. A store that has lost
* a call fails closed: the call is `telephony.not_found`, or its Disclosure counts as not played.
*/
interface TwilioStore {
	/** Returns the record of a provider call, or null. */
	getCall(providerCallId: string): Promise<TwilioCallRecord | null>;
	/** Creates or replaces the record of a provider call. */
	putCall(providerCallId: string, record: TwilioCallRecord): Promise<void>;
	/**
	* Runs `fn` with the current record (null when there is none) while no other `withCall` for the
	* same call runs, until `fn` settles, including any Twilio request it makes. Inside `fn` use
	* `getCall`/`putCall`, never `withCall` again for that call. A durable store holds a row lock
	* (`SELECT ... FOR UPDATE`) for the duration; the memory store chains promises per call.
	*/
	withCall<T>(providerCallId: string, fn: (record: TwilioCallRecord | null) => Promise<T>): Promise<T>;
	/**
	* Atomically creates the record when none exists and returns the record that now stands, which
	* is the caller's own when it won and the earlier one when it lost.
	*/
	claimCall(providerCallId: string, record: TwilioCallRecord): Promise<TwilioCallRecord>;
	/** Returns the provider call a Recording belongs to, or null. */
	getRecording(recordingId: string): Promise<{
		providerCallId: string;
	} | null>;
	/** Remembers which provider call a Recording belongs to. */
	putRecording(recordingId: string, providerCallId: string): Promise<void>;
	/** Returns the placement an idempotency key made, or null. */
	getPlacement(organizationId: string, key: string): Promise<TwilioPlacement | null>;
	/** Remembers a placement. */
	putPlacement(organizationId: string, key: string, placement: TwilioPlacement): Promise<void>;
}
/** Creates the in-process {@link TwilioStore}, for tests and local runs. */
declare function createMemoryTwilioStore(): TwilioStore;
/** What {@link TwilioOptions.disclosureDone} is told about the Disclosure it waits for. */
interface DisclosureWait {
	/** The Organization. */
	organizationId: string;
	/** The provider call. */
	providerCallId: string;
	/** When the wait must give up, as ms since the epoch. */
	deadline: number;
}
/** Options for {@link createTwilioTelephony}. */
interface TwilioOptions {
	/** The Account SID (`AC` and 32 hex digits). */
	accountSid: string;
	/** An API key's SID (`SK` and 32 hex digits): signs requests and Softphone tokens. */
	apiKeySid: string;
	/** The API key's secret. A credential: never logged or put in an error. */
	apiKeySecret: string;
	/**
	* The Auth Token, used only to check webhook signatures. Twilio signs webhooks with it and not
	* with an API key's secret. Without it `verifyWebhook` is always false.
	*/
	authToken?: string;
	/** The TwiML App's SID (`AP` and 32 hex digits) the Softphone dials out through. */
	twimlAppSid: string;
	/**
	* The Twilio region, such as `ie1` for Ireland. Needs API keys made in that region. Default is
	* the US default host `api.twilio.com`.
	*/
	region?: TwilioRegion;
	/** The edge, such as `dublin`; default is the region's own edge. Needs `region`. */
	edge?: string;
	/** The `ENVIRONMENT`; a `ws:` fork destination is accepted only in `local`; default `prod`. */
	environment?: Environment;
	/** Where Twilio reports call progress; the adapter adds `organizationId` and `callId` to the query. */
	statusCallbackUrl?: string;
	/** Where Twilio reports a finished Recording; the adapter adds `organizationId` and `callId`. */
	recordingStatusCallbackUrl?: string;
	/** The store of per-call state; required outside `local` and `dev`, where it is in memory. */
	store?: TwilioStore;
	/** The `fetch` to use; the global one by default. */
	fetch?: TwilioFetch;
	/** Waits between retries; real time by default. */
	sleep?: Sleep;
	/** A number in `[0, 1)` for retry jitter; `Math.random` by default. */
	random?: () => number;
	/** The clock for token and Disclosure times; the system clock by default. */
	clock?: Clock;
	/** The wall clock in ms for deadlines; `Date.now` by default. */
	nowMs?: () => number;
	/** The timeout of an operation that names none, in ms; default {@link DEFAULT_TELEPHONY_TIMEOUT_MS}. */
	defaultTimeoutMs?: number;
	/** The most attempts per request, the first included; default 3. */
	maxAttempts?: number;
	/** The language the Disclosure is spoken in, such as `en-US`; default `en-US`. */
	disclosureLanguage?: string;
	/**
	* Resolves when the Disclosure has finished playing. Twilio has no "finished speaking" event on
	* a REST update, so by default the adapter waits for an estimate of how long the wording takes
	* (see {@link estimateSpeechMs}). A service with a webhook for it passes a hook that waits for
	* that instead; the hook must throw `telephony.unavailable` if the deadline passes.
	*/
	disclosureDone?: (wait: DisclosureWait) => Promise<void>;
}
/**
* How long a Disclosure takes to speak, in ms: 0.4 s a word, a quarter more for safety, and a
* second for the call to start speaking. It deliberately errs long: waiting too long delays the
* Rep a moment, but bridging too early would let the Rep talk over the Disclosure.
*/
declare function estimateSpeechMs(text: string): number;
/** The host Twilio's REST API is called on for a region and edge. */
declare function twilioApiHost(region?: TwilioRegion, edge?: string): string;
/**
* Creates the {@link TelephonyPort} on Twilio: Programmable Voice over REST and TwiML, a Voice SDK
* access token, dual-channel Recordings and a Media Streams fork. Every request has a timeout and
* a bounded, jittered retry on network errors, 429 and 5xx (never on another 4xx); an operation
* as a whole is bounded by its `timeoutMs`. Nothing is logged, and no number, Disclosure text,
* token, signature, secret or Recording URL is put in an error.
*
* The Disclosure rules are the shared ones (`requireDisclosure`): the adapter refuses to bridge,
* record or fork a call whose Disclosure it has not seen play. The Disclosure state lives in the
* {@link TwilioStore}.
*/
declare function createTwilioTelephony(options: TwilioOptions): TelephonyPort;
/** Options for {@link createTwilioMessaging}. The kit takes options, not environment variables. */
interface TwilioMessagingOptions {
	/** The Account SID (`AC` and 32 hex digits). */
	accountSid: string;
	/** The Auth Token, at least 16 characters: signs the REST calls and verifies webhooks. Never logged. */
	authToken: string;
	/** The Contact Check every send asks first. Required: there is no adapter without one (ADR 0003). */
	guard: ContactGuard;
	/** The Messaging Service SID (`MG` and 32 hex digits) SMS goes through; or give `fromNumber`, not both. */
	messagingServiceSid?: string;
	/** The number SMS is sent from, E.164; or give `messagingServiceSid`, not both. */
	fromNumber?: string;
	/** The approved WhatsApp sender, E.164 without the `whatsapp:` prefix. WhatsApp falls back to `messagingServiceSid`. */
	whatsappFrom?: string;
	/** An https URL Twilio reports delivery status to, without credentials. */
	statusCallbackUrl?: string;
	/** Twilio region for data residency; the global host if absent. */
	region?: TwilioRegion;
	/** Twilio edge, with `region`. */
	edge?: string;
	/** The HTTP client; the global `fetch` by default. For tests. */
	fetch?: TwilioFetch;
	/** The time limit of one HTTP attempt, in ms, 1 to 60000; default 5000. The send's own deadline still applies. */
	attemptTimeoutMs?: number;
	/** Receives the errors that mean the provider failed; nothing if absent. */
	reporter?: ErrorReporter;
	/** Where retries are noted (metadata only); nothing if absent. */
	logger?: Logger;
	/** The time source for `receivedAt`; the system clock by default. */
	clock?: Clock;
	/** Pauses between retries; real time by default. */
	sleep?: Sleep;
	/** A number in `[0, 1)` for the jitter; `Math.random` by default. */
	random?: () => number;
}
/**
* Creates the {@link MessagingPort} on Twilio's Programmable Messaging REST API (SMS and WhatsApp).
*
* Every send asks the `guard` first and reaches Twilio only when it allows. Each attempt has its
* own time limit and the whole send an overall deadline that aborts the request; a network error,
* 429 and 5xx are retried a bounded number of times with jitter and the same
* `I-Twilio-Idempotency-Token`, any other 4xx never. Twilio's 21610 (the recipient texted STOP) is
* `messaging.recipient_opted_out` and 63016 (a WhatsApp free-form message outside the 24 hour
* window) `messaging.template_required`. Nothing is logged but retry metadata, and no message
* text, number, URL, signature or credential is put in an error, a log line or a report.
*/
declare function createTwilioMessaging(options: TwilioMessagingOptions): MessagingPort;
/**
* What a recipient's text means, from Twilio's standard English keywords: the whole text, ignoring
* case, spaces, punctuation, emoji and invisible characters, so "Stop.", "stop!" and "STOP ALL"
* all opt out. STOP, STOPALL, UNSUBSCRIBE, CANCEL, END and QUIT opt out; START, UNSTOP and YES opt
* back in; HELP and INFO ask for help. A sentence that merely contains one is a message. It fails
* toward opting out. `start` is only a hint: it must never re-grant consent without the consent
* flow, and only plain ASCII letters count for it and for `help`.
*/
declare function classifyMessageIntent(body: string): MessageIntent;
/** Decides whether a string is an Organization id this deployment accepts. */
type OrganizationIdCheck = (value: string) => boolean;
/** The `area.reason` codes the queue adapters throw. */
declare const QUEUE_ERROR_CODES: {
	/** An envelope failed validation before sending. */
	readonly invalidMessage: "queue.invalid_message";
	/** A message body is over the 256 KiB limit. */
	readonly messageTooLarge: "queue.message_too_large";
	/** A batch has more than 10 messages or more than 256 KiB in total. */
	readonly batchTooLarge: "queue.batch_too_large";
	/** A call argument is outside what the queue accepts (batch size, visibility, wait). */
	readonly invalidRequest: "queue.invalid_request";
	/** The receipt is not for a message that is in flight any more. */
	readonly receiptInvalid: "queue.receipt_invalid";
	/** The queue refused the call for a reason a retry cannot fix (no such queue, access denied). */
	readonly rejected: "queue.rejected";
	/** The queue did not answer, in time or at all, after the bounded retries. */
	readonly unavailable: "queue.unavailable";
	/** The queue answered with something this adapter cannot use. */
	readonly badResponse: "queue.bad_response";
};
/** One of {@link QUEUE_ERROR_CODES}'s values. */
type QueueErrorCode = (typeof QUEUE_ERROR_CODES)[keyof typeof QUEUE_ERROR_CODES];
/** What a queue port or adapter throws. Its message never holds a message body. */
declare class QueueError extends AppError {
	readonly code: QueueErrorCode;
	constructor(code: QueueErrorCode, message: string, options?: {
		cause?: unknown;
		details?: Record<string, unknown>;
	});
}
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
/** A {@link ProcessedStore} in process memory, for tests and local runs of one instance. */
declare function createMemoryProcessedStore(options: {
	clock: Clock;
	newToken?: () => string;
}): ProcessedStore;
/**
* Picks the error reporter for a service: the Sentry adapter when a DSN is given, otherwise the
* no-op one, so `local` and tests run without Sentry. The DSN is per Region (ADR 0001): give each
* deployment the DSN of a Sentry project in its own data region; the kit sends to whatever it is given.
*/
declare function createErrorReporter(options: ErrorReporterOptions): ErrorReporter;
/** Returns the reporter that sends nothing, used when no DSN is configured; it costs one empty call. It is one shared object with no state, so `flush` after `close` is still true: there is nothing to deliver. */
declare function createNoopErrorReporter(): ErrorReporter;
/** Drops a trailing high surrogate, which a cut inside a pair leaves alone. */
declare function dropHighSurrogate(text: string): string;
/**
* Cuts text to at most `max` characters, drops a trailing partial word (it could be the front of a
* secret) and marks the cut. Text that fits is returned as it is. Work is bounded by `max`.
*/
declare function cutText(text: string, max: number): string;
/**
* Masks secrets and personal data inside free text (an error message, a log message): bearer
* tokens, JWTs and common API-key shapes, URL credentials, connection strings, the value in a
* Postgres `Key (column)=(value)` detail, the value of any `key=value` or `key: value` pair whose
* key the kit treats as sensitive (to the end of the line when unquoted, to the end of the JSON
* value after a quoted key), email addresses, telephone numbers written with a `+`, `(area code)` or
* trunk zero, and payment card numbers. An identifier (a UUID, a prefixed id, a timestamp, a
* version, a count) is never altered: where a pattern cannot tell, the text is left alone. Input
* over 32 KiB is cut. Runs in time linear in the input and never throws; if it somehow fails it
* returns a fixed placeholder.
*/
declare function scrubText(text: string): string;
/** The `area.reason` codes the object storage port and adapters throw. */
declare const STORAGE_ERROR_CODES: {
	/** An Organization id, key, prefix, cursor, content type, limit or body is not acceptable. */
	readonly invalidRequest: "storage.invalid_request";
	/** An object is over the store's size limit. */
	readonly objectTooLarge: "storage.object_too_large";
	/** The store refused the call for a reason a retry cannot fix (no such bucket, access denied). */
	readonly rejected: "storage.rejected";
	/** The store did not answer, in time or at all, after the bounded retries. The only retryable code. */
	readonly unavailable: "storage.unavailable";
	/** The store answered with something this adapter cannot use. */
	readonly badResponse: "storage.bad_response";
};
/** One of {@link STORAGE_ERROR_CODES}'s values. */
type StorageErrorCode = (typeof STORAGE_ERROR_CODES)[keyof typeof STORAGE_ERROR_CODES];
/** What an object store throws. Its message never holds an object body, a key or a URL. */
declare class StorageError extends AppError {
	readonly code: StorageErrorCode;
	constructor(code: StorageErrorCode, message: string, options?: {
		cause?: unknown;
		details?: Record<string, unknown>;
	});
}
import { CallId as CallId3, OrganizationId as OrganizationId9 } from "tula-closeline-contract";
import { CallId as CallId2, OrganizationId as OrganizationId8 } from "tula-closeline-contract";
/** The default time opening a stream may take, in milliseconds. */
declare const DEFAULT_STREAMING_TRANSCRIBE_TIMEOUT_MS = 1e4;
/** The longest time a caller may allow opening a stream, in milliseconds. */
declare const MAX_STREAMING_TRANSCRIBE_TIMEOUT_MS = 6e4;
/** The most bytes one {@link TranscribeStream.sendAudio} chunk may hold. */
declare const MAX_AUDIO_CHUNK_BYTES = 65536;
/** The most audio an adapter holds while it reconnects, in bytes; older audio is dropped first. */
declare const MAX_REPLAY_AUDIO_BYTES = 524288;
/** The most words one turn event may carry. */
declare const MAX_WORDS_PER_TURN = 2e3;
/** Which side of the Call a stream carries; the track tells the speaker, so no diarization is needed. */
type StreamTrack = "rep" | "prospect";
/** How the audio is encoded: 16-bit signed little-endian PCM, or 8-bit mu-law (telephony). */
type AudioEncoding = "pcm_s16le" | "pcm_mulaw";
/** The sample rates an adapter accepts, in Hz. */
type SampleRate = 8000 | 16000 | 24000 | 48000;
/** How an adapter retries a dropped stream. */
interface ReconnectPolicy {
	/** The most reconnect attempts after one drop, 0 to 10; 0 never reconnects. Default 5. */
	maxAttempts?: number;
	/** The base of the pause before an attempt, in ms, 1 to 60000; doubled each time and jittered. Default 250. */
	baseDelayMs?: number;
	/** The longest pause before an attempt, in ms, before jitter, at least the base and at most 60000. Default 5000. */
	maxDelayMs?: number;
}
/** One word with its timing. */
interface TranscribedWord {
	/** The word as heard. Tenant data: never logged. */
	text: string;
	/** When it starts, in ms from the start of the stream's audio (continuous across reconnects). */
	startMs: number;
	/** When it ends, in ms from the start of the stream's audio; not before `startMs`. */
	endMs: number;
	/** How sure the vendor is, 0 to 1, when it says. */
	confidence?: number;
}
/** The words heard so far in a turn, interim or settled. */
interface TurnEvent {
	/** Always `turn`. */
	type: "turn";
	/** Identifies the turn within the stream; the same for every event of one turn, never reused. */
	turnId: string;
	/** Counts the stream's turn events from 1, strictly increasing, so a consumer drops a late or repeated one. */
	sequence: number;
	/** False while the text may still change (an interim); true once it is settled (a final). */
	isFinal: boolean;
	/**
	* True when the speaker has finished the turn. Only ever on a final. After it the turn is over
	* and the next turn event has a new `turnId`. A final without it is a settled part of a turn
	* still going.
	*/
	endOfTurn: boolean;
	/** All the text of the turn so far, or of this settled part. Tenant data: never logged. */
	text: string;
	/** The words of `text` with timings, at most {@link MAX_WORDS_PER_TURN}. */
	words: readonly TranscribedWord[];
}
/** The stream lost its connection and the adapter is trying again. Carries no text. */
interface ReconnectingEvent {
	/** Always `reconnecting`. */
	type: "reconnecting";
	/** Which attempt this is, from 1. */
	attempt: number;
	/** The pause before it, in ms. */
	delayMs: number;
}
/** The stream is back after a drop; audio sent while it was down, up to the replay bound, is replayed. */
interface ReconnectedEvent {
	/** Always `reconnected`. */
	type: "reconnected";
	/** How many attempts it took. */
	attempts: number;
}
/** The stream failed for good: the terminal event, with no `closed` after it. Carries no text. */
interface FailedEvent {
	/** Always `failed`. */
	type: "failed";
	/** Why, as an `area.reason` code from the streaming transcribe errors. */
	code: string;
	/** How many reconnect attempts were made. */
	attempts: number;
}
/** The stream was closed by the caller: the terminal event. */
interface ClosedEvent {
	/** Always `closed`. */
	type: "closed";
}
/** Everything a stream tells its listener, in order. */
type StreamEvent = TurnEvent | ReconnectingEvent | ReconnectedEvent | FailedEvent | ClosedEvent;
/** The audio format and listener of one stream. */
interface OpenStreamRequest {
	/** The Organization. */
	organizationId: OrganizationId8;
	/** Our id of the Call; with the track it names the stream: a second live stream for both is `streaming_transcribe.conflict`. */
	callId: CallId2;
	/** The side of the Call this stream carries. */
	track: StreamTrack;
	/** How the audio sent is encoded. */
	encoding: AudioEncoding;
	/** The sample rate of the audio sent, in Hz. */
	sampleRate: SampleRate;
	/** A BCP 47 tag such as `en` or `en-US`; the vendor's default when absent. */
	language?: string;
	/** How to retry a dropped stream; the defaults when absent. */
	reconnect?: ReconnectPolicy;
	/**
	* Receives every event, one at a time and in order. It must return quickly and must not throw;
	* if it does, the adapter reports the error (metadata only) and goes on. It may be called
	* before `open` resolves.
	*/
	onEvent: (event: StreamEvent) => void;
}
/** Options of {@link StreamingTranscribePort.open}. */
interface StreamingTranscribeOptions {
	/** The most time opening may take, in ms, 1 to {@link MAX_STREAMING_TRANSCRIBE_TIMEOUT_MS}; default {@link DEFAULT_STREAMING_TRANSCRIBE_TIMEOUT_MS}. */
	timeoutMs?: number;
}
/** One open stream for one audio track. */
interface TranscribeStream {
	/** The adapter's id of this stream. */
	readonly streamId: string;
	/**
	* Pushes audio, 1 to {@link MAX_AUDIO_CHUNK_BYTES} bytes, in order and in real time. Returns at
	* once; while the connection is down the adapter holds up to {@link MAX_REPLAY_AUDIO_BYTES} and
	* drops the oldest beyond that. On a stream that has closed or failed it throws
	* `streaming_transcribe.closed`. The audio is never logged.
	*/
	sendAudio(chunk: Uint8Array): void;
	/**
	* Ends the stream: the vendor is asked to settle what it has (a last final turn may still
	* arrive), then `closed` is the last event. Idempotent. A stream that already failed resolves
	* without a further event. Bounded by the adapter's own timeout.
	*/
	close(): Promise<void>;
}
/**
* Live speech-to-text behind a vendor (AssemblyAI first), scoped by Organization. One stream
* carries one track of a Call, so the speaker is known without diarization.
*
* Per stream, the events arrive in order: `turn` events with an increasing `sequence`; within a
* turn any number of interims, then a final; the final that ends the turn has `endOfTurn: true`.
* A dropped connection is retried with a bounded, jittered pause ({@link reconnectDelayMs}) and
* shown as `reconnecting` then `reconnected`; word times stay continuous. When the attempts run
* out the stream ends with one `failed` event and the error is given to the
* {@link ErrorReporter} (metadata only): it is never thrown at the caller, because nothing is
* calling. Exactly one of `closed` or `failed` ends a stream, and nothing follows it.
*
* Nothing here logs, reports or puts in an error any audio or any transcript text (tenant data).
*/
interface StreamingTranscribePort {
	/**
	* Opens a stream and resolves once the vendor accepted it. Not idempotent: it opens one stream,
	* and a second for the same Call and track while the first is live is
	* `streaming_transcribe.conflict`. A vendor that cannot be reached is `unavailable` after the
	* bounded retries. O(1).
	*/
	open(request: OpenStreamRequest, options?: StreamingTranscribeOptions): Promise<TranscribeStream>;
}
/** The retry policy with its defaults filled in. */
interface ResolvedReconnectPolicy {
	/** The most attempts after one drop. */
	maxAttempts: number;
	/** The base pause, in ms. */
	baseDelayMs: number;
	/** The longest pause before jitter, in ms. */
	maxDelayMs: number;
}
/** The policy used when a request names none: five attempts, 250 ms doubling to 5 s. */
declare const DEFAULT_RECONNECT_POLICY: ResolvedReconnectPolicy;
/**
* The pause before reconnect attempt `attempt` (from 1): the base doubled each time up to the
* maximum, then scaled by a jitter between 0.5 and 1.5 from `random()` (a number in `[0, 1)`).
*/
declare function reconnectDelayMs(attempt: number, policy: ResolvedReconnectPolicy, random?: () => number): number;
/** The default time to open one connection, in milliseconds. */
declare const DEFAULT_ASSEMBLYAI_CONNECT_TIMEOUT_MS = 5e3;
/** The default time `close` waits for the vendor to settle the last turn, in milliseconds. */
declare const DEFAULT_ASSEMBLYAI_CLOSE_TIMEOUT_MS = 3e3;
/** Which AssemblyAI endpoint serves the audio: the US one, or the one that keeps it in the EU. */
type AssemblyAiRegion = "us" | "eu";
/** Who a socket is for. Used to route a test fake; never sent to the vendor. */
interface AssemblyAiStreamMeta {
	/** The Organization. */
	organizationId: OrganizationId9;
	/** The Call. */
	callId: CallId3;
	/** The track. */
	track: StreamTrack;
}
/** The callbacks an {@link AssemblyAiSocket} reports through. */
interface AssemblyAiSocketHandlers {
	/** The connection is open. */
	open(): void;
	/** A message arrived; `data` is a string for a text frame. */
	message(data: unknown): void;
	/** The connection failed (no detail is kept: it may name a URL). */
	error(): void;
	/** The connection closed with this code. */
	close(code: number): void;
}
/** The part of a WebSocket the adapter uses, so tests can drive a fake vendor. */
interface AssemblyAiSocket {
	/** Sends one text or binary frame; throws when the connection cannot take it. */
	send(data: string | Uint8Array): void;
	/** Closes the connection. */
	close(code?: number): void;
	/** Registers the handlers once, before any event. */
	attach(handlers: AssemblyAiSocketHandlers): void;
}
/** Opens a WebSocket to `url` with `headers`; `meta` says whom it is for and is never sent. */
type AssemblyAiSocketFactory = (url: string, headers: Readonly<Record<string, string>>, meta: AssemblyAiStreamMeta) => AssemblyAiSocket;
/** The real factory, on the runtime's WebSocket (Bun accepts request headers). */
declare const bunAssemblyAiSocket: AssemblyAiSocketFactory;
/** Options for {@link createAssemblyAiStreamingTranscribe}. */
interface AssemblyAiStreamingTranscribeOptions {
	/** The AssemblyAI API key. Sent as the `Authorization` header only; never logged, reported or put in an error. */
	apiKey: string;
	/** `us` (default) or `eu`, the endpoint that processes the audio in the EU. */
	region?: AssemblyAiRegion;
	/** The WebSocket base URL, replacing the region's; `wss`, or `ws` to loopback, with no credentials or query. */
	baseUrl?: string;
	/** True to have AssemblyAI punctuate and capitalise turns; the final then arrives with the formatted text, a little later. Default false. */
	formatTurns?: boolean;
	/** How sure AssemblyAI must be that the speaker is done before it ends a turn, 0 to 1; the vendor's default when absent. */
	endOfTurnConfidenceThreshold?: number;
	/** The silence that ends a turn once the vendor is confident, 0 to 60000 ms; the vendor's default when absent. */
	minEndOfTurnSilenceMs?: number;
	/** The silence that ends a turn whatever the confidence, 0 to 60000 ms; the vendor's default when absent. */
	maxTurnSilenceMs?: number;
	/** The most time to open one connection, 1 to 30000 ms; default {@link DEFAULT_ASSEMBLYAI_CONNECT_TIMEOUT_MS}. */
	connectTimeoutMs?: number;
	/** The most time `close` waits for the vendor to settle, 1 to 30000 ms; default {@link DEFAULT_ASSEMBLYAI_CLOSE_TIMEOUT_MS}. */
	closeTimeoutMs?: number;
	/** Opens sockets; the real WebSocket by default. */
	socket?: AssemblyAiSocketFactory;
	/** Receives the errors that mean the vendor failed (metadata only); nothing if absent. */
	reporter?: ErrorReporter;
	/** Where reconnects and listener failures are noted (metadata only); nothing if absent. */
	logger?: Logger;
	/** Pauses between reconnect attempts; real time by default. */
	sleep?: Sleep;
	/** A number in `[0, 1)` for the jitter; `Math.random` by default. */
	random?: () => number;
}
/** A {@link StreamingTranscribePort} on AssemblyAI that also says how many streams are live. */
interface AssemblyAiStreamingTranscribe extends StreamingTranscribePort {
	/** How many streams are open or reconnecting. */
	openStreams(): number;
}
/**
* Builds a {@link StreamingTranscribePort} on AssemblyAI's streaming speech-to-text (v3) over
* its WebSocket API, with the EU endpoint selectable. One connection per stream; audio is sent as
* binary frames of 50 to 500 ms (small chunks are joined, big ones split), and a `Turn` message
* becomes a turn event, the one with `end_of_turn` the final. Opening and each reconnect are
* bounded by a timeout and a bounded, jittered retry; a dropped connection is retried with the
* request's policy, replays the audio sent while it was down (up to the port's bound), and
* shifts the new session's word times and turn numbers so they carry on. A refused credential
* is `streaming_transcribe.rejected` and is never retried. The API key (sent only as the
* `Authorization` header), the audio and the transcript never reach a log, a report, an error
* or a printed form.
*/
declare function createAssemblyAiStreamingTranscribe(options: AssemblyAiStreamingTranscribeOptions): AssemblyAiStreamingTranscribe;
/** The `area.reason` codes the streaming transcribe port and adapters throw or report. */
declare const STREAMING_TRANSCRIBE_ERROR_CODES: {
	/** An id, track, audio format, chunk, option or policy is not acceptable. Nothing was sent to the vendor. */
	readonly invalidRequest: "streaming_transcribe.invalid_request";
	/** A stream for this Call and track is already open. */
	readonly conflict: "streaming_transcribe.conflict";
	/** The stream has closed or failed, so audio can no longer be sent to it. */
	readonly closed: "streaming_transcribe.closed";
	/** The vendor refused the stream for a reason a retry cannot fix (credentials, quota, terms). */
	readonly rejected: "streaming_transcribe.rejected";
	/** The vendor could not be reached, or the stream could not be restored, after the bounded retries. */
	readonly unavailable: "streaming_transcribe.unavailable";
	/** The vendor sent something this adapter cannot use. */
	readonly badResponse: "streaming_transcribe.bad_response";
};
/** One of {@link STREAMING_TRANSCRIBE_ERROR_CODES}'s values. */
type StreamingTranscribeErrorCode = (typeof STREAMING_TRANSCRIBE_ERROR_CODES)[keyof typeof STREAMING_TRANSCRIBE_ERROR_CODES];
/**
* What a streaming transcribe adapter throws, and what it reports when a stream fails for good.
* Its message and details never hold audio, transcript text, a credential or a vendor URL.
*/
declare class StreamingTranscribeError extends AppError {
	readonly code: StreamingTranscribeErrorCode;
	constructor(code: StreamingTranscribeErrorCode, message: string, options?: {
		cause?: unknown;
		details?: Record<string, unknown>;
	});
}
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
/** What a transcriber throws. Its message never holds audio, an audio URL, text or a speaker name. */
declare class TranscriberError extends AppError {
	readonly code: TranscriberErrorCode;
	constructor(code: TranscriberErrorCode, message: string, options?: {
		cause?: unknown;
		details?: Record<string, unknown>;
	});
}
/** The longest client reference, in characters. */
declare const MAX_CLIENT_REFERENCE_LENGTH = 128;
/** The longest audio URL, in characters (a presigned S3 URL is about 1 KiB). */
declare const MAX_AUDIO_URL_LENGTH = 4096;
/** The most speakers a send may allow. */
declare const MAX_SPEAKERS = 10;
/** The default page size of {@link Transcriber.list}. */
declare const DEFAULT_TRANSCRIBER_LIST_LIMIT = 100;
/** The largest page size of {@link Transcriber.list}. */
declare const MAX_TRANSCRIBER_LIST_LIMIT = 1e3;
/** The most turns one result may hold; an adapter that gets more answers `transcriber.bad_response`. */
declare const MAX_TRANSCRIPT_TURNS = 5e4;
/** The longest text of one turn, in characters. */
declare const MAX_TURN_TEXT = 2e4;
/** The longest vendor id, in characters. */
declare const MAX_VENDOR_ID_LENGTH = 128;
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
/** Options of {@link waitForTranscription}. */
interface WaitOptions {
	/** The most reads, the first included, 1 to 1000; default 60. */
	maxAttempts?: number;
	/** The pause between reads in ms before jitter, 0 to 60000; default 5000. */
	intervalMs?: number;
	/** Replaces the pause, for tests. */
	sleep?: (ms: number) => Promise<void>;
	/** Replaces the random source in [0, 1) for the jitter, for tests. */
	random?: () => number;
	/** Stops waiting when it fires. */
	signal?: AbortSignal;
	/** The {@link Submission.vendorId} the caller stored, passed to every read as the hint. */
	vendorId?: string;
}
/**
* How many bytes of a vendor's response a real adapter may read before it parses it (8 MiB). A
* 3-hour Recording is a few hundred KiB of JSON, so a larger body is not a transcript: stop
* reading, then answer `transcriber.bad_response`. Vendor output is untrusted data.
*/
declare const MAX_TRANSCRIPT_RESPONSE_BYTES: number;
/** The longest audio a result may claim, in milliseconds (12 hours). */
declare const MAX_AUDIO_MS: number;
/** The most characters of text in one result, over all turns (4 million). */
declare const MAX_TRANSCRIPT_CHARS = 4e6;
/** The longest speaker label, in characters. */
declare const MAX_SPEAKER_LABEL = 64;
/** The most channels a split-channels result may name. */
declare const MAX_CHANNELS = 8;
/** The reasons a transcription can fail; the closed list of {@link TranscriptionFailure}. */
declare const TRANSCRIPTION_FAILURES: readonly TranscriptionFailure[];
/** What the request said, so the result can be checked against it. */
interface ResultContext {
	/** How the speakers were to be told apart. */
	speakers: SpeakerMode;
	/** The speaker cap that was asked for, if any. */
	maxSpeakers?: number | undefined;
}
/**
* Checks a result as a vendor produced it and returns a copy, or throws `transcriber.bad_response`
* (its message never holds text or labels). **A real adapter must run every vendor result through
* this**, after reading at most {@link MAX_TRANSCRIPT_RESPONSE_BYTES} of the response and parsing
* it: vendor output is untrusted. It checks the status and the listed failure reasons; for a
* `done` result a whole-millisecond duration of at most 12 hours, at most 50,000 turns and 4 million
* characters of text, each turn with a speaker label of 1 to 64 characters, whole non-negative
* `startMs` and `endMs` with the end not before the start and not after the audio, start times in
* order, text of at most 20,000 characters, and at most `maxSpeakers` (else 10) distinct speakers.
* With `context`, a `diarize` result has no channels and a `split_channels` result a channel from 0
* on every turn. O(turns + text).
*/
declare function checkTranscriptionResult(result: unknown, context?: ResultContext): TranscriptionResult;
/**
* Reads a send until it is `done` or `failed`, with a bound: at most `maxAttempts` reads (60 by
* default) with a pause of `intervalMs` (5 s) varied by jitter between 50% and 150%, so many
* waiters do not read in step. Returns the final result, `{ status: 'pending' }` when the attempts
* ran out (the caller reschedules; it is not a failure), or `undefined` when the send does not
* exist. A read that throws ends the wait with that error. An abort (the `signal`, checked before
* each read and during each pause) rejects with the signal's reason (an `AbortError` by default): it
* is never reported as running out of attempts, which is a `pending` result. Worst case: maxAttempts reads and
* (maxAttempts - 1) pauses of at most 1.5 x intervalMs. For a queued job, one attempt per run is
* usually better.
*/
declare function waitForTranscription(transcriber: Transcriber, organizationId: string, clientReference: string, options?: WaitOptions): Promise<TranscriptionResult | undefined>;
/**
* One piece of synthesised speech, in order. The audio is held in a private field, so it is not in
* `JSON.stringify`, a spread, `String()`, a log line or a console dump; only the sequence number
* and the byte count are. Read the bytes with {@link TtsAudioChunk.audio}.
*/
declare class TtsAudioChunk {
	private;
	/** The position in the stream, from 0, rising by 1 with no gaps. */
	readonly sequence: number;
	/** The size of the audio in bytes. */
	readonly byteLength: number;
	constructor(sequence: number, audio: Uint8Array);
	/** The audio bytes in the format the stream was opened with; not copied, so do not change them. */
	get audio(): Uint8Array;
	/** The metadata, for `JSON.stringify`. */
	toJSON(): {
		sequence: number;
		byteLength: number;
	};
	/** A readable label without the audio. */
	toString(): string;
}
import { OrganizationId as OrganizationId10 } from "tula-closeline-contract";
/** The default overall deadline of one stream, from `open` to the last chunk, in milliseconds. */
declare const DEFAULT_TTS_TIMEOUT_MS = 3e4;
/** The longest overall deadline a caller may allow, in milliseconds. */
declare const MAX_TTS_TIMEOUT_MS = 12e4;
/** The default time from the first text to the first audio chunk, in milliseconds. */
declare const DEFAULT_TTS_FIRST_CHUNK_TIMEOUT_MS = 2e3;
/** The longest time to the first chunk a caller may allow, in milliseconds. */
declare const MAX_TTS_FIRST_CHUNK_TIMEOUT_MS = 3e4;
/** The default most characters one stream may be given in all. */
declare const DEFAULT_TTS_MAX_TEXT_CHARS = 5e3;
/** The largest text length a caller may allow one stream. */
declare const MAX_TTS_MAX_TEXT_CHARS = 2e4;
/** The most bytes one {@link TtsAudioChunk} may hold. */
declare const MAX_TTS_AUDIO_CHUNK_BYTES = 65536;
/** How an adapter retries a retryable vendor error (`tts.unavailable`) before the first chunk. */
interface TtsRetryPolicy {
	/** The most retries after the first attempt, 0 to 5; 0 never retries. Default 1. */
	maxRetries?: number;
	/** The base of the pause before a retry, in ms, 1 to 60000; doubled each time and jittered. Default 50. */
	baseDelayMs?: number;
	/** The longest pause before a retry, in ms, before jitter, at least the base and at most 60000. Default 250. */
	maxDelayMs?: number;
}
/** The retry policy with its defaults filled in. */
interface ResolvedTtsRetryPolicy {
	/** The most retries after the first attempt. */
	maxRetries: number;
	/** The base pause, in ms. */
	baseDelayMs: number;
	/** The longest pause before jitter, in ms. */
	maxDelayMs: number;
}
/** The policy used when a request names none: one retry after 50 ms (a live call cannot wait long). */
declare const DEFAULT_TTS_RETRY_POLICY: ResolvedTtsRetryPolicy;
/**
* The pause before retry `retry` (from 1): the base doubled each time up to the maximum, then
* scaled by a jitter between 0.5 and 1.5 from `random()` (a number in `[0, 1)`).
*/
declare function ttsRetryDelayMs(retry: number, policy: ResolvedTtsRetryPolicy, random?: () => number): number;
/** What opening a stream states: whose it is, the voice and format, and the limits that bound it. */
interface TtsOpenRequest {
	/** The Organization the stream is for; it scopes metering and error context. */
	organizationId: OrganizationId10;
	/** A stock voice style of the vendor, 1 to 128 characters of `A-Z a-z 0-9 _ . : -`. Voice cloning is out of scope. */
	voice: string;
	/** How the audio is encoded: `pcm_mulaw` for telephony, `pcm_s16le` otherwise. */
	encoding: AudioEncoding;
	/** The sample rate of the audio, in Hz. */
	sampleRate: SampleRate;
	/**
	* The most time the whole stream may take from `open`, retries included, in ms, 1 to
	* {@link MAX_TTS_TIMEOUT_MS}; default {@link DEFAULT_TTS_TIMEOUT_MS}. When it passes, the vendor
	* request is aborted and iteration fails with `tts.timeout`.
	*/
	timeoutMs?: number;
	/**
	* The most time from the first text being written (and the stream being read) to the first
	* chunk, per attempt, in ms, 1 to {@link MAX_TTS_FIRST_CHUNK_TIMEOUT_MS}; default
	* {@link DEFAULT_TTS_FIRST_CHUNK_TIMEOUT_MS}. When it passes, iteration fails with `tts.timeout`.
	*/
	firstChunkTimeoutMs?: number;
	/**
	* The most characters all `write` calls of this stream may add up to, 1 to
	* {@link MAX_TTS_MAX_TEXT_CHARS}; default {@link DEFAULT_TTS_MAX_TEXT_CHARS}. A write that would
	* pass it fails with `tts.text_too_large` and adds nothing.
	*/
	maxTextChars?: number;
	/** Retries of `tts.unavailable` before the first chunk; the defaults when absent. */
	retry?: TtsRetryPolicy;
	/** The caller's own cancellation. When it fires the vendor request is aborted and iteration fails with `tts.aborted`. */
	signal?: AbortSignal;
}
/**
* One text-to-speech request in flight: text goes in with {@link TtsStream.write}, audio chunks
* come out in order by iterating the stream. Iterate it once.
*
* The consumer pulls: the next chunk is produced only when the loop asks for it, so a slow
* consumer holds at most one chunk and the text it was given (bounded by `maxTextChars`), never a
* growing queue. Leaving the loop early (`break`) cancels the stream.
*/
interface TtsStream extends AsyncIterable<TtsAudioChunk> {
	/**
	* Adds text to speak, in order. Empty text is ignored. Throws `tts.text_too_large` when the
	* stream's total would pass its maximum, `tts.closed` after `finish`, `cancel` or `close`, and
	* `tts.timeout` or `tts.aborted` once the deadline or the caller's signal has fired. Synchronous
	* and O(text length); it never waits for the vendor.
	*/
	write(text: string): void;
	/** Says no more text is coming, so the stream ends after the last chunk. Idempotent. */
	finish(): void;
	/**
	* Stops now: the vendor request is aborted, no further chunk is delivered (a pending read ends
	* as done) and unspoken text is dropped. Idempotent, and a no-op once the stream has ended or
	* is closed. This is barge-in.
	*/
	cancel(): void;
	/**
	* Cancels and releases everything the stream holds (timer, listeners, buffered text, the vendor
	* connection). Idempotent. Any later `write`, `finish` or read fails with `tts.closed`.
	*/
	close(): Promise<void>;
}
/**
* A text-to-speech engine behind a vendor (Cartesia Sonic first, stock voice styles only). It is
* on the live call path, so it is built for latency: text streams in as the model writes it and
* audio streams out as the vendor makes it.
*
* Every stream has an overall deadline and a time-to-first-chunk limit that abort the vendor
* request. A retryable vendor error (`tts.unavailable`) is retried with a bounded, jittered pause
* only before the first chunk has been delivered; once a chunk is out the failure is thrown from
* the iteration, never retried, so the listener never hears a repeat. Failures are `TtsError`s
* with `tts.*` codes; `tts.unavailable`, `tts.rejected` and `tts.bad_response` are also given to
* the ErrorReporter (metadata only).
*
* The text and the audio are tenant data: they are never logged, reported or put in an error, and
* do not appear in the string, JSON or inspect form of any object the port returns.
*/
interface TtsPort {
	/** Opens a stream. An unacceptable request throws `tts.invalid_request` here; nothing is sent to the vendor until text is written. */
	open(request: TtsOpenRequest): TtsStream;
}
/** The Cartesia API version this adapter was written against (sent as `Cartesia-Version`). */
declare const CARTESIA_API_VERSION = "2026-08-14";
/** The default Cartesia model. */
declare const DEFAULT_CARTESIA_MODEL = "sonic-3.6";
/** The default time to open the WebSocket, in milliseconds. */
declare const DEFAULT_CARTESIA_CONNECT_TIMEOUT_MS = 3e3;
/** The callbacks a {@link CartesiaSocket} reports through. */
interface CartesiaSocketHandlers {
	/** The connection is open. */
	open(): void;
	/** A message arrived; `data` is a string for a text frame. */
	message(data: unknown): void;
	/** The connection failed (no detail is kept: it may name a URL). */
	error(): void;
	/** The connection closed with this code. */
	close(code: number): void;
}
/** The part of a WebSocket the adapter uses, so tests can drive a fake vendor. */
interface CartesiaSocket {
	/** Sends one text frame. */
	send(data: string): void;
	/** Closes the connection. */
	close(code?: number): void;
	/** Registers the handlers once, before any event. */
	attach(handlers: CartesiaSocketHandlers): void;
}
/** Opens a WebSocket to `url` with `headers`. */
type CartesiaSocketFactory = (url: string, headers: Readonly<Record<string, string>>) => CartesiaSocket;
/** The real factory, on the runtime's WebSocket (Bun accepts request headers). */
declare const bunCartesiaSocket: CartesiaSocketFactory;
/** Options for {@link createCartesiaTts}. */
interface CartesiaTtsOptions {
	/** The Cartesia API key. Never logged, reported or put in an error. */
	apiKey: string;
	/** Stock voice styles: the name callers pass as `voice` mapped to a Cartesia voice id. A voice id (UUID) is also accepted as is. */
	voices?: Readonly<Record<string, string>>;
	/** The Cartesia model; default {@link DEFAULT_CARTESIA_MODEL}. */
	model?: string;
	/** The language code; default `en`. */
	language?: string;
	/** How long Cartesia may buffer text before speaking, 0 to 5000 ms; default 100. */
	maxBufferDelayMs?: number;
	/** The most time to open the connection, 1 to 30000 ms; default {@link DEFAULT_CARTESIA_CONNECT_TIMEOUT_MS}. */
	connectTimeoutMs?: number;
	/** The WebSocket base URL; default `wss://api.cartesia.ai`. */
	baseUrl?: string;
	/** Opens sockets; the real WebSocket by default. */
	socket?: CartesiaSocketFactory;
	/** Receives the errors that mean the vendor failed; nothing if absent. */
	reporter?: ErrorReporter;
	/** Where retries are noted (metadata only); nothing if absent. */
	logger?: Logger;
	/** Pauses between retries; real time by default. */
	sleep?: Sleep;
	/** A number in `[0, 1)` for the jitter; `Math.random` by default. */
	random?: () => number;
}
/** A {@link TtsPort} on Cartesia Sonic that also says how many streams are open. */
interface CartesiaTts extends TtsPort {
	/** How many streams have been opened and not yet closed. */
	openStreams(): number;
}
/**
* Builds a {@link TtsPort} on Cartesia Sonic over its WebSocket API: one connection and one
* context per stream, opened when the first text is written. Text is sent as it is written,
* audio is read as raw `pcm_s16le` or `pcm_mulaw` and handed out in chunks of at most 64 KiB.
* The connect, first-chunk and overall limits abort the connection; a failure before the first
* chunk (`tts.unavailable`) is retried on a fresh connection, bounded and jittered, and one after
* it never is. A cancel tells Cartesia to stop the context and closes the connection. The API
* key, the text and the audio never reach a log, a report, an error or a printed form.
*/
declare function createCartesiaTts(options: CartesiaTtsOptions): CartesiaTts;
/** The `area.reason` codes the text-to-speech port and adapters throw. */
declare const TTS_ERROR_CODES: {
	/** The Organization id, voice, format, limits, text or retry policy are not acceptable. Nothing was sent to the vendor. */
	readonly invalidRequest: "tts.invalid_request";
	/** The text written to one stream passed its maximum length. The text was not taken. */
	readonly textTooLarge: "tts.text_too_large";
	/** The stream was used after it was finished, cancelled or closed. */
	readonly closed: "tts.closed";
	/** The overall deadline or the time to the first chunk passed; the underlying request was aborted. */
	readonly timeout: "tts.timeout";
	/** The caller's own AbortSignal fired; the underlying request was aborted. */
	readonly aborted: "tts.aborted";
	/** The vendor refused for a reason a retry cannot fix (credentials, quota, terms, an unknown voice). */
	readonly rejected: "tts.rejected";
	/** The vendor could not be reached, was throttled or failed. Retried only before the first chunk. */
	readonly unavailable: "tts.unavailable";
	/** The vendor sent something this adapter cannot use. */
	readonly badResponse: "tts.bad_response";
};
/** One of {@link TTS_ERROR_CODES}'s values. */
type TtsErrorCode = (typeof TTS_ERROR_CODES)[keyof typeof TTS_ERROR_CODES];
/**
* What a text-to-speech adapter throws. Its message and details never hold the text, audio, a
* credential or a vendor URL; they describe fields, counts and codes only.
*/
declare class TtsError extends AppError {
	readonly code: TtsErrorCode;
	constructor(code: TtsErrorCode, message: string, options?: {
		cause?: unknown;
		details?: Record<string, unknown>;
	});
}
/** The `area.reason` codes the vector store port and adapters throw. */
declare const VECTOR_ERROR_CODES: {
	/** An Organization id, vector id, attribute, filter, batch or `topK` is not acceptable. */
	readonly invalidRequest: "vector.invalid_request";
	/** A vector's length is not the store's dimension count. Never retryable: the caller or the model changed. */
	readonly dimensionMismatch: "vector.dimension_mismatch";
	/** The store refused the call for a reason a retry cannot fix (access denied, wrong index). */
	readonly rejected: "vector.rejected";
	/** The store did not answer, in time or at all, after the bounded retries. The only retryable code. */
	readonly unavailable: "vector.unavailable";
	/** The store answered with something this adapter cannot use. */
	readonly badResponse: "vector.bad_response";
};
/** One of {@link VECTOR_ERROR_CODES}'s values. */
type VectorErrorCode = (typeof VECTOR_ERROR_CODES)[keyof typeof VECTOR_ERROR_CODES];
/** What a vector store throws. Its message never holds a vector, an attribute value or query text. */
declare class VectorError extends AppError {
	readonly code: VectorErrorCode;
	constructor(code: VectorErrorCode, message: string, options?: {
		cause?: unknown;
		details?: Record<string, unknown>;
	});
}
/** The most vectors one `upsert` takes. */
declare const MAX_UPSERT_BATCH = 500;
/** The most ids one `delete` takes. */
declare const MAX_DELETE_BATCH = 500;
/** The longest vector id, in characters (ids are ASCII, so bytes): turbopuffer's limit for string ids. */
declare const MAX_VECTOR_ID_LENGTH = 64;
/** The largest `topK` of a search. */
declare const MAX_TOP_K = 100;
/** The most dimensions a store can be configured with. */
declare const MAX_DIMENSIONS = 4096;
/** The most attributes on one vector, and the most keys in one filter. */
declare const MAX_ATTRIBUTES = 16;
/** The longest string attribute value, in characters. */
declare const MAX_ATTRIBUTE_STRING = 512;
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
/** This library's package name, so a consumer can report which shared libraries it resolved. */
declare const PACKAGE = "tula-closeline-kit";
export { API_KEY_ACTOR, AUDIT_DENIED_METADATA_KEYS, AUDIT_ERROR_CODES, AUDIT_LIMITS, AnswerCallRequest, AnsweredCall, AnyDefinition, AnyEnvelope, AppError, AppErrorInit, AssemblyAiRegion, AssemblyAiSocket, AssemblyAiSocketFactory, AssemblyAiSocketHandlers, AssemblyAiStreamMeta, AssemblyAiStreamingTranscribe, AssemblyAiStreamingTranscribeOptions, AttributeValue, AudioEncoding, AudioReference, AuditEntry, AuditEntryInput, AuditError, AuditErrorCode, AuditRecordedEnvelope, AuditRecorder, AuthEnv, AuthMiddlewareOptions, AuthVariables, BatchFailure, BatchResult, BridgeRequest, BrowserTokenRequest, BusyInterval, ByteStream, CALENDAR_ERROR_CODES, CARTESIA_API_VERSION, CONTACT_GUARD_RETRY_DELAY_MS, CONTACT_GUARD_TIMEOUT_MS, CONTACT_UNAVAILABLE, CalendarAttendee, CalendarBusyRequest, CalendarCallOptions, CalendarConnectRequest, CalendarConnection, CalendarConnectionInit, CalendarCreateRequest, CalendarDeleteRequest, CalendarError, CalendarErrorCode, CalendarEventChanges, CalendarEventCreated, CalendarEventInput, CalendarEventRef, CalendarGrant, CalendarPort, CalendarRequestBase, CalendarRetryPolicy, CalendarUpdateRequest, CartesiaSocket, CartesiaSocketFactory, CartesiaSocketHandlers, CartesiaTts, CartesiaTtsOptions, ClaimResult, Clock, ClosedEvent, ConsumedKey, ContactGuard, ContactGuardRequest, ContactGuardResult, CreateInput, DEFAULT_ASSEMBLYAI_CLOSE_TIMEOUT_MS, DEFAULT_ASSEMBLYAI_CONNECT_TIMEOUT_MS, DEFAULT_CALENDAR_RETRY_POLICY, DEFAULT_CALENDAR_TIMEOUT_MS, DEFAULT_CARTESIA_CONNECT_TIMEOUT_MS, DEFAULT_CARTESIA_MODEL, DEFAULT_CONTENT_TYPE, DEFAULT_LIST_LIMIT, DEFAULT_LLM_MAX_INPUT_TOKENS, DEFAULT_LLM_MAX_OUTPUT_TOKENS, DEFAULT_LLM_RETRY_POLICY, DEFAULT_LLM_TIMEOUT_MS, DEFAULT_MAX_OBJECT_BYTES, DEFAULT_MESSAGING_RETRY_POLICY, DEFAULT_MESSAGING_TIMEOUT_MS, DEFAULT_PRESIGN_SECONDS, DEFAULT_RECONNECT_POLICY, DEFAULT_STREAMING_TRANSCRIBE_TIMEOUT_MS, DEFAULT_TELEPHONY_TIMEOUT_MS, DEFAULT_TRANSCRIBER_LIST_LIMIT, DEFAULT_TTS_FIRST_CHUNK_TIMEOUT_MS, DEFAULT_TTS_MAX_TEXT_CHARS, DEFAULT_TTS_RETRY_POLICY, DEFAULT_TTS_TIMEOUT_MS, DecodeResult, Delivery, DisclosurePlayed, DisclosureWait, ENVIRONMENTS, ESTIMATED_CHARS_PER_TOKEN, EnvelopeBase, EnvelopeOf, Environment, ErrorBody, ErrorContext, ErrorReporter, ErrorReporterOptions, FailedEvent, FetchedRecording, FixedClock, ForkTracksRequest, ForkedTracks, GOOGLE_CALENDAR_SCOPES, GoogleCalendarFetch, GoogleCalendarOptions, HangUpRequest, HttpContactGuard, HttpContactGuardOptions, INTERNAL_CALL_FAILURES, INTERNAL_DEFAULT_IDLE_TIMEOUT_MS, INTERNAL_DEFAULT_MAX_FREE_SOCKETS, INTERNAL_DEFAULT_MAX_RESPONSE_BYTES, INTERNAL_DEFAULT_MAX_SOCKETS, INTERNAL_DEFAULT_RETRY, INTERNAL_DEFAULT_TIMEOUT_MS, INTERNAL_IDEMPOTENCY_HEADER, INTERNAL_MAX_ATTEMPTS, INTERNAL_MAX_REQUEST_BYTES, INTERNAL_RETRY_STATUSES, INVALID_REASONS, InboundEvent, InboundMessage, InboundMessageFields, InternalCallError, InternalCallFailure, InternalClient, InternalClientOptions, InternalMethod, InternalRequest, InternalResponse, InternalRetryPolicy, InvalidDelivery, InvalidReason, Jwks, KeySet, LLM_ERROR_CODES, ListOptions, ListPage, LlmCompleteRequest, LlmCompletion, LlmDoneEvent, LlmError, LlmErrorCode, LlmMessage, LlmPort, LlmRequestBase, LlmRetryPolicy, LlmStreamEvent, LlmStreamRequest, LlmTextEvent, LlmUsage, LogDestination, LogLevel, Logger, LoggerOptions, MAX_ATTRIBUTES, MAX_ATTRIBUTE_STRING, MAX_AUDIO_CHUNK_BYTES, MAX_AUDIO_MS, MAX_AUDIO_URL_LENGTH, MAX_BATCH_SIZE, MAX_BUSY_INTERVALS, MAX_BUSY_RANGE_MS, MAX_CALENDAR_TIMEOUT_MS, MAX_CHANNELS, MAX_CLIENT_REFERENCE_LENGTH, MAX_DELETE_BATCH, MAX_DIMENSIONS, MAX_DISCLOSURE_TEXT_LENGTH, MAX_EVENT_ATTENDEES, MAX_EVENT_DURATION_MS, MAX_JWKS_BYTES, MAX_JWKS_KEYS, MAX_KEY_BYTES, MAX_KEY_SEGMENTS, MAX_LIST_LIMIT, MAX_LLM_MAX_INPUT_TOKENS, MAX_LLM_MAX_OUTPUT_TOKENS, MAX_LLM_MESSAGES, MAX_LLM_TIMEOUT_MS, MAX_MESSAGE_BODY_CHARS, MAX_MESSAGE_BYTES, MAX_MESSAGING_TIMEOUT_MS, MAX_MESSAGING_WEBHOOK_BYTES, MAX_OBJECT_BYTES_LIMIT, MAX_PRESIGN_SECONDS, MAX_REPLAY_AUDIO_BYTES, MAX_RING_LEGS, MAX_SPEAKERS, MAX_SPEAKER_LABEL, MAX_STREAMING_TRANSCRIBE_TIMEOUT_MS, MAX_STREAM_BYTES_LIMIT, MAX_TELEPHONY_TIMEOUT_MS, MAX_TEMPLATE_VARIABLES, MAX_TEMPLATE_VARIABLE_CHARS, MAX_TOKEN_LENGTH, MAX_TOP_K, MAX_TRANSCRIBER_LIST_LIMIT, MAX_TRANSCRIPT_CHARS, MAX_TRANSCRIPT_RESPONSE_BYTES, MAX_TRANSCRIPT_TURNS, MAX_TTS_AUDIO_CHUNK_BYTES, MAX_TTS_FIRST_CHUNK_TIMEOUT_MS, MAX_TTS_MAX_TEXT_CHARS, MAX_TTS_TIMEOUT_MS, MAX_TURN_TEXT, MAX_UPSERT_BATCH, MAX_VECTOR_ID_LENGTH, MAX_VENDOR_ID_LENGTH, MAX_VISIBILITY_SECONDS, MAX_WAIT_SECONDS, MAX_WEBHOOK_BODY_BYTES, MAX_WORDS_PER_TURN, MESSAGING_CHANNELS, MESSAGING_ERROR_CODES, MESSAGING_PURPOSES, MODEL_TIERS, MessageContent, MessageDefinition, MessageDeliveryStatus, MessageIntent, MessageRegistry, MessageRegistryOptions, MessageScope, MessagingChannel, MessagingError, MessagingErrorCode, MessagingPort, MessagingPurpose, MessagingRetryPolicy, MessagingWebhookRequest, ModelTier, OUTLOOK_CALENDAR_SCOPES, ObjectEntry, ObjectInfo, ObjectStore, ObjectStream, OpenStreamRequest, OrganizationIdCheck, OutlookCalendarFetch, OutlookCalendarOptions, PACKAGE, PlaceCallRequest, PlacedCall, PlayDisclosureRequest, PresignOptions, PreviousVersion, ProcessedStore, ProviderCallRef, PutOptions, PutStreamOptions, PutStreamResult, QUEUE_ERROR_CODES, Queue, QueueAuditRecorderOptions, QueueError, QueueErrorCode, Receipt, ReceiveOptions, ReconnectPolicy, ReconnectedEvent, ReconnectingEvent, RecordingRef, RemoteKeySet, RemoteKeySetOptions, ResolvedCalendarRetryPolicy, ResolvedLlmRetryPolicy, ResolvedMessagingRetryPolicy, ResolvedReconnectPolicy, ResolvedTtsRetryPolicy, ResultContext, STORAGE_ERROR_CODES, STREAMING_TRANSCRIBE_ERROR_CODES, STREAM_IDLE_TIMEOUT_MS, SampleRate, ScopedAuthEnv, ScopedAuthVariables, SearchHit, SearchQuery, SendMessageRequest, SentMessage, Sleep, SpeakerMode, StartedRecording, StatusEvent, StorageError, StorageErrorCode, StoredObject, StreamEvent, StreamTrack, StreamingTranscribeError, StreamingTranscribeErrorCode, StreamingTranscribeOptions, StreamingTranscribePort, Submission, TELEPHONY_ERROR_CODES, TRANSCRIBER_ERROR_CODES, TRANSCRIPTION_FAILURES, TTS_ERROR_CODES, TWILIO_DEFAULT_EDGES, TWILIO_REGIONS, TelephonyError, TelephonyErrorCode, TelephonyEvent, TelephonyEventType, TelephonyOptions, TelephonyPort, TokenRejection, TokenVerificationError, TokenVerifier, TokenVerifierOptions, TranscribeRequest, TranscribeStream, TranscribedWord, Transcriber, TranscriberError, TranscriberErrorCode, TranscriptTurn, TranscriptionEntry, TranscriptionFailure, TranscriptionListOptions, TranscriptionPage, TranscriptionResult, TtsAudioChunk, TtsError, TtsErrorCode, TtsOpenRequest, TtsPort, TtsRetryPolicy, TtsStream, TurnEvent, TwilioCallRecord, TwilioMessagingOptions, TwilioOptions, TwilioPlacement, TwilioRegion, TwilioStore, VECTOR_ERROR_CODES, ValidDelivery, VectorAttributes, VectorError, VectorErrorCode, VectorRecord, VectorStore, VendorIdHint, VerifiedApiKeyToken, VerifiedIdentity, VerifiedToken, WaitOptions, WebhookRequest, accessTokenClaimsSchema, apiKeyTokenClaimsSchema, assertBatchCount, assertReceiveOptions, assertVisibility, auditActorSchema, auditEntrySchema, auditEventPayloadSchema, auditMetadataSchema, auditRecordedMessage, auditSubjectSchema, bunAssemblyAiSocket, bunCartesiaSocket, calendarRetryDelayMs, checkTranscriptionResult, classifyMessageIntent, createAssemblyAiStreamingTranscribe, createAuthMiddleware, createCartesiaTts, createErrorReporter, createFixedClock, createGoogleCalendar, createHttpContactGuard, createInternalClient, createLogger, createMemoryProcessedStore, createMemoryTwilioStore, createMessageRegistry, createNoopErrorReporter, createOutlookCalendar, createQueueAuditRecorder, createRemoteKeySet, createStaticKeySet, createTokenVerifier, createTwilioMessaging, createTwilioTelephony, cutText, defineMessage, directFetch, dropHighSurrogate, environmentSchema, estimateSpeechMs, estimateTokens, isAppError, isContactGuardRequest, isReportableMessagingError, isScopeGuard, isSentryDsn, llmRetryDelayMs, messagingRetryDelayMs, parseAuditEntry, reconnectDelayMs, requireScope, requireSentryDsn, scrubText, sentryDsnSchema, shouldReportError, signTwilioRequest, systemClock, systemSleep, toErrorBody, ttsRetryDelayMs, twilioApiHost, waitForTranscription, withCaller };
