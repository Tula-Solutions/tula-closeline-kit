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
}
/** Creates a Logger that records redacted entries in memory instead of writing them. */
declare function createMemoryLogger(): MemoryLogger;
/** Creates test deps: a clock fixed at 2026-01-01T00:00:00.000Z and a memory logger. */
declare function createTestDeps(overrides?: Partial<TestDeps>): TestDeps;
export { LogEntry, MemoryLogger, TestDeps, createMemoryLogger, createTestDeps };
