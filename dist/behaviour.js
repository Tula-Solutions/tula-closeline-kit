import {
  AuditError2,
  CalendarConnection2,
  CALENDAR_ERROR_CODES2,
  CalendarError2,
  MAX_BUSY_RANGE_MS2,
  LLM_ERROR_CODES2,
  LlmError2,
  MESSAGING_ERROR_CODES2,
  MessagingError2,
  InboundMessage2,
  MAX_WEBHOOK_BODY_BYTES2,
  checkTranscriptionResult2,
  TTS_ERROR_CODES2,
  TtsError2
} from "./shared/chunk-q819sn0x.js";
import {
  MAX_MESSAGE_BYTES2
} from "./shared/chunk-mjkmsg3r.js";
import {
  waitForTranscription2
} from "./shared/chunk-83cpvtqk.js";

// src/audit/behaviour.ts
import { afterEach, describe, expect, test } from "bun:test";
import { organizationIdSchema } from "tula-closeline-contract";
var ORG_A = organizationIdSchema.parse(`org_${"a".repeat(32)}`);
var ORG_B = organizationIdSchema.parse(`org_${"b".repeat(32)}`);
function sampleAuditEntry(id, overrides = {}) {
  return {
    id,
    organizationId: ORG_A,
    actor: { kind: "agent", id: "agent_inbound" },
    action: "agent.sent_message",
    subject: { type: "prospect", id: `prs_${"1".repeat(32)}` },
    instructionVersion: 3,
    requestId: "req_1",
    metadata: { channel: "sms", attempt: 1, approved: true },
    ...overrides
  };
}
function auditBehaviour(name, make, skip = false) {
  const run = skip ? describe.skip : describe;
  run(`AuditRecorder behaviour: ${name}`, () => {
    const open = [];
    afterEach(async () => {
      await Promise.all(open.splice(0).map((subject) => subject.close()));
    });
    async function subject() {
      const made = await make();
      open.push(made);
      return made;
    }
    async function refused(s, entry, code) {
      const error = await s.recorder.record(entry).then(() => {
        return;
      }, (e) => e);
      expect(error).toBeInstanceOf(AuditError2);
      expect(error.code).toBe(code);
      expect(await s.delivered()).toEqual([]);
    }
    test("records an entry under its event id and Organization", async () => {
      const s = await subject();
      await s.recorder.record(sampleAuditEntry("evt_1"));
      expect(await s.delivered()).toEqual([
        { id: "evt_1", organizationId: ORG_A, action: "agent.sent_message" }
      ]);
    });
    test("recording the same event id again adds no second event", async () => {
      const s = await subject();
      await s.recorder.record(sampleAuditEntry("evt_1"));
      await s.recorder.record(sampleAuditEntry("evt_1"));
      await s.recorder.record(sampleAuditEntry("evt_1"));
      const ids = (await s.delivered()).map((event) => event.id);
      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids)).toEqual(new Set(["evt_1"]));
    });
    test("different event ids are different events, one per Organization", async () => {
      const s = await subject();
      await s.recorder.record(sampleAuditEntry("evt_1"));
      await s.recorder.record(sampleAuditEntry("evt_2", { organizationId: ORG_B }));
      const events = await s.delivered();
      expect(events.map((e) => [e.id, e.organizationId])).toEqual([
        ["evt_1", ORG_A],
        ["evt_2", ORG_B]
      ]);
    });
    test("refuses an unknown field, an unknown actor kind and a bad action code", async () => {
      const s = await subject();
      await refused(s, { ...sampleAuditEntry("evt_1"), message: "hello" }, "audit.invalid_entry");
      await refused(s, sampleAuditEntry("evt_1", { actor: { kind: "robot", id: "x" } }), "audit.invalid_entry");
      await refused(s, sampleAuditEntry("evt_1", { action: "Sent A Message" }), "audit.invalid_entry");
      await refused(s, sampleAuditEntry("evt_1", { organizationId: "org_x" }), "audit.invalid_entry");
    });
    test("refuses metadata with a long string, a denied key, a nested value or too many keys", async () => {
      const s = await subject();
      const bad = [
        { note: "x".repeat(201) },
        { body: "hi" },
        { Transcript: "hi" },
        { E_MAIL: "a@b.c" },
        { nested: { a: 1 } },
        { list: [1] },
        { n: Number.NaN },
        { n: Number.POSITIVE_INFINITY },
        { empty: null },
        Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i]))
      ];
      for (const metadata of bad) {
        await refused(s, sampleAuditEntry("evt_1", { metadata }), "audit.invalid_entry");
      }
    });
    test("accepts metadata at the limits", async () => {
      const s = await subject();
      await s.recorder.record(sampleAuditEntry("evt_1", {
        metadata: {
          note: "x".repeat(200),
          ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, i]))
        }
      }));
      expect((await s.delivered()).length).toBeGreaterThan(0);
    });
    test("refuses an entry whose serialised size is over the cap", async () => {
      const s = await subject();
      const metadata = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`key_${String(i).padStart(2, "0")}`, "y".repeat(200)]));
      await refused(s, sampleAuditEntry("evt_1", { metadata }), "audit.entry_too_large");
    });
    test("never logs a metadata value, recorded or refused", async () => {
      const s = await subject();
      const secret = "sentinel-value-7f3a9c";
      await s.recorder.record(sampleAuditEntry("evt_1", { metadata: { note: secret } }));
      await s.recorder.record(sampleAuditEntry("evt_1", { metadata: { note: secret } }));
      await s.recorder.record(sampleAuditEntry("evt_2", { metadata: { body: secret } })).catch(() => {
        return;
      });
      await s.recorder.record(sampleAuditEntry("evt_3", { metadata: { note: secret.repeat(40) } })).catch(() => {
        return;
      });
      expect(s.logs().join(`
`)).not.toContain(secret);
    });
  });
}
// src/calendar/behaviour.ts
import { afterEach as afterEach2, describe as describe2, expect as expect2, test as test2 } from "bun:test";
import { inspect } from "node:util";
var SECRET_GRANT = "GRANT-MARKER-SECRET";
var SECRET_TITLE = "TITLE-MARKER-ZEBRA";
var SECRET_EMAIL = "prospect-marker@example.com";
var SECRET_NOTE = "NOTE-MARKER-PHONE";
var DAY = 24 * 60 * 60 * 1000;
var WEEK_START = Date.parse("2026-03-02T00:00:00.000Z");
var at = (hours) => new Date(WEEK_START + hours * 3600000).toISOString();
var dayRange = { from: at(0), to: at(24) };
function calendarBehaviour(name, make, skip = false) {
  const run = skip ? describe2.skip : describe2;
  run(`Calendar behaviour: ${name}`, () => {
    const made = [];
    afterEach2(async () => {
      await Promise.all(made.splice(0).map((subject) => subject.close()));
    });
    async function subject() {
      const next = await make();
      made.push(next);
      return next;
    }
    const retry = { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 4 };
    const opts = { retry };
    async function connect(s, secret = "secret-1", org = s.organizations.a) {
      return s.port.connect({ organizationId: org, grant: s.acceptedGrant(secret) }, opts);
    }
    function event(overrides = {}) {
      return { title: "Discovery call", start: at(10), end: at(10.5), ...overrides };
    }
    async function codeOf(promise) {
      try {
        await promise;
        return;
      } catch (error) {
        return error instanceof CalendarError2 ? error.code : `not a CalendarError: ${String(error)}`;
      }
    }
    async function busy(s, connection, range = dayRange) {
      return s.port.busy({ organizationId: connection.organizationId, connection, ...range }, opts);
    }
    function create(s, connection, requestId, overrides = {}, options = opts) {
      return s.port.createEvent({
        organizationId: connection.organizationId,
        connection,
        requestId,
        event: event(overrides)
      }, options);
    }
    test2("a grant becomes a connection for the Organization, from a code or a refresh token", async () => {
      const s = await subject();
      const fromCode = await connect(s);
      expect2(fromCode).toBeInstanceOf(CalendarConnection2);
      expect2(fromCode.organizationId).toBe(s.organizations.a);
      expect2(fromCode.connectionId.length).toBeGreaterThan(0);
      expect2(fromCode.provider.length).toBeGreaterThan(0);
      const fromRefresh = await s.port.connect({ organizationId: s.organizations.b, grant: s.acceptedGrant("secret-2", "refresh_token") }, opts);
      expect2(fromRefresh.organizationId).toBe(s.organizations.b);
      expect2(fromRefresh.connectionId).not.toBe(fromCode.connectionId);
    });
    test2("a grant the vendor refuses is calendar.rejected and is not retried", async () => {
      const s = await subject();
      expect2(await codeOf(s.port.connect({ organizationId: s.organizations.a, grant: s.refusedGrant() }, opts))).toBe(CALENDAR_ERROR_CODES2.rejected);
      expect2(s.vendorRequests()).toBe(1);
    });
    test2("the credential is not in the connection string, JSON, spread or console form", async () => {
      const s = await subject();
      const connection = await connect(s, SECRET_GRANT);
      const credential = connection.unsafeCredential();
      expect2(credential.length).toBeGreaterThan(0);
      const forms = [
        String(connection),
        `${connection}`,
        JSON.stringify(connection),
        JSON.stringify({ connection }),
        JSON.stringify({ ...connection }),
        inspect(connection, { depth: 5, showHidden: true }),
        inspect({ nested: [connection] }, { depth: 5 })
      ].join(`
`);
      expect2(forms).not.toContain(credential);
      expect2(forms).not.toContain(SECRET_GRANT);
      expect2(forms).toContain(connection.connectionId);
    });
    test2("busy times come back sorted, merged where they touch or overlap, and clipped to the range", async () => {
      const s = await subject();
      const c = await connect(s);
      expect2(await busy(s, c)).toEqual([]);
      s.addBusy(c, { start: at(12), end: at(13) });
      s.addBusy(c, { start: at(9), end: at(10) });
      s.addBusy(c, { start: at(9.5), end: at(11) });
      s.addBusy(c, { start: at(11), end: at(11.5) });
      s.addBusy(c, { start: at(-3), end: at(1) });
      s.addBusy(c, { start: at(23), end: at(30) });
      expect2(await busy(s, c)).toEqual([
        { start: at(0), end: at(1) },
        { start: at(9), end: at(11.5) },
        { start: at(12), end: at(13) },
        { start: at(23), end: at(24) }
      ]);
      expect2(await busy(s, c, { from: at(14), to: at(20) })).toEqual([]);
    });
    test2("a range that is empty, backwards, not a time or over the limit never reaches the vendor", async () => {
      const s = await subject();
      const c = await connect(s);
      const before = s.vendorRequests();
      const bad = [
        { from: at(5), to: at(5) },
        { from: at(6), to: at(5) },
        { from: "tomorrow", to: at(5) },
        { from: at(0), to: "2026-03-02" },
        { from: at(0), to: new Date(WEEK_START + MAX_BUSY_RANGE_MS2 + DAY).toISOString() }
      ];
      for (const range of bad) {
        expect2(await codeOf(busy(s, c, range))).toBe(CALENDAR_ERROR_CODES2.invalidRequest);
      }
      expect2(s.vendorRequests()).toBe(before);
    });
    test2("a created event is busy time, has an id and a join link when video is asked for", async () => {
      const s = await subject();
      const c = await connect(s);
      const plain = await create(s, c, "req-1");
      expect2(plain).toMatchObject({ created: true, start: at(10), end: at(10.5) });
      expect2(plain.eventId.length).toBeGreaterThan(0);
      expect2(plain.joinUrl).toBeUndefined();
      const video = await create(s, c, "req-2", {
        start: at(14),
        end: at(15),
        conferencing: "video"
      });
      expect2(typeof video.joinUrl).toBe("string");
      expect2(video.eventId).not.toBe(plain.eventId);
      expect2(await busy(s, c)).toEqual([
        { start: at(10), end: at(10.5) },
        { start: at(14), end: at(15) }
      ]);
    });
    test2("creating again with the same request id returns the same event and makes no second one", async () => {
      const s = await subject();
      const c = await connect(s);
      const first = await create(s, c, "req-same");
      const again = await create(s, c, "req-same");
      expect2(again.eventId).toBe(first.eventId);
      expect2(again.created).toBe(false);
      expect2(first.created).toBe(true);
      expect2(await busy(s, c)).toEqual([{ start: at(10), end: at(10.5) }]);
    });
    test2("the same request id with a different event is calendar.invalid_request", async () => {
      const s = await subject();
      const c = await connect(s);
      await create(s, c, "req-reused");
      expect2(await codeOf(create(s, c, "req-reused", { start: at(11), end: at(12) }))).toBe(CALENDAR_ERROR_CODES2.invalidRequest);
      expect2(await busy(s, c)).toEqual([{ start: at(10), end: at(10.5) }]);
    });
    test2("request ids are per connection", async () => {
      const s = await subject();
      const one = await connect(s, "secret-1");
      const two = await connect(s, "secret-2");
      const a = await create(s, one, "req-shared");
      const b = await create(s, two, "req-shared", { start: at(11), end: at(12) });
      expect2(b.created).toBe(true);
      expect2(b.eventId).not.toBe(a.eventId);
    });
    test2("updating moves the busy time, and a replay of the request id changes nothing more", async () => {
      const s = await subject();
      const c = await connect(s);
      const made = await create(s, c, "req-1");
      const update = {
        organizationId: c.organizationId,
        connection: c,
        eventId: made.eventId,
        requestId: "req-2",
        changes: { start: at(16), end: at(17) }
      };
      const moved = await s.port.updateEvent(update, opts);
      expect2(moved).toMatchObject({ eventId: made.eventId, start: at(16), end: at(17) });
      expect2(await busy(s, c)).toEqual([{ start: at(16), end: at(17) }]);
      const replayed = await s.port.updateEvent(update, opts);
      expect2(replayed).toEqual(moved);
      expect2(await busy(s, c)).toEqual([{ start: at(16), end: at(17) }]);
      expect2(await codeOf(s.port.updateEvent({ ...update, changes: { start: at(18), end: at(19) } }, opts))).toBe(CALENDAR_ERROR_CODES2.invalidRequest);
    });
    test2("updating an event that does not exist is calendar.not_found", async () => {
      const s = await subject();
      const c = await connect(s);
      expect2(await codeOf(s.port.updateEvent({
        organizationId: c.organizationId,
        connection: c,
        eventId: "no-such-event",
        requestId: "req-1",
        changes: { title: "New title" }
      }, opts))).toBe(CALENDAR_ERROR_CODES2.notFound);
    });
    test2("an update that leaves the event ending before it starts is refused", async () => {
      const s = await subject();
      const c = await connect(s);
      const made = await create(s, c, "req-1");
      expect2(await codeOf(s.port.updateEvent({
        organizationId: c.organizationId,
        connection: c,
        eventId: made.eventId,
        requestId: "req-2",
        changes: { end: at(9) }
      }, opts))).toBe(CALENDAR_ERROR_CODES2.invalidRequest);
      expect2(await busy(s, c)).toEqual([{ start: at(10), end: at(10.5) }]);
    });
    test2("deleting frees the time; a replay and a second delete of a gone event are not errors", async () => {
      const s = await subject();
      const c = await connect(s);
      const made = await create(s, c, "req-1");
      const del = (requestId, eventId = made.eventId) => s.port.deleteEvent({ organizationId: c.organizationId, connection: c, eventId, requestId }, opts);
      expect2(await del("del-1")).toEqual({ deleted: true });
      expect2(await busy(s, c)).toEqual([]);
      expect2(await del("del-1")).toEqual({ deleted: true });
      expect2(await del("del-2")).toEqual({ deleted: false });
      expect2(await del("del-3", "never-existed")).toEqual({ deleted: false });
    });
    test2("one connection cannot read, change or remove the events of another", async () => {
      const s = await subject();
      const mine = await connect(s, "secret-1", s.organizations.a);
      const theirs = await connect(s, "secret-2", s.organizations.b);
      const made = await create(s, mine, "req-1");
      expect2(await busy(s, theirs)).toEqual([]);
      expect2(await codeOf(s.port.updateEvent({
        organizationId: theirs.organizationId,
        connection: theirs,
        eventId: made.eventId,
        requestId: "req-x",
        changes: { title: "Hijacked" }
      }, opts))).toBe(CALENDAR_ERROR_CODES2.notFound);
      expect2(await s.port.deleteEvent({
        organizationId: theirs.organizationId,
        connection: theirs,
        eventId: made.eventId,
        requestId: "del-x"
      }, opts)).toEqual({ deleted: false });
      expect2(await busy(s, mine)).toEqual([{ start: at(10), end: at(10.5) }]);
    });
    test2("a connection used for another Organization is refused before any vendor call", async () => {
      const s = await subject();
      const c = await connect(s);
      const before = s.vendorRequests();
      expect2(await codeOf(s.port.busy({ organizationId: s.organizations.b, connection: c, ...dayRange }, opts))).toBe(CALENDAR_ERROR_CODES2.invalidRequest);
      expect2(s.vendorRequests()).toBe(before);
    });
    test2("a request that is not acceptable is refused before any vendor call", async () => {
      const s = await subject();
      const c = await connect(s);
      const before = s.vendorRequests();
      const many = Array.from({ length: 21 }, (_, i) => ({ email: `p${i}@example.com` }));
      const bad = [
        { requestId: "" },
        { requestId: "has spaces" },
        { requestId: "x".repeat(129) },
        { event: event({ title: "" }) },
        { event: event({ title: "x".repeat(257) }) },
        { event: event({ start: "soon" }) },
        { event: event({ end: at(10) }) },
        { event: event({ end: at(9) }) },
        { event: event({ end: new Date(WEEK_START + 10 * DAY).toISOString() }) },
        { event: event({ attendees: many }) },
        { event: event({ attendees: [{ email: "not-an-email" }] }) },
        { event: event({ conferencing: "phone" }) },
        { event: event({ surprise: true }) },
        { connection: { connectionId: "forged", credential: "x" } },
        { organizationId: "org_nope" }
      ];
      for (const overrides of bad) {
        const request = {
          organizationId: c.organizationId,
          connection: c,
          requestId: "req-ok",
          event: event(),
          ...overrides
        };
        expect2(await codeOf(s.port.createEvent(request, opts))).toBe(CALENDAR_ERROR_CODES2.invalidRequest);
      }
      const badOptions = [
        { timeoutMs: 0 },
        { timeoutMs: 1e7 },
        { retry: { maxRetries: 99 } },
        { retry: { baseDelayMs: 100, maxDelayMs: 10 } },
        { signal: "stop" }
      ];
      for (const option of badOptions) {
        expect2(await codeOf(create(s, c, "req-ok", {}, option))).toBe(CALENDAR_ERROR_CODES2.invalidRequest);
      }
      expect2(await codeOf(s.port.connect({
        organizationId: s.organizations.a,
        grant: { kind: "refresh_token", refreshToken: "" }
      }, opts))).toBe(CALENDAR_ERROR_CODES2.invalidRequest);
      expect2(s.vendorRequests()).toBe(before);
      expect2(await busy(s, c)).toEqual([]);
    });
    test2("a failing provider is retried a bounded number of times, then calendar.unavailable, and nothing is half-written", async () => {
      const s = await subject();
      const c = await connect(s);
      const before = s.vendorRequests();
      s.failNext("retryable", 10);
      expect2(await codeOf(create(s, c, "req-1"))).toBe(CALENDAR_ERROR_CODES2.unavailable);
      expect2(s.vendorRequests() - before).toBe(3);
      expect2(s.reporter.captured.length).toBeGreaterThan(0);
    });
    test2("after a failed create the same request id makes exactly one event", async () => {
      const s = await subject();
      const c = await connect(s);
      s.failNext("retryable", 3);
      expect2(await codeOf(create(s, c, "req-1"))).toBe(CALENDAR_ERROR_CODES2.unavailable);
      expect2(await busy(s, c)).toEqual([]);
      const made = await create(s, c, "req-1");
      expect2(made.created).toBe(true);
      expect2(await busy(s, c)).toEqual([{ start: at(10), end: at(10.5) }]);
    });
    test2("a retryable failure that clears is retried and the call succeeds with one event", async () => {
      const s = await subject();
      const c = await connect(s);
      const before = s.vendorRequests();
      s.failNext("retryable", 2);
      const made = await create(s, c, "req-1");
      expect2(made.eventId.length).toBeGreaterThan(0);
      expect2(s.vendorRequests() - before).toBe(3);
      expect2(await busy(s, c)).toEqual([{ start: at(10), end: at(10.5) }]);
    });
    test2("a lost response is retried and the request id keeps it to one event", async () => {
      const s = await subject();
      if (s.loseResponse === undefined) {
        return;
      }
      const c = await connect(s);
      s.loseResponse(1);
      const made = await create(s, c, "req-1");
      expect2(made.eventId.length).toBeGreaterThan(0);
      expect2(await busy(s, c)).toEqual([{ start: at(10), end: at(10.5) }]);
      const again = await create(s, c, "req-1");
      expect2(again.eventId).toBe(made.eventId);
    });
    test2("connect is not retried, because a grant is single-use", async () => {
      const s = await subject();
      s.failNext("retryable", 1);
      const before = s.vendorRequests();
      expect2(await codeOf(s.port.connect({ organizationId: s.organizations.a, grant: s.acceptedGrant("secret-1") }, opts))).toBe(CALENDAR_ERROR_CODES2.unavailable);
      expect2(s.vendorRequests() - before).toBe(1);
    });
    test2("a fatal vendor failure is calendar.rejected, reported and not retried", async () => {
      const s = await subject();
      const c = await connect(s);
      const before = s.vendorRequests();
      s.failNext("fatal", 1);
      expect2(await codeOf(create(s, c, "req-1"))).toBe(CALENDAR_ERROR_CODES2.rejected);
      expect2(s.vendorRequests() - before).toBe(1);
      expect2(s.reporter.captured.length).toBeGreaterThan(0);
    });
    test2("after revoke every call fails with calendar.revoked, and revoking again succeeds", async () => {
      const s = await subject();
      const c = await connect(s);
      const other = await connect(s, "secret-2");
      const made = await create(s, c, "req-1");
      await s.port.revoke({ organizationId: c.organizationId, connection: c }, opts);
      const base = { organizationId: c.organizationId, connection: c };
      expect2(await codeOf(busy(s, c))).toBe(CALENDAR_ERROR_CODES2.revoked);
      expect2(await codeOf(create(s, c, "req-2"))).toBe(CALENDAR_ERROR_CODES2.revoked);
      expect2(await codeOf(create(s, c, "req-1"))).toBe(CALENDAR_ERROR_CODES2.revoked);
      expect2(await codeOf(s.port.updateEvent({ ...base, eventId: made.eventId, requestId: "req-3", changes: { title: "x" } }, opts))).toBe(CALENDAR_ERROR_CODES2.revoked);
      expect2(await codeOf(s.port.deleteEvent({ ...base, eventId: made.eventId, requestId: "req-4" }, opts))).toBe(CALENDAR_ERROR_CODES2.revoked);
      await s.port.revoke(base, opts);
      expect2(await busy(s, other)).toEqual([]);
    });
    test2("access revoked at the vendor is calendar.revoked, not retried", async () => {
      const s = await subject();
      const c = await connect(s);
      s.revokeAtProvider(c);
      const before = s.vendorRequests();
      expect2(await codeOf(busy(s, c))).toBe(CALENDAR_ERROR_CODES2.revoked);
      expect2(s.vendorRequests() - before).toBeLessThanOrEqual(1);
    });
    test2("the timeout aborts the vendor request and fails with calendar.timeout", async () => {
      const s = await subject();
      const c = await connect(s);
      const aborted = s.abortedRequests();
      s.hang();
      const started = Date.now();
      expect2(await codeOf(create(s, c, "req-1", {}, { timeoutMs: 30, retry }))).toBe(CALENDAR_ERROR_CODES2.timeout);
      expect2(Date.now() - started).toBeLessThan(2000);
      expect2(s.abortedRequests() - aborted).toBe(1);
    });
    test2("the caller signal aborts the vendor request and fails with calendar.aborted", async () => {
      const s = await subject();
      const c = await connect(s);
      const aborted = s.abortedRequests();
      s.hang();
      const controller = new AbortController;
      const pending = codeOf(s.port.busy({ organizationId: c.organizationId, connection: c, ...dayRange }, { ...opts, signal: controller.signal }));
      setTimeout(() => controller.abort(), 10);
      expect2(await pending).toBe(CALENDAR_ERROR_CODES2.aborted);
      expect2(s.abortedRequests() - aborted).toBe(1);
    });
    test2("a signal that is already aborted fails with calendar.aborted", async () => {
      const s = await subject();
      const c = await connect(s);
      expect2(await codeOf(create(s, c, "req-1", {}, { ...opts, signal: AbortSignal.abort() }))).toBe(CALENDAR_ERROR_CODES2.aborted);
      expect2(await busy(s, c)).toEqual([]);
    });
    test2("no token, title, note or address reaches a log, the reporter or an error", async () => {
      const s = await subject();
      const c = await connect(s, SECRET_GRANT);
      const seenErrors = [];
      const sensitive = {
        title: SECRET_TITLE,
        description: SECRET_NOTE,
        attendees: [{ email: SECRET_EMAIL, name: SECRET_TITLE }]
      };
      const swallow = (promise) => promise.catch((e) => seenErrors.push(e));
      await create(s, c, "req-ok", sensitive);
      s.failNext("retryable", 3);
      await swallow(create(s, c, "req-fail", sensitive));
      s.failNext("fatal", 1);
      await swallow(create(s, c, "req-fatal", sensitive));
      await swallow(create(s, c, "req-ok", { ...sensitive, title: `${SECRET_TITLE} changed` }));
      await swallow(create(s, c, "req-bad", { ...sensitive, end: at(1) }));
      await swallow(s.port.connect({ organizationId: s.organizations.a, grant: s.refusedGrant() }, opts));
      await swallow(s.port.updateEvent({
        organizationId: c.organizationId,
        connection: c,
        eventId: "missing",
        requestId: "req-up",
        changes: sensitive
      }, opts));
      await s.port.revoke({ organizationId: c.organizationId, connection: c }, opts);
      await swallow(create(s, c, "req-revoked", sensitive));
      expect2(seenErrors.length).toBeGreaterThan(0);
      const asText = (value) => JSON.stringify(value, (_key, v) => v instanceof Error ? { ...v, name: v.name, message: v.message, stack: v.stack, cause: v.cause } : v);
      const seen = [...s.logs(), asText(s.reporter.captured), asText(seenErrors)].join(`
`);
      for (const secret of [
        SECRET_GRANT,
        SECRET_TITLE,
        SECRET_EMAIL,
        SECRET_NOTE,
        "MARKER",
        c.unsafeCredential()
      ]) {
        expect2(seen).not.toContain(secret);
      }
    });
  });
}
// src/consent/behaviour.ts
import { afterEach as afterEach3, describe as describe3, expect as expect3, test as test3 } from "bun:test";
import { formatId } from "tula-closeline-contract";
function contactGuardBehaviour(name, make) {
  describe3(`ContactGuard behaviour: ${name}`, () => {
    const open = [];
    afterEach3(async () => {
      await Promise.all(open.splice(0).map((subject) => subject.close()));
    });
    async function subject() {
      const made = await make();
      open.push(made);
      return made;
    }
    const org = formatId("org", "a".repeat(32));
    const otherOrg = formatId("org", "b".repeat(32));
    const prospectId = formatId("prs", "1".repeat(32));
    const target = { organizationId: org, prospectId };
    const request = {
      ...target,
      channel: "sms",
      purpose: "agent_initiated"
    };
    test3("a target nobody allowed is denied as missing", async () => {
      const s = await subject();
      const result = await s.guard.check(request);
      expect3(result.allowed).toBe(false);
      expect3(result).toMatchObject({ code: "consent.missing", suppressionReason: null });
    });
    test3("an allowed target is allowed with a basis and a check id", async () => {
      const s = await subject();
      s.allow(target, "sms");
      const result = await s.guard.check(request);
      expect3(result).toMatchObject({ allowed: true, basis: "consent_granted" });
      expect3(result.checkId).not.toBeNull();
    });
    test3("an allowance holds for one channel and not another", async () => {
      const s = await subject();
      s.allow(target, "sms");
      expect3((await s.guard.check({ ...request, channel: "phone" })).allowed).toBe(false);
      expect3((await s.guard.check({ ...request, channel: "sms" })).allowed).toBe(true);
    });
    test3("an allowance for one Organization does not reach another", async () => {
      const s = await subject();
      s.allow(target, "sms");
      const result = await s.guard.check({ ...request, organizationId: otherOrg });
      expect3(result.allowed).toBe(false);
    });
    test3.each([
      ["consent.missing", undefined],
      ["consent.withdrawn", undefined],
      ["consent.suppressed", "unsubscribe"]
    ])("a %s denial is passed through as core gave it", async (code, reason) => {
      const s = await subject();
      s.deny(target, "sms", code, reason);
      const result = await s.guard.check(request);
      expect3(result).toMatchObject({
        allowed: false,
        code,
        suppressionReason: reason ?? null
      });
    });
    test3("an address can be checked as well as a Prospect", async () => {
      const s = await subject();
      const email = { organizationId: org, email: "pat@example.com" };
      s.allow(email, "email");
      const result = await s.guard.check({ ...email, channel: "email", purpose: "agent_initiated" });
      expect3(result.allowed).toBe(true);
    });
    describe3("a Prospect with one of its own addresses", () => {
      const phone = "+14155550142";
      const own = { organizationId: org, prospectId, phone };
      const combined = { ...own, channel: "sms", purpose: "agent_initiated" };
      test3("is allowed when the address is the Prospect's and the Prospect consented", async () => {
        const s = await subject();
        s.allow(own, "sms");
        expect3((await s.guard.check(combined)).allowed).toBe(true);
        expect3(s.reached()).toEqual([combined]);
      });
      test3("is denied as missing for another Prospect's address", async () => {
        const s = await subject();
        s.allow(own, "sms");
        const result = await s.guard.check({ ...combined, phone: "+14155550177" });
        expect3(result).toMatchObject({ allowed: false, code: "consent.missing" });
      });
      test3("is denied as missing when the Prospect has no such identity", async () => {
        const s = await subject();
        s.allow({ organizationId: org, prospectId }, "sms");
        const result = await s.guard.check(combined);
        expect3(result).toMatchObject({ allowed: false, code: "consent.missing" });
      });
      test3("is denied as suppressed when the address is suppressed, though the Prospect is not", async () => {
        const s = await subject();
        s.allow(own, "sms");
        s.deny({ organizationId: org, phone }, "sms", "consent.suppressed", "unsubscribe");
        const result = await s.guard.check(combined);
        expect3(result).toMatchObject({
          allowed: false,
          code: "consent.suppressed",
          suppressionReason: "unsubscribe"
        });
      });
      test3("is denied in a second Organization", async () => {
        const s = await subject();
        s.allow(own, "sms");
        const result = await s.guard.check({ ...combined, organizationId: otherOrg });
        expect3(result.allowed).toBe(false);
      });
    });
    test3("the channel and purpose reach the check", async () => {
      const s = await subject();
      await s.guard.check({ ...request, channel: "whatsapp", purpose: "reply" });
      expect3(s.reached()).toHaveLength(1);
      expect3(s.reached()[0]).toMatchObject({
        organizationId: org,
        prospectId,
        channel: "whatsapp",
        purpose: "reply"
      });
    });
    test3("a check that cannot be answered is denied as unavailable, never allowed", async () => {
      const s = await subject();
      s.allow(target, "sms");
      s.makeUnavailable();
      const result = await s.guard.check(request);
      expect3(result).toEqual({
        allowed: false,
        checkId: null,
        code: "consent.unavailable",
        suppressionReason: null
      });
    });
    test3("a request naming two addresses is denied as unavailable and asks nothing", async () => {
      const s = await subject();
      s.allow(target, "sms");
      const result = await s.guard.check({
        ...request,
        email: "pat@example.com",
        phone: "+14155550142"
      });
      expect3(result).toMatchObject({ allowed: false, code: "consent.unavailable" });
      expect3(s.reached()).toHaveLength(0);
    });
    test3("a request with no target is denied as unavailable", async () => {
      const s = await subject();
      const result = await s.guard.check({
        organizationId: org,
        channel: "sms",
        purpose: "agent_initiated"
      });
      expect3(result).toMatchObject({ allowed: false, code: "consent.unavailable" });
    });
  });
}
// src/llm/behaviour.ts
import { afterEach as afterEach4, describe as describe4, expect as expect4, test as test4 } from "bun:test";
import { z } from "zod";
var SECRET_PROMPT = "zebra confidential pricing";
var SECRET_SYSTEM = "SYSTEM-MARKER-INSTRUCTIONS";
var SECRET_ANSWER = "ANSWER-MARKER-PAYLOAD";
var answerSchema = z.object({ intent: z.enum(["buy", "wait"]), confidence: z.number() });
function llmBehaviour(name, make, skip = false) {
  const run = skip ? describe4.skip : describe4;
  run(`LLM behaviour: ${name}`, () => {
    const made = [];
    afterEach4(async () => {
      await Promise.all(made.splice(0).map((subject) => subject.close()));
    });
    async function subject() {
      const next = await make();
      made.push(next);
      return next;
    }
    const retry = { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 4 };
    const good = JSON.stringify({ intent: "buy", confidence: 0.9 });
    function base(s, content = "what does the prospect want?") {
      return {
        organizationId: s.organizations.a,
        tier: "fast",
        messages: [{ role: "user", content }],
        retry
      };
    }
    function complete(s, overrides = {}) {
      return s.port.complete({
        ...base(s),
        schema: answerSchema,
        schemaName: "answer",
        ...overrides
      });
    }
    async function collect(iterable) {
      const out = [];
      for await (const event of iterable) {
        out.push(event);
      }
      return out;
    }
    async function codeOf(promise) {
      try {
        await promise;
        return;
      } catch (error) {
        return error instanceof LlmError2 ? error.code : `not an LlmError: ${String(error)}`;
      }
    }
    test4("a structured answer comes back typed, with its usage", async () => {
      const s = await subject();
      s.reply(good, { inputTokens: 11, outputTokens: 7 });
      const result = await complete(s);
      expect4(result.value).toEqual({ intent: "buy", confidence: 0.9 });
      expect4(result.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
      expect4(s.vendorRequests()).toBe(1);
    });
    test4("usage is always a pair of non-negative whole numbers", async () => {
      const s = await subject();
      s.reply(good);
      const { usage } = await complete(s);
      expect4(Number.isInteger(usage.inputTokens) && usage.inputTokens > 0).toBe(true);
      expect4(Number.isInteger(usage.outputTokens) && usage.outputTokens > 0).toBe(true);
    });
    test4("output that is not JSON is llm.invalid_output", async () => {
      const s = await subject();
      s.reply("I think they want to buy.");
      expect4(await codeOf(complete(s))).toBe(LLM_ERROR_CODES2.invalidOutput);
    });
    test4("output that does not fit the schema is llm.invalid_output, never a partial value", async () => {
      const s = await subject();
      s.reply(JSON.stringify({ intent: "buy" }));
      expect4(await codeOf(complete(s))).toBe(LLM_ERROR_CODES2.invalidOutput);
      s.reply(JSON.stringify({ intent: "steal", confidence: 1 }));
      expect4(await codeOf(complete(s))).toBe(LLM_ERROR_CODES2.invalidOutput);
    });
    test4("output cut off by the output budget is llm.invalid_output", async () => {
      const s = await subject();
      s.reply(JSON.stringify({ intent: "buy", confidence: 0.9, note: "x".repeat(300) }));
      expect4(await codeOf(complete(s, { maxOutputTokens: 10 }))).toBe(LLM_ERROR_CODES2.invalidOutput);
    });
    test4("invalid output is not retried", async () => {
      const s = await subject();
      s.reply("nonsense");
      await codeOf(complete(s));
      expect4(s.vendorRequests()).toBe(1);
    });
    test4("the timeout aborts the vendor request and fails with llm.timeout", async () => {
      const s = await subject();
      s.hang();
      const started = Date.now();
      expect4(await codeOf(complete(s, { timeoutMs: 30 }))).toBe(LLM_ERROR_CODES2.timeout);
      expect4(Date.now() - started).toBeLessThan(2000);
      expect4(s.vendorRequests()).toBe(1);
      expect4(s.abortedRequests()).toBe(1);
    });
    test4("the caller signal aborts the vendor request and fails with llm.aborted", async () => {
      const s = await subject();
      s.hang();
      const controller = new AbortController;
      const pending = codeOf(complete(s, { signal: controller.signal }));
      setTimeout(() => controller.abort(), 10);
      expect4(await pending).toBe(LLM_ERROR_CODES2.aborted);
      expect4(s.abortedRequests()).toBe(1);
    });
    test4("a signal that is already aborted never reaches the vendor", async () => {
      const s = await subject();
      s.reply(good);
      expect4(await codeOf(complete(s, { signal: AbortSignal.abort() }))).toBe(LLM_ERROR_CODES2.aborted);
      expect4(s.vendorRequests()).toBeLessThanOrEqual(1);
      expect4(s.abortedRequests()).toBe(s.vendorRequests());
    });
    test4("a prompt over the input budget is llm.input_too_large and never reaches the vendor", async () => {
      const s = await subject();
      s.reply(good);
      const big = { ...base(s, "word ".repeat(2000)), maxInputTokens: 100 };
      expect4(await codeOf(complete(s, big))).toBe(LLM_ERROR_CODES2.inputTooLarge);
      expect4(() => s.port.stream(big)).toThrow(LlmError2);
      expect4(s.vendorRequests()).toBe(0);
    });
    test4("a request that is not acceptable is refused before any vendor call", async () => {
      const s = await subject();
      s.reply(good);
      const bad = [
        { organizationId: "org_nope" },
        { tier: "gpt-9" },
        { messages: [] },
        { messages: [{ role: "user", content: "" }] },
        { messages: [{ role: "assistant", content: "hi" }] },
        { messages: [{ role: "system", content: "hi" }] },
        { timeoutMs: 0 },
        { timeoutMs: 1e7 },
        { maxInputTokens: -1 },
        { maxOutputTokens: 1e6 },
        { retry: { maxRetries: 99 } },
        { retry: { baseDelayMs: 100, maxDelayMs: 10 } },
        { schema: { not: "a schema" } },
        { schemaName: "has spaces" },
        { schema: z.object({ at: z.date() }) }
      ];
      for (const overrides of bad) {
        expect4(await codeOf(complete(s, overrides))).toBe(LLM_ERROR_CODES2.invalidRequest);
      }
      expect4(s.vendorRequests()).toBe(0);
    });
    test4("a stream delivers its text in order and ends with one done event", async () => {
      const s = await subject();
      s.reply("we can offer a discount today", { inputTokens: 9, outputTokens: 6 });
      const events = await collect(s.port.stream(base(s)));
      const done = events.at(-1);
      expect4(events.filter((e) => e.type === "done")).toHaveLength(1);
      expect4(done).toEqual({
        type: "done",
        stopReason: "end",
        usage: { inputTokens: 9, outputTokens: 6 }
      });
      const text = events.flatMap((e) => e.type === "text" ? [e.text] : []);
      expect4(text.every((piece) => piece.length > 0)).toBe(true);
      expect4(text.join("")).toBe("we can offer a discount today");
    });
    test4("a stream that hits the output budget stops with max_tokens, within the budget", async () => {
      const s = await subject();
      s.reply("lorem ipsum ".repeat(100));
      const events = await collect(s.port.stream({ ...base(s), maxOutputTokens: 5 }));
      const done = events.at(-1);
      expect4(done?.type === "done" && done.stopReason).toBe("max_tokens");
      expect4(done?.type === "done" && done.usage.outputTokens).toBeLessThanOrEqual(5);
      const text = events.flatMap((e) => e.type === "text" ? [e.text] : []).join("");
      expect4(text.length).toBeLessThan(100);
    });
    test4("a reader that stops early aborts the vendor request", async () => {
      const s = await subject();
      s.reply("one two three four five six seven eight");
      for await (const event of s.port.stream(base(s))) {
        if (event.type === "text") {
          break;
        }
      }
      expect4(s.abortedRequests()).toBe(1);
    });
    test4("the timeout covers a stream and aborts its vendor request", async () => {
      const s = await subject();
      s.hang();
      const code = await codeOf(collect(s.port.stream({ ...base(s), timeoutMs: 30 })));
      expect4(code).toBe(LLM_ERROR_CODES2.timeout);
      expect4(s.abortedRequests()).toBe(1);
    });
    test4("a retryable vendor error is retried and the call then succeeds", async () => {
      const s = await subject();
      s.failNext("retryable", 2);
      s.reply(good);
      const result = await complete(s);
      expect4(result.value.intent).toBe("buy");
      expect4(s.vendorRequests()).toBe(3);
    });
    test4("retries are bounded and the last error is llm.unavailable", async () => {
      const s = await subject();
      s.failNext("retryable", 10);
      s.reply(good);
      expect4(await codeOf(complete(s))).toBe(LLM_ERROR_CODES2.unavailable);
      expect4(s.vendorRequests()).toBe(3);
      s.failNext("retryable", 10);
      expect4(await codeOf(complete(s, { retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 } }))).toBe(LLM_ERROR_CODES2.unavailable);
      expect4(s.vendorRequests()).toBe(4);
    });
    test4("a vendor error that a retry cannot fix is llm.rejected and is not retried", async () => {
      const s = await subject();
      s.failNext("fatal", 1);
      s.reply(good);
      expect4(await codeOf(complete(s))).toBe(LLM_ERROR_CODES2.rejected);
      expect4(s.vendorRequests()).toBe(1);
    });
    test4("a stream retries before its first text", async () => {
      const s = await subject();
      s.failNext("retryable", 1);
      s.reply("hello there");
      const events = await collect(s.port.stream(base(s)));
      expect4(events.at(-1)?.type).toBe("done");
      expect4(s.vendorRequests()).toBe(2);
    });
    test4("a failure is reported with the Organization and no text", async () => {
      const s = await subject();
      s.failNext("retryable", 10);
      await codeOf(complete(s));
      expect4(s.reporter.captured).toHaveLength(1);
      expect4(s.reporter.captured[0]?.error).toMatchObject({ code: LLM_ERROR_CODES2.unavailable });
      expect4(s.reporter.captured[0]?.context.organizationId).toBe(s.organizations.a);
      const tags = s.reporter.captured[0]?.context.tags ?? {};
      expect4(Object.keys(tags).sort()).toEqual(["feature", "tier"]);
    });
    test4("a timeout and a caller cancel are not reported", async () => {
      const s = await subject();
      s.hang();
      await codeOf(complete(s, { timeoutMs: 20 }));
      s.hang();
      const controller = new AbortController;
      const pending = codeOf(complete(s, { signal: controller.signal }));
      setTimeout(() => controller.abort(), 10);
      expect4(await pending).toBe(LLM_ERROR_CODES2.aborted);
      expect4(s.reporter.captured).toHaveLength(0);
    });
    test4("no prompt and no completion reaches a log, the error reporter or an error", async () => {
      const s = await subject();
      const seenErrors = [];
      const system = SECRET_SYSTEM;
      const ask = { ...base(s, SECRET_PROMPT), system };
      s.reply(JSON.stringify({ intent: "buy", confidence: 0.9, note: SECRET_ANSWER }));
      await s.port.complete({ ...ask, schema: answerSchema, schemaName: "answer" });
      s.reply(JSON.stringify({ intent: SECRET_ANSWER }));
      await s.port.complete({ ...ask, schema: answerSchema, schemaName: "answer" }).catch((error) => seenErrors.push(error));
      s.reply(SECRET_ANSWER);
      await s.port.complete({ ...ask, schema: answerSchema, schemaName: "answer" }).catch((error) => seenErrors.push(error));
      s.failNext("retryable", 3);
      await s.port.complete({ ...ask, schema: answerSchema, schemaName: "answer" }).catch((error) => seenErrors.push(error));
      s.reply(`stream ${SECRET_ANSWER}`);
      await collect(s.port.stream(ask));
      s.failNext("fatal", 1);
      await collect(s.port.stream(ask)).catch((error) => seenErrors.push(error));
      expect4(seenErrors.length).toBeGreaterThan(0);
      const asText = (value) => JSON.stringify(value, (_key, v) => v instanceof Error ? { ...v, name: v.name, message: v.message, stack: v.stack, cause: v.cause } : v);
      const seen = [...s.logs(), asText(s.reporter.captured), asText(seenErrors)].join(`
`);
      for (const secret of [SECRET_PROMPT, "confidential", "zebra", SECRET_SYSTEM, SECRET_ANSWER]) {
        expect4(seen).not.toContain(secret);
      }
    });
  });
}
// src/messaging/behaviour.ts
import { afterEach as afterEach5, describe as describe5, expect as expect5, test as test5 } from "bun:test";
import { inspect as inspect2 } from "node:util";
import { formatId as formatId2 } from "tula-closeline-contract";
var SECRET_TEXT = "zebra confidential pricing";
var retry = { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 2 };
var TEMPLATE = `HX${"0123456789abcdef".repeat(2)}`;
async function errorOf(run) {
  try {
    await run();
  } catch (error) {
    if (error instanceof MessagingError2) {
      return error;
    }
    throw error;
  }
  return null;
}
async function codeOf(run) {
  return (await errorOf(run))?.code ?? "no error";
}
function messagingBehaviour(name, make, skip = false) {
  const run = skip ? describe5.skip : describe5;
  run(`Messaging behaviour: ${name}`, () => {
    const made = [];
    afterEach5(async () => {
      await Promise.all(made.splice(0).map((subject) => subject.close()));
    });
    async function subject() {
      const next = await make();
      made.push(next);
      return next;
    }
    function allow(s, channel, org = s.organizations.a) {
      s.guard.allow({ organizationId: org, prospectId: s.prospect, phone: s.recipient }, channel);
    }
    let counter = 0;
    function request(s, overrides = {}) {
      counter += 1;
      return {
        organizationId: s.organizations.a,
        prospectId: s.prospect,
        channel: "sms",
        purpose: "agent_initiated",
        to: s.recipient,
        content: { kind: "text", body: SECRET_TEXT },
        idempotencyKey: `key-${counter}`,
        retry,
        ...overrides
      };
    }
    test5("an allowed SMS is sent once and returns the provider id and the consent check id", async () => {
      const s = await subject();
      allow(s, "sms");
      const sent = await s.port.send(request(s, { idempotencyKey: "order-1" }));
      expect5(sent.providerMessageId).toMatch(/^(SM|MM)[0-9a-fA-F]{32}$/);
      expect5(sent.consentCheckId).toMatch(/^chk_/);
      expect5(sent.channel).toBe("sms");
      expect5(sent.status).toBe("queued");
      expect5(sent.idempotencyKey).toBe("order-1");
      expect5(s.vendorCalls()).toBe(1);
      expect5(sent.numberConsentCheckId).toBe(sent.consentCheckId);
      expect5(s.guard.calls).toEqual([
        {
          organizationId: s.organizations.a,
          prospectId: s.prospect,
          phone: s.recipient,
          channel: "sms",
          purpose: "agent_initiated"
        }
      ]);
    });
    test5("a WhatsApp template with variables is sent; a reply is checked as a reply", async () => {
      const s = await subject();
      allow(s, "whatsapp");
      const sent = await s.port.send(request(s, {
        channel: "whatsapp",
        purpose: "reply",
        content: {
          kind: "template",
          templateId: TEMPLATE,
          variables: { "1": "Ada", "2": "Tue" }
        }
      }));
      expect5(sent.channel).toBe("whatsapp");
      expect5(s.guard.calls[0]?.channel).toBe("whatsapp");
      expect5(s.guard.calls[0]?.purpose).toBe("reply");
    });
    test5("a template over SMS is refused before the check and the vendor", async () => {
      const s = await subject();
      allow(s, "sms");
      const code = await codeOf(() => s.port.send(request(s, { content: { kind: "template", templateId: TEMPLATE } })));
      expect5(code).toBe(MESSAGING_ERROR_CODES2.invalidRequest);
      expect5(s.vendorCalls()).toBe(0);
    });
    for (const denial of ["consent.missing", "consent.withdrawn", "consent.suppressed"]) {
      test5(`a denial with ${denial} fails with messaging.consent_denied and never reaches the vendor`, async () => {
        const s = await subject();
        s.guard.deny({ organizationId: s.organizations.a, prospectId: s.prospect, phone: s.recipient }, "sms", denial);
        const error = await errorOf(() => s.port.send(request(s)));
        expect5(error?.code).toBe(MESSAGING_ERROR_CODES2.consentDenied);
        expect5(error?.details).toEqual({ code: denial });
        expect5(s.vendorCalls()).toBe(0);
        expect5(s.reporter.captured).toEqual([]);
      });
    }
    test5("a Prospect nobody preset is denied as missing and never reaches the vendor", async () => {
      const s = await subject();
      const error = await errorOf(() => s.port.send(request(s)));
      expect5(error?.code).toBe(MESSAGING_ERROR_CODES2.consentDenied);
      expect5(error?.details).toEqual({ code: "consent.missing" });
      expect5(s.vendorCalls()).toBe(0);
    });
    test5("a check that is unavailable denies with consent.unavailable and never reaches the vendor", async () => {
      const s = await subject();
      allow(s, "sms");
      s.guard.setUnavailable();
      const error = await errorOf(() => s.port.send(request(s)));
      expect5(error?.code).toBe(MESSAGING_ERROR_CODES2.consentDenied);
      expect5(error?.details).toEqual({ code: "consent.unavailable" });
      expect5(s.vendorCalls()).toBe(0);
    });
    test5("a suppressed number blocks the send though the Prospect is allowed and not suppressed", async () => {
      const s = await subject();
      allow(s, "sms");
      s.guard.deny({ organizationId: s.organizations.a, phone: s.recipient }, "sms", "consent.suppressed");
      const error = await errorOf(() => s.port.send(request(s)));
      expect5(error?.code).toBe(MESSAGING_ERROR_CODES2.consentDenied);
      expect5(error?.details).toEqual({ code: "consent.suppressed" });
      expect5(s.vendorCalls()).toBe(0);
    });
    test5("a send to another Prospect's number is refused as missing", async () => {
      const s = await subject();
      const otherProspect = formatId2("prs", "2".repeat(32));
      const otherNumber = "+14155550177";
      allow(s, "sms");
      s.guard.allow({ organizationId: s.organizations.a, prospectId: otherProspect, phone: otherNumber }, "sms");
      const error = await errorOf(() => s.port.send(request(s, { to: otherNumber })));
      expect5(error?.code).toBe(MESSAGING_ERROR_CODES2.consentDenied);
      expect5(error?.details).toEqual({ code: "consent.missing" });
      expect5(s.vendorCalls()).toBe(0);
    });
    test5("a number that is no identity of the Prospect is refused though the Prospect has consent", async () => {
      const s = await subject();
      s.guard.allow({ organizationId: s.organizations.a, prospectId: s.prospect }, "sms");
      const error = await errorOf(() => s.port.send(request(s)));
      expect5(error?.code).toBe(MESSAGING_ERROR_CODES2.consentDenied);
      expect5(error?.details).toEqual({ code: "consent.missing" });
      expect5(s.vendorCalls()).toBe(0);
    });
    test5("exactly one Contact Check is made per send, naming the Prospect and the number", async () => {
      const s = await subject();
      allow(s, "sms");
      await s.port.send(request(s));
      expect5(s.guard.calls).toHaveLength(1);
      expect5(s.guard.calls[0]).toMatchObject({ prospectId: s.prospect, phone: s.recipient });
      s.guard.deny({ organizationId: s.organizations.a, prospectId: s.prospect }, "sms", "consent.withdrawn");
      await codeOf(() => s.port.send(request(s)));
      expect5(s.guard.calls).toHaveLength(2);
    });
    test5("a Contact Check that never answers fails with messaging.timeout at the deadline", async () => {
      const s = await subject();
      allow(s, "sms");
      s.guard.check = () => new Promise(() => {
        return;
      });
      const started = Date.now();
      expect5(await codeOf(() => s.port.send(request(s, { timeoutMs: 50 })))).toBe(MESSAGING_ERROR_CODES2.timeout);
      expect5(Date.now() - started).toBeLessThan(500);
      expect5(s.vendorCalls()).toBe(0);
    });
    test5("the caller signal ends a Contact Check that never answers with messaging.aborted", async () => {
      const s = await subject();
      allow(s, "sms");
      s.guard.check = () => new Promise(() => {
        return;
      });
      const controller = new AbortController;
      setTimeout(() => controller.abort(), 20);
      expect5(await codeOf(() => s.port.send(request(s, { signal: controller.signal })))).toBe(MESSAGING_ERROR_CODES2.aborted);
      expect5(s.vendorCalls()).toBe(0);
    });
    test5("consent for SMS does not cover WhatsApp, and the check is asked on every call", async () => {
      const s = await subject();
      allow(s, "sms");
      await s.port.send(request(s));
      expect5(await codeOf(() => s.port.send(request(s, { channel: "whatsapp", content: { kind: "template", templateId: TEMPLATE } })))).toBe(MESSAGING_ERROR_CODES2.consentDenied);
      s.guard.deny({ organizationId: s.organizations.a, prospectId: s.prospect }, "sms", "consent.withdrawn");
      expect5(await codeOf(() => s.port.send(request(s)))).toBe(MESSAGING_ERROR_CODES2.consentDenied);
      expect5(s.guard.calls.length).toBe(3);
      expect5(s.vendorCalls()).toBe(1);
    });
    test5("consent in one Organization does not let a second Organization send", async () => {
      const s = await subject();
      allow(s, "sms", s.organizations.a);
      const error = await errorOf(() => s.port.send(request(s, { organizationId: s.organizations.b })));
      expect5(error?.code).toBe(MESSAGING_ERROR_CODES2.consentDenied);
      expect5(s.vendorCalls()).toBe(0);
    });
    test5("the same idempotency key in two Organizations is two messages", async () => {
      const s = await subject();
      allow(s, "sms", s.organizations.a);
      allow(s, "sms", s.organizations.b);
      const first = await s.port.send(request(s, { idempotencyKey: "same" }));
      const second = await s.port.send(request(s, { idempotencyKey: "same", organizationId: s.organizations.b }));
      expect5(first.providerMessageId).not.toBe(second.providerMessageId);
      expect5(s.vendorCalls()).toBe(2);
    });
    test5("no field or option can skip the check", async () => {
      const s = await subject();
      for (const extra of [
        { skipConsent: true },
        { consent: false },
        { consentCheckId: "chk_00000000000000000000000000000000" },
        { guard: { check: async () => ({ allowed: true }) } },
        { force: true },
        { override: "consent" }
      ]) {
        const code = await codeOf(() => s.port.send({ ...request(s), ...extra }));
        expect5(code).toBe(MESSAGING_ERROR_CODES2.invalidRequest);
      }
      expect5(s.vendorCalls()).toBe(0);
      expect5(s.guard.calls).toEqual([]);
    });
    test5("an unacceptable request is refused before the check and the vendor", async () => {
      const s = await subject();
      allow(s, "sms");
      const bad = [
        { organizationId: "org_nope" },
        { prospectId: "prs_nope" },
        { channel: "email" },
        { purpose: "rep_initiated" },
        { to: "5551234" },
        { to: `whatsapp:${s.recipient}` },
        { content: { kind: "text", body: "" } },
        { content: { kind: "text", body: " ".repeat(5) } },
        { content: { kind: "text", body: "x".repeat(1601) } },
        { content: { kind: "voice" } },
        { content: { kind: "text", body: "hi", extra: 1 } },
        { idempotencyKey: "" },
        { idempotencyKey: "has space" },
        { idempotencyKey: "k".repeat(201) },
        { timeoutMs: 0 },
        { timeoutMs: 60001 },
        { retry: { maxRetries: 6 } },
        { retry: { baseDelayMs: 0 } },
        { signal: {} }
      ];
      for (const overrides of bad) {
        expect5(await codeOf(() => s.port.send(request(s, overrides)))).toBe(MESSAGING_ERROR_CODES2.invalidRequest);
      }
      const whatsapp = [
        { content: { kind: "template", templateId: "HX123" } },
        { content: { kind: "template", templateId: TEMPLATE, variables: { "bad name": "x" } } },
        {
          content: {
            kind: "template",
            templateId: TEMPLATE,
            variables: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`v${i}`, "x"]))
          }
        },
        { content: { kind: "template", templateId: TEMPLATE, variables: { a: "x".repeat(1025) } } }
      ];
      for (const overrides of whatsapp) {
        expect5(await codeOf(() => s.port.send(request(s, { channel: "whatsapp", ...overrides })))).toBe(MESSAGING_ERROR_CODES2.invalidRequest);
      }
      expect5(await codeOf(() => s.port.send(null))).toBe(MESSAGING_ERROR_CODES2.invalidRequest);
      expect5(s.vendorCalls()).toBe(0);
      expect5(s.guard.calls).toEqual([]);
    });
    test5("a retryable vendor error is retried and then succeeds", async () => {
      const s = await subject();
      allow(s, "sms");
      s.failNext("retryable", 1);
      const sent = await s.port.send(request(s));
      expect5(sent.providerMessageId).toMatch(/^(SM|MM)/);
      expect5(s.vendorCalls()).toBe(2);
      expect5(s.reporter.captured).toEqual([]);
    });
    test5("retries are bounded: exhausting them fails with messaging.unavailable and is reported", async () => {
      const s = await subject();
      allow(s, "sms");
      s.failNext("retryable", 5);
      expect5(await codeOf(() => s.port.send(request(s)))).toBe(MESSAGING_ERROR_CODES2.unavailable);
      expect5(s.vendorCalls()).toBe(2);
      expect5(s.reporter.captured.length).toBe(1);
    });
    test5("maxRetries 0 never retries", async () => {
      const s = await subject();
      allow(s, "sms");
      s.failNext("retryable", 1);
      expect5(await codeOf(() => s.port.send(request(s, { retry: { maxRetries: 0 } })))).toBe(MESSAGING_ERROR_CODES2.unavailable);
      expect5(s.vendorCalls()).toBe(1);
    });
    test5("a refusal is not retried and is reported", async () => {
      const s = await subject();
      allow(s, "sms");
      s.failNext("fatal", 1);
      expect5(await codeOf(() => s.port.send(request(s)))).toBe(MESSAGING_ERROR_CODES2.rejected);
      expect5(s.vendorCalls()).toBe(1);
      expect5(s.reporter.captured.length).toBe(1);
    });
    test5("a recipient who opted out is its own code, not retried and not reported", async () => {
      const s = await subject();
      allow(s, "sms");
      s.failNext("opted_out", 1);
      expect5(await codeOf(() => s.port.send(request(s)))).toBe(MESSAGING_ERROR_CODES2.recipientOptedOut);
      expect5(s.vendorCalls()).toBe(1);
      expect5(s.reporter.captured).toEqual([]);
    });
    test5("a WhatsApp free-form message outside the window needs a template, not retried or reported", async () => {
      const s = await subject();
      allow(s, "whatsapp");
      s.failNext("template_required", 1);
      expect5(await codeOf(() => s.port.send(request(s, { channel: "whatsapp" })))).toBe(MESSAGING_ERROR_CODES2.templateRequired);
      expect5(s.vendorCalls()).toBe(1);
      expect5(s.reporter.captured).toEqual([]);
    });
    test5("an unusable answer is messaging.bad_response, not retried, and reported", async () => {
      const s = await subject();
      allow(s, "sms");
      s.failNext("bad_response", 1);
      expect5(await codeOf(() => s.port.send(request(s)))).toBe(MESSAGING_ERROR_CODES2.badResponse);
      expect5(s.vendorCalls()).toBe(1);
      expect5(s.reporter.captured.length).toBe(1);
    });
    test5("the overall deadline fails with messaging.timeout and aborts the vendor request", async () => {
      const s = await subject();
      allow(s, "sms");
      s.hang();
      expect5(await codeOf(() => s.port.send(request(s, { timeoutMs: 30 })))).toBe(MESSAGING_ERROR_CODES2.timeout);
      expect5(s.abortedCalls()).toBe(1);
      expect5(s.vendorCalls()).toBe(1);
    });
    test5("the caller signal fails with messaging.aborted and aborts the vendor request", async () => {
      const s = await subject();
      allow(s, "sms");
      s.hang();
      const controller = new AbortController;
      const sending = errorOf(() => s.port.send(request(s, { signal: controller.signal })));
      setTimeout(() => controller.abort(), 20);
      expect5((await sending)?.code).toBe(MESSAGING_ERROR_CODES2.aborted);
      expect5(s.abortedCalls()).toBe(1);
    });
    test5("a signal that is already aborted never reaches the vendor", async () => {
      const s = await subject();
      allow(s, "sms");
      expect5(await codeOf(() => s.port.send(request(s, { signal: AbortSignal.abort() })))).toBe(MESSAGING_ERROR_CODES2.aborted);
      expect5(s.vendorCalls()).toBe(0);
    });
    describe5("webhooks", () => {
      function asMessage(event) {
        if (!(event instanceof InboundMessage2)) {
          throw new Error("expected a message");
        }
        return event;
      }
      test5("a signed inbound SMS parses with its numbers, text and a fresh timestamp", async () => {
        const s = await subject();
        const message = asMessage(await s.port.receive(s.signedInbound({
          from: s.recipient,
          to: s.ourNumber,
          body: "Yes, call me",
          mediaCount: 2
        })));
        expect5(message.channel).toBe("sms");
        expect5(message.from).toBe(s.recipient);
        expect5(message.to).toBe(s.ourNumber);
        expect5(message.body).toBe("Yes, call me");
        expect5(message.intent).toBe("message");
        expect5(message.mediaCount).toBe(2);
        expect5(message.providerMessageId).toMatch(/^(SM|MM)[0-9a-fA-F]{32}$/);
        expect5(Number.isNaN(Date.parse(message.receivedAt))).toBe(false);
      });
      test5("a WhatsApp message loses its prefix and sets the channel", async () => {
        const s = await subject();
        const message = asMessage(await s.port.receive(s.signedInbound({
          from: s.recipient,
          to: s.ourNumber,
          body: "hello",
          channel: "whatsapp"
        })));
        expect5(message.channel).toBe("whatsapp");
        expect5(message.from).toBe(s.recipient);
        expect5(message.to).toBe(s.ourNumber);
      });
      const intents = [
        ["STOP", "stop"],
        [" stop ", "stop"],
        ["Stop", "stop"],
        ["STOPALL", "stop"],
        ["unsubscribe", "stop"],
        ["Cancel", "stop"],
        ["END", "stop"],
        ["quit", "stop"],
        ["START", "start"],
        ["unstop", "start"],
        ["Yes", "start"],
        ["HELP", "help"],
        ["info", "help"],
        ["Stop.", "stop"],
        ["stop!", "stop"],
        ['  "STOP"  ', "stop"],
        ["STOP ALL", "stop"],
        ["stop all.", "stop"],
        ["stop​", "stop"],
        ["​STOP⁠", "stop"],
        ["STOP \uD83D\uDC4D", "stop"],
        ["Start.", "start"],
        ["help!", "help"],
        ["ſtart", "message"],
        ["Kind", "message"],
        ["please stop texting me", "message"],
        ["stopping by tomorrow", "message"],
        ["no thanks", "message"],
        ["", "message"]
      ];
      for (const [text, intent] of intents) {
        test5(`the text ${JSON.stringify(text)} means ${intent}`, async () => {
          const s = await subject();
          const message = asMessage(await s.port.receive(s.signedInbound({ from: s.recipient, to: s.ourNumber, body: text })));
          expect5(message.intent).toBe(intent);
        });
      }
      test5("a signed status webhook parses into a status event", async () => {
        const s = await subject();
        const id = `SM${"ab".repeat(16)}`;
        expect5(await s.port.receive(s.signedStatus({ providerMessageId: id, status: "delivered" }))).toEqual({ kind: "status", providerMessageId: id, status: "delivered" });
        expect5(await s.port.receive(s.signedStatus({ providerMessageId: id, status: "undelivered", errorCode: 30003 }))).toEqual({
          kind: "status",
          providerMessageId: id,
          status: "undelivered",
          errorCode: 30003
        });
      });
      test5("a tampered body, a tampered URL, a wrong or missing signature are webhook_invalid", async () => {
        const s = await subject();
        const good = s.signedInbound({ from: s.recipient, to: s.ourNumber, body: "hello" });
        const attempts = [
          { ...good, body: good.body.replace("hello", "jello") },
          { ...good, url: `${good.url}/other` },
          { ...good, signature: "AAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
          { ...good, signature: `${good.signature}x` },
          { ...good, signature: "" },
          { ...good, signature: null },
          { ...good, signature: undefined }
        ];
        for (const attempt of attempts) {
          expect5(await codeOf(() => s.port.receive(attempt))).toBe(MESSAGING_ERROR_CODES2.webhookInvalid);
        }
        expect5(await codeOf(() => s.port.receive(null))).toBe(MESSAGING_ERROR_CODES2.webhookInvalid);
      });
      test5("a body over the limit and a body that is not a form are webhook_invalid", async () => {
        const s = await subject();
        const big = s.sign({ MessageSid: `SM${"ab".repeat(16)}`, Body: "x".repeat(300000) });
        expect5(await codeOf(() => s.port.receive(big))).toBe(MESSAGING_ERROR_CODES2.webhookInvalid);
        const good = s.signedInbound({ from: s.recipient, to: s.ourNumber, body: "hi" });
        expect5(await codeOf(() => s.port.receive({ ...good, contentType: "application/json" }))).toBe(MESSAGING_ERROR_CODES2.webhookInvalid);
      });
      test5("a correctly signed body that is neither a message nor a status is webhook_invalid", async () => {
        const s = await subject();
        const sid = `SM${"ab".repeat(16)}`;
        const bodies = [
          { Foo: "bar" },
          { MessageSid: "nope", Body: "hi", From: s.recipient, To: s.ourNumber },
          { MessageSid: sid, Body: "hi", From: "not a number", To: s.ourNumber },
          { MessageSid: sid, Body: "hi", From: s.recipient, To: s.ourNumber, NumMedia: "99" },
          { MessageSid: sid, MessageStatus: "teleported" }
        ];
        for (const fields of bodies) {
          expect5(await codeOf(() => s.port.receive(s.sign(fields)))).toBe(MESSAGING_ERROR_CODES2.webhookInvalid);
        }
      });
    });
    test5("the text, the numbers and the credentials reach no log, report, error or result form", async () => {
      const s = await subject();
      allow(s, "sms");
      const seen = [];
      const note = (value) => {
        seen.push(String(value), inspect2(value, { depth: 6 }));
        try {
          seen.push(JSON.stringify(value));
        } catch {}
      };
      note(await s.port.send(request(s)));
      s.failNext("retryable", 1);
      await s.port.send(request(s));
      for (const kind of ["retryable", "fatal", "opted_out", "bad_response"]) {
        s.failNext(kind, 2);
        const error = await errorOf(() => s.port.send(request(s)));
        note(error);
        seen.push(error?.message ?? "", JSON.stringify(error?.details ?? {}));
      }
      s.guard.deny({ organizationId: s.organizations.a, prospectId: s.prospect }, "sms");
      const denied = await errorOf(() => s.port.send(request(s)));
      note(denied);
      allow(s, "sms");
      s.hang();
      const timeout = await errorOf(() => s.port.send(request(s, { timeoutMs: 20 })));
      note(timeout);
      const event = await s.port.receive(s.signedInbound({ from: s.recipient, to: s.ourNumber, body: SECRET_TEXT }));
      note(event);
      note({ ...event });
      const bad = await errorOf(() => s.port.receive({
        ...s.signedInbound({ from: s.recipient, to: s.ourNumber, body: SECRET_TEXT }),
        signature: "wrong"
      }));
      note(bad);
      seen.push(...s.logs(), JSON.stringify(s.reporter.captured), inspect2(s.reporter.captured, { depth: 6 }));
      for (const captured of s.reporter.captured) {
        note(captured.error);
      }
      const everything = seen.join(`
`);
      for (const secret of [SECRET_TEXT, s.recipient, s.ourNumber, ...s.secrets()]) {
        expect5(everything).not.toContain(secret);
      }
    });
  });
}
// src/queue/behaviour.ts
import { afterEach as afterEach6, describe as describe6, expect as expect6, test as test6 } from "bun:test";
function queueBehaviour(name, make, skip = false) {
  const run = skip ? describe6.skip : describe6;
  run(`Queue behaviour: ${name}`, () => {
    const open = [];
    afterEach6(async () => {
      await Promise.all(open.splice(0).map((subject) => subject.close()));
    });
    async function subject() {
      const made = await make();
      open.push(made);
      return made;
    }
    const ping = (s, n = 1, org = "org_a", id) => s.registry.create({
      type: "test.ping",
      payload: { n },
      organizationId: org,
      traceId: "trace_1",
      ...id === undefined ? {} : { id }
    });
    async function take(s, count, wait = 1) {
      const got = [];
      for (let attempt = 0;attempt < 5 && got.length < count; attempt++) {
        got.push(...await s.queue.receive({
          maxMessages: Math.min(10, count - got.length),
          visibilityTimeoutSeconds: s.visibilitySeconds,
          waitSeconds: wait
        }));
      }
      return got;
    }
    const none = async (s) => await s.queue.receive({
      maxMessages: 10,
      visibilityTimeoutSeconds: s.visibilitySeconds,
      waitSeconds: s.emptyWaitSeconds
    });
    test6("publishing an envelope of an unknown type is refused and nothing is sent", async () => {
      const s = await subject();
      const bad = { ...ping(s), type: "test.nope" };
      await expect6(s.queue.publish(bad)).rejects.toMatchObject({ code: "queue.invalid_message" });
      expect6(await none(s)).toEqual([]);
    });
    test6("publishing a payload that fails its schema is refused", async () => {
      const s = await subject();
      const bad = { ...ping(s), payload: { n: "x" } };
      await expect6(s.queue.publish(bad)).rejects.toMatchObject({ code: "queue.invalid_message" });
    });
    test6("an organization message without an organization id is refused, and a global one with it", async () => {
      const s = await subject();
      const noOrg = { ...ping(s), organizationId: undefined };
      await expect6(s.queue.publish(noOrg)).rejects.toMatchObject({ code: "queue.invalid_message" });
      const note = s.registry.create({ type: "test.note", payload: { text: "hi" }, traceId: "t" });
      const withOrg = { ...note, organizationId: "org_a" };
      await expect6(s.queue.publish(withOrg)).rejects.toMatchObject({
        code: "queue.invalid_message"
      });
    });
    test6("a message over 256 KiB is refused with a clear error", async () => {
      const s = await subject();
      const big = s.registry.create({
        type: "test.note",
        payload: { text: "x".repeat(MAX_MESSAGE_BYTES2) },
        traceId: "t"
      });
      await expect6(s.queue.publish(big)).rejects.toMatchObject({ code: "queue.message_too_large" });
      expect6(await none(s)).toEqual([]);
    });
    test6("a batch of 11, an empty batch, or over 256 KiB in total is refused before anything is sent", async () => {
      const s = await subject();
      const eleven = Array.from({ length: 11 }, (_, i) => ping(s, i));
      await expect6(s.queue.publishBatch(eleven)).rejects.toMatchObject({
        code: "queue.batch_too_large"
      });
      await expect6(s.queue.publishBatch([])).rejects.toMatchObject({
        code: "queue.batch_too_large"
      });
      const half = (text) => s.registry.create({ type: "test.note", payload: { text }, traceId: "t" });
      const heavy = [half("a".repeat(150000)), half("b".repeat(150000))];
      await expect6(s.queue.publishBatch(heavy)).rejects.toMatchObject({
        code: "queue.batch_too_large"
      });
      expect6(await none(s)).toEqual([]);
    });
    test6.each([
      [{ maxMessages: 0, visibilityTimeoutSeconds: 5, waitSeconds: 0 }],
      [{ maxMessages: 11, visibilityTimeoutSeconds: 5, waitSeconds: 0 }],
      [{ maxMessages: 1, visibilityTimeoutSeconds: -1, waitSeconds: 0 }],
      [{ maxMessages: 1, visibilityTimeoutSeconds: 5, waitSeconds: 21 }],
      [{ maxMessages: 1, visibilityTimeoutSeconds: 1.5, waitSeconds: 0 }]
    ])("receive with out-of-range arguments %j is refused", async (args) => {
      const s = await subject();
      await expect6(s.queue.receive(args)).rejects.toMatchObject({ code: "queue.invalid_request" });
    });
    test6("a body that is not a valid message comes back as invalid, with no body in it", async () => {
      const s = await subject();
      const secret = "SECRET-PAYLOAD-VALUE";
      const good = ping(s, 1, "org_a", "msg_x");
      const cases = [
        ["malformed", `not json ${secret}`, "malformed"],
        ["unknown_type", JSON.stringify({ ...good, type: "test.other" }), "unknown_type"],
        ["unsupported_version", JSON.stringify({ ...good, version: 2 }), "unsupported_version"],
        ["invalid_payload", JSON.stringify({ ...good, payload: { n: secret } }), "invalid_payload"],
        ["invalid_scope", JSON.stringify({ ...good, organizationId: undefined }), "invalid_scope"]
      ];
      for (const [, body] of cases) {
        await s.injectRaw(body);
      }
      const got = await take(s, cases.length);
      expect6(got).toHaveLength(cases.length);
      expect6(got.every((delivery) => delivery.kind === "invalid")).toBe(true);
      const reasons = got.map((delivery) => delivery.kind === "invalid" ? delivery.reason : "");
      expect6([...reasons].sort()).toEqual(cases.map(([, , reason]) => reason).sort());
      expect6(JSON.stringify(got)).not.toContain(secret);
    });
    test6("an invalid message that is never acknowledged is delivered maxReceiveCount times and then taken out of circulation", async () => {
      const s = await subject();
      await s.injectRaw('{"broken":');
      for (let round = 0;round < s.maxReceiveCount; round++) {
        const got = await take(s, 1);
        expect6(got).toHaveLength(1);
        expect6(got[0]?.receiveCount).toBe(round + 1);
        await s.queue.release(got[0].receipt);
      }
      expect6(await none(s)).toEqual([]);
    });
    test6("extending visibility of an acknowledged message is refused with queue.receipt_invalid", async () => {
      const s = await subject();
      await s.queue.publish(ping(s));
      const [got] = await take(s, 1);
      const receipt = got.receipt;
      await s.queue.acknowledge(receipt);
      await expect6(s.queue.extendVisibility(receipt, 10)).rejects.toMatchObject({
        code: "queue.receipt_invalid"
      });
    });
    test6("acknowledging twice resolves both times", async () => {
      const s = await subject();
      await s.queue.publish(ping(s));
      const [got] = await take(s, 1);
      const receipt = got.receipt;
      await s.queue.acknowledge(receipt);
      await expect6(s.queue.acknowledge(receipt)).resolves.toBeUndefined();
    });
    test6("a published message arrives with every envelope field intact", async () => {
      const s = await subject();
      const sent = ping(s, 7, "org_a", "msg_1");
      await s.queue.publish(sent);
      const [got] = await take(s, 1);
      expect6(got?.kind).toBe("message");
      if (got?.kind === "message") {
        expect6(got.envelope).toEqual(sent);
        expect6(got.receiveCount).toBe(1);
      }
    });
    test6("an empty queue gives an empty list", async () => {
      const s = await subject();
      expect6(await none(s)).toEqual([]);
    });
    test6("a batch publish reports every id as sent and delivers them all", async () => {
      const s = await subject();
      const batch = [ping(s, 1), ping(s, 2), ping(s, 3)];
      const result = await s.queue.publishBatch(batch);
      expect6(result.failed).toEqual([]);
      expect6(result.sent).toEqual(batch.map((envelope) => envelope.id));
      const got = await take(s, 3);
      expect6(got).toHaveLength(3);
    });
    test6("receive returns at most maxMessages", async () => {
      const s = await subject();
      await s.queue.publishBatch([ping(s, 1), ping(s, 2), ping(s, 3)]);
      const first = await s.queue.receive({
        maxMessages: 2,
        visibilityTimeoutSeconds: s.visibilitySeconds,
        waitSeconds: 1
      });
      expect6(first.length).toBeLessThanOrEqual(2);
      expect6(first.length).toBeGreaterThan(0);
    });
    test6("the subject leaves room for an empty long poll inside the visibility timeout", () => {
      return subject().then((s) => {
        expect6(s.visibilitySeconds).toBeGreaterThanOrEqual(s.emptyWaitSeconds + 3);
      });
    });
    test6("a received message stays hidden until its visibility timeout, then returns with a higher count", async () => {
      const s = await subject();
      await s.queue.publish(ping(s, 1, "org_a", "msg_v"));
      expect6(await take(s, 1)).toHaveLength(1);
      expect6(await none(s)).toEqual([]);
      let again;
      for (let waited = 0;waited <= s.visibilitySeconds + 20 && again === undefined; waited++) {
        await s.pass(1);
        [again] = await s.queue.receive({
          maxMessages: 1,
          visibilityTimeoutSeconds: s.visibilitySeconds,
          waitSeconds: s.emptyWaitSeconds
        });
      }
      expect6(again?.kind === "message" && again.envelope.id).toBe("msg_v");
      expect6(again?.receiveCount).toBe(2);
    });
    test6("extending visibility keeps a message hidden past the original timeout", async () => {
      const s = await subject();
      await s.queue.publish(ping(s));
      const [got] = await take(s, 1);
      await s.queue.extendVisibility(got.receipt, s.visibilitySeconds * 4);
      await s.pass(s.visibilitySeconds + 1);
      expect6(await none(s)).toEqual([]);
    });
    test6("releasing a message makes it receivable at once", async () => {
      const s = await subject();
      await s.queue.publish(ping(s));
      const [got] = await take(s, 1);
      await s.queue.release(got.receipt);
      const [again] = await take(s, 1);
      expect6(again?.receiveCount).toBe(2);
    });
    test6("acknowledging with the receipt of an earlier delivery does not delete the redelivered message", async () => {
      const s = await subject();
      await s.queue.publish(ping(s, 1, "org_a", "msg_stale"));
      const [first] = await take(s, 1);
      await s.pass(s.visibilitySeconds + 1);
      const [second] = await take(s, 1);
      expect6(second?.receiveCount).toBe(2);
      await s.queue.acknowledge(first.receipt);
      await s.queue.release(second.receipt);
      const [third] = await take(s, 1);
      expect6(third?.kind === "message" && third.envelope.id).toBe("msg_stale");
      expect6(third?.receiveCount).toBe(3);
    });
    test6("an acknowledged message is not delivered again", async () => {
      const s = await subject();
      await s.queue.publish(ping(s));
      const [got] = await take(s, 1);
      await s.queue.acknowledge(got.receipt);
      await s.pass(s.visibilitySeconds + 1);
      expect6(await none(s)).toEqual([]);
    });
    test6("a message released maxReceiveCount times moves to the dead-letter queue instead of being delivered again", async () => {
      const s = await subject();
      await s.queue.publish(ping(s, 1, "org_a", "msg_dead"));
      for (let round = 1;round <= s.maxReceiveCount; round++) {
        const [got] = await take(s, 1);
        expect6(got?.receiveCount).toBe(round);
        await s.queue.release(got.receipt);
      }
      expect6(await none(s)).toEqual([]);
      const dead = await s.deadLetterIds();
      if (dead !== undefined) {
        expect6(dead).toEqual(["msg_dead"]);
      }
    });
    test6("two organizations' messages stay separate: each envelope keeps its own organization id", async () => {
      const s = await subject();
      await s.queue.publishBatch([ping(s, 1, "org_a", "same_id"), ping(s, 2, "org_b", "same_id")]);
      const got = await take(s, 2);
      const orgs = got.map((delivery) => delivery.kind === "message" ? delivery.envelope.organizationId : "");
      expect6(orgs.sort()).toEqual(["org_a", "org_b"]);
    });
  });
}
// src/queue/store.behaviour.ts
import { afterEach as afterEach7, describe as describe7, expect as expect7, test as test7 } from "bun:test";
var key = { consumer: "c", organizationId: "org_a", messageId: "m1" };
async function claimed(store, k, lease = 60) {
  const result = await store.claim(k, lease);
  if (result.status !== "claimed") {
    throw new Error(`expected a claim, got ${result.status}`);
  }
  return result.token;
}
function processedStoreBehaviour(name, make) {
  describe7(`ProcessedStore behaviour: ${name}`, () => {
    const open = [];
    afterEach7(async () => {
      await Promise.all(open.splice(0).map((subject) => subject.close()));
    });
    async function subject() {
      const made = await make();
      open.push(made);
      return made;
    }
    test7("a live claim is busy for everyone else, and a done message stays done", async () => {
      const { store } = await subject();
      const token = await claimed(store, key);
      expect7(await store.claim(key, 60)).toMatchObject({ status: "busy" });
      expect7(await store.complete(key, token)).toBe(true);
      expect7(await store.claim(key, 60)).toEqual({ status: "done" });
    });
    test7("busy reports the seconds left on the lease, rounded up, at least one", async () => {
      const { store, pass } = await subject();
      await claimed(store, key);
      await pass(10);
      const busy = await store.claim(key, 60);
      expect7(busy.status).toBe("busy");
      if (busy.status === "busy") {
        expect7(busy.retryAfterSeconds).toBeGreaterThanOrEqual(49);
        expect7(busy.retryAfterSeconds).toBeLessThanOrEqual(51);
      }
    });
    test7("a lapsed claim can be taken again, and the old holder can no longer complete", async () => {
      const { store, pass } = await subject();
      const first = await claimed(store, key);
      await pass(61);
      const second = await claimed(store, key);
      expect7(second).not.toBe(first);
      expect7(await store.complete(key, first)).toBe(false);
      expect7(await store.complete(key, second)).toBe(true);
    });
    test7("release frees the claim for the next delivery; a stale token releases nothing", async () => {
      const { store } = await subject();
      const token = await claimed(store, key);
      await store.release(key, "wrong-token");
      expect7(await store.claim(key, 60)).toMatchObject({ status: "busy" });
      await store.release(key, token);
      expect7(await store.claim(key, 60)).toMatchObject({ status: "claimed" });
    });
    test7("the organization, the consumer and a missing organization are all part of the key", async () => {
      const { store } = await subject();
      await claimed(store, key);
      expect7(await store.claim({ ...key, organizationId: "org_b" }, 60)).toMatchObject({
        status: "claimed"
      });
      expect7(await store.claim({ ...key, organizationId: null }, 60)).toMatchObject({
        status: "claimed"
      });
      expect7(await store.claim({ ...key, consumer: "other" }, 60)).toMatchObject({
        status: "claimed"
      });
      expect7(await store.claim(key, 60)).toMatchObject({ status: "busy" });
    });
    test7("completing a message that was never claimed does nothing", async () => {
      const { store } = await subject();
      expect7(await store.complete(key, "nope")).toBe(false);
    });
    test7("renew pushes the lease out, and only for the holder of a live claim", async () => {
      const { store, pass } = await subject();
      const token = await claimed(store, key);
      await pass(50);
      expect7(await store.renew(key, token, 60)).toBe(true);
      await pass(50);
      expect7(await store.claim(key, 60)).toMatchObject({ status: "busy" });
      expect7(await store.renew(key, "wrong-token", 60)).toBe(false);
      await pass(20);
      expect7(await store.renew(key, token, 60)).toBe(false);
      expect7(await store.renew({ ...key, messageId: "never" }, token, 60)).toBe(false);
    });
    test7("a completed claim cannot be renewed", async () => {
      const { store } = await subject();
      const token = await claimed(store, key);
      await store.complete(key, token);
      expect7(await store.renew(key, token, 60)).toBe(false);
    });
    test7("purge removes old done records and lapsed claims, at most `limit`, and keeps the rest", async () => {
      const { store, pass, now } = await subject();
      for (const id of ["a", "b", "c"]) {
        const k = { ...key, messageId: id };
        await store.complete(k, await claimed(store, k));
      }
      const live = { ...key, messageId: "live" };
      await claimed(store, live, 3600);
      await pass(10);
      const cutoff = now();
      expect7(await store.purge(cutoff, 2)).toBe(2);
      expect7(await store.purge(cutoff, 10)).toBe(1);
      expect7(await store.claim({ ...key, messageId: "a" }, 60)).toMatchObject({ status: "claimed" });
      expect7(await store.claim(live, 60)).toMatchObject({ status: "busy" });
    });
  });
}
// src/storage/behaviour.ts
import { afterEach as afterEach8, describe as describe8, expect as expect8, test as test8 } from "bun:test";
import { createHash } from "node:crypto";
function sameMediaType(x, y) {
  if (x === undefined) {
    return false;
  }
  const parse = (value) => {
    const [type = "", ...params] = value.split(";");
    return {
      type: type.trim().toLowerCase(),
      params: params.map((param) => {
        const at = param.indexOf("=");
        return `${param.slice(0, at).trim().toLowerCase()}=${param.slice(at + 1).trim()}`;
      }).sort()
    };
  };
  const left = parse(x);
  const right = parse(y);
  return left.type === right.type && left.params.join(";") === right.params.join(";");
}
var bytes = (text) => new TextEncoder().encode(text);
var text = (data) => new TextDecoder().decode(data);
function objectStoreBehaviour(name, make, skip = false) {
  const run = skip ? describe8.skip : describe8;
  run(`ObjectStore behaviour: ${name}`, () => {
    const open = [];
    afterEach8(async () => {
      await Promise.all(open.splice(0).map((subject) => subject.close()));
    });
    async function subject() {
      const made = await make();
      open.push(made);
      return made;
    }
    async function keysOf(s, org, prefix) {
      const keys = [];
      let cursor;
      for (let page = 0;page < 50; page++) {
        const got = await s.store.list(org, {
          ...prefix === undefined ? {} : { prefix },
          ...cursor === undefined ? {} : { cursor },
          limit: 1000
        });
        keys.push(...got.items.map((item) => item.key));
        cursor = got.nextCursor;
        if (cursor === undefined) {
          break;
        }
      }
      return keys;
    }
    const BAD_KEYS = [
      "",
      "/",
      "/a",
      "a/",
      "a//b",
      ".",
      "..",
      "../a",
      "a/..",
      "a/../b",
      "a/./b",
      ".hidden",
      "a/.hidden",
      "%2e%2e/a",
      "a%2fb",
      "a\\b",
      "a b",
      "a\x00b",
      `a
b`,
      "café",
      `${"a/".repeat(16)}a`,
      "x".repeat(513),
      `${"x".repeat(129)}`
    ];
    test8.each(BAD_KEYS.map((key) => [JSON.stringify(key.slice(0, 40)), key]))("the key %s is refused by every operation", async (_label, key) => {
      const s = await subject();
      const { a } = s.organizations;
      const code = { code: "storage.invalid_request" };
      await expect8(s.store.put(a, key, bytes("x"))).rejects.toMatchObject(code);
      await expect8(s.store.get(a, key)).rejects.toMatchObject(code);
      await expect8(s.store.head(a, key)).rejects.toMatchObject(code);
      await expect8(s.store.delete(a, key)).rejects.toMatchObject(code);
    });
    test8.each([
      ["empty", ""],
      ["a path", "org/../x"],
      ["a separator", "/x"],
      ["an encoded separator", "x%2Fy"],
      ["a dot segment", ".."],
      ["a wildcard", "x*"],
      ["spaces", "x y"],
      ["too long", "x".repeat(65)]
    ])("an Organization id that is %s is refused", async (_label, id) => {
      const s = await subject();
      const code = { code: "storage.invalid_request" };
      await expect8(s.store.put(id, "k", bytes("x"))).rejects.toMatchObject(code);
      await expect8(s.store.get(id, "k")).rejects.toMatchObject(code);
      await expect8(s.store.head(id, "k")).rejects.toMatchObject(code);
      await expect8(s.store.delete(id, "k")).rejects.toMatchObject(code);
      await expect8(s.store.list(id)).rejects.toMatchObject(code);
    });
    test8("an id built from another Organization id and a path does not reach it", async () => {
      const s = await subject();
      const { a, b } = s.organizations;
      await s.store.put(b, "secret.txt", bytes("b only"));
      for (const id of [`${a}/../${b}`, `${a}/${b}`, `../${b}`, `${b}/`, `${b}/.`]) {
        await expect8(s.store.get(id, "secret.txt")).rejects.toMatchObject({
          code: "storage.invalid_request"
        });
        await expect8(s.store.list(id)).rejects.toMatchObject({ code: "storage.invalid_request" });
      }
    });
    test8("an object comes back as written, with its content type as given", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.store.put(a, "docs/one.txt", bytes("hello"), {
        contentType: "text/plain; charset=utf-8"
      });
      const got = await s.store.get(a, "docs/one.txt");
      expect8(got?.key).toBe("docs/one.txt");
      expect8(text(got?.body ?? new Uint8Array)).toBe("hello");
      expect8(got?.size).toBe(5);
      expect8(sameMediaType(got?.contentType, "text/plain; charset=utf-8")).toBe(true);
      expect8(got?.lastModified).toBeInstanceOf(Date);
      expect8(Number.isNaN(got?.lastModified.getTime())).toBe(false);
      const info = await s.store.head(a, "docs/one.txt");
      expect8(info).toMatchObject({ key: "docs/one.txt", size: 5 });
      expect8(sameMediaType(info?.contentType, "text/plain; charset=utf-8")).toBe(true);
    });
    test8("a content type without parameters comes back byte for byte", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.store.put(a, "a.pdf", bytes("%PDF"), { contentType: "application/pdf" });
      expect8((await s.store.get(a, "a.pdf"))?.contentType).toBe("application/pdf");
      expect8((await s.store.head(a, "a.pdf"))?.contentType).toBe("application/pdf");
    });
    test8("a different media type or parameter value is not the same content type", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.store.put(a, "k", bytes("x"), { contentType: "text/plain; charset=utf-8" });
      const got = await s.store.head(a, "k");
      expect8(sameMediaType(got?.contentType, "text/html; charset=utf-8")).toBe(false);
      expect8(sameMediaType(got?.contentType, "text/plain; charset=latin1")).toBe(false);
      expect8(sameMediaType(got?.contentType, "text/plain")).toBe(false);
    });
    test8("without a content type the store says application/octet-stream", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.store.put(a, "blob", new Uint8Array([0, 255, 1, 254]));
      const got = await s.store.get(a, "blob");
      expect8(got?.contentType).toBe("application/octet-stream");
      expect8([...got?.body ?? []]).toEqual([0, 255, 1, 254]);
    });
    test8("content is stored as bytes whatever its content type claims", async () => {
      const s = await subject();
      const { a } = s.organizations;
      const html = bytes("<script>alert(1)</script>");
      await s.store.put(a, "liar.png", html, { contentType: "image/png" });
      const got = await s.store.get(a, "liar.png");
      expect8(text(got?.body ?? new Uint8Array)).toBe("<script>alert(1)</script>");
      expect8(got?.contentType).toBe("image/png");
    });
    test8("an empty object is stored", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.store.put(a, "empty", new Uint8Array);
      expect8((await s.store.get(a, "empty"))?.size).toBe(0);
    });
    test8.each([
      ["no slash", "text"],
      ["a header break", `text/plain\r
x-injected: 1`],
      ["spaces in the type", "te xt/plain"],
      ["a quote-less parameter name", "text/plain; =x"],
      ["an empty string", ""],
      ["too long", `text/${"x".repeat(260)}`]
    ])("a content type with %s is refused and nothing is stored", async (_label, contentType) => {
      const s = await subject();
      const { a } = s.organizations;
      await expect8(s.store.put(a, "k", bytes("x"), { contentType })).rejects.toMatchObject({
        code: "storage.invalid_request"
      });
      expect8(await s.store.head(a, "k")).toBeUndefined();
    });
    test8("a body that is not bytes is refused", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await expect8(s.store.put(a, "k", "text")).rejects.toMatchObject({
        code: "storage.invalid_request"
      });
    });
    test8("an object over the size limit is refused and the limit itself is accepted", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await expect8(s.store.put(a, "big", new Uint8Array(s.maxObjectBytes + 1))).rejects.toMatchObject({ code: "storage.object_too_large" });
      expect8(await s.store.head(a, "big")).toBeUndefined();
      await s.store.put(a, "edge", new Uint8Array(s.maxObjectBytes));
      expect8((await s.store.head(a, "edge"))?.size).toBe(s.maxObjectBytes);
    });
    test8("a missing object reads as undefined", async () => {
      const s = await subject();
      const { a } = s.organizations;
      expect8(await s.store.get(a, "nothing")).toBeUndefined();
      expect8(await s.store.head(a, "nothing")).toBeUndefined();
    });
    test8("writing a key again replaces the object, and writing the same thing twice changes nothing", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.store.put(a, "k", bytes("one"), { contentType: "text/plain" });
      await s.store.put(a, "k", bytes("two"), { contentType: "text/csv" });
      await s.store.put(a, "k", bytes("two"), { contentType: "text/csv" });
      const got = await s.store.get(a, "k");
      expect8(text(got?.body ?? new Uint8Array)).toBe("two");
      expect8(got?.contentType).toBe("text/csv");
      expect8(await keysOf(s, a)).toEqual(["k"]);
    });
    test8("deleting removes the object, and deleting again or deleting nothing resolves", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.store.put(a, "k", bytes("x"));
      await s.store.delete(a, "k");
      expect8(await s.store.get(a, "k")).toBeUndefined();
      await s.store.delete(a, "k");
      await s.store.delete(a, "never-existed");
    });
    test8("a second Organization cannot read, head, list or delete the first one's objects", async () => {
      const s = await subject();
      const { a, b } = s.organizations;
      await s.store.put(a, "docs/plan.txt", bytes("a secret"));
      expect8(await s.store.get(b, "docs/plan.txt")).toBeUndefined();
      expect8(await s.store.head(b, "docs/plan.txt")).toBeUndefined();
      expect8(await keysOf(s, b)).toEqual([]);
      expect8(await keysOf(s, b, "docs/")).toEqual([]);
      await s.store.delete(b, "docs/plan.txt");
      expect8(text((await s.store.get(a, "docs/plan.txt"))?.body ?? new Uint8Array)).toBe("a secret");
    });
    test8("the same key in two Organizations holds two objects", async () => {
      const s = await subject();
      const { a, b } = s.organizations;
      await s.store.put(a, "same", bytes("from a"));
      await s.store.put(b, "same", bytes("from b"));
      expect8(text((await s.store.get(a, "same"))?.body ?? new Uint8Array)).toBe("from a");
      expect8(text((await s.store.get(b, "same"))?.body ?? new Uint8Array)).toBe("from b");
      await s.store.delete(a, "same");
      expect8(text((await s.store.get(b, "same"))?.body ?? new Uint8Array)).toBe("from b");
    });
    test8("an Organization whose id starts with another id is a different Organization", async () => {
      const s = await subject();
      const { a, aExtended } = s.organizations;
      await s.store.put(a, "one", bytes("a"));
      await s.store.put(aExtended, "two", bytes("extended"));
      expect8(await keysOf(s, a)).toEqual(["one"]);
      expect8(await keysOf(s, aExtended)).toEqual(["two"]);
      expect8(await s.store.get(a, "two")).toBeUndefined();
      expect8(await s.store.get(aExtended, "one")).toBeUndefined();
      await s.store.delete(a, "two");
      expect8(await keysOf(s, aExtended)).toEqual(["two"]);
    });
    test8("a key cannot name another Organization through a path", async () => {
      const s = await subject();
      const { a, b } = s.organizations;
      await s.store.put(b, "secret.txt", bytes("b only"));
      for (const key of [
        `../${b}/secret.txt`,
        `/${b}/secret.txt`,
        `${b}/../${b}/secret.txt`,
        `..%2f${b}%2fsecret.txt`
      ]) {
        await expect8(s.store.get(a, key)).rejects.toMatchObject({ code: "storage.invalid_request" });
        await expect8(s.store.delete(a, key)).rejects.toMatchObject({
          code: "storage.invalid_request"
        });
      }
      for (const prefix of ["../", `../${b}/`, "/", `${a}/../${b}/`, "%2e%2e/", "*", ".."]) {
        await expect8(s.store.list(a, { prefix })).rejects.toMatchObject({
          code: "storage.invalid_request"
        });
      }
      expect8(text((await s.store.get(b, "secret.txt"))?.body ?? new Uint8Array)).toBe("b only");
    });
    test8("a list is a page, in key order, that ends with no cursor", async () => {
      const s = await subject();
      const { a } = s.organizations;
      for (const key of ["c", "a", "b/2", "b/1", "d"]) {
        await s.store.put(a, key, bytes(key));
      }
      const seen = [];
      let cursor;
      let pages = 0;
      do {
        const page = await s.store.list(a, {
          limit: 2,
          ...cursor === undefined ? {} : { cursor }
        });
        expect8(page.items.length).toBeLessThanOrEqual(2);
        seen.push(...page.items.map((item) => item.key));
        for (const item of page.items) {
          expect8(item.size).toBe(item.key.length);
          expect8(item.lastModified).toBeInstanceOf(Date);
        }
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== undefined && pages < 10);
      expect8(seen).toEqual(["a", "b/1", "b/2", "c", "d"]);
      expect8(pages).toBe(3);
    });
    test8("a list without a limit returns at most 100", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await Promise.all(Array.from({ length: 105 }, (_, i) => s.store.put(a, `n${String(i).padStart(3, "0")}`, bytes("x"))));
      const page = await s.store.list(a);
      expect8(page.items).toHaveLength(100);
      expect8(page.nextCursor).toBeDefined();
      const rest = await s.store.list(a, { cursor: page.nextCursor });
      expect8(rest.items).toHaveLength(5);
      expect8(rest.nextCursor).toBeUndefined();
    });
    test8("a prefix keeps only the keys that start with it", async () => {
      const s = await subject();
      const { a } = s.organizations;
      for (const key of ["docs/a.txt", "docs/b.txt", "docs2/c.txt", "other/d.txt", "docsx"]) {
        await s.store.put(a, key, bytes("x"));
      }
      expect8(await keysOf(s, a, "docs/")).toEqual(["docs/a.txt", "docs/b.txt"]);
      expect8(await keysOf(s, a, "docs/a")).toEqual(["docs/a.txt"]);
      expect8(await keysOf(s, a, "docs")).toEqual([
        "docs/a.txt",
        "docs/b.txt",
        "docs2/c.txt",
        "docsx"
      ]);
      expect8(await keysOf(s, a, "nothing/")).toEqual([]);
    });
    test8.each([[0], [-1], [1001], [1.5], [Number.NaN]])("a list limit of %p is refused", async (limit) => {
      const s = await subject();
      await expect8(s.store.list(s.organizations.a, { limit })).rejects.toMatchObject({
        code: "storage.invalid_request"
      });
    });
    test8("a forged cursor is refused", async () => {
      const s = await subject();
      const { a } = s.organizations;
      const forged = [
        "not a cursor!",
        "",
        Buffer.from("../x").toString("base64url"),
        Buffer.from("/x").toString("base64url"),
        Buffer.from(`${a}/../x`).toString("base64url"),
        `${Buffer.from("k").toString("base64url")}=`,
        "a".repeat(701)
      ];
      for (const cursor of forged) {
        await expect8(s.store.list(a, { cursor })).rejects.toMatchObject({
          code: "storage.invalid_request"
        });
      }
    });
    test8("one Organization's cursor used by another lists only the second one's objects", async () => {
      const s = await subject();
      const { a, b } = s.organizations;
      for (const key of ["k1", "k2", "k3"]) {
        await s.store.put(a, key, bytes("a"));
      }
      await s.store.put(b, "k9", bytes("b"));
      const page = await s.store.list(a, { limit: 1 });
      const cursor = page.nextCursor;
      const other = await s.store.list(b, { cursor });
      expect8(other.items.map((item) => item.key)).toEqual(["k9"]);
    });
    test8("the body that get returns is a copy", async () => {
      const s = await subject();
      const { a } = s.organizations;
      const original = bytes("keep");
      await s.store.put(a, "k", original);
      original[0] = 0;
      const first = await s.store.get(a, "k");
      (first?.body)[1] = 0;
      expect8(text((await s.store.get(a, "k"))?.body ?? new Uint8Array)).toBe("keep");
    });
    describe8("streaming", () => {
      const sha = (data) => createHash("sha256").update(data).digest("hex");
      async function* chunksOf(data, size = 7) {
        for (let at = 0;at < data.byteLength; at += size) {
          yield data.subarray(at, at + size);
        }
      }
      async function readAll(stream) {
        const parts = [];
        for await (const part of stream) {
          parts.push(part);
        }
        const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
        let at = 0;
        for (const part of parts) {
          out.set(part, at);
          at += part.byteLength;
        }
        return out;
      }
      test8("a streamed object reads back the same, with its size and SHA-256", async () => {
        const s = await subject();
        const { a } = s.organizations;
        const data = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
        const result = await s.store.putStream(a, "rec/one.bin", chunksOf(data), {
          maxBytes: 5000,
          contentType: "audio/mpeg"
        });
        expect8(result).toEqual({ size: 1000, sha256: sha(data) });
        const got = await s.store.get(a, "rec/one.bin");
        expect8(Array.from(got?.body ?? [])).toEqual(Array.from(data));
        expect8(got?.contentType).toBe("audio/mpeg");
        const streamed = await s.store.getStream(a, "rec/one.bin");
        expect8(streamed?.size).toBe(1000);
        expect8(Array.from(await readAll(streamed.body))).toEqual(Array.from(data));
      });
      test8("a web stream and an empty stream are accepted", async () => {
        const s = await subject();
        const { a } = s.organizations;
        const web = new ReadableStream({
          start(controller) {
            controller.enqueue(bytes("hel"));
            controller.enqueue(bytes("lo"));
            controller.close();
          }
        });
        expect8((await s.store.putStream(a, "web", web, { maxBytes: 10 })).size).toBe(5);
        expect8(text((await s.store.get(a, "web"))?.body ?? new Uint8Array)).toBe("hello");
        const empty = await s.store.putStream(a, "empty", chunksOf(new Uint8Array), {
          maxBytes: 10
        });
        expect8(empty).toEqual({ size: 0, sha256: sha(new Uint8Array) });
        expect8((await s.store.head(a, "empty"))?.size).toBe(0);
      });
      test8("a stream over maxBytes is refused, leaves nothing readable and keeps an older object", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await s.store.put(a, "old", bytes("old"));
        await expect8(s.store.putStream(a, "new", chunksOf(new Uint8Array(100)), { maxBytes: 99 })).rejects.toMatchObject({ code: "storage.object_too_large" });
        await expect8(s.store.putStream(a, "old", chunksOf(new Uint8Array(100)), { maxBytes: 99 })).rejects.toMatchObject({ code: "storage.object_too_large" });
        expect8(await s.store.head(a, "new")).toBeUndefined();
        expect8(text((await s.store.get(a, "old"))?.body ?? new Uint8Array)).toBe("old");
        expect8((await s.store.putStream(a, "exact", chunksOf(new Uint8Array(99)), { maxBytes: 99 })).size).toBe(99);
      });
      test8("a stream that fails midway leaves nothing readable", async () => {
        const s = await subject();
        const { a } = s.organizations;
        async function* broken() {
          yield bytes("some");
          throw new Error("the client went away");
        }
        await expect8(s.store.putStream(a, "half", broken(), { maxBytes: 100 })).rejects.toMatchObject({ code: "storage.invalid_request" });
        expect8(await s.store.head(a, "half")).toBeUndefined();
      });
      test8("an aborted signal stops the write and leaves nothing readable", async () => {
        const s = await subject();
        const { a } = s.organizations;
        const controller = new AbortController;
        async function* slow() {
          yield bytes("first");
          controller.abort();
          yield bytes("second");
        }
        await expect8(s.store.putStream(a, "aborted", slow(), { maxBytes: 100, signal: controller.signal })).rejects.toMatchObject({ code: "storage.unavailable" });
        expect8(await s.store.head(a, "aborted")).toBeUndefined();
      });
      test8.each([[0], [-1], [1.5], [Number.NaN], [2 ** 31 + 1], ["5"]])("maxBytes %p is refused", async (maxBytes) => {
        const s = await subject();
        const { a } = s.organizations;
        await expect8(s.store.putStream(a, "k", chunksOf(bytes("x")), { maxBytes })).rejects.toMatchObject({ code: "storage.invalid_request" });
      });
      test8("a body that is not a stream, a bad key and a bad Organization are refused", async () => {
        const s = await subject();
        const { a } = s.organizations;
        const options = { maxBytes: 10 };
        await expect8(s.store.putStream(a, "k", "text", options)).rejects.toMatchObject({ code: "storage.invalid_request" });
        await expect8(s.store.putStream(a, "../k", chunksOf(bytes("x")), options)).rejects.toMatchObject({ code: "storage.invalid_request" });
        await expect8(s.store.putStream("bad/org", "k", chunksOf(bytes("x")), options)).rejects.toMatchObject({ code: "storage.invalid_request" });
      });
      test8("a second Organization cannot read the first one's streamed object", async () => {
        const s = await subject();
        const { a, b } = s.organizations;
        await s.store.putStream(a, "rec", chunksOf(bytes("private")), { maxBytes: 100 });
        expect8(await s.store.getStream(b, "rec")).toBeUndefined();
        expect8(await s.store.getStream(a, "missing")).toBeUndefined();
      });
    });
    describe8("presigned reads", () => {
      test8("a presigned URL returns the object, and a missing object gives nothing", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await s.store.put(a, "rec/one.mp3", bytes("the audio"));
        const url = await s.store.presignGet(a, "rec/one.mp3", { expiresInSeconds: 300 });
        const missing = await s.store.presignGet(a, "rec/none.mp3", { expiresInSeconds: 300 });
        expect8(typeof url).toBe("string");
        expect8(["http:", "https:"]).toContain(new URL(url).protocol);
        expect8(text(await s.readPresigned(url) ?? new Uint8Array)).toBe("the audio");
        expect8(await s.readPresigned(missing)).toBeUndefined();
      });
      test8("a second Organization's URL for the same key reaches only its own object", async () => {
        const s = await subject();
        const { a, b } = s.organizations;
        await s.store.put(a, "rec/one.mp3", bytes("first org"));
        const other = await s.store.presignGet(b, "rec/one.mp3", { expiresInSeconds: 300 });
        const mine = await s.store.presignGet(a, "rec/one.mp3", { expiresInSeconds: 300 });
        expect8(other).not.toBe(mine);
        expect8(await s.readPresigned(other)).toBeUndefined();
        await s.store.put(b, "rec/one.mp3", bytes("second org"));
        expect8(text(await s.readPresigned(other) ?? new Uint8Array)).toBe("second org");
        expect8(text(await s.readPresigned(mine) ?? new Uint8Array)).toBe("first org");
      });
      test8("the expiry is 1 to 900 seconds and defaults to 300", async () => {
        const s = await subject();
        const { a } = s.organizations;
        for (const expiresInSeconds of [1, 300, 900]) {
          expect8(typeof await s.store.presignGet(a, "k", { expiresInSeconds })).toBe("string");
        }
        expect8(typeof await s.store.presignGet(a, "k")).toBe("string");
        for (const expiresInSeconds of [
          0,
          -1,
          901,
          3600,
          1.5,
          Number.NaN,
          Number.POSITIVE_INFINITY,
          "5"
        ]) {
          await expect8(s.store.presignGet(a, "k", { expiresInSeconds })).rejects.toMatchObject({ code: "storage.invalid_request" });
        }
      });
      test8("a bad key or Organization is refused, and the refusal does not repeat the key", async () => {
        const s = await subject();
        const { a } = s.organizations;
        for (const key of BAD_KEYS.slice(0, 6)) {
          await expect8(s.store.presignGet(a, key, { expiresInSeconds: 60 })).rejects.toMatchObject({
            code: "storage.invalid_request"
          });
        }
        await expect8(s.store.presignGet("bad/org", "k", { expiresInSeconds: 60 })).rejects.toMatchObject({ code: "storage.invalid_request" });
        try {
          await s.store.presignGet(a, "secret-name/../x", { expiresInSeconds: 60 });
        } catch (error) {
          expect8(String(error.message)).not.toContain("secret-name");
        }
      });
    });
  });
}
// src/streaming-transcribe/behaviour.ts
import { afterEach as afterEach9, describe as describe9, expect as expect9, test as test9 } from "bun:test";
import { callIdSchema } from "tula-closeline-contract";
var CHUNK = 3200;
var SECRET_TEXT2 = "zebra confidential pricing";
var AUDIO_MARKER = "AUDIO-MARKER-PAYLOAD";
function audio(bytes) {
  const marker = new TextEncoder().encode(AUDIO_MARKER);
  const out = new Uint8Array(bytes);
  for (let i = 0;i < bytes; i++) {
    out[i] = marker[i % marker.length] ?? 0;
  }
  return out;
}
function streamingTranscribeBehaviour(name, make, skip = false) {
  const run = skip ? describe9.skip : describe9;
  run(`Streaming transcribe behaviour: ${name}`, () => {
    const made = [];
    const streams = [];
    afterEach9(async () => {
      await Promise.all(streams.splice(0).map((stream) => stream.close().catch(() => {
        return;
      })));
      await Promise.all(made.splice(0).map((subject) => subject.close()));
    });
    async function subject() {
      const next = await make();
      made.push(next);
      return next;
    }
    const callId = callIdSchema.parse(`call_${"c".repeat(32)}`);
    const otherCallId = callIdSchema.parse(`call_${"d".repeat(32)}`);
    async function open(s, overrides = {}) {
      const events = [];
      const stream = await s.port.open({
        organizationId: s.organizations.a,
        callId,
        track: "prospect",
        encoding: "pcm_s16le",
        sampleRate: 16000,
        reconnect: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 4 },
        ...overrides,
        onEvent: (event) => events.push(event)
      });
      streams.push(stream);
      return {
        stream,
        events,
        turns: () => events.filter((e) => e.type === "turn")
      };
    }
    async function until(condition, what) {
      const deadline = Date.now() + 5000;
      while (!condition()) {
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for ${what}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    }
    const sayTwo = [{ text: "we need a lower price" }, { text: "send me the quote today" }];
    test9("interims come before the final of a turn, with continuous word times", async () => {
      const s = await subject();
      s.hear(s.organizations.a, callId, "prospect", sayTwo, CHUNK);
      const { stream, turns } = await open(s);
      stream.sendAudio(audio(CHUNK));
      await until(() => turns().some((t) => t.isFinal), "the first final");
      stream.sendAudio(audio(CHUNK));
      await until(() => turns().filter((t) => t.isFinal).length === 2, "the second final");
      const all = turns();
      expect9(all.map((t) => t.sequence)).toEqual(all.map((_, i) => i + 1));
      for (const id of new Set(all.map((t) => t.turnId))) {
        const ofTurn = all.filter((t) => t.turnId === id);
        const final = ofTurn.at(-1);
        expect9(final?.isFinal).toBe(true);
        expect9(ofTurn.filter((t) => t.isFinal)).toHaveLength(1);
        expect9(ofTurn.length).toBeGreaterThan(1);
        for (const interim of ofTurn.slice(0, -1)) {
          expect9(interim.isFinal).toBe(false);
          expect9(interim.endOfTurn).toBe(false);
          expect9(final?.text.startsWith(interim.text)).toBe(true);
        }
      }
      let previousEnd = 0;
      for (const final of all.filter((t) => t.isFinal)) {
        expect9(final.words.map((w) => w.text).join(" ")).toBe(final.text);
        for (const word of final.words) {
          expect9(word.startMs).toBeGreaterThanOrEqual(previousEnd);
          expect9(word.endMs).toBeGreaterThanOrEqual(word.startMs);
          previousEnd = word.endMs;
        }
      }
    });
    test9("the end of turn is marked on the final only, and the next turn has a new id", async () => {
      const s = await subject();
      s.hear(s.organizations.a, callId, "prospect", sayTwo, CHUNK);
      const { stream, turns } = await open(s);
      stream.sendAudio(audio(CHUNK * 2));
      await until(() => turns().filter((t) => t.endOfTurn).length === 2, "two ends of turn");
      const all = turns();
      expect9(all.filter((t) => t.endOfTurn).every((t) => t.isFinal)).toBe(true);
      const ends = all.filter((t) => t.endOfTurn);
      expect9(ends[0]?.turnId).not.toBe(ends[1]?.turnId);
      expect9(all.at(-1)?.endOfTurn).toBe(true);
    });
    test9("a dropped stream reconnects and goes on, with word times continuing", async () => {
      const s = await subject();
      s.hear(s.organizations.a, callId, "prospect", sayTwo, CHUNK);
      const { stream, events, turns } = await open(s);
      stream.sendAudio(audio(CHUNK));
      await until(() => turns().some((t) => t.endOfTurn), "the first turn");
      const firstEnd = turns().find((t) => t.endOfTurn)?.words.at(-1)?.endMs ?? 0;
      s.failReconnects(1);
      await s.dropConnection(stream.streamId);
      const kinds = events.filter((e) => e.type !== "turn").map((e) => e.type);
      expect9(kinds).toEqual(["reconnecting", "reconnecting", "reconnected"]);
      const attempts = events.filter((e) => e.type === "reconnecting");
      expect9(attempts.map((e) => e.type === "reconnecting" ? e.attempt : 0)).toEqual([1, 2]);
      for (const attempt of attempts) {
        if (attempt.type === "reconnecting") {
          expect9(attempt.delayMs).toBeGreaterThanOrEqual(1);
          expect9(attempt.delayMs).toBeLessThanOrEqual(6);
        }
      }
      stream.sendAudio(audio(CHUNK));
      await until(() => turns().filter((t) => t.endOfTurn).length === 2, "the turn after");
      const second = turns().filter((t) => t.endOfTurn)[1];
      expect9(second?.words[0]?.startMs).toBeGreaterThanOrEqual(firstEnd);
      const sequences = turns().map((t) => t.sequence);
      expect9(sequences).toEqual(sequences.map((_, i) => i + 1));
    });
    test9("a stream that cannot be restored ends with one failed event and one metadata report", async () => {
      const s = await subject();
      s.hear(s.organizations.a, callId, "prospect", [{ text: SECRET_TEXT2 }], CHUNK);
      const { stream, events } = await open(s, { reconnect: { maxAttempts: 2, baseDelayMs: 1 } });
      s.failReconnects(10);
      await s.dropConnection(stream.streamId);
      const reconnecting = events.filter((e) => e.type === "reconnecting");
      expect9(reconnecting).toHaveLength(2);
      expect9(events.filter((e) => e.type === "reconnected")).toHaveLength(0);
      const last = events.at(-1);
      expect9(last).toMatchObject({
        type: "failed",
        code: "streaming_transcribe.unavailable",
        attempts: 2
      });
      expect9(events.filter((e) => e.type === "failed" || e.type === "closed")).toHaveLength(1);
      expect9(() => stream.sendAudio(audio(CHUNK))).toThrow(expect9.objectContaining({ code: "streaming_transcribe.closed" }));
      await stream.close();
      expect9(events.at(-1)?.type).toBe("failed");
      expect9(s.reporter.captured).toHaveLength(1);
      expect9(s.reporter.captured[0]?.error).toMatchObject({
        code: "streaming_transcribe.unavailable"
      });
      expect9(s.reporter.captured[0]?.context.organizationId).toBe(s.organizations.a);
    });
    test9("a drop with no attempts allowed fails at once", async () => {
      const s = await subject();
      const { stream, events } = await open(s, { reconnect: { maxAttempts: 0 } });
      await s.dropConnection(stream.streamId);
      expect9(events.map((e) => e.type)).toEqual(["failed"]);
    });
    test9("closing ends the events, is idempotent and frees the Call and track", async () => {
      const s = await subject();
      s.hear(s.organizations.a, callId, "prospect", sayTwo, CHUNK);
      const { stream, events } = await open(s);
      await stream.close();
      await stream.close();
      expect9(events.filter((e) => e.type === "closed")).toHaveLength(1);
      expect9(events.at(-1)?.type).toBe("closed");
      expect9(() => stream.sendAudio(audio(CHUNK))).toThrow(expect9.objectContaining({ code: "streaming_transcribe.closed" }));
      const count = events.length;
      await s.dropConnection(stream.streamId);
      expect9(events).toHaveLength(count);
      const again = await open(s);
      await again.stream.close();
    });
    test9("closing during a reconnect stops it and ends with closed", async () => {
      const s = await subject();
      const { stream, events } = await open(s, {
        reconnect: { maxAttempts: 5, baseDelayMs: 20, maxDelayMs: 20 }
      });
      s.failReconnects(10);
      const dropping = s.dropConnection(stream.streamId);
      await until(() => events.some((e) => e.type === "reconnecting"), "a reconnect attempt");
      await stream.close();
      await dropping;
      expect9(events.at(-1)?.type).toBe("closed");
      expect9(events.some((e) => e.type === "failed")).toBe(false);
    });
    test9("one live stream per Call and track; another track or Organization is separate", async () => {
      const s = await subject();
      const first = await open(s);
      await expect9(open(s)).rejects.toMatchObject({ code: "streaming_transcribe.conflict" });
      const rep = await open(s, { track: "rep" });
      const other = await open(s, { organizationId: s.organizations.b });
      s.hear(s.organizations.b, callId, "prospect", [{ text: "only for the other org" }], CHUNK);
      expect9(first.events).toHaveLength(0);
      expect9(rep.events).toHaveLength(0);
      expect9(other.events).toHaveLength(0);
    });
    test9("a stream hears only what was arranged for its own Organization", async () => {
      const s = await subject();
      s.hear(s.organizations.a, otherCallId, "prospect", sayTwo, CHUNK);
      const b = await open(s, { organizationId: s.organizations.b, callId: otherCallId });
      b.stream.sendAudio(audio(CHUNK * 2));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect9(b.turns()).toHaveLength(0);
    });
    test9("refuses a bad request or chunk before talking to the vendor", async () => {
      const s = await subject();
      const bad = [
        { track: "both" },
        { encoding: "mp3" },
        { sampleRate: 44100 },
        { callId: "nope" },
        { organizationId: "nope" },
        { language: "english please" },
        { reconnect: { maxAttempts: 11 } },
        { reconnect: { baseDelayMs: 0 } }
      ];
      for (const override of bad) {
        await expect9(open(s, override)).rejects.toMatchObject({ code: "streaming_transcribe.invalid_request" });
      }
      await expect9(s.port.open({
        organizationId: s.organizations.a,
        callId,
        track: "rep",
        encoding: "pcm_s16le",
        sampleRate: 16000,
        onEvent: () => {
          return;
        }
      }, { timeoutMs: 0 })).rejects.toMatchObject({ code: "streaming_transcribe.invalid_request" });
      const { stream } = await open(s);
      for (const chunk of [new Uint8Array(0), new Uint8Array(65537)]) {
        expect9(() => stream.sendAudio(chunk)).toThrow(expect9.objectContaining({ code: "streaming_transcribe.invalid_request" }));
      }
    });
    test9("a throwing listener does not stop the stream", async () => {
      const s = await subject();
      s.hear(s.organizations.a, callId, "prospect", sayTwo, CHUNK);
      let seen = 0;
      const stream = await s.port.open({
        organizationId: s.organizations.a,
        callId,
        track: "prospect",
        encoding: "pcm_s16le",
        sampleRate: 16000,
        onEvent: () => {
          seen += 1;
          throw new Error(SECRET_TEXT2);
        }
      });
      streams.push(stream);
      stream.sendAudio(audio(CHUNK * 2));
      await until(() => seen >= 2, "events to a throwing listener");
      expect9(s.logs().join(`
`)).not.toContain(SECRET_TEXT2);
    });
    test9("no audio and no transcript text reaches a log or the error reporter", async () => {
      const s = await subject();
      s.hear(s.organizations.a, callId, "prospect", [{ text: SECRET_TEXT2 }], CHUNK);
      const { stream, turns } = await open(s, { reconnect: { maxAttempts: 1, baseDelayMs: 1 } });
      stream.sendAudio(audio(CHUNK));
      await until(() => turns().some((t) => t.endOfTurn), "the turn");
      s.failReconnects(10);
      await s.dropConnection(stream.streamId);
      expect9(s.reporter.captured).toHaveLength(1);
      const seen = [
        ...s.logs(),
        JSON.stringify(s.reporter.captured, (_key, value) => value instanceof Error ? { ...value, name: value.name, message: value.message, stack: value.stack } : value)
      ].join(`
`);
      for (const secret of [SECRET_TEXT2, "confidential", "zebra", AUDIO_MARKER]) {
        expect9(seen).not.toContain(secret);
      }
      const reported = s.reporter.captured[0];
      const tags = reported?.context.tags ?? {};
      expect9(Object.keys(reported?.context ?? {}).sort()).toEqual(["organizationId", "tags"]);
      expect9(Object.keys(tags).sort()).toEqual(["feature", "track"]);
    });
  });
}
// src/telephony/behaviour.ts
import { afterEach as afterEach10, describe as describe10, expect as expect10, test as test10 } from "bun:test";
import {
  callIdSchema as callIdSchema2,
  membershipIdSchema,
  softphoneTokenSchema
} from "tula-closeline-contract";
function telephonyBehaviour(name, make, skip = false) {
  const run = skip ? describe10.skip : describe10;
  run(`Telephony behaviour: ${name}`, () => {
    const open = [];
    afterEach10(async () => {
      await Promise.all(open.splice(0).map((subject) => subject.close()));
    });
    async function subject() {
      const made = await make();
      open.push(made);
      return made;
    }
    const callId = callIdSchema2.parse(`call_${"c".repeat(32)}`);
    const rep = membershipIdSchema.parse(`mem_${"1".repeat(32)}`);
    const otherRep = membershipIdSchema.parse(`mem_${"2".repeat(32)}`);
    const line = "+14155550100";
    const wording = { wordingVersion: 1, text: "This call is recorded.", aiAssisted: false };
    let keyCounter = 0;
    const key = () => `key-${++keyCounter}-${Math.random().toString(36).slice(2)}`;
    async function place(s, scenario = "answers") {
      const placed = await s.telephony.placeCall({
        organizationId: s.organizations.a,
        callId,
        idempotencyKey: key(),
        from: line,
        to: s.numberFor(scenario)
      });
      return {
        ...placed,
        ref: { organizationId: s.organizations.a, providerCallId: placed.providerCallId }
      };
    }
    async function disclosed(s, aiAssisted = false) {
      const placed = await place(s);
      await s.telephony.playDisclosure({ ...placed.ref, ...wording, aiAssisted });
      return placed;
    }
    const code = (value) => ({ code: value });
    describe10("placing a call", () => {
      test10("a Prospect who answers: the call rings, then is answered", async () => {
        const s = await subject();
        const placed = await place(s);
        expect10(placed.created).toBe(true);
        expect10(placed.providerCallId.length).toBeGreaterThan(0);
        expect10((await s.takeEvents()).map((e) => e.type)).toEqual(["ringing", "answered"]);
      });
      test10("the same idempotency key places exactly one call", async () => {
        const s = await subject();
        const request = {
          organizationId: s.organizations.a,
          callId,
          idempotencyKey: key(),
          from: line,
          to: s.numberFor("answers")
        };
        const first = await s.telephony.placeCall(request);
        const second = await s.telephony.placeCall(request);
        expect10(second).toEqual({ providerCallId: first.providerCallId, created: false });
        expect10((await s.takeEvents()).filter((e) => e.type === "ringing")).toHaveLength(1);
      });
      test10("the same key for another number is refused", async () => {
        const s = await subject();
        const idempotencyKey = key();
        const base = { organizationId: s.organizations.a, callId, idempotencyKey, from: line };
        await s.telephony.placeCall({ ...base, to: s.numberFor("answers") });
        await expect10(s.telephony.placeCall({ ...base, to: s.numberFor("busy") })).rejects.toMatchObject(code("telephony.invalid_request"));
      });
      test10("the same key in another Organization is a different call", async () => {
        const s = await subject();
        const base = { callId, idempotencyKey: key(), from: line, to: s.numberFor("answers") };
        const a = await s.telephony.placeCall({ ...base, organizationId: s.organizations.a });
        const b = await s.telephony.placeCall({ ...base, organizationId: s.organizations.b });
        expect10(b.created).toBe(true);
        expect10(b.providerCallId).not.toBe(a.providerCallId);
      });
      test10.each([
        ["to", { to: "4155550100" }],
        ["to", { to: "+0123" }],
        ["from", { from: "not a number" }],
        ["idempotencyKey", { idempotencyKey: "" }],
        ["idempotencyKey", { idempotencyKey: "has space" }],
        ["callId", { callId: "call_1" }],
        ["organizationId", { organizationId: "org_1" }]
      ])("a bad %s is refused before the provider is asked", async (_field, bad) => {
        const s = await subject();
        const request = {
          organizationId: s.organizations.a,
          callId,
          idempotencyKey: key(),
          from: line,
          to: s.numberFor("answers"),
          ...bad
        };
        await expect10(s.telephony.placeCall(request)).rejects.toMatchObject(code("telephony.invalid_request"));
        expect10(await s.takeEvents()).toHaveLength(0);
      });
      test10("a Prospect who does not answer: no_answer", async () => {
        const s = await subject();
        await place(s, "no_answer");
        const events = await s.takeEvents();
        expect10(events.map((e) => e.type)).toEqual(["ringing", "no_answer"]);
        expect10(events[1]).toMatchObject({ failureReason: "no_answer" });
      });
      test10("a busy Prospect: busy", async () => {
        const s = await subject();
        await place(s, "busy");
        expect10((await s.takeEvents()).at(-1)).toMatchObject({ type: "busy", failureReason: "busy" });
      });
      test10("a carrier failure: failed with a contract reason, and the call is over", async () => {
        const s = await subject();
        const placed = await place(s, "carrier_failure");
        const last = (await s.takeEvents()).at(-1);
        expect10(last?.type).toBe("failed");
        expect10(["carrier_dropped", "carrier_rejected", "provider_error"]).toContain(last?.failureReason);
        await expect10(s.telephony.playDisclosure({ ...placed.ref, ...wording })).rejects.toMatchObject(code("telephony.call_ended"));
      });
      test10("events carry no number and no text", async () => {
        const s = await subject();
        const to = s.numberFor("answers");
        await s.telephony.placeCall({
          organizationId: s.organizations.a,
          callId,
          idempotencyKey: key(),
          from: line,
          to
        });
        const text = JSON.stringify(await s.takeEvents());
        expect10(text).not.toContain(to);
        expect10(text).not.toContain(line);
      });
    });
    describe10("answering an inbound call", () => {
      test10("answers it and rings the browser legs", async () => {
        const s = await subject();
        const providerCallId = await s.receiveInbound(s.organizations.a);
        const answered = await s.telephony.answerCall({
          organizationId: s.organizations.a,
          providerCallId,
          callId,
          ringIdentities: [rep, otherRep]
        });
        expect10(answered).toEqual({ ringing: 2 });
        expect10((await s.takeEvents()).map((e) => e.type)).toContain("answered");
      });
      test10("answering again changes nothing", async () => {
        const s = await subject();
        const providerCallId = await s.receiveInbound(s.organizations.a);
        const request = {
          organizationId: s.organizations.a,
          providerCallId,
          callId,
          ringIdentities: [rep]
        };
        await s.telephony.answerCall(request);
        await s.takeEvents();
        expect10(await s.telephony.answerCall(request)).toEqual({ ringing: 1 });
        expect10(await s.takeEvents()).toHaveLength(0);
      });
      test10("another Organization cannot answer it", async () => {
        const s = await subject();
        const providerCallId = await s.receiveInbound(s.organizations.a);
        await expect10(s.telephony.answerCall({
          organizationId: s.organizations.b,
          providerCallId,
          callId,
          ringIdentities: [rep]
        })).rejects.toMatchObject(code("telephony.not_found"));
      });
      test10.each([
        ["no legs", []],
        ["a bad identity", ["mem_1"]]
      ])("%s is refused", async (_label, ringIdentities) => {
        const s = await subject();
        const providerCallId = await s.receiveInbound(s.organizations.a);
        await expect10(s.telephony.answerCall({
          organizationId: s.organizations.a,
          providerCallId,
          callId,
          ringIdentities
        })).rejects.toMatchObject(code("telephony.invalid_request"));
      });
      test10("a call nobody answered cannot play the Disclosure yet", async () => {
        const s = await subject();
        const providerCallId = await s.receiveInbound(s.organizations.a);
        await expect10(s.telephony.playDisclosure({
          organizationId: s.organizations.a,
          providerCallId,
          ...wording
        })).rejects.toMatchObject(code("telephony.invalid_request"));
      });
    });
    describe10("the Disclosure", () => {
      test10("plays, and reports its wording version, whether it names an AI, and when", async () => {
        const s = await subject();
        const placed = await place(s);
        const played = await s.telephony.playDisclosure({
          ...placed.ref,
          ...wording,
          aiAssisted: true
        });
        expect10(played).toMatchObject({ wordingVersion: 1, aiAssisted: true });
        expect10(Number.isNaN(Date.parse(played.playedAt))).toBe(false);
      });
      test10("playing the same version again reports it and does not replay it", async () => {
        const s = await subject();
        const placed = await place(s);
        const first = await s.telephony.playDisclosure({ ...placed.ref, ...wording });
        const again = await s.telephony.playDisclosure({ ...placed.ref, ...wording });
        expect10(again).toEqual(first);
      });
      test10.each([
        ["an empty text", { text: "   " }],
        ["a control character", { text: "bad\x00text" }],
        ["a text over 1000 characters", { text: "x".repeat(1001) }],
        ["version 0", { wordingVersion: 0 }],
        ["a fractional version", { wordingVersion: 1.5 }],
        ["no aiAssisted flag", { aiAssisted: undefined }]
      ])("%s is refused", async (_label, bad) => {
        const s = await subject();
        const placed = await place(s);
        await expect10(s.telephony.playDisclosure({ ...placed.ref, ...wording, ...bad })).rejects.toMatchObject(code("telephony.invalid_request"));
      });
      test10("a Prospect who hangs up during it: call_ended, nothing is bridged", async () => {
        const s = await subject();
        const placed = await place(s, "hangs_up_during_disclosure");
        await expect10(s.telephony.playDisclosure({ ...placed.ref, ...wording })).rejects.toMatchObject(code("telephony.call_ended"));
        expect10((await s.takeEvents()).at(-1)).toMatchObject({
          type: "completed",
          endedBy: "prospect"
        });
        await expect10(s.telephony.bridge({ ...placed.ref, repIdentity: rep })).rejects.toMatchObject(code("telephony.call_ended"));
      });
      test10("a later wording version replaces the earlier one, including whether it names an AI", async () => {
        const s = await subject();
        const placed = await place(s);
        await s.telephony.playDisclosure({ ...placed.ref, ...wording, aiAssisted: true });
        const second = await s.telephony.playDisclosure({
          ...placed.ref,
          ...wording,
          wordingVersion: 2,
          aiAssisted: false
        });
        expect10(second).toMatchObject({ wordingVersion: 2, aiAssisted: false });
        await expect10(s.telephony.forkTracks({ ...placed.ref, destinationUrl: "wss://copilot.example.test/s" })).rejects.toMatchObject(code("telephony.disclosure_required"));
      });
      test10("another Organization cannot play it on this call", async () => {
        const s = await subject();
        const placed = await place(s);
        await expect10(s.telephony.playDisclosure({
          organizationId: s.organizations.b,
          providerCallId: placed.providerCallId,
          ...wording
        })).rejects.toMatchObject(code("telephony.not_found"));
      });
    });
    describe10("nothing happens before the Disclosure", () => {
      test10("bridging a Rep is refused", async () => {
        const s = await subject();
        const placed = await place(s);
        await expect10(s.telephony.bridge({ ...placed.ref, repIdentity: rep })).rejects.toMatchObject(code("telephony.disclosure_required"));
      });
      test10("recording is refused", async () => {
        const s = await subject();
        const placed = await place(s);
        await expect10(s.telephony.startRecording(placed.ref)).rejects.toMatchObject(code("telephony.disclosure_required"));
      });
      test10("forking the tracks is refused", async () => {
        const s = await subject();
        const placed = await place(s);
        await expect10(s.telephony.forkTracks({ ...placed.ref, destinationUrl: "wss://copilot.example.test/s" })).rejects.toMatchObject(code("telephony.disclosure_required"));
      });
      test10("forking the tracks needs a Disclosure that named an AI", async () => {
        const s = await subject();
        const placed = await disclosed(s, false);
        await expect10(s.telephony.forkTracks({ ...placed.ref, destinationUrl: "wss://copilot.example.test/s" })).rejects.toMatchObject(code("telephony.disclosure_required"));
      });
      test10("a failed Disclosure leaves the call unbridged and unrecorded", async () => {
        const s = await subject();
        const placed = await place(s);
        s.failNext("playDisclosure");
        await expect10(s.telephony.playDisclosure({ ...placed.ref, ...wording })).rejects.toMatchObject(code("telephony.unavailable"));
        await expect10(s.telephony.bridge({ ...placed.ref, repIdentity: rep })).rejects.toMatchObject(code("telephony.disclosure_required"));
        await expect10(s.telephony.startRecording(placed.ref)).rejects.toMatchObject(code("telephony.disclosure_required"));
      });
    });
    describe10("bridging", () => {
      test10("joins a Rep after the Disclosure, and again is a no-op", async () => {
        const s = await subject();
        const placed = await disclosed(s);
        await s.telephony.bridge({ ...placed.ref, repIdentity: rep });
        await s.telephony.bridge({ ...placed.ref, repIdentity: rep });
      });
      test10("moves the call to another Rep", async () => {
        const s = await subject();
        const placed = await disclosed(s);
        await s.telephony.bridge({ ...placed.ref, repIdentity: rep });
        await s.telephony.bridge({ ...placed.ref, repIdentity: otherRep });
      });
      test10("a bad identity is refused", async () => {
        const s = await subject();
        const placed = await disclosed(s);
        await expect10(s.telephony.bridge({ ...placed.ref, repIdentity: "mem_1" })).rejects.toMatchObject(code("telephony.invalid_request"));
      });
      test10("a Prospect who hangs up after the Rep is bridged ends the call", async () => {
        const s = await subject();
        const placed = await disclosed(s);
        await s.telephony.bridge({ ...placed.ref, repIdentity: rep });
        await s.takeEvents();
        await s.prospectHangsUp(placed.ref.organizationId, placed.providerCallId);
        expect10((await s.takeEvents()).find((e) => e.type === "completed")).toMatchObject({
          endedBy: "prospect"
        });
        await expect10(s.telephony.bridge({ ...placed.ref, repIdentity: otherRep })).rejects.toMatchObject(code("telephony.call_ended"));
      });
    });
    describe10("recording", () => {
      test10("is dual-channel and starting it again returns the first Recording", async () => {
        const s = await subject();
        const placed = await disclosed(s);
        const first = await s.telephony.startRecording(placed.ref);
        expect10(first.channels).toBe(2);
        expect10(await s.telephony.startRecording(placed.ref)).toEqual(first);
      });
      test10("cannot be fetched while the call is up", async () => {
        const s = await subject();
        const placed = await disclosed(s);
        const started = await s.telephony.startRecording(placed.ref);
        await expect10(s.telephony.fetchRecording({
          organizationId: placed.ref.organizationId,
          recordingId: started.recordingId
        })).rejects.toMatchObject(code("telephony.recording_not_ready"));
      });
      test10("can be fetched after the call: two channels, a type and bytes", async () => {
        const s = await subject();
        const placed = await disclosed(s);
        const started = await s.telephony.startRecording(placed.ref);
        await s.telephony.hangUp({ ...placed.ref, by: "rep" });
        expect10((await s.takeEvents()).at(-1)).toMatchObject({
          type: "recording_ready",
          recordingId: started.recordingId
        });
        const fetched = await s.telephony.fetchRecording({
          organizationId: placed.ref.organizationId,
          recordingId: started.recordingId
        });
        expect10(fetched.channels).toBe(2);
        expect10(fetched.contentType).toMatch(/^audio\//);
        let bytes = 0;
        for await (const chunk of fetched.body) {
          bytes += chunk.length;
        }
        expect10(bytes).toBeGreaterThan(0);
        if (fetched.sizeBytes !== null) {
          expect10(fetched.sizeBytes).toBe(bytes);
        }
      });
      test10("a recording started before the call ended can be fetched when the Prospect hangs up", async () => {
        const s = await subject();
        const placed = await disclosed(s);
        const started = await s.telephony.startRecording(placed.ref);
        await s.prospectHangsUp(placed.ref.organizationId, placed.providerCallId);
        const fetched = await s.telephony.fetchRecording({
          organizationId: placed.ref.organizationId,
          recordingId: started.recordingId
        });
        await fetched.body[Symbol.asyncIterator]?.().return?.();
        expect10(fetched.channels).toBe(2);
      });
      test10("deleting removes the provider copy; deleting again and an unknown id say it did not exist", async () => {
        const s = await subject();
        const placed = await disclosed(s);
        const started = await s.telephony.startRecording(placed.ref);
        await s.telephony.hangUp(placed.ref);
        const ref = { organizationId: placed.ref.organizationId, recordingId: started.recordingId };
        expect10(await s.telephony.deleteRecording(ref)).toEqual({ existed: true });
        expect10(await s.telephony.deleteRecording(ref)).toEqual({ existed: false });
        expect10(await s.telephony.deleteRecording({ ...ref, recordingId: "never-issued" })).toEqual({
          existed: false
        });
        await expect10(s.telephony.fetchRecording(ref)).rejects.toMatchObject(code("telephony.not_found"));
      });
      test10("another Organization can neither fetch nor delete it", async () => {
        const s = await subject();
        const placed = await disclosed(s);
        const started = await s.telephony.startRecording(placed.ref);
        await s.telephony.hangUp(placed.ref);
        const theirs = { organizationId: s.organizations.b, recordingId: started.recordingId };
        await expect10(s.telephony.fetchRecording(theirs)).rejects.toMatchObject(code("telephony.not_found"));
        expect10(await s.telephony.deleteRecording(theirs)).toEqual({ existed: false });
        const mine = { organizationId: s.organizations.a, recordingId: started.recordingId };
        const fetched = await s.telephony.fetchRecording(mine);
        expect10(fetched.channels).toBe(2);
      });
      test10("a bad recording id is refused", async () => {
        const s = await subject();
        await expect10(s.telephony.fetchRecording({ organizationId: s.organizations.a, recordingId: "../x" })).rejects.toMatchObject(code("telephony.invalid_request"));
      });
    });
    describe10("forking the tracks", () => {
      test10("sends the Rep and the Prospect apart once an AI-naming Disclosure played; again returns the first", async () => {
        const s = await subject();
        const placed = await disclosed(s, true);
        const request = { ...placed.ref, destinationUrl: "wss://copilot.example.test/s" };
        const first = await s.telephony.forkTracks(request);
        expect10(first.tracks).toEqual(["rep", "prospect"]);
        expect10(await s.telephony.forkTracks(request)).toEqual(first);
      });
      test10.each([
        ["a plain http URL", "http://copilot.example.test/s"],
        ["a URL with credentials", "wss://user:pw@copilot.example.test/s"],
        ["not a URL", "copilot"],
        ["an empty string", ""]
      ])("%s is refused", async (_label, destinationUrl) => {
        const s = await subject();
        const placed = await disclosed(s, true);
        await expect10(s.telephony.forkTracks({ ...placed.ref, destinationUrl })).rejects.toMatchObject(code("telephony.invalid_request"));
      });
    });
    describe10("hanging up", () => {
      test10("ends the call with who ended it, and again is a no-op", async () => {
        const s = await subject();
        const placed = await place(s);
        await s.takeEvents();
        await s.telephony.hangUp({ ...placed.ref, by: "rep" });
        expect10(await s.takeEvents()).toMatchObject([{ type: "completed", endedBy: "rep" }]);
        await s.telephony.hangUp(placed.ref);
        expect10(await s.takeEvents()).toHaveLength(0);
      });
      test10("another Organization cannot hang it up", async () => {
        const s = await subject();
        const placed = await place(s);
        await expect10(s.telephony.hangUp({
          organizationId: s.organizations.b,
          providerCallId: placed.providerCallId
        })).rejects.toMatchObject(code("telephony.not_found"));
      });
      test10("an unknown call is not found", async () => {
        const s = await subject();
        await expect10(s.telephony.hangUp({ organizationId: s.organizations.a, providerCallId: "unknown" })).rejects.toMatchObject(code("telephony.not_found"));
      });
      test10("nothing can be played, bridged, recorded or forked on an ended call", async () => {
        const s = await subject();
        const placed = await place(s);
        await s.telephony.hangUp(placed.ref);
        await expect10(s.telephony.playDisclosure({ ...placed.ref, ...wording })).rejects.toMatchObject(code("telephony.call_ended"));
        await expect10(s.telephony.bridge({ ...placed.ref, repIdentity: rep })).rejects.toMatchObject(code("telephony.call_ended"));
        await expect10(s.telephony.startRecording(placed.ref)).rejects.toMatchObject(code("telephony.call_ended"));
      });
    });
    describe10("verifying a webhook", () => {
      async function webhook() {
        const s = await subject();
        const placed = await place(s);
        const event = (await s.takeEvents())[0];
        return { s, placed, event, hook: s.signedWebhook(event) };
      }
      test10("a genuine webhook verifies", async () => {
        const { s, hook } = await webhook();
        expect10(s.telephony.verifyWebhook(hook)).toBe(true);
      });
      test10("a wrong signature of the right length is refused", async () => {
        const { s, hook } = await webhook();
        const flipped = (hook.signature[0] === "A" ? "B" : "A") + hook.signature.slice(1);
        expect10(flipped).toHaveLength(hook.signature.length);
        expect10(s.telephony.verifyWebhook({ ...hook, signature: flipped })).toBe(false);
      });
      test10("a signature of the wrong length is refused", async () => {
        const { s, hook } = await webhook();
        expect10(s.telephony.verifyWebhook({ ...hook, signature: hook.signature.slice(0, -1) })).toBe(false);
        expect10(s.telephony.verifyWebhook({ ...hook, signature: `${hook.signature}A` })).toBe(false);
        expect10(s.telephony.verifyWebhook({ ...hook, signature: "x" })).toBe(false);
      });
      test10.each([
        ["undefined", undefined],
        ["null", null],
        ["empty", ""]
      ])("a %s signature is refused", async (_label, signature) => {
        const { s, hook } = await webhook();
        expect10(s.telephony.verifyWebhook({ ...hook, signature })).toBe(false);
      });
      test10("a signature that fits another body or another URL is refused", async () => {
        const { s, hook } = await webhook();
        expect10(s.telephony.verifyWebhook({ ...hook, body: `${hook.body} ` })).toBe(false);
        expect10(s.telephony.verifyWebhook({ ...hook, url: `${hook.url}?x=1` })).toBe(false);
      });
      test10("a body over the limit is refused without throwing", async () => {
        const { s, hook } = await webhook();
        const body = "x".repeat(MAX_WEBHOOK_BODY_BYTES2 + 1);
        expect10(s.telephony.verifyWebhook({ ...hook, body })).toBe(false);
      });
      test10("garbage in any field is refused, never thrown", async () => {
        const { s } = await webhook();
        for (const bad of [null, undefined, 1, "x", {}, { url: 1, body: 2, signature: 3 }]) {
          expect10(s.telephony.verifyWebhook(bad)).toBe(false);
        }
      });
    });
    describe10("the browser token", () => {
      test10("is a SoftphoneToken for the Rep that expires within the hour", async () => {
        const s = await subject();
        const before = Date.now();
        const token = await s.telephony.mintBrowserToken({
          organizationId: s.organizations.a,
          identity: rep,
          ttlSeconds: 120
        });
        expect10(softphoneTokenSchema.safeParse(token).success).toBe(true);
        expect10(token).toMatchObject({ identity: rep, ttlSeconds: 120 });
        expect10(Date.parse(token.expiresAt)).toBeGreaterThan(before);
        expect10(Date.parse(token.expiresAt)).toBeLessThanOrEqual(Date.now() + 120000 + 1000);
      });
      test10("defaults to a short life and each token is different", async () => {
        const s = await subject();
        const request = { organizationId: s.organizations.a, identity: rep };
        const one = await s.telephony.mintBrowserToken(request);
        const two = await s.telephony.mintBrowserToken(request);
        expect10(one.ttlSeconds).toBeGreaterThanOrEqual(60);
        expect10(one.ttlSeconds).toBeLessThanOrEqual(3600);
        expect10(one.token).not.toBe(two.token);
      });
      test10.each([[59], [3601], [1.5], [Number.NaN]])("a life of %p seconds is refused", async (ttl) => {
        const s = await subject();
        await expect10(s.telephony.mintBrowserToken({
          organizationId: s.organizations.a,
          identity: rep,
          ttlSeconds: ttl
        })).rejects.toMatchObject(code("telephony.invalid_request"));
      });
      test10("the token does not hold the Organization id or the Rep id in clear", async () => {
        const s = await subject();
        const token = await s.telephony.mintBrowserToken({
          organizationId: s.organizations.a,
          identity: rep
        });
        expect10(token.token).not.toContain(s.organizations.a);
        expect10(token.token).not.toContain(rep);
      });
    });
    describe10("timeouts and a failing provider", () => {
      const TIMEOUT = 30;
      const steps = {
        placeCall: {
          ready: async () => ({}),
          call: (s, _c) => s.telephony.placeCall({
            organizationId: s.organizations.a,
            callId,
            idempotencyKey: key(),
            from: line,
            to: s.numberFor("answers")
          }, { timeoutMs: TIMEOUT })
        },
        answerCall: {
          ready: async (s) => ({ providerCallId: await s.receiveInbound(s.organizations.a) }),
          call: (s, c) => s.telephony.answerCall({
            organizationId: s.organizations.a,
            providerCallId: c.providerCallId,
            callId,
            ringIdentities: [rep]
          }, { timeoutMs: TIMEOUT })
        },
        playDisclosure: {
          ready: async (s) => ({ providerCallId: (await place(s)).providerCallId }),
          call: (s, c) => s.telephony.playDisclosure({
            organizationId: s.organizations.a,
            providerCallId: c.providerCallId,
            ...wording
          }, { timeoutMs: TIMEOUT })
        },
        bridge: {
          ready: async (s) => ({ providerCallId: (await disclosed(s)).providerCallId }),
          call: (s, c) => s.telephony.bridge({
            organizationId: s.organizations.a,
            providerCallId: c.providerCallId,
            repIdentity: rep
          }, { timeoutMs: TIMEOUT })
        },
        startRecording: {
          ready: async (s) => ({ providerCallId: (await disclosed(s)).providerCallId }),
          call: (s, c) => s.telephony.startRecording({ organizationId: s.organizations.a, providerCallId: c.providerCallId }, { timeoutMs: TIMEOUT })
        },
        forkTracks: {
          ready: async (s) => ({ providerCallId: (await disclosed(s, true)).providerCallId }),
          call: (s, c) => s.telephony.forkTracks({
            organizationId: s.organizations.a,
            providerCallId: c.providerCallId,
            destinationUrl: "wss://copilot.example.test/s"
          }, { timeoutMs: TIMEOUT })
        },
        hangUp: {
          ready: async (s) => ({ providerCallId: (await place(s)).providerCallId }),
          call: (s, c) => s.telephony.hangUp({ organizationId: s.organizations.a, providerCallId: c.providerCallId }, { timeoutMs: TIMEOUT })
        },
        fetchRecording: {
          ready: async (s) => {
            const placed = await disclosed(s);
            const started = await s.telephony.startRecording(placed.ref);
            await s.telephony.hangUp(placed.ref);
            return { recordingId: started.recordingId };
          },
          call: (s, c) => s.telephony.fetchRecording({ organizationId: s.organizations.a, recordingId: c.recordingId }, { timeoutMs: TIMEOUT })
        },
        deleteRecording: {
          ready: async (s) => {
            const placed = await disclosed(s);
            const started = await s.telephony.startRecording(placed.ref);
            await s.telephony.hangUp(placed.ref);
            return { recordingId: started.recordingId };
          },
          call: (s, c) => s.telephony.deleteRecording({ organizationId: s.organizations.a, recordingId: c.recordingId }, { timeoutMs: TIMEOUT })
        },
        mintBrowserToken: {
          ready: async () => ({}),
          call: (s) => s.telephony.mintBrowserToken({ organizationId: s.organizations.a, identity: rep }, { timeoutMs: TIMEOUT })
        }
      };
      const operations = Object.keys(steps);
      test10.each(operations)("%s gives up when the provider does not answer in time", async (operation) => {
        const s = await subject();
        const ctx = await steps[operation].ready(s);
        s.stallNext(operation);
        const started = Date.now();
        await expect10(steps[operation].call(s, ctx)).rejects.toMatchObject(code("telephony.unavailable"));
        const elapsed = Date.now() - started;
        expect10(elapsed).toBeGreaterThanOrEqual(TIMEOUT - 10);
        expect10(elapsed).toBeLessThan(5000);
      });
      test10.each(operations)("%s reports a failing provider as unavailable", async (operation) => {
        const s = await subject();
        const ctx = await steps[operation].ready(s);
        s.failNext(operation);
        await expect10(steps[operation].call(s, ctx)).rejects.toMatchObject(code("telephony.unavailable"));
      });
      test10.each(operations)("%s works again once the provider recovers", async (operation) => {
        const s = await subject();
        const ctx = await steps[operation].ready(s);
        s.failNext(operation);
        await expect10(steps[operation].call(s, ctx)).rejects.toBeDefined();
        await steps[operation].call(s, ctx);
      });
      test10("a placeCall that timed out placed nothing: the same key places the call", async () => {
        const s = await subject();
        const request = {
          organizationId: s.organizations.a,
          callId,
          idempotencyKey: key(),
          from: line,
          to: s.numberFor("answers")
        };
        s.stallNext("placeCall");
        await expect10(s.telephony.placeCall(request, { timeoutMs: TIMEOUT })).rejects.toMatchObject(code("telephony.unavailable"));
        expect10(await s.takeEvents()).toHaveLength(0);
        expect10((await s.telephony.placeCall(request)).created).toBe(true);
      });
      test10("a hangUp that timed out left the call up", async () => {
        const s = await subject();
        const placed = await disclosed(s);
        s.stallNext("hangUp");
        await expect10(s.telephony.hangUp(placed.ref, { timeoutMs: TIMEOUT })).rejects.toBeDefined();
        await s.telephony.bridge({ ...placed.ref, repIdentity: rep });
      });
      test10.each([[0], [-1], [1.5], [60001], [Number.NaN]])("a timeout of %p ms is refused", async (timeoutMs) => {
        const s = await subject();
        await expect10(s.telephony.mintBrowserToken({ organizationId: s.organizations.a, identity: rep }, { timeoutMs })).rejects.toMatchObject(code("telephony.invalid_request"));
      });
    });
  });
}
// src/transcribe/behaviour.ts
import { afterEach as afterEach11, describe as describe11, expect as expect11, test as test11 } from "bun:test";
function transcriberBehaviour(name, make, skip = false) {
  const run = skip ? describe11.skip : describe11;
  run(`Transcriber behaviour: ${name}`, () => {
    const open = [];
    afterEach11(async () => {
      await Promise.all(open.splice(0).map((subject) => subject.close()));
    });
    async function subject() {
      const made = await make();
      open.push(made);
      return made;
    }
    const invalid = { code: "transcriber.invalid_request" };
    const send = (reference, extra = {}) => ({
      clientReference: reference,
      audio: { url: `https://audio.example.test/${reference}.mp3?sig=abc` },
      audioKey: `rec/${reference}:abc`,
      speakers: "diarize",
      ...extra
    });
    async function finalResult(s, org, reference) {
      const result = await waitForTranscription2(s.transcriber, org, reference, {
        maxAttempts: 120,
        intervalMs: s.pollIntervalMs ?? 0
      });
      expect11(result?.status === "done" || result?.status === "failed").toBe(true);
      return result;
    }
    async function finalResultWith(s, org, reference, vendorId) {
      const result = await waitForTranscription2(s.transcriber, org, reference, {
        maxAttempts: 120,
        intervalMs: s.pollIntervalMs ?? 0,
        vendorId
      });
      expect11(result?.status === "done" || result?.status === "failed").toBe(true);
      return result;
    }
    const references = async (s, org, prefix) => {
      const found = [];
      let cursor;
      for (let page = 0;page < 50; page++) {
        const got = await s.transcriber.list(org, {
          limit: 2,
          ...prefix === undefined ? {} : { prefix },
          ...cursor === undefined ? {} : { cursor }
        });
        found.push(...got.items.map((item) => item.clientReference));
        cursor = got.nextCursor;
        if (cursor === undefined) {
          break;
        }
      }
      return found;
    };
    test11("a send is created once and repeating it creates nothing", async () => {
      const s = await subject();
      const { a } = s.organizations;
      const first = await s.transcriber.submit(a, send("call_1:1"));
      const again = await s.transcriber.submit(a, send("call_1:1"));
      expect11(first).toMatchObject({ clientReference: "call_1:1", created: true });
      expect11(again).toMatchObject({ clientReference: "call_1:1", created: false });
      expect11(await references(s, a)).toEqual(["call_1:1"]);
    });
    test11("the same reference with another mode, speaker cap or audio key is a conflict", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.transcriber.submit(a, send("call_1:1", { maxSpeakers: 2, audioKey: "rec/1:abc" }));
      const conflict = { code: "transcriber.conflict" };
      await expect11(s.transcriber.submit(a, send("call_1:1", { speakers: "split_channels", audioKey: "rec/1:abc" }))).rejects.toMatchObject(conflict);
      await expect11(s.transcriber.submit(a, send("call_1:1", { maxSpeakers: 3, audioKey: "rec/1:abc" }))).rejects.toMatchObject(conflict);
      await expect11(s.transcriber.submit(a, send("call_1:1", { maxSpeakers: 2, audioKey: "rec/2:def" }))).rejects.toMatchObject(conflict);
      expect11(await references(s, a)).toEqual(["call_1:1"]);
    });
    test11("a retry with a freshly presigned URL is the same send, not a conflict", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.transcriber.submit(a, send("call_1:1", { audioKey: "rec/1:abc" }));
      const again = await s.transcriber.submit(a, send("call_1:1", {
        audio: { url: "https://audio.example.test/call_1.mp3?sig=NEWSIGNATURE&expires=2" },
        audioKey: "rec/1:abc"
      }));
      expect11(again.created).toBe(false);
      expect11(await references(s, a)).toEqual(["call_1:1"]);
    });
    test11("a result is pending at first or final, and a final one passes the shared result check", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.transcriber.submit(a, send("call_1:1", { maxSpeakers: 2 }));
      const first = await s.transcriber.getResult(a, "call_1:1");
      expect11(["pending", "done", "failed"]).toContain(first?.status);
      const final = await finalResult(s, a, "call_1:1");
      checkTranscriptionResult2(final, { speakers: "diarize", maxSpeakers: 2 });
      expect11(checkTranscriptionResult2(await s.transcriber.getResult(a, "call_1:1"))).toEqual(final);
    });
    test11("a split-channels result carries the channel of every turn", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.transcriber.submit(a, send("call_1:2", { speakers: "split_channels" }));
      const final = await finalResult(s, a, "call_1:2");
      checkTranscriptionResult2(final, { speakers: "split_channels" });
    });
    test11("a send that was never made, or was deleted, has no result", async () => {
      const s = await subject();
      const { a } = s.organizations;
      expect11(await s.transcriber.getResult(a, "nope")).toBeUndefined();
      await s.transcriber.submit(a, send("call_1:1"));
      await s.transcriber.delete(a, "call_1:1");
      expect11(await s.transcriber.getResult(a, "call_1:1")).toBeUndefined();
    });
    test11("delete reports whether a copy existed and can be repeated", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.transcriber.submit(a, send("call_1:1"));
      expect11(await s.transcriber.delete(a, "call_1:1")).toEqual({ existed: true });
      expect11(await s.transcriber.delete(a, "call_1:1")).toEqual({ existed: false });
      expect11(await s.transcriber.delete(a, "never_sent:1")).toEqual({ existed: false });
      expect11(await references(s, a)).toEqual([]);
    });
    test11("a deleted reference can be sent again as a new send", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.transcriber.submit(a, send("call_1:1"));
      await s.transcriber.delete(a, "call_1:1");
      expect11((await s.transcriber.submit(a, send("call_1:1"))).created).toBe(true);
    });
    test11("list finds sends by reference prefix, in order, in pages", async () => {
      const s = await subject();
      const { a } = s.organizations;
      for (const reference of ["call_2:1", "call_1:2", "call_1:1", "call_1:3", "other"]) {
        await s.transcriber.submit(a, send(reference));
      }
      expect11(await references(s, a, "call_1:")).toEqual(["call_1:1", "call_1:2", "call_1:3"]);
      expect11(await references(s, a)).toEqual([
        "call_1:1",
        "call_1:2",
        "call_1:3",
        "call_2:1",
        "other"
      ]);
      const first = await s.transcriber.list(a, { prefix: "call_1:", limit: 2 });
      expect11(first.items).toHaveLength(2);
      expect11(first.nextCursor).toBeDefined();
      expect11(["pending", "done", "failed"]).toContain(first.items[0]?.status);
      const seen = first.items.map((item) => item.clientReference);
      let cursor = first.nextCursor;
      for (let pages = 0;cursor !== undefined && pages < 20; pages++) {
        const next = await s.transcriber.list(a, { prefix: "call_1:", limit: 2, cursor });
        seen.push(...next.items.map((item) => item.clientReference));
        cursor = next.nextCursor;
      }
      expect11(seen).toEqual(["call_1:1", "call_1:2", "call_1:3"]);
    });
    describe11("the vendor id", () => {
      test11("submit returns an opaque bounded id, the same one when the send is repeated", async () => {
        const s = await subject();
        const { a } = s.organizations;
        const first = await s.transcriber.submit(a, send("call_1:1"));
        const again = await s.transcriber.submit(a, send("call_1:1"));
        expect11(first.vendorId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
        expect11(again.vendorId).toBe(first.vendorId);
      });
      test11("list carries the id of each send", async () => {
        const s = await subject();
        const { a } = s.organizations;
        const one = await s.transcriber.submit(a, send("call_1:1"));
        const two = await s.transcriber.submit(a, send("call_1:2"));
        const page = await s.transcriber.list(a, { prefix: "call_1:" });
        const ids = new Map(page.items.map((item) => [item.clientReference, item.vendorId]));
        expect11(ids.get("call_1:1")).toBe(one.vendorId);
        expect11(ids.get("call_1:2")).toBe(two.vendorId);
      });
      test11("a read and a delete with the right id work as they do by reference alone", async () => {
        const s = await subject();
        const { a } = s.organizations;
        const { vendorId } = await s.transcriber.submit(a, send("call_1:1"));
        const result = await finalResultWith(s, a, "call_1:1", vendorId);
        expect11(result.status === "done" || result.status === "failed").toBe(true);
        expect11(await s.transcriber.delete(a, "call_1:1", { vendorId })).toEqual({ existed: true });
        expect11(await s.transcriber.getResult(a, "call_1:1", { vendorId })).toBeUndefined();
        expect11(await s.transcriber.delete(a, "call_1:1", { vendorId })).toEqual({ existed: false });
      });
      test11("an id that names another reference's send is ignored: the call is about the reference", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await s.transcriber.submit(a, send("call_1:1"));
        const other = await s.transcriber.submit(a, send("call_1:2"));
        expect11(await s.transcriber.getResult(a, "call_1:1", { vendorId: other.vendorId })).toBeDefined();
        expect11(await s.transcriber.delete(a, "call_1:1", { vendorId: other.vendorId })).toEqual({
          existed: true
        });
        expect11(await references(s, a)).toEqual(["call_1:2"]);
        expect11(await s.transcriber.getResult(a, "call_1:9", { vendorId: other.vendorId })).toBeUndefined();
        expect11(await s.transcriber.delete(a, "call_1:9", { vendorId: other.vendorId })).toEqual({
          existed: false
        });
        expect11(await references(s, a)).toEqual(["call_1:2"]);
      });
      test11("an id from another Organization is ignored and never reaches that Organization's send", async () => {
        const s = await subject();
        const { a, b } = s.organizations;
        const mine = await s.transcriber.submit(a, send("call_1:1"));
        await s.transcriber.submit(b, send("call_1:1", { speakers: "split_channels" }));
        expect11(await s.transcriber.delete(b, "call_1:1", { vendorId: mine.vendorId })).toEqual({
          existed: true
        });
        expect11(await references(s, a)).toEqual(["call_1:1"]);
        expect11(await references(s, b)).toEqual([]);
        expect11(await s.transcriber.getResult(b, "call_1:1", { vendorId: mine.vendorId })).toBeUndefined();
        expect11(await s.transcriber.delete(b, "call_1:1", { vendorId: mine.vendorId })).toEqual({
          existed: false
        });
        expect11(await s.transcriber.getResult(a, "call_1:1")).toBeDefined();
      });
      test11("an id the vendor does not know falls back to the reference", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await s.transcriber.submit(a, send("call_1:1"));
        expect11(await s.transcriber.getResult(a, "call_1:1", { vendorId: "unknown-id-1" })).toBeDefined();
        expect11(await s.transcriber.delete(a, "call_1:1", { vendorId: "unknown-id-1" })).toEqual({
          existed: true
        });
      });
      test11.each([
        ["empty", ""],
        ["with a space", "a b"],
        ["with a slash", "a/b"],
        ["over 128 characters", "a".repeat(129)],
        ["not a string", 5]
      ])("an id that is %s is refused", async (_label, vendorId) => {
        const s = await subject();
        const { a } = s.organizations;
        await s.transcriber.submit(a, send("call_1:1"));
        await expect11(s.transcriber.getResult(a, "call_1:1", { vendorId })).rejects.toMatchObject(invalid);
        await expect11(s.transcriber.delete(a, "call_1:1", { vendorId })).rejects.toMatchObject(invalid);
        expect11(await references(s, a)).toEqual(["call_1:1"]);
      });
      test11("a hint with the id of a deleted job is ignored and acts on the resubmitted one", async () => {
        const s = await subject();
        const { a } = s.organizations;
        const old = await s.transcriber.submit(a, send("call_1:1"));
        await s.transcriber.delete(a, "call_1:1");
        const fresh = await s.transcriber.submit(a, send("call_1:1"));
        expect11(fresh.created).toBe(true);
        expect11(await s.transcriber.getResult(a, "call_1:1", { vendorId: old.vendorId })).toBeDefined();
        expect11(await s.transcriber.delete(a, "call_1:1", { vendorId: old.vendorId })).toEqual({
          existed: true
        });
        expect11(await references(s, a)).toEqual([]);
      });
      test11("a send submitted through one instance is listed and deleted through another", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await s.transcriber.submit(a, send("call_1:1"));
        const other = await s.reopen();
        const found = await other.list(a, { prefix: "call_1:" });
        expect11(found.items.map((item) => item.clientReference)).toEqual(["call_1:1"]);
        expect11(await other.delete(a, "call_1:1")).toEqual({ existed: true });
        expect11(await references(s, a)).toEqual([]);
      });
      test11("a send whose id was never kept is found by listing for its reference and deleted without it", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await s.transcriber.submit(a, send("call_1:1"));
        await s.transcriber.submit(a, send("call_1:2"));
        await s.transcriber.submit(a, send("call_9:1"));
        const found = await s.transcriber.list(a, { prefix: "call_1:" });
        for (const entry of found.items) {
          expect11(entry.vendorId).toBeDefined();
          expect11(await s.transcriber.delete(a, entry.clientReference)).toEqual({ existed: true });
        }
        expect11(await references(s, a)).toEqual(["call_9:1"]);
      });
    });
    test11("concurrent submits of one reference create it once", async () => {
      const s = await subject();
      const { a } = s.organizations;
      const answers = await Promise.all(Array.from({ length: 8 }, () => s.transcriber.submit(a, send("call_1:1"))));
      expect11(answers.filter((answer) => answer.created)).toHaveLength(1);
      expect11(await references(s, a)).toEqual(["call_1:1"]);
    });
    test11("a prefix that ends with the separator does not match a longer id", async () => {
      const s = await subject();
      const { a } = s.organizations;
      for (const reference of ["call_1:1", "call_10:1"]) {
        await s.transcriber.submit(a, send(reference));
      }
      expect11(await references(s, a, "call_1:")).toEqual(["call_1:1"]);
    });
    test11("a purge by prefix removes sends the caller kept no record of", async () => {
      const s = await subject();
      const { a } = s.organizations;
      for (const reference of ["call_1:1", "call_1:2", "call_9:1"]) {
        await s.transcriber.submit(a, send(reference));
      }
      for (const reference of await references(s, a, "call_1:")) {
        await s.transcriber.delete(a, reference);
      }
      expect11(await references(s, a)).toEqual(["call_9:1"]);
    });
    test11("a second Organization cannot read, delete or list the first one's sends, and may reuse a reference", async () => {
      const s = await subject();
      const { a, b } = s.organizations;
      await s.transcriber.submit(a, send("call_1:1"));
      expect11(await s.transcriber.getResult(b, "call_1:1")).toBeUndefined();
      expect11(await s.transcriber.delete(b, "call_1:1")).toEqual({ existed: false });
      expect11(await references(s, b)).toEqual([]);
      expect11((await s.transcriber.submit(b, send("call_1:1", { speakers: "split_channels" }))).created).toBe(true);
      expect11(await references(s, a)).toEqual(["call_1:1"]);
      await s.transcriber.delete(b, "call_1:1");
      expect11(await s.transcriber.getResult(a, "call_1:1")).toBeDefined();
    });
    test11("an Organization whose id starts with another id is a different Organization", async () => {
      const s = await subject();
      const { a, aExtended } = s.organizations;
      await s.transcriber.submit(a, send("call_1:1"));
      expect11(await references(s, aExtended)).toEqual([]);
      expect11(await s.transcriber.getResult(aExtended, "call_1:1")).toBeUndefined();
    });
    test11.each([
      ["an empty reference", { clientReference: "" }],
      ["a reference with a space", { clientReference: "call 1" }],
      ["a reference with a slash", { clientReference: "org/call" }],
      ["a reference over 128 characters", { clientReference: "a".repeat(129) }],
      ["no audio", { audio: undefined }],
      ["a URL that is not a URL", { audio: { url: "not a url" } }],
      ["a file URL", { audio: { url: "file:///etc/passwd" } }],
      ["a URL with only a user name", { audio: { url: "https://user@example.test/a" } }],
      ["a URL with user information", { audio: { url: "https://user:pw@example.test/a" } }],
      [
        "a URL over 4096 characters",
        { audio: { url: `https://example.test/${"a".repeat(4100)}` } }
      ],
      ["an unknown speaker mode", { speakers: "both" }],
      ["no audio key", { audioKey: undefined }],
      ["an audio key with a space", { audioKey: "rec 1" }],
      ["an audio key over 256 characters", { audioKey: "a".repeat(257) }],
      ["a speaker cap of 0", { maxSpeakers: 0 }],
      ["a speaker cap of 11", { maxSpeakers: 11 }],
      ["a fractional speaker cap", { maxSpeakers: 1.5 }],
      [
        "a speaker cap with split channels",
        { speakers: "split_channels", maxSpeakers: 2 }
      ],
      ["a callback that is not a URL", { callbackUrl: "nope" }]
    ])("a send with %s is refused and nothing is made", async (_label, change) => {
      const s = await subject();
      const { a } = s.organizations;
      await expect11(s.transcriber.submit(a, { ...send("call_1:1"), ...change })).rejects.toMatchObject(invalid);
      expect11(await references(s, a)).toEqual([]);
    });
    test11("the refusal of a bad send never repeats the audio URL", async () => {
      const s = await subject();
      const { a } = s.organizations;
      const secret = "https://user:SECRETPASSWORD@example.test/a?sig=SECRETSIG";
      try {
        await s.transcriber.submit(a, { ...send("call_1:1"), audio: { url: secret } });
        throw new Error("the send was accepted");
      } catch (error) {
        expect11(JSON.stringify(error)).not.toContain("SECRET");
        expect11(String(error.message)).not.toContain("SECRET");
      }
    });
    test11.each([
      ["a bad Organization id", "bad/org", "call_1:1"],
      ["a bad reference", undefined, "bad ref"]
    ])("reads and deletes with %s are refused", async (_label, org, reference) => {
      const s = await subject();
      const id = org ?? s.organizations.a;
      await expect11(s.transcriber.getResult(id, reference)).rejects.toMatchObject(invalid);
      await expect11(s.transcriber.delete(id, reference)).rejects.toMatchObject(invalid);
    });
    test11.each([
      [{ limit: 0 }],
      [{ limit: 1001 }],
      [{ limit: 1.5 }],
      [{ prefix: "bad prefix" }],
      [{ cursor: "!!!" }]
    ])("list options %p are refused", async (options) => {
      const s = await subject();
      await expect11(s.transcriber.list(s.organizations.a, options)).rejects.toMatchObject(invalid);
    });
  });
}
// src/tts/behaviour.ts
import { afterEach as afterEach12, describe as describe12, expect as expect12, test as test12 } from "bun:test";
import { inspect as inspect3 } from "node:util";
var SECRET_TEXT3 = "zebra confidential pricing";
var SECRET_AUDIO = "AUDIO-MARKER-PAYLOAD";
var retry2 = { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 2 };
function audio2(n, marker = "piece") {
  return new TextEncoder().encode(`${marker}-${n}`);
}
async function collect(stream) {
  const out = [];
  for await (const chunk of stream) {
    out.push(chunk);
  }
  return out;
}
async function codeOf2(run) {
  try {
    await run();
  } catch (error) {
    if (error instanceof TtsError2) {
      return error.code;
    }
    throw error;
  }
  return "no error";
}
function ttsBehaviour(name, make, skip = false) {
  const run = skip ? describe12.skip : describe12;
  run(`TTS behaviour: ${name}`, () => {
    const made = [];
    afterEach12(async () => {
      await Promise.all(made.splice(0).map((subject) => subject.close()));
    });
    async function subject() {
      const next = await make();
      made.push(next);
      return next;
    }
    function open(s, overrides = {}) {
      return s.port.open({
        organizationId: s.organizations.a,
        voice: s.voice,
        encoding: "pcm_s16le",
        sampleRate: 24000,
        retry: retry2,
        ...overrides
      });
    }
    test12("chunks come out in order, with their sequence, as text goes in", async () => {
      const s = await subject();
      const pieces = [audio2(0), audio2(1), audio2(2)];
      s.speak(pieces);
      const stream = open(s);
      stream.write("Hello, ");
      stream.write("this is a call.");
      const reading = collect(stream);
      stream.write(" One more sentence.");
      stream.finish();
      const chunks = await reading;
      expect12(chunks.map((c) => c.sequence)).toEqual([0, 1, 2]);
      expect12(chunks.map((c) => [...c.audio])).toEqual(pieces.map((p) => [...p]));
      expect12(chunks.map((c) => c.byteLength)).toEqual(pieces.map((p) => p.byteLength));
      expect12(s.vendorRequests()).toBe(1);
    });
    test12("a stream finished without text ends empty and sends nothing to the vendor", async () => {
      const s = await subject();
      const stream = open(s);
      stream.write("");
      stream.finish();
      expect12(await collect(stream)).toEqual([]);
      expect12(s.vendorRequests()).toBe(0);
    });
    test12("finish is idempotent and a write after it fails with tts.closed", async () => {
      const s = await subject();
      s.speak([audio2(0)]);
      const stream = open(s);
      stream.write("hi");
      stream.finish();
      stream.finish();
      expect12(await codeOf2(() => stream.write("more"))).toBe(TTS_ERROR_CODES2.closed);
      expect12((await collect(stream)).length).toBe(1);
    });
    test12("a cancel mid-stream stops further chunks and can be repeated", async () => {
      const s = await subject();
      s.speak([audio2(0), audio2(1), audio2(2), audio2(3), audio2(4)], { chunkDelayMs: 5 });
      const stream = open(s);
      stream.write("a long reply that the prospect interrupts");
      const iterator = stream[Symbol.asyncIterator]();
      expect12((await iterator.next()).value?.sequence).toBe(0);
      expect12((await iterator.next()).value?.sequence).toBe(1);
      stream.cancel();
      stream.cancel();
      expect12((await iterator.next()).done).toBe(true);
      expect12((await iterator.next()).done).toBe(true);
      expect12(s.abortedRequests()).toBe(1);
      expect12(await codeOf2(() => stream.write("more"))).toBe(TTS_ERROR_CODES2.closed);
      stream.finish();
      await stream.close();
    });
    test12("a read pending at cancel ends as done", async () => {
      const s = await subject();
      s.speak([audio2(0), audio2(1)], { chunkDelayMs: 5000 });
      const stream = open(s);
      stream.write("hello");
      const iterator = stream[Symbol.asyncIterator]();
      expect12((await iterator.next()).done).toBe(false);
      const pending = iterator.next();
      stream.cancel();
      expect12((await pending).done).toBe(true);
    });
    test12("a cancel before any text sends nothing to the vendor", async () => {
      const s = await subject();
      const stream = open(s);
      const reading = collect(stream);
      stream.cancel();
      expect12(await reading).toEqual([]);
      expect12(s.vendorRequests()).toBe(0);
    });
    test12("leaving the loop early cancels the stream", async () => {
      const s = await subject();
      s.speak([audio2(0), audio2(1), audio2(2)], { chunkDelayMs: 5 });
      const stream = open(s);
      stream.write("hello");
      for await (const chunk of stream) {
        expect12(chunk.sequence).toBe(0);
        break;
      }
      expect12(s.abortedRequests()).toBe(1);
      expect12(await codeOf2(() => stream.write("more"))).toBe(TTS_ERROR_CODES2.closed);
    });
    test12("a vendor error before the first chunk is retried and no audio repeats", async () => {
      const s = await subject();
      s.failNext("retryable", 1);
      s.speak([audio2(0), audio2(1)]);
      const stream = open(s);
      stream.write("hello");
      stream.finish();
      const chunks = await collect(stream);
      expect12(chunks.map((c) => c.sequence)).toEqual([0, 1]);
      expect12(s.vendorRequests()).toBe(2);
    });
    test12("retries are bounded: tts.unavailable after the policy, reported without text", async () => {
      const s = await subject();
      s.failNext("retryable", 5);
      const stream = open(s, { retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 } });
      stream.write(SECRET_TEXT3);
      stream.finish();
      expect12(await codeOf2(() => collect(stream))).toBe(TTS_ERROR_CODES2.unavailable);
      expect12(s.vendorRequests()).toBe(3);
      expect12(JSON.stringify(s.reporter.captured)).not.toContain(SECRET_TEXT3);
      expect12(s.reporter.captured.length).toBeGreaterThan(0);
    });
    test12("a refusal is tts.rejected and is not retried", async () => {
      const s = await subject();
      s.failNext("fatal", 1);
      const stream = open(s);
      stream.write("hello");
      stream.finish();
      expect12(await codeOf2(() => collect(stream))).toBe(TTS_ERROR_CODES2.rejected);
      expect12(s.vendorRequests()).toBe(1);
    });
    test12("a vendor error after the first chunk is thrown, never retried, never repeated", async () => {
      const s = await subject();
      s.speak([audio2(0), audio2(1), audio2(2)], { failAfterChunks: 2 });
      s.speak([audio2(7), audio2(8)]);
      const stream = open(s);
      stream.write("hello");
      stream.finish();
      const heard = [];
      let code = "no error";
      try {
        for await (const chunk of stream) {
          heard.push(chunk.sequence);
        }
      } catch (error) {
        code = error instanceof TtsError2 ? error.code : String(error);
      }
      expect12(heard).toEqual([0, 1]);
      expect12(code).toBe(TTS_ERROR_CODES2.unavailable);
      expect12(s.vendorRequests()).toBe(1);
    });
    test12("text over the limit is tts.text_too_large and adds nothing", async () => {
      const s = await subject();
      s.speak([audio2(0)]);
      const stream = open(s, { maxTextChars: 10 });
      stream.write("12345");
      expect12(await codeOf2(() => stream.write("678901"))).toBe(TTS_ERROR_CODES2.textTooLarge);
      stream.write("67890");
      expect12(await codeOf2(() => stream.write("1"))).toBe(TTS_ERROR_CODES2.textTooLarge);
      stream.finish();
      expect12((await collect(stream)).length).toBe(1);
    });
    test12("a first chunk that never comes is tts.timeout and aborts the vendor request", async () => {
      const s = await subject();
      s.hang();
      const stream = open(s, { firstChunkTimeoutMs: 30 });
      stream.write("hello");
      let error;
      try {
        await collect(stream);
      } catch (caught) {
        error = caught;
      }
      expect12(error).toBeInstanceOf(TtsError2);
      expect12(error.code).toBe(TTS_ERROR_CODES2.timeout);
      expect12(error.details).toMatchObject({ phase: "first_chunk" });
      expect12(s.abortedRequests()).toBe(1);
    });
    test12("the overall deadline is tts.timeout and aborts the vendor request", async () => {
      const s = await subject();
      s.speak([audio2(0), audio2(1), audio2(2)], { chunkDelayMs: 500 });
      const stream = open(s, { timeoutMs: 60 });
      stream.write("hello");
      let error;
      try {
        await collect(stream);
      } catch (caught) {
        error = caught;
      }
      expect12(error.code).toBe(TTS_ERROR_CODES2.timeout);
      expect12(error.details).toMatchObject({ phase: "overall" });
      expect12(s.abortedRequests()).toBe(1);
    });
    test12("the caller's signal is tts.aborted and aborts the vendor request", async () => {
      const s = await subject();
      s.speak([audio2(0), audio2(1)], { chunkDelayMs: 500 });
      const controller = new AbortController;
      const stream = open(s, { signal: controller.signal });
      stream.write("hello");
      const iterator = stream[Symbol.asyncIterator]();
      await iterator.next();
      const pending = iterator.next();
      controller.abort();
      expect12(await codeOf2(() => pending)).toBe(TTS_ERROR_CODES2.aborted);
      expect12(s.abortedRequests()).toBe(1);
    });
    test12("a signal that already fired sends nothing to the vendor", async () => {
      const s = await subject();
      const stream = open(s, { signal: AbortSignal.abort() });
      expect12(await codeOf2(() => stream.write("hello"))).toBe(TTS_ERROR_CODES2.aborted);
      expect12(await codeOf2(() => collect(stream))).toBe(TTS_ERROR_CODES2.aborted);
      expect12(s.vendorRequests()).toBe(0);
    });
    test12("close releases the stream, aborts a pending request and is idempotent", async () => {
      const s = await subject();
      s.hang();
      const before = s.openStreams();
      const stream = open(s, { firstChunkTimeoutMs: 1e4 });
      expect12(s.openStreams()).toBe(before + 1);
      stream.write("hello");
      const reading = collect(stream);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await stream.close();
      await stream.close();
      expect12(await reading).toEqual([]);
      expect12(s.openStreams()).toBe(before);
      expect12(s.abortedRequests()).toBe(1);
    });
    test12("using a closed stream fails clearly with tts.closed", async () => {
      const s = await subject();
      const stream = open(s);
      await stream.close();
      expect12(await codeOf2(() => stream.write("hello"))).toBe(TTS_ERROR_CODES2.closed);
      expect12(await codeOf2(() => stream.finish())).toBe(TTS_ERROR_CODES2.closed);
      expect12(await codeOf2(() => collect(stream))).toBe(TTS_ERROR_CODES2.closed);
      stream.cancel();
      expect12(s.vendorRequests()).toBe(0);
    });
    describe12("a bad request is tts.invalid_request and nothing reaches the vendor", () => {
      const cases = [
        ["organizationId", () => ({ organizationId: "nope" })],
        ["voice (empty)", () => ({ voice: "" })],
        ["voice (characters)", () => ({ voice: "a b/c" })],
        ["encoding", () => ({ encoding: "mp3" })],
        ["sampleRate", () => ({ sampleRate: 44100 })],
        ["timeoutMs (zero)", () => ({ timeoutMs: 0 })],
        ["timeoutMs (huge)", () => ({ timeoutMs: 10 ** 9 })],
        ["firstChunkTimeoutMs", () => ({ firstChunkTimeoutMs: 1.5 })],
        ["maxTextChars (zero)", () => ({ maxTextChars: 0 })],
        ["maxTextChars (huge)", () => ({ maxTextChars: 10 ** 9 })],
        ["retry.maxRetries", () => ({ retry: { maxRetries: 99 } })],
        ["retry that is not an object", () => ({ retry: 5 })],
        ["retry.maxDelayMs below base", () => ({ retry: { baseDelayMs: 10, maxDelayMs: 5 } })],
        ["signal", () => ({ signal: {} })]
      ];
      test12.each(cases)("%s", async (_name, overrides) => {
        const s = await subject();
        const before = s.openStreams();
        expect12(await codeOf2(() => open(s, overrides(s)))).toBe(TTS_ERROR_CODES2.invalidRequest);
        expect12(s.vendorRequests()).toBe(0);
        expect12(s.openStreams()).toBe(before);
      });
      test12("text that is not a string", async () => {
        const s = await subject();
        const stream = open(s);
        expect12(await codeOf2(() => stream.write(42))).toBe(TTS_ERROR_CODES2.invalidRequest);
        await stream.close();
      });
    });
    test12("neither the text nor the audio reaches a log, a report, an error or any printed form", async () => {
      const s = await subject();
      const marked = [audio2(0, SECRET_AUDIO), audio2(1, SECRET_AUDIO)];
      const base64 = marked.map((m) => Buffer.from(m).toString("base64"));
      const forms = [];
      const record = (value) => {
        forms.push(String(value), inspect3(value, { depth: 6 }));
        try {
          forms.push(JSON.stringify(value) ?? "");
        } catch {}
      };
      s.failNext("retryable", 1);
      s.speak(marked);
      const stream = open(s);
      record(stream);
      stream.write(SECRET_TEXT3);
      stream.write(` ${SECRET_TEXT3}`);
      stream.finish();
      record(stream);
      for await (const chunk of stream) {
        record(chunk);
        record({ chunk });
        record([chunk]);
        record({ ...chunk });
        expect12(Buffer.from(chunk.audio).toString()).toContain(SECRET_AUDIO);
      }
      s.failNext("fatal", 1);
      const failing = open(s, { maxTextChars: 40 });
      failing.write(SECRET_TEXT3);
      try {
        await collect(failing);
      } catch (error) {
        record(error);
        forms.push(error.message);
        forms.push(JSON.stringify(error.details ?? {}));
      }
      try {
        failing.write(`${SECRET_TEXT3} ${SECRET_TEXT3}`);
      } catch (error) {
        record(error);
        forms.push(error.message);
      }
      s.speak(marked, { failAfterChunks: 1 });
      const breaking = open(s);
      breaking.write(SECRET_TEXT3);
      try {
        await collect(breaking);
      } catch (error) {
        record(error);
      }
      const everything = [
        ...forms,
        ...s.logs(),
        JSON.stringify(s.reporter.captured),
        inspect3(s.reporter.captured, { depth: 8 })
      ].join(`
`);
      expect12(everything).not.toContain(SECRET_TEXT3);
      expect12(everything).not.toContain(SECRET_AUDIO);
      for (const encoded of base64) {
        expect12(everything).not.toContain(encoded);
      }
      expect12(everything).not.toContain(`[${[...marked[0] ?? []].join(",")}`);
    });
  });
}
// src/vector/behaviour.ts
import { afterEach as afterEach13, describe as describe13, expect as expect13, test as test13 } from "bun:test";
function vectorStoreBehaviour(name, make, skip = false) {
  const run = skip ? describe13.skip : describe13;
  run(`VectorStore behaviour: ${name}`, () => {
    const open = [];
    afterEach13(async () => {
      await Promise.all(open.splice(0).map((subject) => subject.close()));
    });
    async function subject() {
      const made = await make();
      open.push(made);
      return made;
    }
    const vec = (s, ...lead) => Array.from({ length: s.store.dimensions }, (_, i) => lead[i] ?? 0);
    const ids = (hits) => hits.map((hit) => hit.id);
    const invalid = { code: "vector.invalid_request" };
    async function seed(s, org = s.organizations.a) {
      await s.store.upsert(org, [
        { id: "x", vector: vec(s, 1, 0, 0), attributes: { document_id: "doc_1", page: 1 } },
        { id: "y", vector: vec(s, 0, 1, 0), attributes: { document_id: "doc_1", page: 2 } },
        {
          id: "xy",
          vector: vec(s, 1, 1, 0),
          attributes: { document_id: "doc_2", page: 1, final: true }
        },
        { id: "z", vector: vec(s, 0, 0, 1) }
      ]);
    }
    test13("a search returns the closest vectors first, with cosine scores and attributes", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await seed(s);
      const hits = await s.store.search(a, { vector: vec(s, 1, 0, 0), topK: 4 });
      expect13(ids(hits).slice(0, 2)).toEqual(["x", "xy"]);
      expect13(hits[0]?.score).toBeCloseTo(1, 4);
      expect13(hits[1]?.score).toBeCloseTo(Math.SQRT1_2, 4);
      expect13(hits[0]?.attributes).toEqual({ document_id: "doc_1", page: 1 });
      expect13(hits.find((hit) => hit.id === "z")?.attributes).toEqual({});
    });
    test13("a score does not depend on the length of either vector", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.store.upsert(a, [{ id: "long", vector: vec(s, 50, 0, 0) }]);
      const [hit] = await s.store.search(a, { vector: vec(s, 0.001, 0, 0), topK: 1 });
      expect13(hit?.id).toBe("long");
      expect13(hit?.score).toBeCloseTo(1, 4);
    });
    test13("topK bounds the results", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await seed(s);
      expect13(await s.store.search(a, { vector: vec(s, 1, 1, 1), topK: 2 })).toHaveLength(2);
      expect13(await s.store.search(a, { vector: vec(s, 1, 1, 1), topK: 100 })).toHaveLength(4);
      expect13(await s.store.search(s.organizations.b, { vector: vec(s, 1), topK: 5 })).toEqual([]);
    });
    test13.each([[0], [-1], [101], [1.5], [Number.NaN], ["5"]])("a topK of %p is refused", async (topK) => {
      const s = await subject();
      await expect13(s.store.search(s.organizations.a, { vector: vec(s, 1), topK })).rejects.toMatchObject(invalid);
    });
    test13("a filter keeps vectors whose attributes equal every entry", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await seed(s);
      const search = async (filter) => ids(await s.store.search(a, { vector: vec(s, 1, 1, 1), topK: 10, filter })).sort();
      expect13(await search({ document_id: "doc_1" })).toEqual(["x", "y"]);
      expect13(await search({ document_id: "doc_1", page: 2 })).toEqual(["y"]);
      expect13(await search({ final: true })).toEqual(["xy"]);
      expect13(await search({ page: 1 })).toEqual(["x", "xy"]);
      expect13(await search({ document_id: "nope" })).toEqual([]);
      expect13(await search({ page: "1" })).toEqual([]);
    });
    test13("a vector of the wrong length is a non-retryable dimension error and writes nothing", async () => {
      const s = await subject();
      const { a } = s.organizations;
      const code = { code: "vector.dimension_mismatch" };
      const short = Array.from({ length: s.store.dimensions - 1 }, () => 1);
      const long = Array.from({ length: s.store.dimensions + 1 }, () => 1);
      await expect13(s.store.search(a, { vector: short, topK: 1 })).rejects.toMatchObject(code);
      await expect13(s.store.search(a, { vector: long, topK: 1 })).rejects.toMatchObject(code);
      await expect13(s.store.upsert(a, [
        { id: "fine", vector: vec(s, 1) },
        { id: "short", vector: short }
      ])).rejects.toMatchObject(code);
      expect13(await s.store.search(a, { vector: vec(s, 1), topK: 10 })).toEqual([]);
    });
    test13.each([
      ["NaN", (n) => Array.from({ length: n }, (_, i) => i === 0 ? Number.NaN : 1)],
      [
        "Infinity",
        (n) => Array.from({ length: n }, (_, i) => i === 0 ? Number.POSITIVE_INFINITY : 1)
      ],
      [
        "a value too large for a float",
        (n) => Array.from({ length: n }, (_, i) => i === 0 ? 1000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000 : 1)
      ],
      ["all zeros", (n) => Array.from({ length: n }, () => 0)],
      [
        "a string",
        (n) => Array.from({ length: n }, (_, i) => i === 0 ? "1" : 1)
      ]
    ])("a vector with %s is refused", async (_label, build) => {
      const s = await subject();
      const { a } = s.organizations;
      const vector = build(s.store.dimensions);
      await expect13(s.store.upsert(a, [{ id: "v", vector }])).rejects.toMatchObject(invalid);
      await expect13(s.store.search(a, { vector, topK: 1 })).rejects.toMatchObject(invalid);
    });
    test13.each([
      ["an empty id", ""],
      ["a slash", "a/b"],
      ["a leading dot", ".x"],
      ["a space", "a b"],
      ["a long id", "x".repeat(65)]
    ])("an id with %s is refused", async (_label, id) => {
      const s = await subject();
      const { a } = s.organizations;
      await expect13(s.store.upsert(a, [{ id, vector: vec(s, 1) }])).rejects.toMatchObject(invalid);
      await expect13(s.store.delete(a, [id])).rejects.toMatchObject(invalid);
    });
    test13("a batch of 0 or 501 records, or one with a repeated id, is refused", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await expect13(s.store.upsert(a, [])).rejects.toMatchObject(invalid);
      const many = Array.from({ length: 501 }, (_, i) => ({ id: `v${i}`, vector: vec(s, 1) }));
      await expect13(s.store.upsert(a, many)).rejects.toMatchObject(invalid);
      await expect13(s.store.upsert(a, [
        { id: "same", vector: vec(s, 1) },
        { id: "same", vector: vec(s, 0, 1) }
      ])).rejects.toMatchObject(invalid);
      await expect13(s.store.delete(a, [])).rejects.toMatchObject(invalid);
      await expect13(s.store.delete(a, Array.from({ length: 501 }, (_, i) => `v${i}`))).rejects.toMatchObject(invalid);
      expect13(await s.store.search(a, { vector: vec(s, 1), topK: 10 })).toEqual([]);
    });
    test13.each([
      ["the reserved name id", { id: "x" }],
      ["the reserved name vector", { vector: "x" }],
      ["a name starting with a dollar sign", { $dist: "x" }],
      ["an upper-case name", { Document: "x" }],
      ["a name with a dot", { "a.b": "x" }],
      ["an array value", { tags: ["x"] }],
      ["a null value", { n: null }],
      ["a non-finite number", { n: Number.NaN }],
      ["a long string", { n: "x".repeat(513) }],
      [
        "too many entries",
        Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"]))
      ]
    ])("attributes with %s are refused", async (_label, attributes) => {
      const s = await subject();
      const { a } = s.organizations;
      await expect13(s.store.upsert(a, [{ id: "v", vector: vec(s, 1), attributes }])).rejects.toMatchObject(invalid);
      await expect13(s.store.search(a, { vector: vec(s, 1), topK: 1, filter: attributes })).rejects.toMatchObject(invalid);
      await expect13(s.store.deleteByFilter(a, attributes)).rejects.toMatchObject(invalid);
    });
    test13("storing an id again replaces its vector and attributes, and doing it twice changes nothing", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.store.upsert(a, [{ id: "v", vector: vec(s, 1), attributes: { n: 1 } }]);
      const replacement = [{ id: "v", vector: vec(s, 0, 1), attributes: { n: 2 } }];
      await s.store.upsert(a, replacement);
      await s.store.upsert(a, replacement);
      const hits = await s.store.search(a, { vector: vec(s, 0, 1), topK: 10 });
      expect13(ids(hits)).toEqual(["v"]);
      expect13(hits[0]?.score).toBeCloseTo(1, 4);
      expect13(hits[0]?.attributes).toEqual({ n: 2 });
    });
    describe13("setAttributes", () => {
      const query = (s) => ({ vector: vec(s, 1, 1, 0), topK: 10 });
      test13("merges the attributes, leaves the others and the vector as they were", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await seed(s);
        const before = await s.store.search(a, query(s));
        const missing = await s.store.setAttributes(a, ["x", "xy"], { outcome: "won", seq: 2 });
        const after = await s.store.search(a, query(s));
        expect13(missing).toEqual([]);
        expect13(after.map((hit) => [hit.id, hit.score])).toEqual(before.map((hit) => [hit.id, hit.score]));
        const byId = Object.fromEntries(after.map((hit) => [hit.id, hit.attributes]));
        expect13(byId.x).toEqual({ document_id: "doc_1", page: 1, outcome: "won", seq: 2 });
        expect13(byId.xy).toEqual({
          document_id: "doc_2",
          page: 1,
          final: true,
          outcome: "won",
          seq: 2
        });
        expect13(byId.y).toEqual({ document_id: "doc_1", page: 2 });
        expect13(byId.z).toEqual({});
      });
      test13("overwrites a value that exists and keeps the rest", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await seed(s);
        await s.store.setAttributes(a, ["x"], { page: 9 });
        const hit = (await s.store.search(a, query(s))).find((item) => item.id === "x");
        expect13(hit?.attributes).toEqual({ document_id: "doc_1", page: 9 });
      });
      test13("reports ids it did not find, in order, and does not create them", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await seed(s);
        const missing = await s.store.setAttributes(a, ["nope", "x", "gone"], { outcome: "lost" });
        expect13(missing).toEqual(["nope", "gone"]);
        const all = await s.store.search(a, { vector: vec(s, 1), topK: 100 });
        expect13(ids(all).sort()).toEqual(["x", "xy", "y", "z"]);
        expect13(await s.store.setAttributes(s.organizations.b, ["x"], { n: 1 })).toEqual(["x"]);
      });
      test13("an Organization with no vectors reports every id and creates nothing", async () => {
        const s = await subject();
        const { a } = s.organizations;
        expect13(await s.store.setAttributes(a, ["x", "y"], { n: 1 })).toEqual(["x", "y"]);
        expect13(await s.store.search(a, { vector: vec(s, 1), topK: 10 })).toEqual([]);
      });
      test13("more than the upsert maximum, none, or a repeated id is refused and records nothing", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await seed(s);
        const many = ["x", ...Array.from({ length: 500 }, (_, i) => `v${i}`)];
        await expect13(s.store.setAttributes(a, many, { n: 1 })).rejects.toMatchObject(invalid);
        await expect13(s.store.setAttributes(a, [], { n: 1 })).rejects.toMatchObject(invalid);
        await expect13(s.store.setAttributes(a, ["x", "x"], { n: 1 })).rejects.toMatchObject(invalid);
        await expect13(s.store.setAttributes(a, ["bad id"], { n: 1 })).rejects.toMatchObject(invalid);
        const atMax = Array.from({ length: 500 }, (_, i) => `v${i}`);
        expect13(await s.store.setAttributes(a, atMax, { n: 1 })).toHaveLength(500);
        const x = (await s.store.search(a, { vector: vec(s, 1), topK: 1 }))[0];
        expect13(x?.attributes).toEqual({ document_id: "doc_1", page: 1 });
      });
      test13("a second Organization's vectors with the same ids are untouched", async () => {
        const s = await subject();
        const { a, b } = s.organizations;
        await seed(s, a);
        await seed(s, b);
        await s.store.setAttributes(a, ["x", "y"], { outcome: "won" });
        const other = await s.store.search(b, {
          vector: vec(s, 1),
          topK: 10,
          filter: { outcome: "won" }
        });
        expect13(other).toEqual([]);
        const mine = await s.store.search(a, {
          vector: vec(s, 1),
          topK: 10,
          filter: { outcome: "won" }
        });
        expect13(ids(mine).sort()).toEqual(["x", "y"]);
      });
      test13("repeating the call changes nothing", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await seed(s);
        await s.store.setAttributes(a, ["x", "nope"], { outcome: "won" });
        const once = await s.store.search(a, query(s));
        const missing = await s.store.setAttributes(a, ["x", "nope"], { outcome: "won" });
        expect13(missing).toEqual(["nope"]);
        expect13(await s.store.search(a, query(s))).toEqual(once);
      });
      test13("a filter on the changed attribute sees the new value and not the old", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await seed(s);
        await s.store.setAttributes(a, ["x"], { outcome: "open" });
        await s.store.setAttributes(a, ["x"], { outcome: "won" });
        const search = (outcome) => s.store.search(a, { vector: vec(s, 1), topK: 10, filter: { outcome } });
        expect13(ids(await search("won"))).toEqual(["x"]);
        expect13(await search("open")).toEqual([]);
      });
      test13.each([
        ["no entries", {}],
        ["the reserved name id", { id: "x" }],
        ["the reserved name vector", { vector: "x" }],
        ["an upper-case name", { Document: "x" }],
        ["an array value", { tags: ["x"] }],
        ["a null value", { n: null }],
        ["a non-finite number", { n: Number.NaN }],
        ["a long string", { n: "x".repeat(513) }],
        [
          "too many entries",
          Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"]))
        ]
      ])("attributes with %s are refused and change nothing", async (_label, attributes) => {
        const s = await subject();
        const { a } = s.organizations;
        await seed(s);
        await expect13(s.store.setAttributes(a, ["x"], attributes)).rejects.toMatchObject(invalid);
        const x = (await s.store.search(a, { vector: vec(s, 1), topK: 1 }))[0];
        expect13(x?.attributes).toEqual({ document_id: "doc_1", page: 1 });
      });
      test13("a merge that would give a vector more than 16 attributes is refused and writes nothing", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await s.store.upsert(a, [
          {
            id: "full",
            vector: vec(s, 1),
            attributes: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, 1]))
          },
          { id: "room", vector: vec(s, 0, 1), attributes: { k0: 1 } }
        ]);
        await expect13(s.store.setAttributes(a, ["room", "full"], { extra: 1 })).rejects.toMatchObject(invalid);
        const room = (await s.store.search(a, { vector: vec(s, 0, 1), topK: 2 })).find((hit) => hit.id === "room");
        expect13(room?.attributes).toEqual({ k0: 1 });
        expect13(await s.store.setAttributes(a, ["full"], { k0: 2 })).toEqual([]);
      });
      test13("an invalid Organization id is refused", async () => {
        const s = await subject();
        await expect13(s.store.setAttributes("not an org", ["x"], { n: 1 })).rejects.toMatchObject(invalid);
      });
    });
    test13("deleting by id removes those vectors, ignores unknown ids and can be repeated", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await seed(s);
      await s.store.delete(a, ["x", "missing"]);
      await s.store.delete(a, ["x", "missing"]);
      expect13(ids(await s.store.search(a, { vector: vec(s, 1, 1, 1), topK: 10 })).sort()).toEqual([
        "xy",
        "y",
        "z"
      ]);
    });
    test13("deleting by filter removes the matching vectors only, and an empty filter is refused", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await seed(s);
      await expect13(s.store.deleteByFilter(a, {})).rejects.toMatchObject(invalid);
      await s.store.deleteByFilter(a, { document_id: "doc_1" });
      await s.store.deleteByFilter(a, { document_id: "doc_1" });
      await s.store.deleteByFilter(a, { document_id: "never" });
      expect13(ids(await s.store.search(a, { vector: vec(s, 1, 1, 1), topK: 10 })).sort()).toEqual([
        "xy",
        "z"
      ]);
    });
    test13("a second Organization cannot search, overwrite or delete the first one's vectors", async () => {
      const s = await subject();
      const { a, b } = s.organizations;
      await seed(s, a);
      expect13(await s.store.search(b, { vector: vec(s, 1, 0, 0), topK: 100 })).toEqual([]);
      expect13(await s.store.search(b, {
        vector: vec(s, 1, 0, 0),
        topK: 100,
        filter: { document_id: "doc_1" }
      })).toEqual([]);
      await s.store.upsert(b, [
        { id: "x", vector: vec(s, 0, 0, 1), attributes: { document_id: "b_doc" } }
      ]);
      await s.store.delete(b, ["y", "xy"]);
      await s.store.deleteByFilter(b, { document_id: "doc_1" });
      const mine = await s.store.search(a, { vector: vec(s, 1, 0, 0), topK: 100 });
      expect13(ids(mine).sort()).toEqual(["x", "xy", "y", "z"]);
      expect13(mine.find((hit) => hit.id === "x")?.attributes).toEqual({
        document_id: "doc_1",
        page: 1
      });
      const theirs = await s.store.search(b, { vector: vec(s, 1, 0, 0), topK: 100 });
      expect13(ids(theirs)).toEqual(["x"]);
      expect13(theirs[0]?.attributes).toEqual({ document_id: "b_doc" });
    });
    test13("an Organization whose id starts with another id is a different Organization", async () => {
      const s = await subject();
      const { a, aExtended } = s.organizations;
      await s.store.upsert(a, [{ id: "one", vector: vec(s, 1) }]);
      await s.store.upsert(aExtended, [{ id: "two", vector: vec(s, 1) }]);
      expect13(ids(await s.store.search(a, { vector: vec(s, 1), topK: 10 }))).toEqual(["one"]);
      expect13(ids(await s.store.search(aExtended, { vector: vec(s, 1), topK: 10 }))).toEqual(["two"]);
      await s.store.delete(a, ["two"]);
      await s.store.deleteByFilter(a, { n: 1 });
      expect13(ids(await s.store.search(aExtended, { vector: vec(s, 1), topK: 10 }))).toEqual(["two"]);
    });
    test13("an id of exactly 64 characters is accepted", async () => {
      const s = await subject();
      const { a } = s.organizations;
      const id = "x".repeat(64);
      await s.store.upsert(a, [{ id, vector: vec(s, 1) }]);
      expect13(ids(await s.store.search(a, { vector: vec(s, 1), topK: 1 }))).toEqual([id]);
    });
    test13("deleting everything an Organization has leaves other Organizations alone and can be repeated", async () => {
      const s = await subject();
      const { a, b, aExtended } = s.organizations;
      await seed(s, a);
      await seed(s, b);
      await seed(s, aExtended);
      await s.store.deleteAll(a);
      await s.store.deleteAll(a);
      await s.store.deleteAll(`${a.slice(0, -1)}9`);
      expect13(await s.store.search(a, { vector: vec(s, 1, 1, 1), topK: 10 })).toEqual([]);
      expect13(await s.store.search(b, { vector: vec(s, 1, 1, 1), topK: 10 })).toHaveLength(4);
      expect13(await s.store.search(aExtended, { vector: vec(s, 1, 1, 1), topK: 10 })).toHaveLength(4);
      await s.store.upsert(a, [{ id: "again", vector: vec(s, 1) }]);
      expect13(ids(await s.store.search(a, { vector: vec(s, 1), topK: 10 }))).toEqual(["again"]);
    });
    test13("warming an Organization changes nothing and works with or without data", async () => {
      const s = await subject();
      const { a, b } = s.organizations;
      await s.store.warm(b);
      await seed(s, a);
      await s.store.warm(a);
      await s.store.warm(a);
      expect13(await s.store.search(a, { vector: vec(s, 1, 1, 1), topK: 10 })).toHaveLength(4);
      expect13(await s.store.search(b, { vector: vec(s, 1, 1, 1), topK: 10 })).toEqual([]);
    });
    test13.each([
      ["empty", ""],
      ["a path", "org/../x"],
      ["a separator", "x/y"],
      ["an encoded separator", "x%2Fy"],
      ["a wildcard", "x*"],
      ["too long", "x".repeat(65)]
    ])("an Organization id that is %s is refused by every operation", async (_label, id) => {
      const s = await subject();
      await expect13(s.store.upsert(id, [{ id: "v", vector: vec(s, 1) }])).rejects.toMatchObject(invalid);
      await expect13(s.store.search(id, { vector: vec(s, 1), topK: 1 })).rejects.toMatchObject(invalid);
      await expect13(s.store.delete(id, ["v"])).rejects.toMatchObject(invalid);
      await expect13(s.store.deleteByFilter(id, { n: 1 })).rejects.toMatchObject(invalid);
      await expect13(s.store.deleteAll(id)).rejects.toMatchObject(invalid);
      await expect13(s.store.warm(id)).rejects.toMatchObject(invalid);
    });
  });
}
export {
  auditBehaviour,
  calendarBehaviour,
  contactGuardBehaviour,
  llmBehaviour,
  messagingBehaviour,
  objectStoreBehaviour,
  processedStoreBehaviour,
  queueBehaviour,
  sampleAuditEntry,
  streamingTranscribeBehaviour,
  telephonyBehaviour,
  transcriberBehaviour,
  ttsBehaviour,
  vectorStoreBehaviour
};
