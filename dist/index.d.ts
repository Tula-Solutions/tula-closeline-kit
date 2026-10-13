import { OrganizationId, Region, Role, UserId } from "tula-closeline-contract";
import { z } from "zod";
/** The longest access token, in characters, that verification will look at. */
declare const MAX_TOKEN_LENGTH = 4096;
/** The claims every Closeline access token carries, besides the registered `iss`, `aud`, `exp`. */
declare const accessTokenClaimsSchema: z.ZodObject<{
	sub: z.core.$ZodBranded<z.ZodString, "usr", "out">;
	org: z.core.$ZodBranded<z.ZodString, "org", "out">;
	role: z.ZodEnum<{
		admin: "admin";
		manager: "manager";
		owner: "owner";
		rep: "rep";
	}>;
	region: z.ZodEnum<{
		eu: "eu";
		us: "us";
	}>;
	iat: z.ZodNumber;
	exp: z.ZodNumber;
}, z.core.$strip>;
/** The identity a verified access token proves. */
interface VerifiedToken {
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
}
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
import { OrganizationId as OrganizationId2, Region as Region2, Role as Role2, UserId as UserId2 } from "tula-closeline-contract";
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
	verify(token: string): Promise<VerifiedToken>;
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
/** The verified identity of the caller, read with `c.get('organizationId')` and so on. */
interface AuthVariables {
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
* Creates Hono middleware that requires a valid `Authorization: Bearer` access token. On success
* it sets organizationId, userId, role and region; on failure it throws an AppError: 401 with
* `auth.unauthenticated`, `auth.token_expired` or `auth.token_invalid`, or 503 with
* `auth.unavailable` when the signing keys could not be loaded or verification threw.
*/
declare function createAuthMiddleware(options: AuthMiddlewareOptions): MiddlewareHandler<AuthEnv>;
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
import { z as z2 } from "zod";
/** The deployment environments a service can run in, from its `ENVIRONMENT` variable. */
declare const ENVIRONMENTS: readonly ["local", "dev", "staging", "prod"];
/** One of the deployment environments. */
type Environment = (typeof ENVIRONMENTS)[number];
/** Zod schema for the `ENVIRONMENT` variable. */
declare const environmentSchema: z2.ZodEnum<{
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
declare const sentryDsnSchema: z2.ZodPreprocess<z2.ZodOptional<z2.ZodString>, unknown>;
/**
* Refinement for a service's env object: `SENTRY_DSN` may be missing in `local` and must be set in
* `dev`, `staging` and `prod`, where it must use `https:`. Use it as `z.object({ ENVIRONMENT, SENTRY_DSN, ... }).superRefine(requireSentryDsn)`
* so boot fails when a deployed service has no error tracker.
*/
declare function requireSentryDsn(env: {
	ENVIRONMENT: Environment;
	SENTRY_DSN?: string | undefined;
}, ctx: z2.RefinementCtx): void;
/** The header that carries a call's idempotency key. */
declare const INTERNAL_IDEMPOTENCY_HEADER = "Idempotency-Key";
/** The default bound on one attempt, connecting to the last byte of the answer. */
declare const INTERNAL_DEFAULT_TIMEOUT_MS = 5e3;
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
*/
declare const INTERNAL_CALL_FAILURES: readonly ["connection", "timeout", "aborted", "redirect", "response_too_large", "response_invalid"];
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
};
/** A client for calls from one Closeline service to another. */
interface InternalClient {
	/**
	* Sends the call and resolves with any answer that was not a redirect, including 4xx and 5xx.
	* Rejects with {@link InternalCallError} when there is none. Retries only a connection failure,
	* a timeout, 429, 502, 503 and 504, and only when the method is idempotent or a key is given.
	*/
	request(call: InternalRequest): Promise<InternalResponse>;
}
/**
* Builds the client for calls from this service to one other service (ADR 0013).
*
* It uses `node:http` and `node:https` with `agent: false`, never `fetch`: Bun's `fetch` sends a
* request to the proxy named by `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` (and their lower-case
* forms) unless `NO_PROXY` names the host, and the bearer secret would travel with it. The
* `node:` transport reads no proxy variable, so nothing in the environment can reroute a call.
* `proxy.test.ts` pins this for the Bun version in use.
*
* Cost per call: one new connection (plus one TLS handshake for https), one request, no
* keep-alive; memory is bounded by `maxResponseBytes`. Redirects are never followed. TLS
* certificates are verified: every https request sets `rejectUnauthorized: true` itself, so
* `NODE_TLS_REJECT_UNAUTHORIZED=0` has no effect on it, and the client is not built at all
* while that variable is `0` outside `local`. `NODE_EXTRA_CA_CERTS` still adds trusted
* authorities, as it does for every process; that is an operator's choice, not a way to skip checks.
*/
declare function createInternalClient(options: InternalClientOptions): InternalClient;
import { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand, SendMessageBatchCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import { z as z3 } from "zod";
/** The largest message body SQS accepts, in bytes (256 KiB). Every adapter enforces it. */
declare const MAX_MESSAGE_BYTES = 262144;
/** `organization` messages belong to one Organization and carry its id; `global` ones never do. */
type MessageScope = "organization" | "global";
/** What one kind of message is: its name, its current version, its scope and its payload schema. */
interface MessageDefinition<
	T extends string = string,
	P extends z3.ZodType = z3.ZodType,
	S extends MessageScope = MessageScope
> {
	readonly type: T;
	readonly version: number;
	readonly scope: S;
	readonly payload: P;
}
/** A definition of any type, for code that accepts every kind. */
type AnyDefinition = MessageDefinition<string, z3.ZodType, MessageScope>;
/**
* Declares a message type. `type` looks like `area.event_name` (`core.organization_created`);
* `version` is a positive integer you raise when the payload changes incompatibly. A consumer
* accepts only the version its registry holds, so a newer message waits in the queue (and reaches
* the dead-letter queue) until the consumer is deployed with the new definition.
*/
declare function defineMessage<
	const T extends string,
	P extends z3.ZodType,
	const S extends MessageScope
>(definition: {
	type: T;
	version: number;
	scope: S;
	payload: P;
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
type EnvelopeOf<D> = D extends MessageDefinition<infer T, infer P, infer S> ? EnvelopeBase<T, z3.output<P>> & ScopeField<S> : never;
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
	payload: z3.input<P>;
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
}
/**
* Builds a registry from the message definitions a service knows. Two definitions with the same
* type are a mistake and throw.
*/
declare function createMessageRegistry<const D extends AnyDefinition>(definitions: readonly D[], options?: MessageRegistryOptions): MessageRegistry<D>;
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
import { Region as Region3 } from "tula-closeline-contract";
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
/**
* Waits `ms` milliseconds, or less when `signal` aborts. Resolves either way, never rejects, so a
* loop that sleeps checks its own stop flag. Injected so tests drive time by hand.
*/
type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
/** The real {@link Sleep}, on `setTimeout`. */
declare const systemSleep: Sleep;
/** Identifies one message for one consumer: what "already processed" is recorded against. */
interface ConsumedKey {
	/** The consumer's name, so two consumers of different queues in one service do not collide. */
	consumer: string;
	/** The Organization the message belongs to, or null for a global message. Part of the key on purpose. */
	organizationId: string | null;
	/** The envelope id. */
	messageId: string;
}
/** What {@link ProcessedStore.claim} answers. */
type ClaimResult = {
	status: "claimed";
	token: string;
} | {
	status: "done";
} | {
	status: "busy";
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
	*/
	claim(key: ConsumedKey, leaseSeconds: number): Promise<ClaimResult>;
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
	/** How long an invalid or unhandled message stays hidden before the next look, in seconds; default 60. */
	invalidDelaySeconds?: number;
}
/** What {@link Consumer.stop} did with the messages in flight. */
interface StopResult {
	/** Messages whose handling ended before the deadline, over the consumer's life. */
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
/**
* Picks the error reporter for a service: the Sentry adapter when a DSN is given, otherwise the
* no-op one, so `local` and tests run without Sentry. The DSN is per Region (ADR 0001): give each
* deployment the DSN of a Sentry project in its own data region; the kit sends to whatever it is given.
*/
declare function createErrorReporter(options: ErrorReporterOptions): ErrorReporter;
/** Returns the reporter that sends nothing, used when no DSN is configured; it costs one empty call. It is one shared object with no state, so `flush` after `close` is still true: there is nothing to deliver. */
declare function createNoopErrorReporter(): ErrorReporter;
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
/** This library's package name, so a consumer can report which shared libraries it resolved. */
declare const PACKAGE = "tula-closeline-kit";
export { AnyDefinition, AnyEnvelope, AppError, AppErrorInit, AuthEnv, AuthMiddlewareOptions, AuthVariables, BatchFailure, BatchResult, ClaimResult, Clock, ConsumedKey, Consumer, ConsumerOptions, CreateInput, DecodeResult, Delivery, ENVIRONMENTS, EnvelopeBase, EnvelopeOf, Environment, ErrorBody, ErrorContext, ErrorReporter, ErrorReporterOptions, FixedClock, HandlerContext, Handlers, INTERNAL_CALL_FAILURES, INTERNAL_DEFAULT_MAX_RESPONSE_BYTES, INTERNAL_DEFAULT_RETRY, INTERNAL_DEFAULT_TIMEOUT_MS, INTERNAL_IDEMPOTENCY_HEADER, INTERNAL_MAX_ATTEMPTS, INTERNAL_MAX_REQUEST_BYTES, INTERNAL_RETRY_STATUSES, INVALID_REASONS, InternalCallError, InternalCallFailure, InternalClient, InternalClientOptions, InternalMethod, InternalRequest, InternalResponse, InternalRetryPolicy, InvalidDelivery, InvalidReason, Jwks, KeySet, LogDestination, LogLevel, Logger, LoggerOptions, MAX_BATCH_SIZE, MAX_JWKS_BYTES, MAX_JWKS_KEYS, MAX_MESSAGE_BYTES, MAX_TOKEN_LENGTH, MAX_VISIBILITY_SECONDS, MAX_WAIT_SECONDS, MessageDefinition, MessageRegistry, MessageRegistryOptions, MessageScope, PACKAGE, ProcessedStore, QUEUE_ERROR_CODES, Queue, QueueError, QueueErrorCode, Receipt, ReceiveOptions, RemoteKeySet, RemoteKeySetOptions, SQS_DEFAULT_MAX_ATTEMPTS, SQS_DEFAULT_TIMEOUT_MS, Sleep, SqsQueueOptions, SqsSender, StopResult, TokenRejection, TokenVerificationError, TokenVerifier, TokenVerifierOptions, ValidDelivery, VerifiedToken, accessTokenClaimsSchema, assertBatchCount, assertReceiveOptions, assertVisibility, createAuthMiddleware, createConsumer, createErrorReporter, createFixedClock, createInternalClient, createLogger, createMemoryProcessedStore, createMessageRegistry, createNoopErrorReporter, createRemoteKeySet, createSqsQueue, createStaticKeySet, createTokenVerifier, cutText, defineMessage, environmentSchema, isAppError, isSentryDsn, requireSentryDsn, scrubText, sentryDsnSchema, shouldReportError, systemClock, systemSleep, toErrorBody };
