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
export { CapturedError, DEFAULT_TEST_ORGANIZATION_ID, DEFAULT_TEST_USER_ID, LogEntry, MemoryErrorReporter, MemoryLogger, MintTokenOptions, TestDeps, TestKeyPair, createMemoryErrorReporter, createMemoryLogger, createTestDeps, createTestJwks, createTestKeyPair, mintTestToken, testOrganizationId, testUserId };
