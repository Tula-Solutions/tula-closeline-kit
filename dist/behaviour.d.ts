import { OrganizationId as OrganizationId3 } from "tula-closeline-contract";
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
import { OrganizationId } from "tula-closeline-contract";
/** What {@link CalendarConnection}'s constructor takes. */
interface CalendarConnectionInit {
	/** The Organization the Rep belongs to. */
	organizationId: OrganizationId;
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
	readonly organizationId: OrganizationId;
	/** The vendor name. */
	readonly provider: string;
	/** The non-secret id of the connection. */
	readonly connectionId: string;
	constructor(init: CalendarConnectionInit);
	/** The vendor credential. For the adapter that issued the connection and for encrypted storage only; never log it. */
	unsafeCredential(): string;
	/** The non-secret parts, for `JSON.stringify`. */
	toJSON(): {
		organizationId: OrganizationId;
		provider: string;
		connectionId: string;
	};
	/** A readable label without the credential. */
	toString(): string;
}
import { OrganizationId as OrganizationId2 } from "tula-closeline-contract";
/** How an adapter retries a retryable vendor error (`calendar.unavailable`) before giving up. */
interface CalendarRetryPolicy {
	/** The most retries after the first attempt, 0 to 5; 0 never retries. Default 2. */
	maxRetries?: number;
	/** The base of the pause before a retry, in ms, 1 to 60000; doubled each time and jittered. Default 200. */
	baseDelayMs?: number;
	/** The longest pause before a retry, in ms, before jitter, at least the base and at most 60000. Default 2000. */
	maxDelayMs?: number;
}
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
	organizationId: OrganizationId2;
	/** The connection to use. */
	connection: CalendarConnection;
}
/** A request to connect a calendar. */
interface CalendarConnectRequest {
	/** The Organization the Rep belongs to. */
	organizationId: OrganizationId2;
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
* request id the vendor (or the adapter) uses to recognise a repeat. `connect` is the exception:
* an authorization code is single-use, so it is never retried; the caller retries with a new grant. Failures are `CalendarError`s
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
	*/
	revoke(request: CalendarRequestBase, options?: CalendarCallOptions): Promise<void>;
}
/** What the behaviour suite needs from an adapter under test. */
interface CalendarSubject {
	/** The port under test. */
	port: CalendarPort;
	/** Two unrelated Organization ids the port accepts. */
	organizations: {
		a: OrganizationId3;
		b: OrganizationId3;
	};
	/** The reporter the port was built with: the suite reads what it was given. */
	reporter: MemoryErrorReporter;
	/** Everything the port logged, one JSON or text line per entry. */
	logs(): string[];
	/** A grant of `kind` the vendor accepts, whose secret part (code or refresh token) is `secret`. */
	acceptedGrant(secret: string, kind?: CalendarGrant["kind"]): CalendarGrant;
	/** A grant the vendor refuses. */
	refusedGrant(): CalendarGrant;
	/** Puts a busy block on the calendar that none of our events made, such as the Rep's own meeting. */
	addBusy(connection: CalendarConnection, interval: BusyInterval): void;
	/** Arranges that the next vendor request never answers, until it is aborted. */
	hang(): void;
	/** Arranges that the next `times` vendor requests fail: `retryable` as throttling or a 5xx, `fatal` as a refusal. */
	failNext(kind: "retryable" | "fatal", times: number): void;
	/** Arranges that the next `times` vendor requests take effect but their response is lost; leave out when the vendor cannot be made to. */
	loseResponse?(times: number): void;
	/** The Rep revokes access at the vendor, outside our own `revoke`. */
	revokeAtProvider(connection: CalendarConnection): void;
	/** How many requests have reached the vendor, a retry counting as its own. */
	vendorRequests(): number;
	/** How many vendor requests were aborted while they were still pending. */
	abortedRequests(): number;
	/** Removes what the subject created. */
	close(): Promise<void>;
}
/**
* The behaviour every {@link import('./port').CalendarPort} must show: a grant becomes an opaque
* connection whose tokens never reach a string, JSON or log; busy times come back sorted, merged
* and clipped; an event write is idempotent by request id (also when a response is lost and the
* call retries) and a different event under the same id is refused; a failing provider leaves no
* half-written event and only a retryable failure is retried, a bounded number of times; a revoked
* connection fails every call with `calendar.revoked`; the timeout and the caller's signal abort
* the vendor request; a bad request never reaches the vendor; and no token, title, note or address
* reaches a log, the error reporter or an error. Run it against the memory adapter and any real
* adapter (which needs a subject that drives the vendor's test mode).
*/
declare function calendarBehaviour(name: string, make: () => Promise<CalendarSubject>, skip?: boolean): void;
import { ContactDenialCode as ContactDenialCode2, SuppressionReason as SuppressionReason2 } from "tula-closeline-contract";
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
/** Who a preset is about: an Organization and exactly one of a Prospect id or an address. */
type ContactTarget = Pick<ContactGuardRequest, "organizationId" | "prospectId" | "email" | "phone" | "linkedinUrl">;
/** What the behaviour suite needs from a {@link ContactGuard} under test. */
interface ContactGuardSubject {
	/** The guard under test, with nothing preset: an unknown target is denied. */
	guard: ContactGuard;
	/** Makes the check answer allowed for `target` on `channel`. */
	allow(target: ContactTarget, channel: ContactGuardRequest["channel"]): void;
	/** Makes the check answer denied with `code` for `target` on `channel`. */
	deny(target: ContactTarget, channel: ContactGuardRequest["channel"], code: Exclude<ContactDenialCode2, "consent.unavailable">, suppressionReason?: SuppressionReason2): void;
	/** Makes the check unreachable, as if core did not answer. */
	makeUnavailable(): void;
	/** The requests that reached the check, in order. */
	reached(): readonly ContactGuardRequest[];
	/** Removes what the subject created. */
	close(): Promise<void>;
}
/**
* The behaviour every {@link ContactGuard} must show: it answers what the check answers, an
* unknown target is denied, and anything that is not a clear answer is a denial with
* `consent.unavailable`; it never throws and never allows by default. Run it against the memory
* adapter and the HTTP adapter.
*/
declare function contactGuardBehaviour(name: string, make: () => Promise<ContactGuardSubject>): void;
import { OrganizationId as OrganizationId5 } from "tula-closeline-contract";
import { OrganizationId as OrganizationId4 } from "tula-closeline-contract";
import { z as z2 } from "zod";
/**
* The model class a caller wants, never a vendor model id: `fast` for the live loop (low latency,
* short answers) and `smart` for work that can wait longer for a better answer. An adapter maps
* each tier to the model ids it uses.
*/
type ModelTier = "fast" | "smart";
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
	organizationId: OrganizationId4;
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
interface LlmCompleteRequest<S extends z2.ZodType = z2.ZodType> extends LlmRequestBase {
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
	complete<S extends z2.ZodType>(request: LlmCompleteRequest<S>): Promise<LlmCompletion<z2.output<S>>>;
	/**
	* Streams free text. An unacceptable request throws `llm.invalid_request` or
	* `llm.input_too_large` from this call; every later failure is thrown from the iteration. The
	* stream ends with one `done` event. Leaving the loop early (`break`) aborts the vendor
	* request. The time limit covers the whole stream.
	*/
	stream(request: LlmStreamRequest): AsyncIterable<LlmStreamEvent>;
}
/** What the behaviour suite needs from an adapter under test. */
interface LlmSubject {
	/** The port under test. */
	port: LlmPort;
	/** Two unrelated Organization ids the port accepts. */
	organizations: {
		a: OrganizationId5;
		b: OrganizationId5;
	};
	/** The reporter the port was built with: the suite reads what it was given. */
	reporter: MemoryErrorReporter;
	/** Everything the port logged, one JSON or text line per entry. */
	logs(): string[];
	/** Arranges that the next call that reaches the model is answered with `text`. */
	reply(text: string, usage?: Partial<LlmUsage>): void;
	/** Arranges that the next call that reaches the model never answers, until it is aborted. */
	hang(): void;
	/** Arranges that the next `times` vendor requests fail: `retryable` as throttling or a 5xx, `fatal` as refused credentials. */
	failNext(kind: "retryable" | "fatal", times: number): void;
	/** How many requests have reached the vendor, a retry counting as its own. */
	vendorRequests(): number;
	/** How many vendor requests were aborted while they were still pending. */
	abortedRequests(): number;
	/** Removes what the subject created. */
	close(): Promise<void>;
}
/**
* The behaviour every {@link LlmPort} must show: a structured answer comes back typed with its
* usage; output that is not JSON, does not fit the schema or was cut off is `llm.invalid_output`
* and never a partial value; the timeout and the caller's signal abort the vendor request; a
* prompt over the input budget never reaches the vendor; a stream delivers text then one `done`
* and a reader that stops early aborts the request; only retryable vendor errors are retried and
* only a bounded number of times; a bad request is refused before any vendor call; and neither a
* prompt nor a completion reaches a log, the error reporter or an error. Run it against the
* memory adapter and any real adapter (which needs a subject that drives the vendor's test mode).
*/
declare function llmBehaviour(name: string, make: () => Promise<LlmSubject>, skip?: boolean): void;
import { z as z3 } from "zod";
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
import { z as z4 } from "zod";
/** A message that belongs to an Organization, for tests and examples. */
declare const testPing: MessageDefinition<"test.ping", z4.ZodObject<{
	n: z4.ZodNumber;
}, z4.core.$strip>, "organization">;
/** A message that belongs to no Organization, for tests and examples. */
declare const testNote: MessageDefinition<"test.note", z4.ZodObject<{
	text: z4.ZodString;
}, z4.core.$strip>, "global">;
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
	/**
	* Fetches a presigned URL the way a vendor would and returns the body, or `undefined` for a 404
	* or a refusal. The memory adapter resolves its own URLs; the S3 subject does a real GET.
	*/
	readPresigned(url: string): Promise<Uint8Array | undefined>;
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
import { CallId as CallId2, OrganizationId as OrganizationId7 } from "tula-closeline-contract";
import { CallId, OrganizationId as OrganizationId6 } from "tula-closeline-contract";
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
	organizationId: OrganizationId6;
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
/** The words the vendor is arranged to hear once the stream has been sent enough audio. */
interface HeardTurn {
	/** The words, separated by spaces: at least three. */
	text: string;
}
/** What the behaviour suite needs from an adapter under test. */
interface StreamingTranscribeSubject {
	/** The port under test, with no streams for the Organizations below. */
	port: StreamingTranscribePort;
	/** Two unrelated Organization ids the port accepts. */
	organizations: {
		a: OrganizationId7;
		b: OrganizationId7;
	};
	/** The reporter the port was built with: the suite reads what it was given. */
	reporter: MemoryErrorReporter;
	/** Everything the port logged, one JSON or text line per entry. */
	logs(): string[];
	/**
	* Arranges that the stream to be opened for this Call and track hears `turns`, one after
	* another: the first once the stream has been sent `bytesPerTurn` bytes, the next after twice
	* that, and so on. Called before `open`.
	*/
	hear(organizationId: OrganizationId7, callId: CallId2, track: StreamTrack, turns: readonly HeardTurn[], bytesPerTurn: number): void;
	/** Drops the connection of a stream, as the vendor's socket closing would; resolves once it is back or has failed. */
	dropConnection(streamId: string): Promise<void>;
	/** Makes the next `times` reconnect attempts fail. */
	failReconnects(times: number): void;
	/** Removes what the subject created, including every vendor stream. */
	close(): Promise<void>;
}
/**
* The behaviour every {@link StreamingTranscribePort} must show: interims come before the final
* of a turn and the end-of-turn mark is on the last final only; word times are continuous; a
* dropped stream reconnects within its bounded attempts and keeps going; one that cannot be
* restored ends with one `failed` event and one report of metadata; closing is idempotent and
* ends the events; one live stream per Call and track; Organizations are separate; and neither
* audio nor transcript text reaches a log or the error reporter. Run it against the memory
* adapter and any real adapter (which needs a subject that drives the vendor's test mode).
*/
declare function streamingTranscribeBehaviour(name: string, make: () => Promise<StreamingTranscribeSubject>, skip?: boolean): void;
import { OrganizationId as OrganizationId10 } from "tula-closeline-contract";
import { CallId as CallId3, MembershipId, OrganizationId as OrganizationId8, SoftphoneToken, VoiceCallFailureReason } from "tula-closeline-contract";
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
	organizationId: OrganizationId8;
	/** The provider's id of the call leg to the Prospect: opaque, 1 to 128 of letters, digits, `.`, `_`, `:` and `-`. */
	providerCallId: string;
}
/** The call a service asks the provider to place to a Prospect. */
interface PlaceCallRequest {
	/** The Organization. */
	organizationId: OrganizationId8;
	/** Our id of the Call, kept by the adapter as a tag on the provider call; it never leaves the provider as speech. */
	callId: CallId3;
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
	callId: CallId3;
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
	organizationId: OrganizationId8;
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
	organizationId: OrganizationId8;
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
	organizationId: OrganizationId8;
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
/** The operations a test can make fail or stall. */
type TelephonyOperation = "placeCall" | "answerCall" | "playDisclosure" | "bridge" | "startRecording" | "forkTracks" | "hangUp" | "fetchRecording" | "deleteRecording" | "mintBrowserToken";
/** A webhook request that carries a signature. */
interface SignedWebhook extends WebhookRequest {
	/** The valid signature. */
	signature: string;
}
/** What a Prospect at a dialed number does, in the scenarios the suite needs. */
type ProspectScenario = "answers" | "no_answer" | "busy" | "hangs_up_during_disclosure" | "carrier_failure";
/** What the behaviour suite needs from an adapter under test. */
interface TelephonySubject {
	/** The port under test, with no calls for the Organizations below. */
	telephony: TelephonyPort;
	/** Two unrelated Organization ids the port accepts. */
	organizations: {
		a: OrganizationId10;
		b: OrganizationId10;
	};
	/** Returns a number (E.164) that, when dialed, plays out as `scenario`. */
	numberFor(scenario: ProspectScenario): string;
	/** Makes a provider call arrive on a Line, as an inbound webhook would; returns its provider id. */
	receiveInbound(organizationId: string): string | Promise<string>;
	/** Has the Prospect on a call hang up now. */
	prospectHangsUp(organizationId: string, providerCallId: string): void | Promise<void>;
	/** Makes the next call of `operation` never get an answer from the provider. */
	stallNext(operation: TelephonyOperation): void;
	/** Makes the next call of `operation` fail at the provider, as `telephony.unavailable`. */
	failNext(operation: TelephonyOperation): void;
	/** Returns the events the provider has reported since the last call, in order. */
	takeEvents(): TelephonyEvent[] | Promise<TelephonyEvent[]>;
	/** The signed webhook the provider would send for `event`. */
	signedWebhook(event: TelephonyEvent): SignedWebhook;
	/** Removes what the subject created, including every provider call and Recording. */
	close(): Promise<void>;
}
/**
* The behaviour every {@link TelephonyPort} must show: calls are scoped to their Organization;
* placing is idempotent; the Disclosure must play before a Rep is bridged, a Recording starts or
* tracks are forked, and no request can skip it; the Recording has two channels and can be
* fetched after the call and deleted; webhooks verify in constant time and refuse a wrong, short,
* long or missing signature; the browser token is short-lived; and every operation gives up after
* its timeout and reports a failing provider as `telephony.unavailable`. Run it against the memory
* adapter and any real adapter (which needs a subject that drives the provider's test mode).
*/
declare function telephonyBehaviour(name: string, make: () => Promise<TelephonySubject>, skip?: boolean): void;
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
	/**
	* Opens another instance of the same adapter over the same vendor state, as a restarted service
	* would, so a real-adapter run can submit through one instance and list and delete through
	* another. The stand-in has no storage outside itself, so its `reopen` may return the same
	* store.
	*/
	reopen(): Promise<Transcriber>;
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
export { CalendarSubject, ContactGuardSubject, HeardTurn, LlmSubject, ObjectStoreSubject, ProspectScenario, QueueSubject, StoreSubject, StreamingTranscribeSubject, TelephonySubject, TranscriberSubject, VectorStoreSubject, calendarBehaviour, contactGuardBehaviour, llmBehaviour, objectStoreBehaviour, processedStoreBehaviour, queueBehaviour, streamingTranscribeBehaviour, telephonyBehaviour, transcriberBehaviour, vectorStoreBehaviour };
