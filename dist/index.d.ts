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
/**
* Waits `ms` milliseconds, or less when `signal` aborts. Resolves either way, never rejects, so a
* loop that sleeps checks its own stop flag. Injected so tests drive time by hand.
*/
type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
/** The real {@link Sleep}, on `setTimeout`. */
declare const systemSleep: Sleep;
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
/** Decides whether a string is an Organization id this deployment accepts. */
type OrganizationIdCheck = (value: string) => boolean;
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
	payload: z3.ZodType;
	/** Turns a validated old payload into the current payload's input. A throw makes the message invalid. */
	upcast: (payload: unknown) => unknown;
}
/** A definition of any type, for code that accepts every kind. */
type AnyDefinition = MessageDefinition<string, z3.ZodType, MessageScope>;
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
	P extends z3.ZodType,
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
	/**
	* The shape of an Organization id, checked for `organization` messages on the way in and out.
	* Defaults to the contract's `organizationIdSchema` (`org_` and 32 lower-case hex digits).
	*/
	organizationIdSchema?: z3.ZodType<string>;
}
/**
* Builds a registry from the message definitions a service knows. Two definitions with the same
* type are a mistake and throw.
*/
declare function createMessageRegistry<const D extends AnyDefinition>(definitions: readonly D[], options?: MessageRegistryOptions): MessageRegistry<D>;
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
export { AnyDefinition, AnyEnvelope, AppError, AppErrorInit, AttributeValue, AudioReference, AuthEnv, AuthMiddlewareOptions, AuthVariables, BatchFailure, BatchResult, ByteStream, CONTACT_GUARD_RETRY_DELAY_MS, CONTACT_GUARD_TIMEOUT_MS, CONTACT_UNAVAILABLE, ClaimResult, Clock, ConsumedKey, ContactGuard, ContactGuardRequest, ContactGuardResult, CreateInput, DEFAULT_CONTENT_TYPE, DEFAULT_LIST_LIMIT, DEFAULT_MAX_OBJECT_BYTES, DEFAULT_PRESIGN_SECONDS, DEFAULT_TRANSCRIBER_LIST_LIMIT, DecodeResult, Delivery, ENVIRONMENTS, EnvelopeBase, EnvelopeOf, Environment, ErrorBody, ErrorContext, ErrorReporter, ErrorReporterOptions, FixedClock, HttpContactGuard, HttpContactGuardOptions, INTERNAL_CALL_FAILURES, INTERNAL_DEFAULT_IDLE_TIMEOUT_MS, INTERNAL_DEFAULT_MAX_FREE_SOCKETS, INTERNAL_DEFAULT_MAX_RESPONSE_BYTES, INTERNAL_DEFAULT_MAX_SOCKETS, INTERNAL_DEFAULT_RETRY, INTERNAL_DEFAULT_TIMEOUT_MS, INTERNAL_IDEMPOTENCY_HEADER, INTERNAL_MAX_ATTEMPTS, INTERNAL_MAX_REQUEST_BYTES, INTERNAL_RETRY_STATUSES, INVALID_REASONS, InternalCallError, InternalCallFailure, InternalClient, InternalClientOptions, InternalMethod, InternalRequest, InternalResponse, InternalRetryPolicy, InvalidDelivery, InvalidReason, Jwks, KeySet, ListOptions, ListPage, LogDestination, LogLevel, Logger, LoggerOptions, MAX_ATTRIBUTES, MAX_ATTRIBUTE_STRING, MAX_AUDIO_MS, MAX_AUDIO_URL_LENGTH, MAX_BATCH_SIZE, MAX_CHANNELS, MAX_CLIENT_REFERENCE_LENGTH, MAX_DELETE_BATCH, MAX_DIMENSIONS, MAX_JWKS_BYTES, MAX_JWKS_KEYS, MAX_KEY_BYTES, MAX_KEY_SEGMENTS, MAX_LIST_LIMIT, MAX_MESSAGE_BYTES, MAX_OBJECT_BYTES_LIMIT, MAX_PRESIGN_SECONDS, MAX_SPEAKERS, MAX_SPEAKER_LABEL, MAX_STREAM_BYTES_LIMIT, MAX_TOKEN_LENGTH, MAX_TOP_K, MAX_TRANSCRIBER_LIST_LIMIT, MAX_TRANSCRIPT_CHARS, MAX_TRANSCRIPT_RESPONSE_BYTES, MAX_TRANSCRIPT_TURNS, MAX_TURN_TEXT, MAX_UPSERT_BATCH, MAX_VECTOR_ID_LENGTH, MAX_VENDOR_ID_LENGTH, MAX_VISIBILITY_SECONDS, MAX_WAIT_SECONDS, MessageDefinition, MessageRegistry, MessageRegistryOptions, MessageScope, ObjectEntry, ObjectInfo, ObjectStore, ObjectStream, OrganizationIdCheck, PACKAGE, PresignOptions, PreviousVersion, ProcessedStore, PutOptions, PutStreamOptions, PutStreamResult, QUEUE_ERROR_CODES, Queue, QueueError, QueueErrorCode, Receipt, ReceiveOptions, RemoteKeySet, RemoteKeySetOptions, ResultContext, STORAGE_ERROR_CODES, STREAM_IDLE_TIMEOUT_MS, SearchHit, SearchQuery, Sleep, SpeakerMode, StorageError, StorageErrorCode, StoredObject, Submission, TRANSCRIBER_ERROR_CODES, TRANSCRIPTION_FAILURES, TokenRejection, TokenVerificationError, TokenVerifier, TokenVerifierOptions, TranscribeRequest, Transcriber, TranscriberError, TranscriberErrorCode, TranscriptTurn, TranscriptionEntry, TranscriptionFailure, TranscriptionListOptions, TranscriptionPage, TranscriptionResult, VECTOR_ERROR_CODES, ValidDelivery, VectorAttributes, VectorError, VectorErrorCode, VectorRecord, VectorStore, VendorIdHint, VerifiedToken, WaitOptions, accessTokenClaimsSchema, assertBatchCount, assertReceiveOptions, assertVisibility, checkTranscriptionResult, createAuthMiddleware, createErrorReporter, createFixedClock, createHttpContactGuard, createInternalClient, createLogger, createMemoryProcessedStore, createMessageRegistry, createNoopErrorReporter, createRemoteKeySet, createStaticKeySet, createTokenVerifier, cutText, defineMessage, dropHighSurrogate, environmentSchema, isAppError, isContactGuardRequest, isSentryDsn, requireSentryDsn, scrubText, sentryDsnSchema, shouldReportError, systemClock, systemSleep, toErrorBody, waitForTranscription, withCaller };
