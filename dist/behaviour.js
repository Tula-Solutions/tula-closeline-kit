import {
  CalendarConnection2,
  CALENDAR_ERROR_CODES2,
  CalendarError2,
  MAX_BUSY_RANGE_MS2,
  LLM_ERROR_CODES2,
  LlmError2,
  MAX_WEBHOOK_BODY_BYTES2,
  checkTranscriptionResult2
} from "./shared/chunk-w4kmnw1c.js";
import {
  MAX_MESSAGE_BYTES2
} from "./shared/chunk-mjkmsg3r.js";
import {
  waitForTranscription2
} from "./shared/chunk-83cpvtqk.js";

// src/calendar/behaviour.ts
import { afterEach, describe, expect, test } from "bun:test";
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
  const run = skip ? describe.skip : describe;
  run(`Calendar behaviour: ${name}`, () => {
    const made = [];
    afterEach(async () => {
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
    test("a grant becomes a connection for the Organization, from a code or a refresh token", async () => {
      const s = await subject();
      const fromCode = await connect(s);
      expect(fromCode).toBeInstanceOf(CalendarConnection2);
      expect(fromCode.organizationId).toBe(s.organizations.a);
      expect(fromCode.connectionId.length).toBeGreaterThan(0);
      expect(fromCode.provider.length).toBeGreaterThan(0);
      const fromRefresh = await s.port.connect({ organizationId: s.organizations.b, grant: s.acceptedGrant("secret-2", "refresh_token") }, opts);
      expect(fromRefresh.organizationId).toBe(s.organizations.b);
      expect(fromRefresh.connectionId).not.toBe(fromCode.connectionId);
    });
    test("a grant the vendor refuses is calendar.rejected and is not retried", async () => {
      const s = await subject();
      expect(await codeOf(s.port.connect({ organizationId: s.organizations.a, grant: s.refusedGrant() }, opts))).toBe(CALENDAR_ERROR_CODES2.rejected);
      expect(s.vendorRequests()).toBe(1);
    });
    test("the credential is not in the connection string, JSON, spread or console form", async () => {
      const s = await subject();
      const connection = await connect(s, SECRET_GRANT);
      const credential = connection.unsafeCredential();
      expect(credential.length).toBeGreaterThan(0);
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
      expect(forms).not.toContain(credential);
      expect(forms).not.toContain(SECRET_GRANT);
      expect(forms).toContain(connection.connectionId);
    });
    test("busy times come back sorted, merged where they touch or overlap, and clipped to the range", async () => {
      const s = await subject();
      const c = await connect(s);
      expect(await busy(s, c)).toEqual([]);
      s.addBusy(c, { start: at(12), end: at(13) });
      s.addBusy(c, { start: at(9), end: at(10) });
      s.addBusy(c, { start: at(9.5), end: at(11) });
      s.addBusy(c, { start: at(11), end: at(11.5) });
      s.addBusy(c, { start: at(-3), end: at(1) });
      s.addBusy(c, { start: at(23), end: at(30) });
      expect(await busy(s, c)).toEqual([
        { start: at(0), end: at(1) },
        { start: at(9), end: at(11.5) },
        { start: at(12), end: at(13) },
        { start: at(23), end: at(24) }
      ]);
      expect(await busy(s, c, { from: at(14), to: at(20) })).toEqual([]);
    });
    test("a range that is empty, backwards, not a time or over the limit never reaches the vendor", async () => {
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
        expect(await codeOf(busy(s, c, range))).toBe(CALENDAR_ERROR_CODES2.invalidRequest);
      }
      expect(s.vendorRequests()).toBe(before);
    });
    test("a created event is busy time, has an id and a join link when video is asked for", async () => {
      const s = await subject();
      const c = await connect(s);
      const plain = await create(s, c, "req-1");
      expect(plain).toMatchObject({ created: true, start: at(10), end: at(10.5) });
      expect(plain.eventId.length).toBeGreaterThan(0);
      expect(plain.joinUrl).toBeUndefined();
      const video = await create(s, c, "req-2", {
        start: at(14),
        end: at(15),
        conferencing: "video"
      });
      expect(typeof video.joinUrl).toBe("string");
      expect(video.eventId).not.toBe(plain.eventId);
      expect(await busy(s, c)).toEqual([
        { start: at(10), end: at(10.5) },
        { start: at(14), end: at(15) }
      ]);
    });
    test("creating again with the same request id returns the same event and makes no second one", async () => {
      const s = await subject();
      const c = await connect(s);
      const first = await create(s, c, "req-same");
      const again = await create(s, c, "req-same");
      expect(again.eventId).toBe(first.eventId);
      expect(again.created).toBe(false);
      expect(first.created).toBe(true);
      expect(await busy(s, c)).toEqual([{ start: at(10), end: at(10.5) }]);
    });
    test("the same request id with a different event is calendar.invalid_request", async () => {
      const s = await subject();
      const c = await connect(s);
      await create(s, c, "req-reused");
      expect(await codeOf(create(s, c, "req-reused", { start: at(11), end: at(12) }))).toBe(CALENDAR_ERROR_CODES2.invalidRequest);
      expect(await busy(s, c)).toEqual([{ start: at(10), end: at(10.5) }]);
    });
    test("request ids are per connection", async () => {
      const s = await subject();
      const one = await connect(s, "secret-1");
      const two = await connect(s, "secret-2");
      const a = await create(s, one, "req-shared");
      const b = await create(s, two, "req-shared", { start: at(11), end: at(12) });
      expect(b.created).toBe(true);
      expect(b.eventId).not.toBe(a.eventId);
    });
    test("updating moves the busy time, and a replay of the request id changes nothing more", async () => {
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
      expect(moved).toMatchObject({ eventId: made.eventId, start: at(16), end: at(17) });
      expect(await busy(s, c)).toEqual([{ start: at(16), end: at(17) }]);
      const replayed = await s.port.updateEvent(update, opts);
      expect(replayed).toEqual(moved);
      expect(await busy(s, c)).toEqual([{ start: at(16), end: at(17) }]);
      expect(await codeOf(s.port.updateEvent({ ...update, changes: { start: at(18), end: at(19) } }, opts))).toBe(CALENDAR_ERROR_CODES2.invalidRequest);
    });
    test("updating an event that does not exist is calendar.not_found", async () => {
      const s = await subject();
      const c = await connect(s);
      expect(await codeOf(s.port.updateEvent({
        organizationId: c.organizationId,
        connection: c,
        eventId: "no-such-event",
        requestId: "req-1",
        changes: { title: "New title" }
      }, opts))).toBe(CALENDAR_ERROR_CODES2.notFound);
    });
    test("an update that leaves the event ending before it starts is refused", async () => {
      const s = await subject();
      const c = await connect(s);
      const made = await create(s, c, "req-1");
      expect(await codeOf(s.port.updateEvent({
        organizationId: c.organizationId,
        connection: c,
        eventId: made.eventId,
        requestId: "req-2",
        changes: { end: at(9) }
      }, opts))).toBe(CALENDAR_ERROR_CODES2.invalidRequest);
      expect(await busy(s, c)).toEqual([{ start: at(10), end: at(10.5) }]);
    });
    test("deleting frees the time; a replay and a second delete of a gone event are not errors", async () => {
      const s = await subject();
      const c = await connect(s);
      const made = await create(s, c, "req-1");
      const del = (requestId, eventId = made.eventId) => s.port.deleteEvent({ organizationId: c.organizationId, connection: c, eventId, requestId }, opts);
      expect(await del("del-1")).toEqual({ deleted: true });
      expect(await busy(s, c)).toEqual([]);
      expect(await del("del-1")).toEqual({ deleted: true });
      expect(await del("del-2")).toEqual({ deleted: false });
      expect(await del("del-3", "never-existed")).toEqual({ deleted: false });
    });
    test("one connection cannot read, change or remove the events of another", async () => {
      const s = await subject();
      const mine = await connect(s, "secret-1", s.organizations.a);
      const theirs = await connect(s, "secret-2", s.organizations.b);
      const made = await create(s, mine, "req-1");
      expect(await busy(s, theirs)).toEqual([]);
      expect(await codeOf(s.port.updateEvent({
        organizationId: theirs.organizationId,
        connection: theirs,
        eventId: made.eventId,
        requestId: "req-x",
        changes: { title: "Hijacked" }
      }, opts))).toBe(CALENDAR_ERROR_CODES2.notFound);
      expect(await s.port.deleteEvent({
        organizationId: theirs.organizationId,
        connection: theirs,
        eventId: made.eventId,
        requestId: "del-x"
      }, opts)).toEqual({ deleted: false });
      expect(await busy(s, mine)).toEqual([{ start: at(10), end: at(10.5) }]);
    });
    test("a connection used for another Organization is refused before any vendor call", async () => {
      const s = await subject();
      const c = await connect(s);
      const before = s.vendorRequests();
      expect(await codeOf(s.port.busy({ organizationId: s.organizations.b, connection: c, ...dayRange }, opts))).toBe(CALENDAR_ERROR_CODES2.invalidRequest);
      expect(s.vendorRequests()).toBe(before);
    });
    test("a request that is not acceptable is refused before any vendor call", async () => {
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
        expect(await codeOf(s.port.createEvent(request, opts))).toBe(CALENDAR_ERROR_CODES2.invalidRequest);
      }
      const badOptions = [
        { timeoutMs: 0 },
        { timeoutMs: 1e7 },
        { retry: { maxRetries: 99 } },
        { retry: { baseDelayMs: 100, maxDelayMs: 10 } },
        { signal: "stop" }
      ];
      for (const option of badOptions) {
        expect(await codeOf(create(s, c, "req-ok", {}, option))).toBe(CALENDAR_ERROR_CODES2.invalidRequest);
      }
      expect(await codeOf(s.port.connect({
        organizationId: s.organizations.a,
        grant: { kind: "refresh_token", refreshToken: "" }
      }, opts))).toBe(CALENDAR_ERROR_CODES2.invalidRequest);
      expect(s.vendorRequests()).toBe(before);
      expect(await busy(s, c)).toEqual([]);
    });
    test("a failing provider is retried a bounded number of times, then calendar.unavailable, and nothing is half-written", async () => {
      const s = await subject();
      const c = await connect(s);
      const before = s.vendorRequests();
      s.failNext("retryable", 10);
      expect(await codeOf(create(s, c, "req-1"))).toBe(CALENDAR_ERROR_CODES2.unavailable);
      expect(s.vendorRequests() - before).toBe(3);
      expect(s.reporter.captured.length).toBeGreaterThan(0);
    });
    test("after a failed create the same request id makes exactly one event", async () => {
      const s = await subject();
      const c = await connect(s);
      s.failNext("retryable", 3);
      expect(await codeOf(create(s, c, "req-1"))).toBe(CALENDAR_ERROR_CODES2.unavailable);
      expect(await busy(s, c)).toEqual([]);
      const made = await create(s, c, "req-1");
      expect(made.created).toBe(true);
      expect(await busy(s, c)).toEqual([{ start: at(10), end: at(10.5) }]);
    });
    test("a retryable failure that clears is retried and the call succeeds with one event", async () => {
      const s = await subject();
      const c = await connect(s);
      const before = s.vendorRequests();
      s.failNext("retryable", 2);
      const made = await create(s, c, "req-1");
      expect(made.eventId.length).toBeGreaterThan(0);
      expect(s.vendorRequests() - before).toBe(3);
      expect(await busy(s, c)).toEqual([{ start: at(10), end: at(10.5) }]);
    });
    test("a lost response is retried and the request id keeps it to one event", async () => {
      const s = await subject();
      if (s.loseResponse === undefined) {
        return;
      }
      const c = await connect(s);
      s.loseResponse(1);
      const made = await create(s, c, "req-1");
      expect(made.eventId.length).toBeGreaterThan(0);
      expect(await busy(s, c)).toEqual([{ start: at(10), end: at(10.5) }]);
      const again = await create(s, c, "req-1");
      expect(again.eventId).toBe(made.eventId);
    });
    test("a fatal vendor failure is calendar.rejected, reported and not retried", async () => {
      const s = await subject();
      const c = await connect(s);
      const before = s.vendorRequests();
      s.failNext("fatal", 1);
      expect(await codeOf(create(s, c, "req-1"))).toBe(CALENDAR_ERROR_CODES2.rejected);
      expect(s.vendorRequests() - before).toBe(1);
      expect(s.reporter.captured.length).toBeGreaterThan(0);
    });
    test("after revoke every call fails with calendar.revoked, and revoking again succeeds", async () => {
      const s = await subject();
      const c = await connect(s);
      const other = await connect(s, "secret-2");
      const made = await create(s, c, "req-1");
      await s.port.revoke({ organizationId: c.organizationId, connection: c }, opts);
      const base = { organizationId: c.organizationId, connection: c };
      expect(await codeOf(busy(s, c))).toBe(CALENDAR_ERROR_CODES2.revoked);
      expect(await codeOf(create(s, c, "req-2"))).toBe(CALENDAR_ERROR_CODES2.revoked);
      expect(await codeOf(create(s, c, "req-1"))).toBe(CALENDAR_ERROR_CODES2.revoked);
      expect(await codeOf(s.port.updateEvent({ ...base, eventId: made.eventId, requestId: "req-3", changes: { title: "x" } }, opts))).toBe(CALENDAR_ERROR_CODES2.revoked);
      expect(await codeOf(s.port.deleteEvent({ ...base, eventId: made.eventId, requestId: "req-4" }, opts))).toBe(CALENDAR_ERROR_CODES2.revoked);
      await s.port.revoke(base, opts);
      expect(await busy(s, other)).toEqual([]);
    });
    test("access revoked at the vendor is calendar.revoked, not retried", async () => {
      const s = await subject();
      const c = await connect(s);
      s.revokeAtProvider(c);
      const before = s.vendorRequests();
      expect(await codeOf(busy(s, c))).toBe(CALENDAR_ERROR_CODES2.revoked);
      expect(s.vendorRequests() - before).toBeLessThanOrEqual(1);
    });
    test("the timeout aborts the vendor request and fails with calendar.timeout", async () => {
      const s = await subject();
      const c = await connect(s);
      const aborted = s.abortedRequests();
      s.hang();
      const started = Date.now();
      expect(await codeOf(create(s, c, "req-1", {}, { timeoutMs: 30, retry }))).toBe(CALENDAR_ERROR_CODES2.timeout);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(s.abortedRequests() - aborted).toBe(1);
    });
    test("the caller signal aborts the vendor request and fails with calendar.aborted", async () => {
      const s = await subject();
      const c = await connect(s);
      const aborted = s.abortedRequests();
      s.hang();
      const controller = new AbortController;
      const pending = codeOf(s.port.busy({ organizationId: c.organizationId, connection: c, ...dayRange }, { ...opts, signal: controller.signal }));
      setTimeout(() => controller.abort(), 10);
      expect(await pending).toBe(CALENDAR_ERROR_CODES2.aborted);
      expect(s.abortedRequests() - aborted).toBe(1);
    });
    test("a signal that is already aborted fails with calendar.aborted", async () => {
      const s = await subject();
      const c = await connect(s);
      expect(await codeOf(create(s, c, "req-1", {}, { ...opts, signal: AbortSignal.abort() }))).toBe(CALENDAR_ERROR_CODES2.aborted);
      expect(await busy(s, c)).toEqual([]);
    });
    test("no token, title, note or address reaches a log, the reporter or an error", async () => {
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
      expect(seenErrors.length).toBeGreaterThan(0);
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
        expect(seen).not.toContain(secret);
      }
    });
  });
}
// src/consent/behaviour.ts
import { afterEach as afterEach2, describe as describe2, expect as expect2, test as test2 } from "bun:test";
import { formatId } from "tula-closeline-contract";
function contactGuardBehaviour(name, make) {
  describe2(`ContactGuard behaviour: ${name}`, () => {
    const open = [];
    afterEach2(async () => {
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
    test2("a target nobody allowed is denied as missing", async () => {
      const s = await subject();
      const result = await s.guard.check(request);
      expect2(result.allowed).toBe(false);
      expect2(result).toMatchObject({ code: "consent.missing", suppressionReason: null });
    });
    test2("an allowed target is allowed with a basis and a check id", async () => {
      const s = await subject();
      s.allow(target, "sms");
      const result = await s.guard.check(request);
      expect2(result).toMatchObject({ allowed: true, basis: "consent_granted" });
      expect2(result.checkId).not.toBeNull();
    });
    test2("an allowance holds for one channel and not another", async () => {
      const s = await subject();
      s.allow(target, "sms");
      expect2((await s.guard.check({ ...request, channel: "phone" })).allowed).toBe(false);
      expect2((await s.guard.check({ ...request, channel: "sms" })).allowed).toBe(true);
    });
    test2("an allowance for one Organization does not reach another", async () => {
      const s = await subject();
      s.allow(target, "sms");
      const result = await s.guard.check({ ...request, organizationId: otherOrg });
      expect2(result.allowed).toBe(false);
    });
    test2.each([
      ["consent.missing", undefined],
      ["consent.withdrawn", undefined],
      ["consent.suppressed", "unsubscribe"]
    ])("a %s denial is passed through as core gave it", async (code, reason) => {
      const s = await subject();
      s.deny(target, "sms", code, reason);
      const result = await s.guard.check(request);
      expect2(result).toMatchObject({
        allowed: false,
        code,
        suppressionReason: reason ?? null
      });
    });
    test2("an address can be checked as well as a Prospect", async () => {
      const s = await subject();
      const email = { organizationId: org, email: "pat@example.com" };
      s.allow(email, "email");
      const result = await s.guard.check({ ...email, channel: "email", purpose: "agent_initiated" });
      expect2(result.allowed).toBe(true);
    });
    test2("the channel and purpose reach the check", async () => {
      const s = await subject();
      await s.guard.check({ ...request, channel: "whatsapp", purpose: "reply" });
      expect2(s.reached()).toHaveLength(1);
      expect2(s.reached()[0]).toMatchObject({
        organizationId: org,
        prospectId,
        channel: "whatsapp",
        purpose: "reply"
      });
    });
    test2("a check that cannot be answered is denied as unavailable, never allowed", async () => {
      const s = await subject();
      s.allow(target, "sms");
      s.makeUnavailable();
      const result = await s.guard.check(request);
      expect2(result).toEqual({
        allowed: false,
        checkId: null,
        code: "consent.unavailable",
        suppressionReason: null
      });
    });
    test2("a request naming two targets is denied as unavailable and asks nothing", async () => {
      const s = await subject();
      s.allow(target, "sms");
      const result = await s.guard.check({ ...request, email: "pat@example.com" });
      expect2(result).toMatchObject({ allowed: false, code: "consent.unavailable" });
      expect2(s.reached()).toHaveLength(0);
    });
    test2("a request with no target is denied as unavailable", async () => {
      const s = await subject();
      const result = await s.guard.check({
        organizationId: org,
        channel: "sms",
        purpose: "agent_initiated"
      });
      expect2(result).toMatchObject({ allowed: false, code: "consent.unavailable" });
    });
  });
}
// src/llm/behaviour.ts
import { afterEach as afterEach3, describe as describe3, expect as expect3, test as test3 } from "bun:test";
import { z } from "zod";
var SECRET_PROMPT = "zebra confidential pricing";
var SECRET_SYSTEM = "SYSTEM-MARKER-INSTRUCTIONS";
var SECRET_ANSWER = "ANSWER-MARKER-PAYLOAD";
var answerSchema = z.object({ intent: z.enum(["buy", "wait"]), confidence: z.number() });
function llmBehaviour(name, make, skip = false) {
  const run = skip ? describe3.skip : describe3;
  run(`LLM behaviour: ${name}`, () => {
    const made = [];
    afterEach3(async () => {
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
    test3("a structured answer comes back typed, with its usage", async () => {
      const s = await subject();
      s.reply(good, { inputTokens: 11, outputTokens: 7 });
      const result = await complete(s);
      expect3(result.value).toEqual({ intent: "buy", confidence: 0.9 });
      expect3(result.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
      expect3(s.vendorRequests()).toBe(1);
    });
    test3("usage is always a pair of non-negative whole numbers", async () => {
      const s = await subject();
      s.reply(good);
      const { usage } = await complete(s);
      expect3(Number.isInteger(usage.inputTokens) && usage.inputTokens > 0).toBe(true);
      expect3(Number.isInteger(usage.outputTokens) && usage.outputTokens > 0).toBe(true);
    });
    test3("output that is not JSON is llm.invalid_output", async () => {
      const s = await subject();
      s.reply("I think they want to buy.");
      expect3(await codeOf(complete(s))).toBe(LLM_ERROR_CODES2.invalidOutput);
    });
    test3("output that does not fit the schema is llm.invalid_output, never a partial value", async () => {
      const s = await subject();
      s.reply(JSON.stringify({ intent: "buy" }));
      expect3(await codeOf(complete(s))).toBe(LLM_ERROR_CODES2.invalidOutput);
      s.reply(JSON.stringify({ intent: "steal", confidence: 1 }));
      expect3(await codeOf(complete(s))).toBe(LLM_ERROR_CODES2.invalidOutput);
    });
    test3("output cut off by the output budget is llm.invalid_output", async () => {
      const s = await subject();
      s.reply(JSON.stringify({ intent: "buy", confidence: 0.9, note: "x".repeat(300) }));
      expect3(await codeOf(complete(s, { maxOutputTokens: 10 }))).toBe(LLM_ERROR_CODES2.invalidOutput);
    });
    test3("invalid output is not retried", async () => {
      const s = await subject();
      s.reply("nonsense");
      await codeOf(complete(s));
      expect3(s.vendorRequests()).toBe(1);
    });
    test3("the timeout aborts the vendor request and fails with llm.timeout", async () => {
      const s = await subject();
      s.hang();
      const started = Date.now();
      expect3(await codeOf(complete(s, { timeoutMs: 30 }))).toBe(LLM_ERROR_CODES2.timeout);
      expect3(Date.now() - started).toBeLessThan(2000);
      expect3(s.vendorRequests()).toBe(1);
      expect3(s.abortedRequests()).toBe(1);
    });
    test3("the caller signal aborts the vendor request and fails with llm.aborted", async () => {
      const s = await subject();
      s.hang();
      const controller = new AbortController;
      const pending = codeOf(complete(s, { signal: controller.signal }));
      setTimeout(() => controller.abort(), 10);
      expect3(await pending).toBe(LLM_ERROR_CODES2.aborted);
      expect3(s.abortedRequests()).toBe(1);
    });
    test3("a signal that is already aborted never reaches the vendor", async () => {
      const s = await subject();
      s.reply(good);
      expect3(await codeOf(complete(s, { signal: AbortSignal.abort() }))).toBe(LLM_ERROR_CODES2.aborted);
      expect3(s.vendorRequests()).toBeLessThanOrEqual(1);
      expect3(s.abortedRequests()).toBe(s.vendorRequests());
    });
    test3("a prompt over the input budget is llm.input_too_large and never reaches the vendor", async () => {
      const s = await subject();
      s.reply(good);
      const big = { ...base(s, "word ".repeat(2000)), maxInputTokens: 100 };
      expect3(await codeOf(complete(s, big))).toBe(LLM_ERROR_CODES2.inputTooLarge);
      expect3(() => s.port.stream(big)).toThrow(LlmError2);
      expect3(s.vendorRequests()).toBe(0);
    });
    test3("a request that is not acceptable is refused before any vendor call", async () => {
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
        expect3(await codeOf(complete(s, overrides))).toBe(LLM_ERROR_CODES2.invalidRequest);
      }
      expect3(s.vendorRequests()).toBe(0);
    });
    test3("a stream delivers its text in order and ends with one done event", async () => {
      const s = await subject();
      s.reply("we can offer a discount today", { inputTokens: 9, outputTokens: 6 });
      const events = await collect(s.port.stream(base(s)));
      const done = events.at(-1);
      expect3(events.filter((e) => e.type === "done")).toHaveLength(1);
      expect3(done).toEqual({
        type: "done",
        stopReason: "end",
        usage: { inputTokens: 9, outputTokens: 6 }
      });
      const text = events.flatMap((e) => e.type === "text" ? [e.text] : []);
      expect3(text.every((piece) => piece.length > 0)).toBe(true);
      expect3(text.join("")).toBe("we can offer a discount today");
    });
    test3("a stream that hits the output budget stops with max_tokens, within the budget", async () => {
      const s = await subject();
      s.reply("lorem ipsum ".repeat(100));
      const events = await collect(s.port.stream({ ...base(s), maxOutputTokens: 5 }));
      const done = events.at(-1);
      expect3(done?.type === "done" && done.stopReason).toBe("max_tokens");
      expect3(done?.type === "done" && done.usage.outputTokens).toBeLessThanOrEqual(5);
      const text = events.flatMap((e) => e.type === "text" ? [e.text] : []).join("");
      expect3(text.length).toBeLessThan(100);
    });
    test3("a reader that stops early aborts the vendor request", async () => {
      const s = await subject();
      s.reply("one two three four five six seven eight");
      for await (const event of s.port.stream(base(s))) {
        if (event.type === "text") {
          break;
        }
      }
      expect3(s.abortedRequests()).toBe(1);
    });
    test3("the timeout covers a stream and aborts its vendor request", async () => {
      const s = await subject();
      s.hang();
      const code = await codeOf(collect(s.port.stream({ ...base(s), timeoutMs: 30 })));
      expect3(code).toBe(LLM_ERROR_CODES2.timeout);
      expect3(s.abortedRequests()).toBe(1);
    });
    test3("a retryable vendor error is retried and the call then succeeds", async () => {
      const s = await subject();
      s.failNext("retryable", 2);
      s.reply(good);
      const result = await complete(s);
      expect3(result.value.intent).toBe("buy");
      expect3(s.vendorRequests()).toBe(3);
    });
    test3("retries are bounded and the last error is llm.unavailable", async () => {
      const s = await subject();
      s.failNext("retryable", 10);
      s.reply(good);
      expect3(await codeOf(complete(s))).toBe(LLM_ERROR_CODES2.unavailable);
      expect3(s.vendorRequests()).toBe(3);
      s.failNext("retryable", 10);
      expect3(await codeOf(complete(s, { retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 } }))).toBe(LLM_ERROR_CODES2.unavailable);
      expect3(s.vendorRequests()).toBe(4);
    });
    test3("a vendor error that a retry cannot fix is llm.rejected and is not retried", async () => {
      const s = await subject();
      s.failNext("fatal", 1);
      s.reply(good);
      expect3(await codeOf(complete(s))).toBe(LLM_ERROR_CODES2.rejected);
      expect3(s.vendorRequests()).toBe(1);
    });
    test3("a stream retries before its first text", async () => {
      const s = await subject();
      s.failNext("retryable", 1);
      s.reply("hello there");
      const events = await collect(s.port.stream(base(s)));
      expect3(events.at(-1)?.type).toBe("done");
      expect3(s.vendorRequests()).toBe(2);
    });
    test3("a failure is reported with the Organization and no text", async () => {
      const s = await subject();
      s.failNext("retryable", 10);
      await codeOf(complete(s));
      expect3(s.reporter.captured).toHaveLength(1);
      expect3(s.reporter.captured[0]?.error).toMatchObject({ code: LLM_ERROR_CODES2.unavailable });
      expect3(s.reporter.captured[0]?.context.organizationId).toBe(s.organizations.a);
      const tags = s.reporter.captured[0]?.context.tags ?? {};
      expect3(Object.keys(tags).sort()).toEqual(["feature", "tier"]);
    });
    test3("a timeout and a caller cancel are not reported", async () => {
      const s = await subject();
      s.hang();
      await codeOf(complete(s, { timeoutMs: 20 }));
      s.hang();
      const controller = new AbortController;
      const pending = codeOf(complete(s, { signal: controller.signal }));
      setTimeout(() => controller.abort(), 10);
      expect3(await pending).toBe(LLM_ERROR_CODES2.aborted);
      expect3(s.reporter.captured).toHaveLength(0);
    });
    test3("no prompt and no completion reaches a log, the error reporter or an error", async () => {
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
      expect3(seenErrors.length).toBeGreaterThan(0);
      const asText = (value) => JSON.stringify(value, (_key, v) => v instanceof Error ? { ...v, name: v.name, message: v.message, stack: v.stack, cause: v.cause } : v);
      const seen = [...s.logs(), asText(s.reporter.captured), asText(seenErrors)].join(`
`);
      for (const secret of [SECRET_PROMPT, "confidential", "zebra", SECRET_SYSTEM, SECRET_ANSWER]) {
        expect3(seen).not.toContain(secret);
      }
    });
  });
}
// src/queue/behaviour.ts
import { afterEach as afterEach4, describe as describe4, expect as expect4, test as test4 } from "bun:test";
function queueBehaviour(name, make, skip = false) {
  const run = skip ? describe4.skip : describe4;
  run(`Queue behaviour: ${name}`, () => {
    const open = [];
    afterEach4(async () => {
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
    test4("publishing an envelope of an unknown type is refused and nothing is sent", async () => {
      const s = await subject();
      const bad = { ...ping(s), type: "test.nope" };
      await expect4(s.queue.publish(bad)).rejects.toMatchObject({ code: "queue.invalid_message" });
      expect4(await none(s)).toEqual([]);
    });
    test4("publishing a payload that fails its schema is refused", async () => {
      const s = await subject();
      const bad = { ...ping(s), payload: { n: "x" } };
      await expect4(s.queue.publish(bad)).rejects.toMatchObject({ code: "queue.invalid_message" });
    });
    test4("an organization message without an organization id is refused, and a global one with it", async () => {
      const s = await subject();
      const noOrg = { ...ping(s), organizationId: undefined };
      await expect4(s.queue.publish(noOrg)).rejects.toMatchObject({ code: "queue.invalid_message" });
      const note = s.registry.create({ type: "test.note", payload: { text: "hi" }, traceId: "t" });
      const withOrg = { ...note, organizationId: "org_a" };
      await expect4(s.queue.publish(withOrg)).rejects.toMatchObject({
        code: "queue.invalid_message"
      });
    });
    test4("a message over 256 KiB is refused with a clear error", async () => {
      const s = await subject();
      const big = s.registry.create({
        type: "test.note",
        payload: { text: "x".repeat(MAX_MESSAGE_BYTES2) },
        traceId: "t"
      });
      await expect4(s.queue.publish(big)).rejects.toMatchObject({ code: "queue.message_too_large" });
      expect4(await none(s)).toEqual([]);
    });
    test4("a batch of 11, an empty batch, or over 256 KiB in total is refused before anything is sent", async () => {
      const s = await subject();
      const eleven = Array.from({ length: 11 }, (_, i) => ping(s, i));
      await expect4(s.queue.publishBatch(eleven)).rejects.toMatchObject({
        code: "queue.batch_too_large"
      });
      await expect4(s.queue.publishBatch([])).rejects.toMatchObject({
        code: "queue.batch_too_large"
      });
      const half = (text) => s.registry.create({ type: "test.note", payload: { text }, traceId: "t" });
      const heavy = [half("a".repeat(150000)), half("b".repeat(150000))];
      await expect4(s.queue.publishBatch(heavy)).rejects.toMatchObject({
        code: "queue.batch_too_large"
      });
      expect4(await none(s)).toEqual([]);
    });
    test4.each([
      [{ maxMessages: 0, visibilityTimeoutSeconds: 5, waitSeconds: 0 }],
      [{ maxMessages: 11, visibilityTimeoutSeconds: 5, waitSeconds: 0 }],
      [{ maxMessages: 1, visibilityTimeoutSeconds: -1, waitSeconds: 0 }],
      [{ maxMessages: 1, visibilityTimeoutSeconds: 5, waitSeconds: 21 }],
      [{ maxMessages: 1, visibilityTimeoutSeconds: 1.5, waitSeconds: 0 }]
    ])("receive with out-of-range arguments %j is refused", async (args) => {
      const s = await subject();
      await expect4(s.queue.receive(args)).rejects.toMatchObject({ code: "queue.invalid_request" });
    });
    test4("a body that is not a valid message comes back as invalid, with no body in it", async () => {
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
      expect4(got).toHaveLength(cases.length);
      expect4(got.every((delivery) => delivery.kind === "invalid")).toBe(true);
      const reasons = got.map((delivery) => delivery.kind === "invalid" ? delivery.reason : "");
      expect4([...reasons].sort()).toEqual(cases.map(([, , reason]) => reason).sort());
      expect4(JSON.stringify(got)).not.toContain(secret);
    });
    test4("an invalid message that is never acknowledged is delivered maxReceiveCount times and then taken out of circulation", async () => {
      const s = await subject();
      await s.injectRaw('{"broken":');
      for (let round = 0;round < s.maxReceiveCount; round++) {
        const got = await take(s, 1);
        expect4(got).toHaveLength(1);
        expect4(got[0]?.receiveCount).toBe(round + 1);
        await s.queue.release(got[0].receipt);
      }
      expect4(await none(s)).toEqual([]);
    });
    test4("extending visibility of an acknowledged message is refused with queue.receipt_invalid", async () => {
      const s = await subject();
      await s.queue.publish(ping(s));
      const [got] = await take(s, 1);
      const receipt = got.receipt;
      await s.queue.acknowledge(receipt);
      await expect4(s.queue.extendVisibility(receipt, 10)).rejects.toMatchObject({
        code: "queue.receipt_invalid"
      });
    });
    test4("acknowledging twice resolves both times", async () => {
      const s = await subject();
      await s.queue.publish(ping(s));
      const [got] = await take(s, 1);
      const receipt = got.receipt;
      await s.queue.acknowledge(receipt);
      await expect4(s.queue.acknowledge(receipt)).resolves.toBeUndefined();
    });
    test4("a published message arrives with every envelope field intact", async () => {
      const s = await subject();
      const sent = ping(s, 7, "org_a", "msg_1");
      await s.queue.publish(sent);
      const [got] = await take(s, 1);
      expect4(got?.kind).toBe("message");
      if (got?.kind === "message") {
        expect4(got.envelope).toEqual(sent);
        expect4(got.receiveCount).toBe(1);
      }
    });
    test4("an empty queue gives an empty list", async () => {
      const s = await subject();
      expect4(await none(s)).toEqual([]);
    });
    test4("a batch publish reports every id as sent and delivers them all", async () => {
      const s = await subject();
      const batch = [ping(s, 1), ping(s, 2), ping(s, 3)];
      const result = await s.queue.publishBatch(batch);
      expect4(result.failed).toEqual([]);
      expect4(result.sent).toEqual(batch.map((envelope) => envelope.id));
      const got = await take(s, 3);
      expect4(got).toHaveLength(3);
    });
    test4("receive returns at most maxMessages", async () => {
      const s = await subject();
      await s.queue.publishBatch([ping(s, 1), ping(s, 2), ping(s, 3)]);
      const first = await s.queue.receive({
        maxMessages: 2,
        visibilityTimeoutSeconds: s.visibilitySeconds,
        waitSeconds: 1
      });
      expect4(first.length).toBeLessThanOrEqual(2);
      expect4(first.length).toBeGreaterThan(0);
    });
    test4("the subject leaves room for an empty long poll inside the visibility timeout", () => {
      return subject().then((s) => {
        expect4(s.visibilitySeconds).toBeGreaterThanOrEqual(s.emptyWaitSeconds + 3);
      });
    });
    test4("a received message stays hidden until its visibility timeout, then returns with a higher count", async () => {
      const s = await subject();
      await s.queue.publish(ping(s, 1, "org_a", "msg_v"));
      expect4(await take(s, 1)).toHaveLength(1);
      expect4(await none(s)).toEqual([]);
      let again;
      for (let waited = 0;waited <= s.visibilitySeconds + 20 && again === undefined; waited++) {
        await s.pass(1);
        [again] = await s.queue.receive({
          maxMessages: 1,
          visibilityTimeoutSeconds: s.visibilitySeconds,
          waitSeconds: s.emptyWaitSeconds
        });
      }
      expect4(again?.kind === "message" && again.envelope.id).toBe("msg_v");
      expect4(again?.receiveCount).toBe(2);
    });
    test4("extending visibility keeps a message hidden past the original timeout", async () => {
      const s = await subject();
      await s.queue.publish(ping(s));
      const [got] = await take(s, 1);
      await s.queue.extendVisibility(got.receipt, s.visibilitySeconds * 4);
      await s.pass(s.visibilitySeconds + 1);
      expect4(await none(s)).toEqual([]);
    });
    test4("releasing a message makes it receivable at once", async () => {
      const s = await subject();
      await s.queue.publish(ping(s));
      const [got] = await take(s, 1);
      await s.queue.release(got.receipt);
      const [again] = await take(s, 1);
      expect4(again?.receiveCount).toBe(2);
    });
    test4("acknowledging with the receipt of an earlier delivery does not delete the redelivered message", async () => {
      const s = await subject();
      await s.queue.publish(ping(s, 1, "org_a", "msg_stale"));
      const [first] = await take(s, 1);
      await s.pass(s.visibilitySeconds + 1);
      const [second] = await take(s, 1);
      expect4(second?.receiveCount).toBe(2);
      await s.queue.acknowledge(first.receipt);
      await s.queue.release(second.receipt);
      const [third] = await take(s, 1);
      expect4(third?.kind === "message" && third.envelope.id).toBe("msg_stale");
      expect4(third?.receiveCount).toBe(3);
    });
    test4("an acknowledged message is not delivered again", async () => {
      const s = await subject();
      await s.queue.publish(ping(s));
      const [got] = await take(s, 1);
      await s.queue.acknowledge(got.receipt);
      await s.pass(s.visibilitySeconds + 1);
      expect4(await none(s)).toEqual([]);
    });
    test4("a message released maxReceiveCount times moves to the dead-letter queue instead of being delivered again", async () => {
      const s = await subject();
      await s.queue.publish(ping(s, 1, "org_a", "msg_dead"));
      for (let round = 1;round <= s.maxReceiveCount; round++) {
        const [got] = await take(s, 1);
        expect4(got?.receiveCount).toBe(round);
        await s.queue.release(got.receipt);
      }
      expect4(await none(s)).toEqual([]);
      const dead = await s.deadLetterIds();
      if (dead !== undefined) {
        expect4(dead).toEqual(["msg_dead"]);
      }
    });
    test4("two organizations' messages stay separate: each envelope keeps its own organization id", async () => {
      const s = await subject();
      await s.queue.publishBatch([ping(s, 1, "org_a", "same_id"), ping(s, 2, "org_b", "same_id")]);
      const got = await take(s, 2);
      const orgs = got.map((delivery) => delivery.kind === "message" ? delivery.envelope.organizationId : "");
      expect4(orgs.sort()).toEqual(["org_a", "org_b"]);
    });
  });
}
// src/queue/store.behaviour.ts
import { afterEach as afterEach5, describe as describe5, expect as expect5, test as test5 } from "bun:test";
var key = { consumer: "c", organizationId: "org_a", messageId: "m1" };
async function claimed(store, k, lease = 60) {
  const result = await store.claim(k, lease);
  if (result.status !== "claimed") {
    throw new Error(`expected a claim, got ${result.status}`);
  }
  return result.token;
}
function processedStoreBehaviour(name, make) {
  describe5(`ProcessedStore behaviour: ${name}`, () => {
    const open = [];
    afterEach5(async () => {
      await Promise.all(open.splice(0).map((subject) => subject.close()));
    });
    async function subject() {
      const made = await make();
      open.push(made);
      return made;
    }
    test5("a live claim is busy for everyone else, and a done message stays done", async () => {
      const { store } = await subject();
      const token = await claimed(store, key);
      expect5(await store.claim(key, 60)).toMatchObject({ status: "busy" });
      expect5(await store.complete(key, token)).toBe(true);
      expect5(await store.claim(key, 60)).toEqual({ status: "done" });
    });
    test5("busy reports the seconds left on the lease, rounded up, at least one", async () => {
      const { store, pass } = await subject();
      await claimed(store, key);
      await pass(10);
      const busy = await store.claim(key, 60);
      expect5(busy.status).toBe("busy");
      if (busy.status === "busy") {
        expect5(busy.retryAfterSeconds).toBeGreaterThanOrEqual(49);
        expect5(busy.retryAfterSeconds).toBeLessThanOrEqual(51);
      }
    });
    test5("a lapsed claim can be taken again, and the old holder can no longer complete", async () => {
      const { store, pass } = await subject();
      const first = await claimed(store, key);
      await pass(61);
      const second = await claimed(store, key);
      expect5(second).not.toBe(first);
      expect5(await store.complete(key, first)).toBe(false);
      expect5(await store.complete(key, second)).toBe(true);
    });
    test5("release frees the claim for the next delivery; a stale token releases nothing", async () => {
      const { store } = await subject();
      const token = await claimed(store, key);
      await store.release(key, "wrong-token");
      expect5(await store.claim(key, 60)).toMatchObject({ status: "busy" });
      await store.release(key, token);
      expect5(await store.claim(key, 60)).toMatchObject({ status: "claimed" });
    });
    test5("the organization, the consumer and a missing organization are all part of the key", async () => {
      const { store } = await subject();
      await claimed(store, key);
      expect5(await store.claim({ ...key, organizationId: "org_b" }, 60)).toMatchObject({
        status: "claimed"
      });
      expect5(await store.claim({ ...key, organizationId: null }, 60)).toMatchObject({
        status: "claimed"
      });
      expect5(await store.claim({ ...key, consumer: "other" }, 60)).toMatchObject({
        status: "claimed"
      });
      expect5(await store.claim(key, 60)).toMatchObject({ status: "busy" });
    });
    test5("completing a message that was never claimed does nothing", async () => {
      const { store } = await subject();
      expect5(await store.complete(key, "nope")).toBe(false);
    });
    test5("renew pushes the lease out, and only for the holder of a live claim", async () => {
      const { store, pass } = await subject();
      const token = await claimed(store, key);
      await pass(50);
      expect5(await store.renew(key, token, 60)).toBe(true);
      await pass(50);
      expect5(await store.claim(key, 60)).toMatchObject({ status: "busy" });
      expect5(await store.renew(key, "wrong-token", 60)).toBe(false);
      await pass(20);
      expect5(await store.renew(key, token, 60)).toBe(false);
      expect5(await store.renew({ ...key, messageId: "never" }, token, 60)).toBe(false);
    });
    test5("a completed claim cannot be renewed", async () => {
      const { store } = await subject();
      const token = await claimed(store, key);
      await store.complete(key, token);
      expect5(await store.renew(key, token, 60)).toBe(false);
    });
    test5("purge removes old done records and lapsed claims, at most `limit`, and keeps the rest", async () => {
      const { store, pass, now } = await subject();
      for (const id of ["a", "b", "c"]) {
        const k = { ...key, messageId: id };
        await store.complete(k, await claimed(store, k));
      }
      const live = { ...key, messageId: "live" };
      await claimed(store, live, 3600);
      await pass(10);
      const cutoff = now();
      expect5(await store.purge(cutoff, 2)).toBe(2);
      expect5(await store.purge(cutoff, 10)).toBe(1);
      expect5(await store.claim({ ...key, messageId: "a" }, 60)).toMatchObject({ status: "claimed" });
      expect5(await store.claim(live, 60)).toMatchObject({ status: "busy" });
    });
  });
}
// src/storage/behaviour.ts
import { afterEach as afterEach6, describe as describe6, expect as expect6, test as test6 } from "bun:test";
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
  const run = skip ? describe6.skip : describe6;
  run(`ObjectStore behaviour: ${name}`, () => {
    const open = [];
    afterEach6(async () => {
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
    test6.each(BAD_KEYS.map((key) => [JSON.stringify(key.slice(0, 40)), key]))("the key %s is refused by every operation", async (_label, key) => {
      const s = await subject();
      const { a } = s.organizations;
      const code = { code: "storage.invalid_request" };
      await expect6(s.store.put(a, key, bytes("x"))).rejects.toMatchObject(code);
      await expect6(s.store.get(a, key)).rejects.toMatchObject(code);
      await expect6(s.store.head(a, key)).rejects.toMatchObject(code);
      await expect6(s.store.delete(a, key)).rejects.toMatchObject(code);
    });
    test6.each([
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
      await expect6(s.store.put(id, "k", bytes("x"))).rejects.toMatchObject(code);
      await expect6(s.store.get(id, "k")).rejects.toMatchObject(code);
      await expect6(s.store.head(id, "k")).rejects.toMatchObject(code);
      await expect6(s.store.delete(id, "k")).rejects.toMatchObject(code);
      await expect6(s.store.list(id)).rejects.toMatchObject(code);
    });
    test6("an id built from another Organization id and a path does not reach it", async () => {
      const s = await subject();
      const { a, b } = s.organizations;
      await s.store.put(b, "secret.txt", bytes("b only"));
      for (const id of [`${a}/../${b}`, `${a}/${b}`, `../${b}`, `${b}/`, `${b}/.`]) {
        await expect6(s.store.get(id, "secret.txt")).rejects.toMatchObject({
          code: "storage.invalid_request"
        });
        await expect6(s.store.list(id)).rejects.toMatchObject({ code: "storage.invalid_request" });
      }
    });
    test6("an object comes back as written, with its content type as given", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.store.put(a, "docs/one.txt", bytes("hello"), {
        contentType: "text/plain; charset=utf-8"
      });
      const got = await s.store.get(a, "docs/one.txt");
      expect6(got?.key).toBe("docs/one.txt");
      expect6(text(got?.body ?? new Uint8Array)).toBe("hello");
      expect6(got?.size).toBe(5);
      expect6(sameMediaType(got?.contentType, "text/plain; charset=utf-8")).toBe(true);
      expect6(got?.lastModified).toBeInstanceOf(Date);
      expect6(Number.isNaN(got?.lastModified.getTime())).toBe(false);
      const info = await s.store.head(a, "docs/one.txt");
      expect6(info).toMatchObject({ key: "docs/one.txt", size: 5 });
      expect6(sameMediaType(info?.contentType, "text/plain; charset=utf-8")).toBe(true);
    });
    test6("a content type without parameters comes back byte for byte", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.store.put(a, "a.pdf", bytes("%PDF"), { contentType: "application/pdf" });
      expect6((await s.store.get(a, "a.pdf"))?.contentType).toBe("application/pdf");
      expect6((await s.store.head(a, "a.pdf"))?.contentType).toBe("application/pdf");
    });
    test6("a different media type or parameter value is not the same content type", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.store.put(a, "k", bytes("x"), { contentType: "text/plain; charset=utf-8" });
      const got = await s.store.head(a, "k");
      expect6(sameMediaType(got?.contentType, "text/html; charset=utf-8")).toBe(false);
      expect6(sameMediaType(got?.contentType, "text/plain; charset=latin1")).toBe(false);
      expect6(sameMediaType(got?.contentType, "text/plain")).toBe(false);
    });
    test6("without a content type the store says application/octet-stream", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.store.put(a, "blob", new Uint8Array([0, 255, 1, 254]));
      const got = await s.store.get(a, "blob");
      expect6(got?.contentType).toBe("application/octet-stream");
      expect6([...got?.body ?? []]).toEqual([0, 255, 1, 254]);
    });
    test6("content is stored as bytes whatever its content type claims", async () => {
      const s = await subject();
      const { a } = s.organizations;
      const html = bytes("<script>alert(1)</script>");
      await s.store.put(a, "liar.png", html, { contentType: "image/png" });
      const got = await s.store.get(a, "liar.png");
      expect6(text(got?.body ?? new Uint8Array)).toBe("<script>alert(1)</script>");
      expect6(got?.contentType).toBe("image/png");
    });
    test6("an empty object is stored", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.store.put(a, "empty", new Uint8Array);
      expect6((await s.store.get(a, "empty"))?.size).toBe(0);
    });
    test6.each([
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
      await expect6(s.store.put(a, "k", bytes("x"), { contentType })).rejects.toMatchObject({
        code: "storage.invalid_request"
      });
      expect6(await s.store.head(a, "k")).toBeUndefined();
    });
    test6("a body that is not bytes is refused", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await expect6(s.store.put(a, "k", "text")).rejects.toMatchObject({
        code: "storage.invalid_request"
      });
    });
    test6("an object over the size limit is refused and the limit itself is accepted", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await expect6(s.store.put(a, "big", new Uint8Array(s.maxObjectBytes + 1))).rejects.toMatchObject({ code: "storage.object_too_large" });
      expect6(await s.store.head(a, "big")).toBeUndefined();
      await s.store.put(a, "edge", new Uint8Array(s.maxObjectBytes));
      expect6((await s.store.head(a, "edge"))?.size).toBe(s.maxObjectBytes);
    });
    test6("a missing object reads as undefined", async () => {
      const s = await subject();
      const { a } = s.organizations;
      expect6(await s.store.get(a, "nothing")).toBeUndefined();
      expect6(await s.store.head(a, "nothing")).toBeUndefined();
    });
    test6("writing a key again replaces the object, and writing the same thing twice changes nothing", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.store.put(a, "k", bytes("one"), { contentType: "text/plain" });
      await s.store.put(a, "k", bytes("two"), { contentType: "text/csv" });
      await s.store.put(a, "k", bytes("two"), { contentType: "text/csv" });
      const got = await s.store.get(a, "k");
      expect6(text(got?.body ?? new Uint8Array)).toBe("two");
      expect6(got?.contentType).toBe("text/csv");
      expect6(await keysOf(s, a)).toEqual(["k"]);
    });
    test6("deleting removes the object, and deleting again or deleting nothing resolves", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.store.put(a, "k", bytes("x"));
      await s.store.delete(a, "k");
      expect6(await s.store.get(a, "k")).toBeUndefined();
      await s.store.delete(a, "k");
      await s.store.delete(a, "never-existed");
    });
    test6("a second Organization cannot read, head, list or delete the first one's objects", async () => {
      const s = await subject();
      const { a, b } = s.organizations;
      await s.store.put(a, "docs/plan.txt", bytes("a secret"));
      expect6(await s.store.get(b, "docs/plan.txt")).toBeUndefined();
      expect6(await s.store.head(b, "docs/plan.txt")).toBeUndefined();
      expect6(await keysOf(s, b)).toEqual([]);
      expect6(await keysOf(s, b, "docs/")).toEqual([]);
      await s.store.delete(b, "docs/plan.txt");
      expect6(text((await s.store.get(a, "docs/plan.txt"))?.body ?? new Uint8Array)).toBe("a secret");
    });
    test6("the same key in two Organizations holds two objects", async () => {
      const s = await subject();
      const { a, b } = s.organizations;
      await s.store.put(a, "same", bytes("from a"));
      await s.store.put(b, "same", bytes("from b"));
      expect6(text((await s.store.get(a, "same"))?.body ?? new Uint8Array)).toBe("from a");
      expect6(text((await s.store.get(b, "same"))?.body ?? new Uint8Array)).toBe("from b");
      await s.store.delete(a, "same");
      expect6(text((await s.store.get(b, "same"))?.body ?? new Uint8Array)).toBe("from b");
    });
    test6("an Organization whose id starts with another id is a different Organization", async () => {
      const s = await subject();
      const { a, aExtended } = s.organizations;
      await s.store.put(a, "one", bytes("a"));
      await s.store.put(aExtended, "two", bytes("extended"));
      expect6(await keysOf(s, a)).toEqual(["one"]);
      expect6(await keysOf(s, aExtended)).toEqual(["two"]);
      expect6(await s.store.get(a, "two")).toBeUndefined();
      expect6(await s.store.get(aExtended, "one")).toBeUndefined();
      await s.store.delete(a, "two");
      expect6(await keysOf(s, aExtended)).toEqual(["two"]);
    });
    test6("a key cannot name another Organization through a path", async () => {
      const s = await subject();
      const { a, b } = s.organizations;
      await s.store.put(b, "secret.txt", bytes("b only"));
      for (const key of [
        `../${b}/secret.txt`,
        `/${b}/secret.txt`,
        `${b}/../${b}/secret.txt`,
        `..%2f${b}%2fsecret.txt`
      ]) {
        await expect6(s.store.get(a, key)).rejects.toMatchObject({ code: "storage.invalid_request" });
        await expect6(s.store.delete(a, key)).rejects.toMatchObject({
          code: "storage.invalid_request"
        });
      }
      for (const prefix of ["../", `../${b}/`, "/", `${a}/../${b}/`, "%2e%2e/", "*", ".."]) {
        await expect6(s.store.list(a, { prefix })).rejects.toMatchObject({
          code: "storage.invalid_request"
        });
      }
      expect6(text((await s.store.get(b, "secret.txt"))?.body ?? new Uint8Array)).toBe("b only");
    });
    test6("a list is a page, in key order, that ends with no cursor", async () => {
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
        expect6(page.items.length).toBeLessThanOrEqual(2);
        seen.push(...page.items.map((item) => item.key));
        for (const item of page.items) {
          expect6(item.size).toBe(item.key.length);
          expect6(item.lastModified).toBeInstanceOf(Date);
        }
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== undefined && pages < 10);
      expect6(seen).toEqual(["a", "b/1", "b/2", "c", "d"]);
      expect6(pages).toBe(3);
    });
    test6("a list without a limit returns at most 100", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await Promise.all(Array.from({ length: 105 }, (_, i) => s.store.put(a, `n${String(i).padStart(3, "0")}`, bytes("x"))));
      const page = await s.store.list(a);
      expect6(page.items).toHaveLength(100);
      expect6(page.nextCursor).toBeDefined();
      const rest = await s.store.list(a, { cursor: page.nextCursor });
      expect6(rest.items).toHaveLength(5);
      expect6(rest.nextCursor).toBeUndefined();
    });
    test6("a prefix keeps only the keys that start with it", async () => {
      const s = await subject();
      const { a } = s.organizations;
      for (const key of ["docs/a.txt", "docs/b.txt", "docs2/c.txt", "other/d.txt", "docsx"]) {
        await s.store.put(a, key, bytes("x"));
      }
      expect6(await keysOf(s, a, "docs/")).toEqual(["docs/a.txt", "docs/b.txt"]);
      expect6(await keysOf(s, a, "docs/a")).toEqual(["docs/a.txt"]);
      expect6(await keysOf(s, a, "docs")).toEqual([
        "docs/a.txt",
        "docs/b.txt",
        "docs2/c.txt",
        "docsx"
      ]);
      expect6(await keysOf(s, a, "nothing/")).toEqual([]);
    });
    test6.each([[0], [-1], [1001], [1.5], [Number.NaN]])("a list limit of %p is refused", async (limit) => {
      const s = await subject();
      await expect6(s.store.list(s.organizations.a, { limit })).rejects.toMatchObject({
        code: "storage.invalid_request"
      });
    });
    test6("a forged cursor is refused", async () => {
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
        await expect6(s.store.list(a, { cursor })).rejects.toMatchObject({
          code: "storage.invalid_request"
        });
      }
    });
    test6("one Organization's cursor used by another lists only the second one's objects", async () => {
      const s = await subject();
      const { a, b } = s.organizations;
      for (const key of ["k1", "k2", "k3"]) {
        await s.store.put(a, key, bytes("a"));
      }
      await s.store.put(b, "k9", bytes("b"));
      const page = await s.store.list(a, { limit: 1 });
      const cursor = page.nextCursor;
      const other = await s.store.list(b, { cursor });
      expect6(other.items.map((item) => item.key)).toEqual(["k9"]);
    });
    test6("the body that get returns is a copy", async () => {
      const s = await subject();
      const { a } = s.organizations;
      const original = bytes("keep");
      await s.store.put(a, "k", original);
      original[0] = 0;
      const first = await s.store.get(a, "k");
      (first?.body)[1] = 0;
      expect6(text((await s.store.get(a, "k"))?.body ?? new Uint8Array)).toBe("keep");
    });
    describe6("streaming", () => {
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
      test6("a streamed object reads back the same, with its size and SHA-256", async () => {
        const s = await subject();
        const { a } = s.organizations;
        const data = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
        const result = await s.store.putStream(a, "rec/one.bin", chunksOf(data), {
          maxBytes: 5000,
          contentType: "audio/mpeg"
        });
        expect6(result).toEqual({ size: 1000, sha256: sha(data) });
        const got = await s.store.get(a, "rec/one.bin");
        expect6(Array.from(got?.body ?? [])).toEqual(Array.from(data));
        expect6(got?.contentType).toBe("audio/mpeg");
        const streamed = await s.store.getStream(a, "rec/one.bin");
        expect6(streamed?.size).toBe(1000);
        expect6(Array.from(await readAll(streamed.body))).toEqual(Array.from(data));
      });
      test6("a web stream and an empty stream are accepted", async () => {
        const s = await subject();
        const { a } = s.organizations;
        const web = new ReadableStream({
          start(controller) {
            controller.enqueue(bytes("hel"));
            controller.enqueue(bytes("lo"));
            controller.close();
          }
        });
        expect6((await s.store.putStream(a, "web", web, { maxBytes: 10 })).size).toBe(5);
        expect6(text((await s.store.get(a, "web"))?.body ?? new Uint8Array)).toBe("hello");
        const empty = await s.store.putStream(a, "empty", chunksOf(new Uint8Array), {
          maxBytes: 10
        });
        expect6(empty).toEqual({ size: 0, sha256: sha(new Uint8Array) });
        expect6((await s.store.head(a, "empty"))?.size).toBe(0);
      });
      test6("a stream over maxBytes is refused, leaves nothing readable and keeps an older object", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await s.store.put(a, "old", bytes("old"));
        await expect6(s.store.putStream(a, "new", chunksOf(new Uint8Array(100)), { maxBytes: 99 })).rejects.toMatchObject({ code: "storage.object_too_large" });
        await expect6(s.store.putStream(a, "old", chunksOf(new Uint8Array(100)), { maxBytes: 99 })).rejects.toMatchObject({ code: "storage.object_too_large" });
        expect6(await s.store.head(a, "new")).toBeUndefined();
        expect6(text((await s.store.get(a, "old"))?.body ?? new Uint8Array)).toBe("old");
        expect6((await s.store.putStream(a, "exact", chunksOf(new Uint8Array(99)), { maxBytes: 99 })).size).toBe(99);
      });
      test6("a stream that fails midway leaves nothing readable", async () => {
        const s = await subject();
        const { a } = s.organizations;
        async function* broken() {
          yield bytes("some");
          throw new Error("the client went away");
        }
        await expect6(s.store.putStream(a, "half", broken(), { maxBytes: 100 })).rejects.toMatchObject({ code: "storage.invalid_request" });
        expect6(await s.store.head(a, "half")).toBeUndefined();
      });
      test6("an aborted signal stops the write and leaves nothing readable", async () => {
        const s = await subject();
        const { a } = s.organizations;
        const controller = new AbortController;
        async function* slow() {
          yield bytes("first");
          controller.abort();
          yield bytes("second");
        }
        await expect6(s.store.putStream(a, "aborted", slow(), { maxBytes: 100, signal: controller.signal })).rejects.toMatchObject({ code: "storage.unavailable" });
        expect6(await s.store.head(a, "aborted")).toBeUndefined();
      });
      test6.each([[0], [-1], [1.5], [Number.NaN], [2 ** 31 + 1], ["5"]])("maxBytes %p is refused", async (maxBytes) => {
        const s = await subject();
        const { a } = s.organizations;
        await expect6(s.store.putStream(a, "k", chunksOf(bytes("x")), { maxBytes })).rejects.toMatchObject({ code: "storage.invalid_request" });
      });
      test6("a body that is not a stream, a bad key and a bad Organization are refused", async () => {
        const s = await subject();
        const { a } = s.organizations;
        const options = { maxBytes: 10 };
        await expect6(s.store.putStream(a, "k", "text", options)).rejects.toMatchObject({ code: "storage.invalid_request" });
        await expect6(s.store.putStream(a, "../k", chunksOf(bytes("x")), options)).rejects.toMatchObject({ code: "storage.invalid_request" });
        await expect6(s.store.putStream("bad/org", "k", chunksOf(bytes("x")), options)).rejects.toMatchObject({ code: "storage.invalid_request" });
      });
      test6("a second Organization cannot read the first one's streamed object", async () => {
        const s = await subject();
        const { a, b } = s.organizations;
        await s.store.putStream(a, "rec", chunksOf(bytes("private")), { maxBytes: 100 });
        expect6(await s.store.getStream(b, "rec")).toBeUndefined();
        expect6(await s.store.getStream(a, "missing")).toBeUndefined();
      });
    });
    describe6("presigned reads", () => {
      test6("a presigned URL returns the object, and a missing object gives nothing", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await s.store.put(a, "rec/one.mp3", bytes("the audio"));
        const url = await s.store.presignGet(a, "rec/one.mp3", { expiresInSeconds: 300 });
        const missing = await s.store.presignGet(a, "rec/none.mp3", { expiresInSeconds: 300 });
        expect6(typeof url).toBe("string");
        expect6(["http:", "https:"]).toContain(new URL(url).protocol);
        expect6(text(await s.readPresigned(url) ?? new Uint8Array)).toBe("the audio");
        expect6(await s.readPresigned(missing)).toBeUndefined();
      });
      test6("a second Organization's URL for the same key reaches only its own object", async () => {
        const s = await subject();
        const { a, b } = s.organizations;
        await s.store.put(a, "rec/one.mp3", bytes("first org"));
        const other = await s.store.presignGet(b, "rec/one.mp3", { expiresInSeconds: 300 });
        const mine = await s.store.presignGet(a, "rec/one.mp3", { expiresInSeconds: 300 });
        expect6(other).not.toBe(mine);
        expect6(await s.readPresigned(other)).toBeUndefined();
        await s.store.put(b, "rec/one.mp3", bytes("second org"));
        expect6(text(await s.readPresigned(other) ?? new Uint8Array)).toBe("second org");
        expect6(text(await s.readPresigned(mine) ?? new Uint8Array)).toBe("first org");
      });
      test6("the expiry is 1 to 900 seconds and defaults to 300", async () => {
        const s = await subject();
        const { a } = s.organizations;
        for (const expiresInSeconds of [1, 300, 900]) {
          expect6(typeof await s.store.presignGet(a, "k", { expiresInSeconds })).toBe("string");
        }
        expect6(typeof await s.store.presignGet(a, "k")).toBe("string");
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
          await expect6(s.store.presignGet(a, "k", { expiresInSeconds })).rejects.toMatchObject({ code: "storage.invalid_request" });
        }
      });
      test6("a bad key or Organization is refused, and the refusal does not repeat the key", async () => {
        const s = await subject();
        const { a } = s.organizations;
        for (const key of BAD_KEYS.slice(0, 6)) {
          await expect6(s.store.presignGet(a, key, { expiresInSeconds: 60 })).rejects.toMatchObject({
            code: "storage.invalid_request"
          });
        }
        await expect6(s.store.presignGet("bad/org", "k", { expiresInSeconds: 60 })).rejects.toMatchObject({ code: "storage.invalid_request" });
        try {
          await s.store.presignGet(a, "secret-name/../x", { expiresInSeconds: 60 });
        } catch (error) {
          expect6(String(error.message)).not.toContain("secret-name");
        }
      });
    });
  });
}
// src/streaming-transcribe/behaviour.ts
import { afterEach as afterEach7, describe as describe7, expect as expect7, test as test7 } from "bun:test";
import { callIdSchema } from "tula-closeline-contract";
var CHUNK = 3200;
var SECRET_TEXT = "zebra confidential pricing";
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
  const run = skip ? describe7.skip : describe7;
  run(`Streaming transcribe behaviour: ${name}`, () => {
    const made = [];
    const streams = [];
    afterEach7(async () => {
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
    test7("interims come before the final of a turn, with continuous word times", async () => {
      const s = await subject();
      s.hear(s.organizations.a, callId, "prospect", sayTwo, CHUNK);
      const { stream, turns } = await open(s);
      stream.sendAudio(audio(CHUNK));
      await until(() => turns().some((t) => t.isFinal), "the first final");
      stream.sendAudio(audio(CHUNK));
      await until(() => turns().filter((t) => t.isFinal).length === 2, "the second final");
      const all = turns();
      expect7(all.map((t) => t.sequence)).toEqual(all.map((_, i) => i + 1));
      for (const id of new Set(all.map((t) => t.turnId))) {
        const ofTurn = all.filter((t) => t.turnId === id);
        const final = ofTurn.at(-1);
        expect7(final?.isFinal).toBe(true);
        expect7(ofTurn.filter((t) => t.isFinal)).toHaveLength(1);
        expect7(ofTurn.length).toBeGreaterThan(1);
        for (const interim of ofTurn.slice(0, -1)) {
          expect7(interim.isFinal).toBe(false);
          expect7(interim.endOfTurn).toBe(false);
          expect7(final?.text.startsWith(interim.text)).toBe(true);
        }
      }
      let previousEnd = 0;
      for (const final of all.filter((t) => t.isFinal)) {
        expect7(final.words.map((w) => w.text).join(" ")).toBe(final.text);
        for (const word of final.words) {
          expect7(word.startMs).toBeGreaterThanOrEqual(previousEnd);
          expect7(word.endMs).toBeGreaterThanOrEqual(word.startMs);
          previousEnd = word.endMs;
        }
      }
    });
    test7("the end of turn is marked on the final only, and the next turn has a new id", async () => {
      const s = await subject();
      s.hear(s.organizations.a, callId, "prospect", sayTwo, CHUNK);
      const { stream, turns } = await open(s);
      stream.sendAudio(audio(CHUNK * 2));
      await until(() => turns().filter((t) => t.endOfTurn).length === 2, "two ends of turn");
      const all = turns();
      expect7(all.filter((t) => t.endOfTurn).every((t) => t.isFinal)).toBe(true);
      const ends = all.filter((t) => t.endOfTurn);
      expect7(ends[0]?.turnId).not.toBe(ends[1]?.turnId);
      expect7(all.at(-1)?.endOfTurn).toBe(true);
    });
    test7("a dropped stream reconnects and goes on, with word times continuing", async () => {
      const s = await subject();
      s.hear(s.organizations.a, callId, "prospect", sayTwo, CHUNK);
      const { stream, events, turns } = await open(s);
      stream.sendAudio(audio(CHUNK));
      await until(() => turns().some((t) => t.endOfTurn), "the first turn");
      const firstEnd = turns().find((t) => t.endOfTurn)?.words.at(-1)?.endMs ?? 0;
      s.failReconnects(1);
      await s.dropConnection(stream.streamId);
      const kinds = events.filter((e) => e.type !== "turn").map((e) => e.type);
      expect7(kinds).toEqual(["reconnecting", "reconnecting", "reconnected"]);
      const attempts = events.filter((e) => e.type === "reconnecting");
      expect7(attempts.map((e) => e.type === "reconnecting" ? e.attempt : 0)).toEqual([1, 2]);
      for (const attempt of attempts) {
        if (attempt.type === "reconnecting") {
          expect7(attempt.delayMs).toBeGreaterThanOrEqual(1);
          expect7(attempt.delayMs).toBeLessThanOrEqual(6);
        }
      }
      stream.sendAudio(audio(CHUNK));
      await until(() => turns().filter((t) => t.endOfTurn).length === 2, "the turn after");
      const second = turns().filter((t) => t.endOfTurn)[1];
      expect7(second?.words[0]?.startMs).toBeGreaterThanOrEqual(firstEnd);
      const sequences = turns().map((t) => t.sequence);
      expect7(sequences).toEqual(sequences.map((_, i) => i + 1));
    });
    test7("a stream that cannot be restored ends with one failed event and one metadata report", async () => {
      const s = await subject();
      s.hear(s.organizations.a, callId, "prospect", [{ text: SECRET_TEXT }], CHUNK);
      const { stream, events } = await open(s, { reconnect: { maxAttempts: 2, baseDelayMs: 1 } });
      s.failReconnects(10);
      await s.dropConnection(stream.streamId);
      const reconnecting = events.filter((e) => e.type === "reconnecting");
      expect7(reconnecting).toHaveLength(2);
      expect7(events.filter((e) => e.type === "reconnected")).toHaveLength(0);
      const last = events.at(-1);
      expect7(last).toMatchObject({
        type: "failed",
        code: "streaming_transcribe.unavailable",
        attempts: 2
      });
      expect7(events.filter((e) => e.type === "failed" || e.type === "closed")).toHaveLength(1);
      expect7(() => stream.sendAudio(audio(CHUNK))).toThrow(expect7.objectContaining({ code: "streaming_transcribe.closed" }));
      await stream.close();
      expect7(events.at(-1)?.type).toBe("failed");
      expect7(s.reporter.captured).toHaveLength(1);
      expect7(s.reporter.captured[0]?.error).toMatchObject({
        code: "streaming_transcribe.unavailable"
      });
      expect7(s.reporter.captured[0]?.context.organizationId).toBe(s.organizations.a);
    });
    test7("a drop with no attempts allowed fails at once", async () => {
      const s = await subject();
      const { stream, events } = await open(s, { reconnect: { maxAttempts: 0 } });
      await s.dropConnection(stream.streamId);
      expect7(events.map((e) => e.type)).toEqual(["failed"]);
    });
    test7("closing ends the events, is idempotent and frees the Call and track", async () => {
      const s = await subject();
      s.hear(s.organizations.a, callId, "prospect", sayTwo, CHUNK);
      const { stream, events } = await open(s);
      await stream.close();
      await stream.close();
      expect7(events.filter((e) => e.type === "closed")).toHaveLength(1);
      expect7(events.at(-1)?.type).toBe("closed");
      expect7(() => stream.sendAudio(audio(CHUNK))).toThrow(expect7.objectContaining({ code: "streaming_transcribe.closed" }));
      const count = events.length;
      await s.dropConnection(stream.streamId);
      expect7(events).toHaveLength(count);
      const again = await open(s);
      await again.stream.close();
    });
    test7("closing during a reconnect stops it and ends with closed", async () => {
      const s = await subject();
      const { stream, events } = await open(s, {
        reconnect: { maxAttempts: 5, baseDelayMs: 20, maxDelayMs: 20 }
      });
      s.failReconnects(10);
      const dropping = s.dropConnection(stream.streamId);
      await until(() => events.some((e) => e.type === "reconnecting"), "a reconnect attempt");
      await stream.close();
      await dropping;
      expect7(events.at(-1)?.type).toBe("closed");
      expect7(events.some((e) => e.type === "failed")).toBe(false);
    });
    test7("one live stream per Call and track; another track or Organization is separate", async () => {
      const s = await subject();
      const first = await open(s);
      await expect7(open(s)).rejects.toMatchObject({ code: "streaming_transcribe.conflict" });
      const rep = await open(s, { track: "rep" });
      const other = await open(s, { organizationId: s.organizations.b });
      s.hear(s.organizations.b, callId, "prospect", [{ text: "only for the other org" }], CHUNK);
      expect7(first.events).toHaveLength(0);
      expect7(rep.events).toHaveLength(0);
      expect7(other.events).toHaveLength(0);
    });
    test7("a stream hears only what was arranged for its own Organization", async () => {
      const s = await subject();
      s.hear(s.organizations.a, otherCallId, "prospect", sayTwo, CHUNK);
      const b = await open(s, { organizationId: s.organizations.b, callId: otherCallId });
      b.stream.sendAudio(audio(CHUNK * 2));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect7(b.turns()).toHaveLength(0);
    });
    test7("refuses a bad request or chunk before talking to the vendor", async () => {
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
        await expect7(open(s, override)).rejects.toMatchObject({ code: "streaming_transcribe.invalid_request" });
      }
      await expect7(s.port.open({
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
        expect7(() => stream.sendAudio(chunk)).toThrow(expect7.objectContaining({ code: "streaming_transcribe.invalid_request" }));
      }
    });
    test7("a throwing listener does not stop the stream", async () => {
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
          throw new Error(SECRET_TEXT);
        }
      });
      streams.push(stream);
      stream.sendAudio(audio(CHUNK * 2));
      await until(() => seen >= 2, "events to a throwing listener");
      expect7(s.logs().join(`
`)).not.toContain(SECRET_TEXT);
    });
    test7("no audio and no transcript text reaches a log or the error reporter", async () => {
      const s = await subject();
      s.hear(s.organizations.a, callId, "prospect", [{ text: SECRET_TEXT }], CHUNK);
      const { stream, turns } = await open(s, { reconnect: { maxAttempts: 1, baseDelayMs: 1 } });
      stream.sendAudio(audio(CHUNK));
      await until(() => turns().some((t) => t.endOfTurn), "the turn");
      s.failReconnects(10);
      await s.dropConnection(stream.streamId);
      expect7(s.reporter.captured).toHaveLength(1);
      const seen = [
        ...s.logs(),
        JSON.stringify(s.reporter.captured, (_key, value) => value instanceof Error ? { ...value, name: value.name, message: value.message, stack: value.stack } : value)
      ].join(`
`);
      for (const secret of [SECRET_TEXT, "confidential", "zebra", AUDIO_MARKER]) {
        expect7(seen).not.toContain(secret);
      }
      const reported = s.reporter.captured[0];
      const tags = reported?.context.tags ?? {};
      expect7(Object.keys(reported?.context ?? {}).sort()).toEqual(["organizationId", "tags"]);
      expect7(Object.keys(tags).sort()).toEqual(["feature", "track"]);
    });
  });
}
// src/telephony/behaviour.ts
import { afterEach as afterEach8, describe as describe8, expect as expect8, test as test8 } from "bun:test";
import {
  callIdSchema as callIdSchema2,
  membershipIdSchema,
  softphoneTokenSchema
} from "tula-closeline-contract";
function telephonyBehaviour(name, make, skip = false) {
  const run = skip ? describe8.skip : describe8;
  run(`Telephony behaviour: ${name}`, () => {
    const open = [];
    afterEach8(async () => {
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
    describe8("placing a call", () => {
      test8("a Prospect who answers: the call rings, then is answered", async () => {
        const s = await subject();
        const placed = await place(s);
        expect8(placed.created).toBe(true);
        expect8(placed.providerCallId.length).toBeGreaterThan(0);
        expect8((await s.takeEvents()).map((e) => e.type)).toEqual(["ringing", "answered"]);
      });
      test8("the same idempotency key places exactly one call", async () => {
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
        expect8(second).toEqual({ providerCallId: first.providerCallId, created: false });
        expect8((await s.takeEvents()).filter((e) => e.type === "ringing")).toHaveLength(1);
      });
      test8("the same key for another number is refused", async () => {
        const s = await subject();
        const idempotencyKey = key();
        const base = { organizationId: s.organizations.a, callId, idempotencyKey, from: line };
        await s.telephony.placeCall({ ...base, to: s.numberFor("answers") });
        await expect8(s.telephony.placeCall({ ...base, to: s.numberFor("busy") })).rejects.toMatchObject(code("telephony.invalid_request"));
      });
      test8("the same key in another Organization is a different call", async () => {
        const s = await subject();
        const base = { callId, idempotencyKey: key(), from: line, to: s.numberFor("answers") };
        const a = await s.telephony.placeCall({ ...base, organizationId: s.organizations.a });
        const b = await s.telephony.placeCall({ ...base, organizationId: s.organizations.b });
        expect8(b.created).toBe(true);
        expect8(b.providerCallId).not.toBe(a.providerCallId);
      });
      test8.each([
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
        await expect8(s.telephony.placeCall(request)).rejects.toMatchObject(code("telephony.invalid_request"));
        expect8(await s.takeEvents()).toHaveLength(0);
      });
      test8("a Prospect who does not answer: no_answer", async () => {
        const s = await subject();
        await place(s, "no_answer");
        const events = await s.takeEvents();
        expect8(events.map((e) => e.type)).toEqual(["ringing", "no_answer"]);
        expect8(events[1]).toMatchObject({ failureReason: "no_answer" });
      });
      test8("a busy Prospect: busy", async () => {
        const s = await subject();
        await place(s, "busy");
        expect8((await s.takeEvents()).at(-1)).toMatchObject({ type: "busy", failureReason: "busy" });
      });
      test8("a carrier failure: failed with a contract reason, and the call is over", async () => {
        const s = await subject();
        const placed = await place(s, "carrier_failure");
        const last = (await s.takeEvents()).at(-1);
        expect8(last?.type).toBe("failed");
        expect8(["carrier_dropped", "carrier_rejected", "provider_error"]).toContain(last?.failureReason);
        await expect8(s.telephony.playDisclosure({ ...placed.ref, ...wording })).rejects.toMatchObject(code("telephony.call_ended"));
      });
      test8("events carry no number and no text", async () => {
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
        expect8(text).not.toContain(to);
        expect8(text).not.toContain(line);
      });
    });
    describe8("answering an inbound call", () => {
      test8("answers it and rings the browser legs", async () => {
        const s = await subject();
        const providerCallId = await s.receiveInbound(s.organizations.a);
        const answered = await s.telephony.answerCall({
          organizationId: s.organizations.a,
          providerCallId,
          callId,
          ringIdentities: [rep, otherRep]
        });
        expect8(answered).toEqual({ ringing: 2 });
        expect8((await s.takeEvents()).map((e) => e.type)).toContain("answered");
      });
      test8("answering again changes nothing", async () => {
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
        expect8(await s.telephony.answerCall(request)).toEqual({ ringing: 1 });
        expect8(await s.takeEvents()).toHaveLength(0);
      });
      test8("another Organization cannot answer it", async () => {
        const s = await subject();
        const providerCallId = await s.receiveInbound(s.organizations.a);
        await expect8(s.telephony.answerCall({
          organizationId: s.organizations.b,
          providerCallId,
          callId,
          ringIdentities: [rep]
        })).rejects.toMatchObject(code("telephony.not_found"));
      });
      test8.each([
        ["no legs", []],
        ["a bad identity", ["mem_1"]]
      ])("%s is refused", async (_label, ringIdentities) => {
        const s = await subject();
        const providerCallId = await s.receiveInbound(s.organizations.a);
        await expect8(s.telephony.answerCall({
          organizationId: s.organizations.a,
          providerCallId,
          callId,
          ringIdentities
        })).rejects.toMatchObject(code("telephony.invalid_request"));
      });
      test8("a call nobody answered cannot play the Disclosure yet", async () => {
        const s = await subject();
        const providerCallId = await s.receiveInbound(s.organizations.a);
        await expect8(s.telephony.playDisclosure({
          organizationId: s.organizations.a,
          providerCallId,
          ...wording
        })).rejects.toMatchObject(code("telephony.invalid_request"));
      });
    });
    describe8("the Disclosure", () => {
      test8("plays, and reports its wording version, whether it names an AI, and when", async () => {
        const s = await subject();
        const placed = await place(s);
        const played = await s.telephony.playDisclosure({
          ...placed.ref,
          ...wording,
          aiAssisted: true
        });
        expect8(played).toMatchObject({ wordingVersion: 1, aiAssisted: true });
        expect8(Number.isNaN(Date.parse(played.playedAt))).toBe(false);
      });
      test8("playing the same version again reports it and does not replay it", async () => {
        const s = await subject();
        const placed = await place(s);
        const first = await s.telephony.playDisclosure({ ...placed.ref, ...wording });
        const again = await s.telephony.playDisclosure({ ...placed.ref, ...wording });
        expect8(again).toEqual(first);
      });
      test8.each([
        ["an empty text", { text: "   " }],
        ["a control character", { text: "bad\x00text" }],
        ["a text over 1000 characters", { text: "x".repeat(1001) }],
        ["version 0", { wordingVersion: 0 }],
        ["a fractional version", { wordingVersion: 1.5 }],
        ["no aiAssisted flag", { aiAssisted: undefined }]
      ])("%s is refused", async (_label, bad) => {
        const s = await subject();
        const placed = await place(s);
        await expect8(s.telephony.playDisclosure({ ...placed.ref, ...wording, ...bad })).rejects.toMatchObject(code("telephony.invalid_request"));
      });
      test8("a Prospect who hangs up during it: call_ended, nothing is bridged", async () => {
        const s = await subject();
        const placed = await place(s, "hangs_up_during_disclosure");
        await expect8(s.telephony.playDisclosure({ ...placed.ref, ...wording })).rejects.toMatchObject(code("telephony.call_ended"));
        expect8((await s.takeEvents()).at(-1)).toMatchObject({
          type: "completed",
          endedBy: "prospect"
        });
        await expect8(s.telephony.bridge({ ...placed.ref, repIdentity: rep })).rejects.toMatchObject(code("telephony.call_ended"));
      });
      test8("a later wording version replaces the earlier one, including whether it names an AI", async () => {
        const s = await subject();
        const placed = await place(s);
        await s.telephony.playDisclosure({ ...placed.ref, ...wording, aiAssisted: true });
        const second = await s.telephony.playDisclosure({
          ...placed.ref,
          ...wording,
          wordingVersion: 2,
          aiAssisted: false
        });
        expect8(second).toMatchObject({ wordingVersion: 2, aiAssisted: false });
        await expect8(s.telephony.forkTracks({ ...placed.ref, destinationUrl: "wss://copilot.example.test/s" })).rejects.toMatchObject(code("telephony.disclosure_required"));
      });
      test8("another Organization cannot play it on this call", async () => {
        const s = await subject();
        const placed = await place(s);
        await expect8(s.telephony.playDisclosure({
          organizationId: s.organizations.b,
          providerCallId: placed.providerCallId,
          ...wording
        })).rejects.toMatchObject(code("telephony.not_found"));
      });
    });
    describe8("nothing happens before the Disclosure", () => {
      test8("bridging a Rep is refused", async () => {
        const s = await subject();
        const placed = await place(s);
        await expect8(s.telephony.bridge({ ...placed.ref, repIdentity: rep })).rejects.toMatchObject(code("telephony.disclosure_required"));
      });
      test8("recording is refused", async () => {
        const s = await subject();
        const placed = await place(s);
        await expect8(s.telephony.startRecording(placed.ref)).rejects.toMatchObject(code("telephony.disclosure_required"));
      });
      test8("forking the tracks is refused", async () => {
        const s = await subject();
        const placed = await place(s);
        await expect8(s.telephony.forkTracks({ ...placed.ref, destinationUrl: "wss://copilot.example.test/s" })).rejects.toMatchObject(code("telephony.disclosure_required"));
      });
      test8("forking the tracks needs a Disclosure that named an AI", async () => {
        const s = await subject();
        const placed = await disclosed(s, false);
        await expect8(s.telephony.forkTracks({ ...placed.ref, destinationUrl: "wss://copilot.example.test/s" })).rejects.toMatchObject(code("telephony.disclosure_required"));
      });
      test8("a failed Disclosure leaves the call unbridged and unrecorded", async () => {
        const s = await subject();
        const placed = await place(s);
        s.failNext("playDisclosure");
        await expect8(s.telephony.playDisclosure({ ...placed.ref, ...wording })).rejects.toMatchObject(code("telephony.unavailable"));
        await expect8(s.telephony.bridge({ ...placed.ref, repIdentity: rep })).rejects.toMatchObject(code("telephony.disclosure_required"));
        await expect8(s.telephony.startRecording(placed.ref)).rejects.toMatchObject(code("telephony.disclosure_required"));
      });
    });
    describe8("bridging", () => {
      test8("joins a Rep after the Disclosure, and again is a no-op", async () => {
        const s = await subject();
        const placed = await disclosed(s);
        await s.telephony.bridge({ ...placed.ref, repIdentity: rep });
        await s.telephony.bridge({ ...placed.ref, repIdentity: rep });
      });
      test8("moves the call to another Rep", async () => {
        const s = await subject();
        const placed = await disclosed(s);
        await s.telephony.bridge({ ...placed.ref, repIdentity: rep });
        await s.telephony.bridge({ ...placed.ref, repIdentity: otherRep });
      });
      test8("a bad identity is refused", async () => {
        const s = await subject();
        const placed = await disclosed(s);
        await expect8(s.telephony.bridge({ ...placed.ref, repIdentity: "mem_1" })).rejects.toMatchObject(code("telephony.invalid_request"));
      });
      test8("a Prospect who hangs up after the Rep is bridged ends the call", async () => {
        const s = await subject();
        const placed = await disclosed(s);
        await s.telephony.bridge({ ...placed.ref, repIdentity: rep });
        await s.takeEvents();
        await s.prospectHangsUp(placed.ref.organizationId, placed.providerCallId);
        expect8((await s.takeEvents()).find((e) => e.type === "completed")).toMatchObject({
          endedBy: "prospect"
        });
        await expect8(s.telephony.bridge({ ...placed.ref, repIdentity: otherRep })).rejects.toMatchObject(code("telephony.call_ended"));
      });
    });
    describe8("recording", () => {
      test8("is dual-channel and starting it again returns the first Recording", async () => {
        const s = await subject();
        const placed = await disclosed(s);
        const first = await s.telephony.startRecording(placed.ref);
        expect8(first.channels).toBe(2);
        expect8(await s.telephony.startRecording(placed.ref)).toEqual(first);
      });
      test8("cannot be fetched while the call is up", async () => {
        const s = await subject();
        const placed = await disclosed(s);
        const started = await s.telephony.startRecording(placed.ref);
        await expect8(s.telephony.fetchRecording({
          organizationId: placed.ref.organizationId,
          recordingId: started.recordingId
        })).rejects.toMatchObject(code("telephony.recording_not_ready"));
      });
      test8("can be fetched after the call: two channels, a type and bytes", async () => {
        const s = await subject();
        const placed = await disclosed(s);
        const started = await s.telephony.startRecording(placed.ref);
        await s.telephony.hangUp({ ...placed.ref, by: "rep" });
        expect8((await s.takeEvents()).at(-1)).toMatchObject({
          type: "recording_ready",
          recordingId: started.recordingId
        });
        const fetched = await s.telephony.fetchRecording({
          organizationId: placed.ref.organizationId,
          recordingId: started.recordingId
        });
        expect8(fetched.channels).toBe(2);
        expect8(fetched.contentType).toMatch(/^audio\//);
        let bytes = 0;
        for await (const chunk of fetched.body) {
          bytes += chunk.length;
        }
        expect8(bytes).toBeGreaterThan(0);
        if (fetched.sizeBytes !== null) {
          expect8(fetched.sizeBytes).toBe(bytes);
        }
      });
      test8("a recording started before the call ended can be fetched when the Prospect hangs up", async () => {
        const s = await subject();
        const placed = await disclosed(s);
        const started = await s.telephony.startRecording(placed.ref);
        await s.prospectHangsUp(placed.ref.organizationId, placed.providerCallId);
        const fetched = await s.telephony.fetchRecording({
          organizationId: placed.ref.organizationId,
          recordingId: started.recordingId
        });
        await fetched.body[Symbol.asyncIterator]?.().return?.();
        expect8(fetched.channels).toBe(2);
      });
      test8("deleting removes the provider copy; deleting again and an unknown id say it did not exist", async () => {
        const s = await subject();
        const placed = await disclosed(s);
        const started = await s.telephony.startRecording(placed.ref);
        await s.telephony.hangUp(placed.ref);
        const ref = { organizationId: placed.ref.organizationId, recordingId: started.recordingId };
        expect8(await s.telephony.deleteRecording(ref)).toEqual({ existed: true });
        expect8(await s.telephony.deleteRecording(ref)).toEqual({ existed: false });
        expect8(await s.telephony.deleteRecording({ ...ref, recordingId: "never-issued" })).toEqual({
          existed: false
        });
        await expect8(s.telephony.fetchRecording(ref)).rejects.toMatchObject(code("telephony.not_found"));
      });
      test8("another Organization can neither fetch nor delete it", async () => {
        const s = await subject();
        const placed = await disclosed(s);
        const started = await s.telephony.startRecording(placed.ref);
        await s.telephony.hangUp(placed.ref);
        const theirs = { organizationId: s.organizations.b, recordingId: started.recordingId };
        await expect8(s.telephony.fetchRecording(theirs)).rejects.toMatchObject(code("telephony.not_found"));
        expect8(await s.telephony.deleteRecording(theirs)).toEqual({ existed: false });
        const mine = { organizationId: s.organizations.a, recordingId: started.recordingId };
        const fetched = await s.telephony.fetchRecording(mine);
        expect8(fetched.channels).toBe(2);
      });
      test8("a bad recording id is refused", async () => {
        const s = await subject();
        await expect8(s.telephony.fetchRecording({ organizationId: s.organizations.a, recordingId: "../x" })).rejects.toMatchObject(code("telephony.invalid_request"));
      });
    });
    describe8("forking the tracks", () => {
      test8("sends the Rep and the Prospect apart once an AI-naming Disclosure played; again returns the first", async () => {
        const s = await subject();
        const placed = await disclosed(s, true);
        const request = { ...placed.ref, destinationUrl: "wss://copilot.example.test/s" };
        const first = await s.telephony.forkTracks(request);
        expect8(first.tracks).toEqual(["rep", "prospect"]);
        expect8(await s.telephony.forkTracks(request)).toEqual(first);
      });
      test8.each([
        ["a plain http URL", "http://copilot.example.test/s"],
        ["a URL with credentials", "wss://user:pw@copilot.example.test/s"],
        ["not a URL", "copilot"],
        ["an empty string", ""]
      ])("%s is refused", async (_label, destinationUrl) => {
        const s = await subject();
        const placed = await disclosed(s, true);
        await expect8(s.telephony.forkTracks({ ...placed.ref, destinationUrl })).rejects.toMatchObject(code("telephony.invalid_request"));
      });
    });
    describe8("hanging up", () => {
      test8("ends the call with who ended it, and again is a no-op", async () => {
        const s = await subject();
        const placed = await place(s);
        await s.takeEvents();
        await s.telephony.hangUp({ ...placed.ref, by: "rep" });
        expect8(await s.takeEvents()).toMatchObject([{ type: "completed", endedBy: "rep" }]);
        await s.telephony.hangUp(placed.ref);
        expect8(await s.takeEvents()).toHaveLength(0);
      });
      test8("another Organization cannot hang it up", async () => {
        const s = await subject();
        const placed = await place(s);
        await expect8(s.telephony.hangUp({
          organizationId: s.organizations.b,
          providerCallId: placed.providerCallId
        })).rejects.toMatchObject(code("telephony.not_found"));
      });
      test8("an unknown call is not found", async () => {
        const s = await subject();
        await expect8(s.telephony.hangUp({ organizationId: s.organizations.a, providerCallId: "unknown" })).rejects.toMatchObject(code("telephony.not_found"));
      });
      test8("nothing can be played, bridged, recorded or forked on an ended call", async () => {
        const s = await subject();
        const placed = await place(s);
        await s.telephony.hangUp(placed.ref);
        await expect8(s.telephony.playDisclosure({ ...placed.ref, ...wording })).rejects.toMatchObject(code("telephony.call_ended"));
        await expect8(s.telephony.bridge({ ...placed.ref, repIdentity: rep })).rejects.toMatchObject(code("telephony.call_ended"));
        await expect8(s.telephony.startRecording(placed.ref)).rejects.toMatchObject(code("telephony.call_ended"));
      });
    });
    describe8("verifying a webhook", () => {
      async function webhook() {
        const s = await subject();
        const placed = await place(s);
        const event = (await s.takeEvents())[0];
        return { s, placed, event, hook: s.signedWebhook(event) };
      }
      test8("a genuine webhook verifies", async () => {
        const { s, hook } = await webhook();
        expect8(s.telephony.verifyWebhook(hook)).toBe(true);
      });
      test8("a wrong signature of the right length is refused", async () => {
        const { s, hook } = await webhook();
        const flipped = (hook.signature[0] === "A" ? "B" : "A") + hook.signature.slice(1);
        expect8(flipped).toHaveLength(hook.signature.length);
        expect8(s.telephony.verifyWebhook({ ...hook, signature: flipped })).toBe(false);
      });
      test8("a signature of the wrong length is refused", async () => {
        const { s, hook } = await webhook();
        expect8(s.telephony.verifyWebhook({ ...hook, signature: hook.signature.slice(0, -1) })).toBe(false);
        expect8(s.telephony.verifyWebhook({ ...hook, signature: `${hook.signature}A` })).toBe(false);
        expect8(s.telephony.verifyWebhook({ ...hook, signature: "x" })).toBe(false);
      });
      test8.each([
        ["undefined", undefined],
        ["null", null],
        ["empty", ""]
      ])("a %s signature is refused", async (_label, signature) => {
        const { s, hook } = await webhook();
        expect8(s.telephony.verifyWebhook({ ...hook, signature })).toBe(false);
      });
      test8("a signature that fits another body or another URL is refused", async () => {
        const { s, hook } = await webhook();
        expect8(s.telephony.verifyWebhook({ ...hook, body: `${hook.body} ` })).toBe(false);
        expect8(s.telephony.verifyWebhook({ ...hook, url: `${hook.url}?x=1` })).toBe(false);
      });
      test8("a body over the limit is refused without throwing", async () => {
        const { s, hook } = await webhook();
        const body = "x".repeat(MAX_WEBHOOK_BODY_BYTES2 + 1);
        expect8(s.telephony.verifyWebhook({ ...hook, body })).toBe(false);
      });
      test8("garbage in any field is refused, never thrown", async () => {
        const { s } = await webhook();
        for (const bad of [null, undefined, 1, "x", {}, { url: 1, body: 2, signature: 3 }]) {
          expect8(s.telephony.verifyWebhook(bad)).toBe(false);
        }
      });
    });
    describe8("the browser token", () => {
      test8("is a SoftphoneToken for the Rep that expires within the hour", async () => {
        const s = await subject();
        const before = Date.now();
        const token = await s.telephony.mintBrowserToken({
          organizationId: s.organizations.a,
          identity: rep,
          ttlSeconds: 120
        });
        expect8(softphoneTokenSchema.safeParse(token).success).toBe(true);
        expect8(token).toMatchObject({ identity: rep, ttlSeconds: 120 });
        expect8(Date.parse(token.expiresAt)).toBeGreaterThan(before);
        expect8(Date.parse(token.expiresAt)).toBeLessThanOrEqual(Date.now() + 120000 + 1000);
      });
      test8("defaults to a short life and each token is different", async () => {
        const s = await subject();
        const request = { organizationId: s.organizations.a, identity: rep };
        const one = await s.telephony.mintBrowserToken(request);
        const two = await s.telephony.mintBrowserToken(request);
        expect8(one.ttlSeconds).toBeGreaterThanOrEqual(60);
        expect8(one.ttlSeconds).toBeLessThanOrEqual(3600);
        expect8(one.token).not.toBe(two.token);
      });
      test8.each([[59], [3601], [1.5], [Number.NaN]])("a life of %p seconds is refused", async (ttl) => {
        const s = await subject();
        await expect8(s.telephony.mintBrowserToken({
          organizationId: s.organizations.a,
          identity: rep,
          ttlSeconds: ttl
        })).rejects.toMatchObject(code("telephony.invalid_request"));
      });
      test8("the token does not hold the Organization id or the Rep id in clear", async () => {
        const s = await subject();
        const token = await s.telephony.mintBrowserToken({
          organizationId: s.organizations.a,
          identity: rep
        });
        expect8(token.token).not.toContain(s.organizations.a);
        expect8(token.token).not.toContain(rep);
      });
    });
    describe8("timeouts and a failing provider", () => {
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
      test8.each(operations)("%s gives up when the provider does not answer in time", async (operation) => {
        const s = await subject();
        const ctx = await steps[operation].ready(s);
        s.stallNext(operation);
        const started = Date.now();
        await expect8(steps[operation].call(s, ctx)).rejects.toMatchObject(code("telephony.unavailable"));
        const elapsed = Date.now() - started;
        expect8(elapsed).toBeGreaterThanOrEqual(TIMEOUT - 10);
        expect8(elapsed).toBeLessThan(5000);
      });
      test8.each(operations)("%s reports a failing provider as unavailable", async (operation) => {
        const s = await subject();
        const ctx = await steps[operation].ready(s);
        s.failNext(operation);
        await expect8(steps[operation].call(s, ctx)).rejects.toMatchObject(code("telephony.unavailable"));
      });
      test8.each(operations)("%s works again once the provider recovers", async (operation) => {
        const s = await subject();
        const ctx = await steps[operation].ready(s);
        s.failNext(operation);
        await expect8(steps[operation].call(s, ctx)).rejects.toBeDefined();
        await steps[operation].call(s, ctx);
      });
      test8("a placeCall that timed out placed nothing: the same key places the call", async () => {
        const s = await subject();
        const request = {
          organizationId: s.organizations.a,
          callId,
          idempotencyKey: key(),
          from: line,
          to: s.numberFor("answers")
        };
        s.stallNext("placeCall");
        await expect8(s.telephony.placeCall(request, { timeoutMs: TIMEOUT })).rejects.toMatchObject(code("telephony.unavailable"));
        expect8(await s.takeEvents()).toHaveLength(0);
        expect8((await s.telephony.placeCall(request)).created).toBe(true);
      });
      test8("a hangUp that timed out left the call up", async () => {
        const s = await subject();
        const placed = await disclosed(s);
        s.stallNext("hangUp");
        await expect8(s.telephony.hangUp(placed.ref, { timeoutMs: TIMEOUT })).rejects.toBeDefined();
        await s.telephony.bridge({ ...placed.ref, repIdentity: rep });
      });
      test8.each([[0], [-1], [1.5], [60001], [Number.NaN]])("a timeout of %p ms is refused", async (timeoutMs) => {
        const s = await subject();
        await expect8(s.telephony.mintBrowserToken({ organizationId: s.organizations.a, identity: rep }, { timeoutMs })).rejects.toMatchObject(code("telephony.invalid_request"));
      });
    });
  });
}
// src/transcribe/behaviour.ts
import { afterEach as afterEach9, describe as describe9, expect as expect9, test as test9 } from "bun:test";
function transcriberBehaviour(name, make, skip = false) {
  const run = skip ? describe9.skip : describe9;
  run(`Transcriber behaviour: ${name}`, () => {
    const open = [];
    afterEach9(async () => {
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
      expect9(result?.status === "done" || result?.status === "failed").toBe(true);
      return result;
    }
    async function finalResultWith(s, org, reference, vendorId) {
      const result = await waitForTranscription2(s.transcriber, org, reference, {
        maxAttempts: 120,
        intervalMs: s.pollIntervalMs ?? 0,
        vendorId
      });
      expect9(result?.status === "done" || result?.status === "failed").toBe(true);
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
    test9("a send is created once and repeating it creates nothing", async () => {
      const s = await subject();
      const { a } = s.organizations;
      const first = await s.transcriber.submit(a, send("call_1:1"));
      const again = await s.transcriber.submit(a, send("call_1:1"));
      expect9(first).toMatchObject({ clientReference: "call_1:1", created: true });
      expect9(again).toMatchObject({ clientReference: "call_1:1", created: false });
      expect9(await references(s, a)).toEqual(["call_1:1"]);
    });
    test9("the same reference with another mode, speaker cap or audio key is a conflict", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.transcriber.submit(a, send("call_1:1", { maxSpeakers: 2, audioKey: "rec/1:abc" }));
      const conflict = { code: "transcriber.conflict" };
      await expect9(s.transcriber.submit(a, send("call_1:1", { speakers: "split_channels", audioKey: "rec/1:abc" }))).rejects.toMatchObject(conflict);
      await expect9(s.transcriber.submit(a, send("call_1:1", { maxSpeakers: 3, audioKey: "rec/1:abc" }))).rejects.toMatchObject(conflict);
      await expect9(s.transcriber.submit(a, send("call_1:1", { maxSpeakers: 2, audioKey: "rec/2:def" }))).rejects.toMatchObject(conflict);
      expect9(await references(s, a)).toEqual(["call_1:1"]);
    });
    test9("a retry with a freshly presigned URL is the same send, not a conflict", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.transcriber.submit(a, send("call_1:1", { audioKey: "rec/1:abc" }));
      const again = await s.transcriber.submit(a, send("call_1:1", {
        audio: { url: "https://audio.example.test/call_1.mp3?sig=NEWSIGNATURE&expires=2" },
        audioKey: "rec/1:abc"
      }));
      expect9(again.created).toBe(false);
      expect9(await references(s, a)).toEqual(["call_1:1"]);
    });
    test9("a result is pending at first or final, and a final one passes the shared result check", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.transcriber.submit(a, send("call_1:1", { maxSpeakers: 2 }));
      const first = await s.transcriber.getResult(a, "call_1:1");
      expect9(["pending", "done", "failed"]).toContain(first?.status);
      const final = await finalResult(s, a, "call_1:1");
      checkTranscriptionResult2(final, { speakers: "diarize", maxSpeakers: 2 });
      expect9(checkTranscriptionResult2(await s.transcriber.getResult(a, "call_1:1"))).toEqual(final);
    });
    test9("a split-channels result carries the channel of every turn", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.transcriber.submit(a, send("call_1:2", { speakers: "split_channels" }));
      const final = await finalResult(s, a, "call_1:2");
      checkTranscriptionResult2(final, { speakers: "split_channels" });
    });
    test9("a send that was never made, or was deleted, has no result", async () => {
      const s = await subject();
      const { a } = s.organizations;
      expect9(await s.transcriber.getResult(a, "nope")).toBeUndefined();
      await s.transcriber.submit(a, send("call_1:1"));
      await s.transcriber.delete(a, "call_1:1");
      expect9(await s.transcriber.getResult(a, "call_1:1")).toBeUndefined();
    });
    test9("delete reports whether a copy existed and can be repeated", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.transcriber.submit(a, send("call_1:1"));
      expect9(await s.transcriber.delete(a, "call_1:1")).toEqual({ existed: true });
      expect9(await s.transcriber.delete(a, "call_1:1")).toEqual({ existed: false });
      expect9(await s.transcriber.delete(a, "never_sent:1")).toEqual({ existed: false });
      expect9(await references(s, a)).toEqual([]);
    });
    test9("a deleted reference can be sent again as a new send", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.transcriber.submit(a, send("call_1:1"));
      await s.transcriber.delete(a, "call_1:1");
      expect9((await s.transcriber.submit(a, send("call_1:1"))).created).toBe(true);
    });
    test9("list finds sends by reference prefix, in order, in pages", async () => {
      const s = await subject();
      const { a } = s.organizations;
      for (const reference of ["call_2:1", "call_1:2", "call_1:1", "call_1:3", "other"]) {
        await s.transcriber.submit(a, send(reference));
      }
      expect9(await references(s, a, "call_1:")).toEqual(["call_1:1", "call_1:2", "call_1:3"]);
      expect9(await references(s, a)).toEqual([
        "call_1:1",
        "call_1:2",
        "call_1:3",
        "call_2:1",
        "other"
      ]);
      const first = await s.transcriber.list(a, { prefix: "call_1:", limit: 2 });
      expect9(first.items).toHaveLength(2);
      expect9(first.nextCursor).toBeDefined();
      expect9(["pending", "done", "failed"]).toContain(first.items[0]?.status);
      const seen = first.items.map((item) => item.clientReference);
      let cursor = first.nextCursor;
      for (let pages = 0;cursor !== undefined && pages < 20; pages++) {
        const next = await s.transcriber.list(a, { prefix: "call_1:", limit: 2, cursor });
        seen.push(...next.items.map((item) => item.clientReference));
        cursor = next.nextCursor;
      }
      expect9(seen).toEqual(["call_1:1", "call_1:2", "call_1:3"]);
    });
    describe9("the vendor id", () => {
      test9("submit returns an opaque bounded id, the same one when the send is repeated", async () => {
        const s = await subject();
        const { a } = s.organizations;
        const first = await s.transcriber.submit(a, send("call_1:1"));
        const again = await s.transcriber.submit(a, send("call_1:1"));
        expect9(first.vendorId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
        expect9(again.vendorId).toBe(first.vendorId);
      });
      test9("list carries the id of each send", async () => {
        const s = await subject();
        const { a } = s.organizations;
        const one = await s.transcriber.submit(a, send("call_1:1"));
        const two = await s.transcriber.submit(a, send("call_1:2"));
        const page = await s.transcriber.list(a, { prefix: "call_1:" });
        const ids = new Map(page.items.map((item) => [item.clientReference, item.vendorId]));
        expect9(ids.get("call_1:1")).toBe(one.vendorId);
        expect9(ids.get("call_1:2")).toBe(two.vendorId);
      });
      test9("a read and a delete with the right id work as they do by reference alone", async () => {
        const s = await subject();
        const { a } = s.organizations;
        const { vendorId } = await s.transcriber.submit(a, send("call_1:1"));
        const result = await finalResultWith(s, a, "call_1:1", vendorId);
        expect9(result.status === "done" || result.status === "failed").toBe(true);
        expect9(await s.transcriber.delete(a, "call_1:1", { vendorId })).toEqual({ existed: true });
        expect9(await s.transcriber.getResult(a, "call_1:1", { vendorId })).toBeUndefined();
        expect9(await s.transcriber.delete(a, "call_1:1", { vendorId })).toEqual({ existed: false });
      });
      test9("an id that names another reference's send is ignored: the call is about the reference", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await s.transcriber.submit(a, send("call_1:1"));
        const other = await s.transcriber.submit(a, send("call_1:2"));
        expect9(await s.transcriber.getResult(a, "call_1:1", { vendorId: other.vendorId })).toBeDefined();
        expect9(await s.transcriber.delete(a, "call_1:1", { vendorId: other.vendorId })).toEqual({
          existed: true
        });
        expect9(await references(s, a)).toEqual(["call_1:2"]);
        expect9(await s.transcriber.getResult(a, "call_1:9", { vendorId: other.vendorId })).toBeUndefined();
        expect9(await s.transcriber.delete(a, "call_1:9", { vendorId: other.vendorId })).toEqual({
          existed: false
        });
        expect9(await references(s, a)).toEqual(["call_1:2"]);
      });
      test9("an id from another Organization is ignored and never reaches that Organization's send", async () => {
        const s = await subject();
        const { a, b } = s.organizations;
        const mine = await s.transcriber.submit(a, send("call_1:1"));
        await s.transcriber.submit(b, send("call_1:1", { speakers: "split_channels" }));
        expect9(await s.transcriber.delete(b, "call_1:1", { vendorId: mine.vendorId })).toEqual({
          existed: true
        });
        expect9(await references(s, a)).toEqual(["call_1:1"]);
        expect9(await references(s, b)).toEqual([]);
        expect9(await s.transcriber.getResult(b, "call_1:1", { vendorId: mine.vendorId })).toBeUndefined();
        expect9(await s.transcriber.delete(b, "call_1:1", { vendorId: mine.vendorId })).toEqual({
          existed: false
        });
        expect9(await s.transcriber.getResult(a, "call_1:1")).toBeDefined();
      });
      test9("an id the vendor does not know falls back to the reference", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await s.transcriber.submit(a, send("call_1:1"));
        expect9(await s.transcriber.getResult(a, "call_1:1", { vendorId: "unknown-id-1" })).toBeDefined();
        expect9(await s.transcriber.delete(a, "call_1:1", { vendorId: "unknown-id-1" })).toEqual({
          existed: true
        });
      });
      test9.each([
        ["empty", ""],
        ["with a space", "a b"],
        ["with a slash", "a/b"],
        ["over 128 characters", "a".repeat(129)],
        ["not a string", 5]
      ])("an id that is %s is refused", async (_label, vendorId) => {
        const s = await subject();
        const { a } = s.organizations;
        await s.transcriber.submit(a, send("call_1:1"));
        await expect9(s.transcriber.getResult(a, "call_1:1", { vendorId })).rejects.toMatchObject(invalid);
        await expect9(s.transcriber.delete(a, "call_1:1", { vendorId })).rejects.toMatchObject(invalid);
        expect9(await references(s, a)).toEqual(["call_1:1"]);
      });
      test9("a hint with the id of a deleted job is ignored and acts on the resubmitted one", async () => {
        const s = await subject();
        const { a } = s.organizations;
        const old = await s.transcriber.submit(a, send("call_1:1"));
        await s.transcriber.delete(a, "call_1:1");
        const fresh = await s.transcriber.submit(a, send("call_1:1"));
        expect9(fresh.created).toBe(true);
        expect9(await s.transcriber.getResult(a, "call_1:1", { vendorId: old.vendorId })).toBeDefined();
        expect9(await s.transcriber.delete(a, "call_1:1", { vendorId: old.vendorId })).toEqual({
          existed: true
        });
        expect9(await references(s, a)).toEqual([]);
      });
      test9("a send submitted through one instance is listed and deleted through another", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await s.transcriber.submit(a, send("call_1:1"));
        const other = await s.reopen();
        const found = await other.list(a, { prefix: "call_1:" });
        expect9(found.items.map((item) => item.clientReference)).toEqual(["call_1:1"]);
        expect9(await other.delete(a, "call_1:1")).toEqual({ existed: true });
        expect9(await references(s, a)).toEqual([]);
      });
      test9("a send whose id was never kept is found by listing for its reference and deleted without it", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await s.transcriber.submit(a, send("call_1:1"));
        await s.transcriber.submit(a, send("call_1:2"));
        await s.transcriber.submit(a, send("call_9:1"));
        const found = await s.transcriber.list(a, { prefix: "call_1:" });
        for (const entry of found.items) {
          expect9(entry.vendorId).toBeDefined();
          expect9(await s.transcriber.delete(a, entry.clientReference)).toEqual({ existed: true });
        }
        expect9(await references(s, a)).toEqual(["call_9:1"]);
      });
    });
    test9("concurrent submits of one reference create it once", async () => {
      const s = await subject();
      const { a } = s.organizations;
      const answers = await Promise.all(Array.from({ length: 8 }, () => s.transcriber.submit(a, send("call_1:1"))));
      expect9(answers.filter((answer) => answer.created)).toHaveLength(1);
      expect9(await references(s, a)).toEqual(["call_1:1"]);
    });
    test9("a prefix that ends with the separator does not match a longer id", async () => {
      const s = await subject();
      const { a } = s.organizations;
      for (const reference of ["call_1:1", "call_10:1"]) {
        await s.transcriber.submit(a, send(reference));
      }
      expect9(await references(s, a, "call_1:")).toEqual(["call_1:1"]);
    });
    test9("a purge by prefix removes sends the caller kept no record of", async () => {
      const s = await subject();
      const { a } = s.organizations;
      for (const reference of ["call_1:1", "call_1:2", "call_9:1"]) {
        await s.transcriber.submit(a, send(reference));
      }
      for (const reference of await references(s, a, "call_1:")) {
        await s.transcriber.delete(a, reference);
      }
      expect9(await references(s, a)).toEqual(["call_9:1"]);
    });
    test9("a second Organization cannot read, delete or list the first one's sends, and may reuse a reference", async () => {
      const s = await subject();
      const { a, b } = s.organizations;
      await s.transcriber.submit(a, send("call_1:1"));
      expect9(await s.transcriber.getResult(b, "call_1:1")).toBeUndefined();
      expect9(await s.transcriber.delete(b, "call_1:1")).toEqual({ existed: false });
      expect9(await references(s, b)).toEqual([]);
      expect9((await s.transcriber.submit(b, send("call_1:1", { speakers: "split_channels" }))).created).toBe(true);
      expect9(await references(s, a)).toEqual(["call_1:1"]);
      await s.transcriber.delete(b, "call_1:1");
      expect9(await s.transcriber.getResult(a, "call_1:1")).toBeDefined();
    });
    test9("an Organization whose id starts with another id is a different Organization", async () => {
      const s = await subject();
      const { a, aExtended } = s.organizations;
      await s.transcriber.submit(a, send("call_1:1"));
      expect9(await references(s, aExtended)).toEqual([]);
      expect9(await s.transcriber.getResult(aExtended, "call_1:1")).toBeUndefined();
    });
    test9.each([
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
      await expect9(s.transcriber.submit(a, { ...send("call_1:1"), ...change })).rejects.toMatchObject(invalid);
      expect9(await references(s, a)).toEqual([]);
    });
    test9("the refusal of a bad send never repeats the audio URL", async () => {
      const s = await subject();
      const { a } = s.organizations;
      const secret = "https://user:SECRETPASSWORD@example.test/a?sig=SECRETSIG";
      try {
        await s.transcriber.submit(a, { ...send("call_1:1"), audio: { url: secret } });
        throw new Error("the send was accepted");
      } catch (error) {
        expect9(JSON.stringify(error)).not.toContain("SECRET");
        expect9(String(error.message)).not.toContain("SECRET");
      }
    });
    test9.each([
      ["a bad Organization id", "bad/org", "call_1:1"],
      ["a bad reference", undefined, "bad ref"]
    ])("reads and deletes with %s are refused", async (_label, org, reference) => {
      const s = await subject();
      const id = org ?? s.organizations.a;
      await expect9(s.transcriber.getResult(id, reference)).rejects.toMatchObject(invalid);
      await expect9(s.transcriber.delete(id, reference)).rejects.toMatchObject(invalid);
    });
    test9.each([
      [{ limit: 0 }],
      [{ limit: 1001 }],
      [{ limit: 1.5 }],
      [{ prefix: "bad prefix" }],
      [{ cursor: "!!!" }]
    ])("list options %p are refused", async (options) => {
      const s = await subject();
      await expect9(s.transcriber.list(s.organizations.a, options)).rejects.toMatchObject(invalid);
    });
  });
}
// src/vector/behaviour.ts
import { afterEach as afterEach10, describe as describe10, expect as expect10, test as test10 } from "bun:test";
function vectorStoreBehaviour(name, make, skip = false) {
  const run = skip ? describe10.skip : describe10;
  run(`VectorStore behaviour: ${name}`, () => {
    const open = [];
    afterEach10(async () => {
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
    test10("a search returns the closest vectors first, with cosine scores and attributes", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await seed(s);
      const hits = await s.store.search(a, { vector: vec(s, 1, 0, 0), topK: 4 });
      expect10(ids(hits).slice(0, 2)).toEqual(["x", "xy"]);
      expect10(hits[0]?.score).toBeCloseTo(1, 4);
      expect10(hits[1]?.score).toBeCloseTo(Math.SQRT1_2, 4);
      expect10(hits[0]?.attributes).toEqual({ document_id: "doc_1", page: 1 });
      expect10(hits.find((hit) => hit.id === "z")?.attributes).toEqual({});
    });
    test10("a score does not depend on the length of either vector", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.store.upsert(a, [{ id: "long", vector: vec(s, 50, 0, 0) }]);
      const [hit] = await s.store.search(a, { vector: vec(s, 0.001, 0, 0), topK: 1 });
      expect10(hit?.id).toBe("long");
      expect10(hit?.score).toBeCloseTo(1, 4);
    });
    test10("topK bounds the results", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await seed(s);
      expect10(await s.store.search(a, { vector: vec(s, 1, 1, 1), topK: 2 })).toHaveLength(2);
      expect10(await s.store.search(a, { vector: vec(s, 1, 1, 1), topK: 100 })).toHaveLength(4);
      expect10(await s.store.search(s.organizations.b, { vector: vec(s, 1), topK: 5 })).toEqual([]);
    });
    test10.each([[0], [-1], [101], [1.5], [Number.NaN], ["5"]])("a topK of %p is refused", async (topK) => {
      const s = await subject();
      await expect10(s.store.search(s.organizations.a, { vector: vec(s, 1), topK })).rejects.toMatchObject(invalid);
    });
    test10("a filter keeps vectors whose attributes equal every entry", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await seed(s);
      const search = async (filter) => ids(await s.store.search(a, { vector: vec(s, 1, 1, 1), topK: 10, filter })).sort();
      expect10(await search({ document_id: "doc_1" })).toEqual(["x", "y"]);
      expect10(await search({ document_id: "doc_1", page: 2 })).toEqual(["y"]);
      expect10(await search({ final: true })).toEqual(["xy"]);
      expect10(await search({ page: 1 })).toEqual(["x", "xy"]);
      expect10(await search({ document_id: "nope" })).toEqual([]);
      expect10(await search({ page: "1" })).toEqual([]);
    });
    test10("a vector of the wrong length is a non-retryable dimension error and writes nothing", async () => {
      const s = await subject();
      const { a } = s.organizations;
      const code = { code: "vector.dimension_mismatch" };
      const short = Array.from({ length: s.store.dimensions - 1 }, () => 1);
      const long = Array.from({ length: s.store.dimensions + 1 }, () => 1);
      await expect10(s.store.search(a, { vector: short, topK: 1 })).rejects.toMatchObject(code);
      await expect10(s.store.search(a, { vector: long, topK: 1 })).rejects.toMatchObject(code);
      await expect10(s.store.upsert(a, [
        { id: "fine", vector: vec(s, 1) },
        { id: "short", vector: short }
      ])).rejects.toMatchObject(code);
      expect10(await s.store.search(a, { vector: vec(s, 1), topK: 10 })).toEqual([]);
    });
    test10.each([
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
      await expect10(s.store.upsert(a, [{ id: "v", vector }])).rejects.toMatchObject(invalid);
      await expect10(s.store.search(a, { vector, topK: 1 })).rejects.toMatchObject(invalid);
    });
    test10.each([
      ["an empty id", ""],
      ["a slash", "a/b"],
      ["a leading dot", ".x"],
      ["a space", "a b"],
      ["a long id", "x".repeat(65)]
    ])("an id with %s is refused", async (_label, id) => {
      const s = await subject();
      const { a } = s.organizations;
      await expect10(s.store.upsert(a, [{ id, vector: vec(s, 1) }])).rejects.toMatchObject(invalid);
      await expect10(s.store.delete(a, [id])).rejects.toMatchObject(invalid);
    });
    test10("a batch of 0 or 501 records, or one with a repeated id, is refused", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await expect10(s.store.upsert(a, [])).rejects.toMatchObject(invalid);
      const many = Array.from({ length: 501 }, (_, i) => ({ id: `v${i}`, vector: vec(s, 1) }));
      await expect10(s.store.upsert(a, many)).rejects.toMatchObject(invalid);
      await expect10(s.store.upsert(a, [
        { id: "same", vector: vec(s, 1) },
        { id: "same", vector: vec(s, 0, 1) }
      ])).rejects.toMatchObject(invalid);
      await expect10(s.store.delete(a, [])).rejects.toMatchObject(invalid);
      await expect10(s.store.delete(a, Array.from({ length: 501 }, (_, i) => `v${i}`))).rejects.toMatchObject(invalid);
      expect10(await s.store.search(a, { vector: vec(s, 1), topK: 10 })).toEqual([]);
    });
    test10.each([
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
      await expect10(s.store.upsert(a, [{ id: "v", vector: vec(s, 1), attributes }])).rejects.toMatchObject(invalid);
      await expect10(s.store.search(a, { vector: vec(s, 1), topK: 1, filter: attributes })).rejects.toMatchObject(invalid);
      await expect10(s.store.deleteByFilter(a, attributes)).rejects.toMatchObject(invalid);
    });
    test10("storing an id again replaces its vector and attributes, and doing it twice changes nothing", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.store.upsert(a, [{ id: "v", vector: vec(s, 1), attributes: { n: 1 } }]);
      const replacement = [{ id: "v", vector: vec(s, 0, 1), attributes: { n: 2 } }];
      await s.store.upsert(a, replacement);
      await s.store.upsert(a, replacement);
      const hits = await s.store.search(a, { vector: vec(s, 0, 1), topK: 10 });
      expect10(ids(hits)).toEqual(["v"]);
      expect10(hits[0]?.score).toBeCloseTo(1, 4);
      expect10(hits[0]?.attributes).toEqual({ n: 2 });
    });
    describe10("setAttributes", () => {
      const query = (s) => ({ vector: vec(s, 1, 1, 0), topK: 10 });
      test10("merges the attributes, leaves the others and the vector as they were", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await seed(s);
        const before = await s.store.search(a, query(s));
        const missing = await s.store.setAttributes(a, ["x", "xy"], { outcome: "won", seq: 2 });
        const after = await s.store.search(a, query(s));
        expect10(missing).toEqual([]);
        expect10(after.map((hit) => [hit.id, hit.score])).toEqual(before.map((hit) => [hit.id, hit.score]));
        const byId = Object.fromEntries(after.map((hit) => [hit.id, hit.attributes]));
        expect10(byId.x).toEqual({ document_id: "doc_1", page: 1, outcome: "won", seq: 2 });
        expect10(byId.xy).toEqual({
          document_id: "doc_2",
          page: 1,
          final: true,
          outcome: "won",
          seq: 2
        });
        expect10(byId.y).toEqual({ document_id: "doc_1", page: 2 });
        expect10(byId.z).toEqual({});
      });
      test10("overwrites a value that exists and keeps the rest", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await seed(s);
        await s.store.setAttributes(a, ["x"], { page: 9 });
        const hit = (await s.store.search(a, query(s))).find((item) => item.id === "x");
        expect10(hit?.attributes).toEqual({ document_id: "doc_1", page: 9 });
      });
      test10("reports ids it did not find, in order, and does not create them", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await seed(s);
        const missing = await s.store.setAttributes(a, ["nope", "x", "gone"], { outcome: "lost" });
        expect10(missing).toEqual(["nope", "gone"]);
        const all = await s.store.search(a, { vector: vec(s, 1), topK: 100 });
        expect10(ids(all).sort()).toEqual(["x", "xy", "y", "z"]);
        expect10(await s.store.setAttributes(s.organizations.b, ["x"], { n: 1 })).toEqual(["x"]);
      });
      test10("an Organization with no vectors reports every id and creates nothing", async () => {
        const s = await subject();
        const { a } = s.organizations;
        expect10(await s.store.setAttributes(a, ["x", "y"], { n: 1 })).toEqual(["x", "y"]);
        expect10(await s.store.search(a, { vector: vec(s, 1), topK: 10 })).toEqual([]);
      });
      test10("more than the upsert maximum, none, or a repeated id is refused and records nothing", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await seed(s);
        const many = ["x", ...Array.from({ length: 500 }, (_, i) => `v${i}`)];
        await expect10(s.store.setAttributes(a, many, { n: 1 })).rejects.toMatchObject(invalid);
        await expect10(s.store.setAttributes(a, [], { n: 1 })).rejects.toMatchObject(invalid);
        await expect10(s.store.setAttributes(a, ["x", "x"], { n: 1 })).rejects.toMatchObject(invalid);
        await expect10(s.store.setAttributes(a, ["bad id"], { n: 1 })).rejects.toMatchObject(invalid);
        const atMax = Array.from({ length: 500 }, (_, i) => `v${i}`);
        expect10(await s.store.setAttributes(a, atMax, { n: 1 })).toHaveLength(500);
        const x = (await s.store.search(a, { vector: vec(s, 1), topK: 1 }))[0];
        expect10(x?.attributes).toEqual({ document_id: "doc_1", page: 1 });
      });
      test10("a second Organization's vectors with the same ids are untouched", async () => {
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
        expect10(other).toEqual([]);
        const mine = await s.store.search(a, {
          vector: vec(s, 1),
          topK: 10,
          filter: { outcome: "won" }
        });
        expect10(ids(mine).sort()).toEqual(["x", "y"]);
      });
      test10("repeating the call changes nothing", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await seed(s);
        await s.store.setAttributes(a, ["x", "nope"], { outcome: "won" });
        const once = await s.store.search(a, query(s));
        const missing = await s.store.setAttributes(a, ["x", "nope"], { outcome: "won" });
        expect10(missing).toEqual(["nope"]);
        expect10(await s.store.search(a, query(s))).toEqual(once);
      });
      test10("a filter on the changed attribute sees the new value and not the old", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await seed(s);
        await s.store.setAttributes(a, ["x"], { outcome: "open" });
        await s.store.setAttributes(a, ["x"], { outcome: "won" });
        const search = (outcome) => s.store.search(a, { vector: vec(s, 1), topK: 10, filter: { outcome } });
        expect10(ids(await search("won"))).toEqual(["x"]);
        expect10(await search("open")).toEqual([]);
      });
      test10.each([
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
        await expect10(s.store.setAttributes(a, ["x"], attributes)).rejects.toMatchObject(invalid);
        const x = (await s.store.search(a, { vector: vec(s, 1), topK: 1 }))[0];
        expect10(x?.attributes).toEqual({ document_id: "doc_1", page: 1 });
      });
      test10("a merge that would give a vector more than 16 attributes is refused and writes nothing", async () => {
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
        await expect10(s.store.setAttributes(a, ["room", "full"], { extra: 1 })).rejects.toMatchObject(invalid);
        const room = (await s.store.search(a, { vector: vec(s, 0, 1), topK: 2 })).find((hit) => hit.id === "room");
        expect10(room?.attributes).toEqual({ k0: 1 });
        expect10(await s.store.setAttributes(a, ["full"], { k0: 2 })).toEqual([]);
      });
      test10("an invalid Organization id is refused", async () => {
        const s = await subject();
        await expect10(s.store.setAttributes("not an org", ["x"], { n: 1 })).rejects.toMatchObject(invalid);
      });
    });
    test10("deleting by id removes those vectors, ignores unknown ids and can be repeated", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await seed(s);
      await s.store.delete(a, ["x", "missing"]);
      await s.store.delete(a, ["x", "missing"]);
      expect10(ids(await s.store.search(a, { vector: vec(s, 1, 1, 1), topK: 10 })).sort()).toEqual([
        "xy",
        "y",
        "z"
      ]);
    });
    test10("deleting by filter removes the matching vectors only, and an empty filter is refused", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await seed(s);
      await expect10(s.store.deleteByFilter(a, {})).rejects.toMatchObject(invalid);
      await s.store.deleteByFilter(a, { document_id: "doc_1" });
      await s.store.deleteByFilter(a, { document_id: "doc_1" });
      await s.store.deleteByFilter(a, { document_id: "never" });
      expect10(ids(await s.store.search(a, { vector: vec(s, 1, 1, 1), topK: 10 })).sort()).toEqual([
        "xy",
        "z"
      ]);
    });
    test10("a second Organization cannot search, overwrite or delete the first one's vectors", async () => {
      const s = await subject();
      const { a, b } = s.organizations;
      await seed(s, a);
      expect10(await s.store.search(b, { vector: vec(s, 1, 0, 0), topK: 100 })).toEqual([]);
      expect10(await s.store.search(b, {
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
      expect10(ids(mine).sort()).toEqual(["x", "xy", "y", "z"]);
      expect10(mine.find((hit) => hit.id === "x")?.attributes).toEqual({
        document_id: "doc_1",
        page: 1
      });
      const theirs = await s.store.search(b, { vector: vec(s, 1, 0, 0), topK: 100 });
      expect10(ids(theirs)).toEqual(["x"]);
      expect10(theirs[0]?.attributes).toEqual({ document_id: "b_doc" });
    });
    test10("an Organization whose id starts with another id is a different Organization", async () => {
      const s = await subject();
      const { a, aExtended } = s.organizations;
      await s.store.upsert(a, [{ id: "one", vector: vec(s, 1) }]);
      await s.store.upsert(aExtended, [{ id: "two", vector: vec(s, 1) }]);
      expect10(ids(await s.store.search(a, { vector: vec(s, 1), topK: 10 }))).toEqual(["one"]);
      expect10(ids(await s.store.search(aExtended, { vector: vec(s, 1), topK: 10 }))).toEqual(["two"]);
      await s.store.delete(a, ["two"]);
      await s.store.deleteByFilter(a, { n: 1 });
      expect10(ids(await s.store.search(aExtended, { vector: vec(s, 1), topK: 10 }))).toEqual(["two"]);
    });
    test10("an id of exactly 64 characters is accepted", async () => {
      const s = await subject();
      const { a } = s.organizations;
      const id = "x".repeat(64);
      await s.store.upsert(a, [{ id, vector: vec(s, 1) }]);
      expect10(ids(await s.store.search(a, { vector: vec(s, 1), topK: 1 }))).toEqual([id]);
    });
    test10("deleting everything an Organization has leaves other Organizations alone and can be repeated", async () => {
      const s = await subject();
      const { a, b, aExtended } = s.organizations;
      await seed(s, a);
      await seed(s, b);
      await seed(s, aExtended);
      await s.store.deleteAll(a);
      await s.store.deleteAll(a);
      await s.store.deleteAll(`${a.slice(0, -1)}9`);
      expect10(await s.store.search(a, { vector: vec(s, 1, 1, 1), topK: 10 })).toEqual([]);
      expect10(await s.store.search(b, { vector: vec(s, 1, 1, 1), topK: 10 })).toHaveLength(4);
      expect10(await s.store.search(aExtended, { vector: vec(s, 1, 1, 1), topK: 10 })).toHaveLength(4);
      await s.store.upsert(a, [{ id: "again", vector: vec(s, 1) }]);
      expect10(ids(await s.store.search(a, { vector: vec(s, 1), topK: 10 }))).toEqual(["again"]);
    });
    test10("warming an Organization changes nothing and works with or without data", async () => {
      const s = await subject();
      const { a, b } = s.organizations;
      await s.store.warm(b);
      await seed(s, a);
      await s.store.warm(a);
      await s.store.warm(a);
      expect10(await s.store.search(a, { vector: vec(s, 1, 1, 1), topK: 10 })).toHaveLength(4);
      expect10(await s.store.search(b, { vector: vec(s, 1, 1, 1), topK: 10 })).toEqual([]);
    });
    test10.each([
      ["empty", ""],
      ["a path", "org/../x"],
      ["a separator", "x/y"],
      ["an encoded separator", "x%2Fy"],
      ["a wildcard", "x*"],
      ["too long", "x".repeat(65)]
    ])("an Organization id that is %s is refused by every operation", async (_label, id) => {
      const s = await subject();
      await expect10(s.store.upsert(id, [{ id: "v", vector: vec(s, 1) }])).rejects.toMatchObject(invalid);
      await expect10(s.store.search(id, { vector: vec(s, 1), topK: 1 })).rejects.toMatchObject(invalid);
      await expect10(s.store.delete(id, ["v"])).rejects.toMatchObject(invalid);
      await expect10(s.store.deleteByFilter(id, { n: 1 })).rejects.toMatchObject(invalid);
      await expect10(s.store.deleteAll(id)).rejects.toMatchObject(invalid);
      await expect10(s.store.warm(id)).rejects.toMatchObject(invalid);
    });
  });
}
export {
  calendarBehaviour,
  contactGuardBehaviour,
  llmBehaviour,
  objectStoreBehaviour,
  processedStoreBehaviour,
  queueBehaviour,
  streamingTranscribeBehaviour,
  telephonyBehaviour,
  transcriberBehaviour,
  vectorStoreBehaviour
};
