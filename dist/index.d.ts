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
import { OrganizationId as OrganizationId3 } from "tula-closeline-contract";
import { z as z3 } from "zod";
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
	organizationId: OrganizationId3;
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
interface LlmCompleteRequest<S extends z3.ZodType = z3.ZodType> extends LlmRequestBase {
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
	/** The tokens used, over all attempts that reached the model. */
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
	complete<S extends z3.ZodType>(request: LlmCompleteRequest<S>): Promise<LlmCompletion<z3.output<S>>>;
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
/** Decides whether a string is an Organization id this deployment accepts. */
type OrganizationIdCheck = (value: string) => boolean;
import { z as z4 } from "zod";
/** The largest message body SQS accepts, in bytes (256 KiB). Every adapter enforces it. */
declare const MAX_MESSAGE_BYTES = 262144;
/** `organization` messages belong to one Organization and carry its id; `global` ones never do. */
type MessageScope = "organization" | "global";
/** What one kind of message is: its name, its current version, its scope and its payload schema. */
interface MessageDefinition<
	T extends string = string,
	P extends z4.ZodType = z4.ZodType,
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
	payload: z4.ZodType;
	/** Turns a validated old payload into the current payload's input. A throw makes the message invalid. */
	upcast: (payload: unknown) => unknown;
}
/** A definition of any type, for code that accepts every kind. */
type AnyDefinition = MessageDefinition<string, z4.ZodType, MessageScope>;
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
	P extends z4.ZodType,
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
type EnvelopeOf<D> = D extends MessageDefinition<infer T, infer P, infer S> ? EnvelopeBase<T, z4.output<P>> & ScopeField<S> : never;
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
	payload: z4.input<P>;
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
	organizationIdSchema?: z4.ZodType<string>;
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
import { CallId, OrganizationId as OrganizationId4 } from "tula-closeline-contract";
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
	organizationId: OrganizationId4;
	/** Our id of the Call; with the track it names the stream: a second live stream for both is `streaming_transcribe.conflict`. */
	callId: CallId;
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
import { CallId as CallId2, MembershipId, OrganizationId as OrganizationId5, SoftphoneToken, VoiceCallFailureReason } from "tula-closeline-contract";
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
	organizationId: OrganizationId5;
	/** The provider's id of the call leg to the Prospect: opaque, 1 to 128 of letters, digits, `.`, `_`, `:` and `-`. */
	providerCallId: string;
}
/** The call a service asks the provider to place to a Prospect. */
interface PlaceCallRequest {
	/** The Organization. */
	organizationId: OrganizationId5;
	/** Our id of the Call, kept by the adapter as a tag on the provider call; it never leaves the provider as speech. */
	callId: CallId2;
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
	callId: CallId2;
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
	organizationId: OrganizationId5;
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
	organizationId: OrganizationId5;
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
	organizationId: OrganizationId5;
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
* Signs a webhook the way Twilio does (`X-Twilio-Signature`): HMAC-SHA1 with the Auth Token over
* the URL followed by each form field's name and value in sorted order, in base64. For tests and
* for simulating Twilio; the adapter itself only verifies.
*/
declare function signTwilioRequest(authToken: string, url: string, params?: Readonly<Record<string, string>> | readonly (readonly [string, string])[]): string;
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
export { AnswerCallRequest, AnsweredCall, AnyDefinition, AnyEnvelope, AppError, AppErrorInit, AttributeValue, AudioEncoding, AudioReference, AuthEnv, AuthMiddlewareOptions, AuthVariables, BatchFailure, BatchResult, BridgeRequest, BrowserTokenRequest, ByteStream, CONTACT_GUARD_RETRY_DELAY_MS, CONTACT_GUARD_TIMEOUT_MS, CONTACT_UNAVAILABLE, ClaimResult, Clock, ClosedEvent, ConsumedKey, ContactGuard, ContactGuardRequest, ContactGuardResult, CreateInput, DEFAULT_CONTENT_TYPE, DEFAULT_LIST_LIMIT, DEFAULT_LLM_MAX_INPUT_TOKENS, DEFAULT_LLM_MAX_OUTPUT_TOKENS, DEFAULT_LLM_RETRY_POLICY, DEFAULT_LLM_TIMEOUT_MS, DEFAULT_MAX_OBJECT_BYTES, DEFAULT_PRESIGN_SECONDS, DEFAULT_RECONNECT_POLICY, DEFAULT_STREAMING_TRANSCRIBE_TIMEOUT_MS, DEFAULT_TELEPHONY_TIMEOUT_MS, DEFAULT_TRANSCRIBER_LIST_LIMIT, DecodeResult, Delivery, DisclosurePlayed, DisclosureWait, ENVIRONMENTS, ESTIMATED_CHARS_PER_TOKEN, EnvelopeBase, EnvelopeOf, Environment, ErrorBody, ErrorContext, ErrorReporter, ErrorReporterOptions, FailedEvent, FetchedRecording, FixedClock, ForkTracksRequest, ForkedTracks, HangUpRequest, HttpContactGuard, HttpContactGuardOptions, INTERNAL_CALL_FAILURES, INTERNAL_DEFAULT_IDLE_TIMEOUT_MS, INTERNAL_DEFAULT_MAX_FREE_SOCKETS, INTERNAL_DEFAULT_MAX_RESPONSE_BYTES, INTERNAL_DEFAULT_MAX_SOCKETS, INTERNAL_DEFAULT_RETRY, INTERNAL_DEFAULT_TIMEOUT_MS, INTERNAL_IDEMPOTENCY_HEADER, INTERNAL_MAX_ATTEMPTS, INTERNAL_MAX_REQUEST_BYTES, INTERNAL_RETRY_STATUSES, INVALID_REASONS, InternalCallError, InternalCallFailure, InternalClient, InternalClientOptions, InternalMethod, InternalRequest, InternalResponse, InternalRetryPolicy, InvalidDelivery, InvalidReason, Jwks, KeySet, LLM_ERROR_CODES, ListOptions, ListPage, LlmCompleteRequest, LlmCompletion, LlmDoneEvent, LlmError, LlmErrorCode, LlmMessage, LlmPort, LlmRequestBase, LlmRetryPolicy, LlmStreamEvent, LlmStreamRequest, LlmTextEvent, LlmUsage, LogDestination, LogLevel, Logger, LoggerOptions, MAX_ATTRIBUTES, MAX_ATTRIBUTE_STRING, MAX_AUDIO_CHUNK_BYTES, MAX_AUDIO_MS, MAX_AUDIO_URL_LENGTH, MAX_BATCH_SIZE, MAX_CHANNELS, MAX_CLIENT_REFERENCE_LENGTH, MAX_DELETE_BATCH, MAX_DIMENSIONS, MAX_DISCLOSURE_TEXT_LENGTH, MAX_JWKS_BYTES, MAX_JWKS_KEYS, MAX_KEY_BYTES, MAX_KEY_SEGMENTS, MAX_LIST_LIMIT, MAX_LLM_MAX_INPUT_TOKENS, MAX_LLM_MAX_OUTPUT_TOKENS, MAX_LLM_MESSAGES, MAX_LLM_TIMEOUT_MS, MAX_MESSAGE_BYTES, MAX_OBJECT_BYTES_LIMIT, MAX_PRESIGN_SECONDS, MAX_REPLAY_AUDIO_BYTES, MAX_RING_LEGS, MAX_SPEAKERS, MAX_SPEAKER_LABEL, MAX_STREAMING_TRANSCRIBE_TIMEOUT_MS, MAX_STREAM_BYTES_LIMIT, MAX_TELEPHONY_TIMEOUT_MS, MAX_TOKEN_LENGTH, MAX_TOP_K, MAX_TRANSCRIBER_LIST_LIMIT, MAX_TRANSCRIPT_CHARS, MAX_TRANSCRIPT_RESPONSE_BYTES, MAX_TRANSCRIPT_TURNS, MAX_TURN_TEXT, MAX_UPSERT_BATCH, MAX_VECTOR_ID_LENGTH, MAX_VENDOR_ID_LENGTH, MAX_VISIBILITY_SECONDS, MAX_WAIT_SECONDS, MAX_WEBHOOK_BODY_BYTES, MAX_WORDS_PER_TURN, MODEL_TIERS, MessageDefinition, MessageRegistry, MessageRegistryOptions, MessageScope, ModelTier, ObjectEntry, ObjectInfo, ObjectStore, ObjectStream, OpenStreamRequest, OrganizationIdCheck, PACKAGE, PlaceCallRequest, PlacedCall, PlayDisclosureRequest, PresignOptions, PreviousVersion, ProcessedStore, ProviderCallRef, PutOptions, PutStreamOptions, PutStreamResult, QUEUE_ERROR_CODES, Queue, QueueError, QueueErrorCode, Receipt, ReceiveOptions, ReconnectPolicy, ReconnectedEvent, ReconnectingEvent, RecordingRef, RemoteKeySet, RemoteKeySetOptions, ResolvedLlmRetryPolicy, ResolvedReconnectPolicy, ResultContext, STORAGE_ERROR_CODES, STREAMING_TRANSCRIBE_ERROR_CODES, STREAM_IDLE_TIMEOUT_MS, SampleRate, SearchHit, SearchQuery, Sleep, SpeakerMode, StartedRecording, StorageError, StorageErrorCode, StoredObject, StreamEvent, StreamTrack, StreamingTranscribeError, StreamingTranscribeErrorCode, StreamingTranscribeOptions, StreamingTranscribePort, Submission, TELEPHONY_ERROR_CODES, TRANSCRIBER_ERROR_CODES, TRANSCRIPTION_FAILURES, TWILIO_DEFAULT_EDGES, TWILIO_REGIONS, TelephonyError, TelephonyErrorCode, TelephonyEvent, TelephonyEventType, TelephonyOptions, TelephonyPort, TokenRejection, TokenVerificationError, TokenVerifier, TokenVerifierOptions, TranscribeRequest, TranscribeStream, TranscribedWord, Transcriber, TranscriberError, TranscriberErrorCode, TranscriptTurn, TranscriptionEntry, TranscriptionFailure, TranscriptionListOptions, TranscriptionPage, TranscriptionResult, TurnEvent, TwilioCallRecord, TwilioOptions, TwilioPlacement, TwilioRegion, TwilioStore, VECTOR_ERROR_CODES, ValidDelivery, VectorAttributes, VectorError, VectorErrorCode, VectorRecord, VectorStore, VendorIdHint, VerifiedToken, WaitOptions, WebhookRequest, accessTokenClaimsSchema, assertBatchCount, assertReceiveOptions, assertVisibility, checkTranscriptionResult, createAuthMiddleware, createErrorReporter, createFixedClock, createHttpContactGuard, createInternalClient, createLogger, createMemoryProcessedStore, createMemoryTwilioStore, createMessageRegistry, createNoopErrorReporter, createRemoteKeySet, createStaticKeySet, createTokenVerifier, createTwilioTelephony, cutText, defineMessage, dropHighSurrogate, environmentSchema, estimateSpeechMs, estimateTokens, isAppError, isContactGuardRequest, isSentryDsn, llmRetryDelayMs, reconnectDelayMs, requireSentryDsn, scrubText, sentryDsnSchema, shouldReportError, signTwilioRequest, systemClock, systemSleep, toErrorBody, twilioApiHost, waitForTranscription, withCaller };
