import {
  MAX_MESSAGE_BYTES2
} from "./shared/chunk-mjkmsg3r.js";
import {
  checkTranscriptionResult2
} from "./shared/chunk-5yzgse6v.js";
import {
  waitForTranscription2
} from "./shared/chunk-83cpvtqk.js";

// src/consent/behaviour.ts
import { afterEach, describe, expect, test } from "bun:test";
import { formatId } from "tula-closeline-contract";
function contactGuardBehaviour(name, make) {
  describe(`ContactGuard behaviour: ${name}`, () => {
    const open = [];
    afterEach(async () => {
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
    test("a target nobody allowed is denied as missing", async () => {
      const s = await subject();
      const result = await s.guard.check(request);
      expect(result.allowed).toBe(false);
      expect(result).toMatchObject({ code: "consent.missing", suppressionReason: null });
    });
    test("an allowed target is allowed with a basis and a check id", async () => {
      const s = await subject();
      s.allow(target, "sms");
      const result = await s.guard.check(request);
      expect(result).toMatchObject({ allowed: true, basis: "consent_granted" });
      expect(result.checkId).not.toBeNull();
    });
    test("an allowance holds for one channel and not another", async () => {
      const s = await subject();
      s.allow(target, "sms");
      expect((await s.guard.check({ ...request, channel: "phone" })).allowed).toBe(false);
      expect((await s.guard.check({ ...request, channel: "sms" })).allowed).toBe(true);
    });
    test("an allowance for one Organization does not reach another", async () => {
      const s = await subject();
      s.allow(target, "sms");
      const result = await s.guard.check({ ...request, organizationId: otherOrg });
      expect(result.allowed).toBe(false);
    });
    test.each([
      ["consent.missing", undefined],
      ["consent.withdrawn", undefined],
      ["consent.suppressed", "unsubscribe"]
    ])("a %s denial is passed through as core gave it", async (code, reason) => {
      const s = await subject();
      s.deny(target, "sms", code, reason);
      const result = await s.guard.check(request);
      expect(result).toMatchObject({
        allowed: false,
        code,
        suppressionReason: reason ?? null
      });
    });
    test("an address can be checked as well as a Prospect", async () => {
      const s = await subject();
      const email = { organizationId: org, email: "pat@example.com" };
      s.allow(email, "email");
      const result = await s.guard.check({ ...email, channel: "email", purpose: "agent_initiated" });
      expect(result.allowed).toBe(true);
    });
    test("the channel and purpose reach the check", async () => {
      const s = await subject();
      await s.guard.check({ ...request, channel: "whatsapp", purpose: "reply" });
      expect(s.reached()).toHaveLength(1);
      expect(s.reached()[0]).toMatchObject({
        organizationId: org,
        prospectId,
        channel: "whatsapp",
        purpose: "reply"
      });
    });
    test("a check that cannot be answered is denied as unavailable, never allowed", async () => {
      const s = await subject();
      s.allow(target, "sms");
      s.makeUnavailable();
      const result = await s.guard.check(request);
      expect(result).toEqual({
        allowed: false,
        checkId: null,
        code: "consent.unavailable",
        suppressionReason: null
      });
    });
    test("a request naming two targets is denied as unavailable and asks nothing", async () => {
      const s = await subject();
      s.allow(target, "sms");
      const result = await s.guard.check({ ...request, email: "pat@example.com" });
      expect(result).toMatchObject({ allowed: false, code: "consent.unavailable" });
      expect(s.reached()).toHaveLength(0);
    });
    test("a request with no target is denied as unavailable", async () => {
      const s = await subject();
      const result = await s.guard.check({
        organizationId: org,
        channel: "sms",
        purpose: "agent_initiated"
      });
      expect(result).toMatchObject({ allowed: false, code: "consent.unavailable" });
    });
  });
}
// src/queue/behaviour.ts
import { afterEach as afterEach2, describe as describe2, expect as expect2, test as test2 } from "bun:test";
function queueBehaviour(name, make, skip = false) {
  const run = skip ? describe2.skip : describe2;
  run(`Queue behaviour: ${name}`, () => {
    const open = [];
    afterEach2(async () => {
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
    test2("publishing an envelope of an unknown type is refused and nothing is sent", async () => {
      const s = await subject();
      const bad = { ...ping(s), type: "test.nope" };
      await expect2(s.queue.publish(bad)).rejects.toMatchObject({ code: "queue.invalid_message" });
      expect2(await none(s)).toEqual([]);
    });
    test2("publishing a payload that fails its schema is refused", async () => {
      const s = await subject();
      const bad = { ...ping(s), payload: { n: "x" } };
      await expect2(s.queue.publish(bad)).rejects.toMatchObject({ code: "queue.invalid_message" });
    });
    test2("an organization message without an organization id is refused, and a global one with it", async () => {
      const s = await subject();
      const noOrg = { ...ping(s), organizationId: undefined };
      await expect2(s.queue.publish(noOrg)).rejects.toMatchObject({ code: "queue.invalid_message" });
      const note = s.registry.create({ type: "test.note", payload: { text: "hi" }, traceId: "t" });
      const withOrg = { ...note, organizationId: "org_a" };
      await expect2(s.queue.publish(withOrg)).rejects.toMatchObject({
        code: "queue.invalid_message"
      });
    });
    test2("a message over 256 KiB is refused with a clear error", async () => {
      const s = await subject();
      const big = s.registry.create({
        type: "test.note",
        payload: { text: "x".repeat(MAX_MESSAGE_BYTES2) },
        traceId: "t"
      });
      await expect2(s.queue.publish(big)).rejects.toMatchObject({ code: "queue.message_too_large" });
      expect2(await none(s)).toEqual([]);
    });
    test2("a batch of 11, an empty batch, or over 256 KiB in total is refused before anything is sent", async () => {
      const s = await subject();
      const eleven = Array.from({ length: 11 }, (_, i) => ping(s, i));
      await expect2(s.queue.publishBatch(eleven)).rejects.toMatchObject({
        code: "queue.batch_too_large"
      });
      await expect2(s.queue.publishBatch([])).rejects.toMatchObject({
        code: "queue.batch_too_large"
      });
      const half = (text) => s.registry.create({ type: "test.note", payload: { text }, traceId: "t" });
      const heavy = [half("a".repeat(150000)), half("b".repeat(150000))];
      await expect2(s.queue.publishBatch(heavy)).rejects.toMatchObject({
        code: "queue.batch_too_large"
      });
      expect2(await none(s)).toEqual([]);
    });
    test2.each([
      [{ maxMessages: 0, visibilityTimeoutSeconds: 5, waitSeconds: 0 }],
      [{ maxMessages: 11, visibilityTimeoutSeconds: 5, waitSeconds: 0 }],
      [{ maxMessages: 1, visibilityTimeoutSeconds: -1, waitSeconds: 0 }],
      [{ maxMessages: 1, visibilityTimeoutSeconds: 5, waitSeconds: 21 }],
      [{ maxMessages: 1, visibilityTimeoutSeconds: 1.5, waitSeconds: 0 }]
    ])("receive with out-of-range arguments %j is refused", async (args) => {
      const s = await subject();
      await expect2(s.queue.receive(args)).rejects.toMatchObject({ code: "queue.invalid_request" });
    });
    test2("a body that is not a valid message comes back as invalid, with no body in it", async () => {
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
      expect2(got).toHaveLength(cases.length);
      expect2(got.every((delivery) => delivery.kind === "invalid")).toBe(true);
      const reasons = got.map((delivery) => delivery.kind === "invalid" ? delivery.reason : "");
      expect2([...reasons].sort()).toEqual(cases.map(([, , reason]) => reason).sort());
      expect2(JSON.stringify(got)).not.toContain(secret);
    });
    test2("an invalid message that is never acknowledged is delivered maxReceiveCount times and then taken out of circulation", async () => {
      const s = await subject();
      await s.injectRaw('{"broken":');
      for (let round = 0;round < s.maxReceiveCount; round++) {
        const got = await take(s, 1);
        expect2(got).toHaveLength(1);
        expect2(got[0]?.receiveCount).toBe(round + 1);
        await s.queue.release(got[0].receipt);
      }
      expect2(await none(s)).toEqual([]);
    });
    test2("extending visibility of an acknowledged message is refused with queue.receipt_invalid", async () => {
      const s = await subject();
      await s.queue.publish(ping(s));
      const [got] = await take(s, 1);
      const receipt = got.receipt;
      await s.queue.acknowledge(receipt);
      await expect2(s.queue.extendVisibility(receipt, 10)).rejects.toMatchObject({
        code: "queue.receipt_invalid"
      });
    });
    test2("acknowledging twice resolves both times", async () => {
      const s = await subject();
      await s.queue.publish(ping(s));
      const [got] = await take(s, 1);
      const receipt = got.receipt;
      await s.queue.acknowledge(receipt);
      await expect2(s.queue.acknowledge(receipt)).resolves.toBeUndefined();
    });
    test2("a published message arrives with every envelope field intact", async () => {
      const s = await subject();
      const sent = ping(s, 7, "org_a", "msg_1");
      await s.queue.publish(sent);
      const [got] = await take(s, 1);
      expect2(got?.kind).toBe("message");
      if (got?.kind === "message") {
        expect2(got.envelope).toEqual(sent);
        expect2(got.receiveCount).toBe(1);
      }
    });
    test2("an empty queue gives an empty list", async () => {
      const s = await subject();
      expect2(await none(s)).toEqual([]);
    });
    test2("a batch publish reports every id as sent and delivers them all", async () => {
      const s = await subject();
      const batch = [ping(s, 1), ping(s, 2), ping(s, 3)];
      const result = await s.queue.publishBatch(batch);
      expect2(result.failed).toEqual([]);
      expect2(result.sent).toEqual(batch.map((envelope) => envelope.id));
      const got = await take(s, 3);
      expect2(got).toHaveLength(3);
    });
    test2("receive returns at most maxMessages", async () => {
      const s = await subject();
      await s.queue.publishBatch([ping(s, 1), ping(s, 2), ping(s, 3)]);
      const first = await s.queue.receive({
        maxMessages: 2,
        visibilityTimeoutSeconds: s.visibilitySeconds,
        waitSeconds: 1
      });
      expect2(first.length).toBeLessThanOrEqual(2);
      expect2(first.length).toBeGreaterThan(0);
    });
    test2("the subject leaves room for an empty long poll inside the visibility timeout", () => {
      return subject().then((s) => {
        expect2(s.visibilitySeconds).toBeGreaterThanOrEqual(s.emptyWaitSeconds + 3);
      });
    });
    test2("a received message stays hidden until its visibility timeout, then returns with a higher count", async () => {
      const s = await subject();
      await s.queue.publish(ping(s, 1, "org_a", "msg_v"));
      expect2(await take(s, 1)).toHaveLength(1);
      expect2(await none(s)).toEqual([]);
      let again;
      for (let waited = 0;waited <= s.visibilitySeconds + 20 && again === undefined; waited++) {
        await s.pass(1);
        [again] = await s.queue.receive({
          maxMessages: 1,
          visibilityTimeoutSeconds: s.visibilitySeconds,
          waitSeconds: s.emptyWaitSeconds
        });
      }
      expect2(again?.kind === "message" && again.envelope.id).toBe("msg_v");
      expect2(again?.receiveCount).toBe(2);
    });
    test2("extending visibility keeps a message hidden past the original timeout", async () => {
      const s = await subject();
      await s.queue.publish(ping(s));
      const [got] = await take(s, 1);
      await s.queue.extendVisibility(got.receipt, s.visibilitySeconds * 4);
      await s.pass(s.visibilitySeconds + 1);
      expect2(await none(s)).toEqual([]);
    });
    test2("releasing a message makes it receivable at once", async () => {
      const s = await subject();
      await s.queue.publish(ping(s));
      const [got] = await take(s, 1);
      await s.queue.release(got.receipt);
      const [again] = await take(s, 1);
      expect2(again?.receiveCount).toBe(2);
    });
    test2("acknowledging with the receipt of an earlier delivery does not delete the redelivered message", async () => {
      const s = await subject();
      await s.queue.publish(ping(s, 1, "org_a", "msg_stale"));
      const [first] = await take(s, 1);
      await s.pass(s.visibilitySeconds + 1);
      const [second] = await take(s, 1);
      expect2(second?.receiveCount).toBe(2);
      await s.queue.acknowledge(first.receipt);
      await s.queue.release(second.receipt);
      const [third] = await take(s, 1);
      expect2(third?.kind === "message" && third.envelope.id).toBe("msg_stale");
      expect2(third?.receiveCount).toBe(3);
    });
    test2("an acknowledged message is not delivered again", async () => {
      const s = await subject();
      await s.queue.publish(ping(s));
      const [got] = await take(s, 1);
      await s.queue.acknowledge(got.receipt);
      await s.pass(s.visibilitySeconds + 1);
      expect2(await none(s)).toEqual([]);
    });
    test2("a message released maxReceiveCount times moves to the dead-letter queue instead of being delivered again", async () => {
      const s = await subject();
      await s.queue.publish(ping(s, 1, "org_a", "msg_dead"));
      for (let round = 1;round <= s.maxReceiveCount; round++) {
        const [got] = await take(s, 1);
        expect2(got?.receiveCount).toBe(round);
        await s.queue.release(got.receipt);
      }
      expect2(await none(s)).toEqual([]);
      const dead = await s.deadLetterIds();
      if (dead !== undefined) {
        expect2(dead).toEqual(["msg_dead"]);
      }
    });
    test2("two organizations' messages stay separate: each envelope keeps its own organization id", async () => {
      const s = await subject();
      await s.queue.publishBatch([ping(s, 1, "org_a", "same_id"), ping(s, 2, "org_b", "same_id")]);
      const got = await take(s, 2);
      const orgs = got.map((delivery) => delivery.kind === "message" ? delivery.envelope.organizationId : "");
      expect2(orgs.sort()).toEqual(["org_a", "org_b"]);
    });
  });
}
// src/queue/store.behaviour.ts
import { afterEach as afterEach3, describe as describe3, expect as expect3, test as test3 } from "bun:test";
var key = { consumer: "c", organizationId: "org_a", messageId: "m1" };
async function claimed(store, k, lease = 60) {
  const result = await store.claim(k, lease);
  if (result.status !== "claimed") {
    throw new Error(`expected a claim, got ${result.status}`);
  }
  return result.token;
}
function processedStoreBehaviour(name, make) {
  describe3(`ProcessedStore behaviour: ${name}`, () => {
    const open = [];
    afterEach3(async () => {
      await Promise.all(open.splice(0).map((subject) => subject.close()));
    });
    async function subject() {
      const made = await make();
      open.push(made);
      return made;
    }
    test3("a live claim is busy for everyone else, and a done message stays done", async () => {
      const { store } = await subject();
      const token = await claimed(store, key);
      expect3(await store.claim(key, 60)).toMatchObject({ status: "busy" });
      expect3(await store.complete(key, token)).toBe(true);
      expect3(await store.claim(key, 60)).toEqual({ status: "done" });
    });
    test3("busy reports the seconds left on the lease, rounded up, at least one", async () => {
      const { store, pass } = await subject();
      await claimed(store, key);
      await pass(10);
      const busy = await store.claim(key, 60);
      expect3(busy.status).toBe("busy");
      if (busy.status === "busy") {
        expect3(busy.retryAfterSeconds).toBeGreaterThanOrEqual(49);
        expect3(busy.retryAfterSeconds).toBeLessThanOrEqual(51);
      }
    });
    test3("a lapsed claim can be taken again, and the old holder can no longer complete", async () => {
      const { store, pass } = await subject();
      const first = await claimed(store, key);
      await pass(61);
      const second = await claimed(store, key);
      expect3(second).not.toBe(first);
      expect3(await store.complete(key, first)).toBe(false);
      expect3(await store.complete(key, second)).toBe(true);
    });
    test3("release frees the claim for the next delivery; a stale token releases nothing", async () => {
      const { store } = await subject();
      const token = await claimed(store, key);
      await store.release(key, "wrong-token");
      expect3(await store.claim(key, 60)).toMatchObject({ status: "busy" });
      await store.release(key, token);
      expect3(await store.claim(key, 60)).toMatchObject({ status: "claimed" });
    });
    test3("the organization, the consumer and a missing organization are all part of the key", async () => {
      const { store } = await subject();
      await claimed(store, key);
      expect3(await store.claim({ ...key, organizationId: "org_b" }, 60)).toMatchObject({
        status: "claimed"
      });
      expect3(await store.claim({ ...key, organizationId: null }, 60)).toMatchObject({
        status: "claimed"
      });
      expect3(await store.claim({ ...key, consumer: "other" }, 60)).toMatchObject({
        status: "claimed"
      });
      expect3(await store.claim(key, 60)).toMatchObject({ status: "busy" });
    });
    test3("completing a message that was never claimed does nothing", async () => {
      const { store } = await subject();
      expect3(await store.complete(key, "nope")).toBe(false);
    });
    test3("renew pushes the lease out, and only for the holder of a live claim", async () => {
      const { store, pass } = await subject();
      const token = await claimed(store, key);
      await pass(50);
      expect3(await store.renew(key, token, 60)).toBe(true);
      await pass(50);
      expect3(await store.claim(key, 60)).toMatchObject({ status: "busy" });
      expect3(await store.renew(key, "wrong-token", 60)).toBe(false);
      await pass(20);
      expect3(await store.renew(key, token, 60)).toBe(false);
      expect3(await store.renew({ ...key, messageId: "never" }, token, 60)).toBe(false);
    });
    test3("a completed claim cannot be renewed", async () => {
      const { store } = await subject();
      const token = await claimed(store, key);
      await store.complete(key, token);
      expect3(await store.renew(key, token, 60)).toBe(false);
    });
    test3("purge removes old done records and lapsed claims, at most `limit`, and keeps the rest", async () => {
      const { store, pass, now } = await subject();
      for (const id of ["a", "b", "c"]) {
        const k = { ...key, messageId: id };
        await store.complete(k, await claimed(store, k));
      }
      const live = { ...key, messageId: "live" };
      await claimed(store, live, 3600);
      await pass(10);
      const cutoff = now();
      expect3(await store.purge(cutoff, 2)).toBe(2);
      expect3(await store.purge(cutoff, 10)).toBe(1);
      expect3(await store.claim({ ...key, messageId: "a" }, 60)).toMatchObject({ status: "claimed" });
      expect3(await store.claim(live, 60)).toMatchObject({ status: "busy" });
    });
  });
}
// src/storage/behaviour.ts
import { afterEach as afterEach4, describe as describe4, expect as expect4, test as test4 } from "bun:test";
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
  const run = skip ? describe4.skip : describe4;
  run(`ObjectStore behaviour: ${name}`, () => {
    const open = [];
    afterEach4(async () => {
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
    test4.each(BAD_KEYS.map((key) => [JSON.stringify(key.slice(0, 40)), key]))("the key %s is refused by every operation", async (_label, key) => {
      const s = await subject();
      const { a } = s.organizations;
      const code = { code: "storage.invalid_request" };
      await expect4(s.store.put(a, key, bytes("x"))).rejects.toMatchObject(code);
      await expect4(s.store.get(a, key)).rejects.toMatchObject(code);
      await expect4(s.store.head(a, key)).rejects.toMatchObject(code);
      await expect4(s.store.delete(a, key)).rejects.toMatchObject(code);
    });
    test4.each([
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
      await expect4(s.store.put(id, "k", bytes("x"))).rejects.toMatchObject(code);
      await expect4(s.store.get(id, "k")).rejects.toMatchObject(code);
      await expect4(s.store.head(id, "k")).rejects.toMatchObject(code);
      await expect4(s.store.delete(id, "k")).rejects.toMatchObject(code);
      await expect4(s.store.list(id)).rejects.toMatchObject(code);
    });
    test4("an id built from another Organization id and a path does not reach it", async () => {
      const s = await subject();
      const { a, b } = s.organizations;
      await s.store.put(b, "secret.txt", bytes("b only"));
      for (const id of [`${a}/../${b}`, `${a}/${b}`, `../${b}`, `${b}/`, `${b}/.`]) {
        await expect4(s.store.get(id, "secret.txt")).rejects.toMatchObject({
          code: "storage.invalid_request"
        });
        await expect4(s.store.list(id)).rejects.toMatchObject({ code: "storage.invalid_request" });
      }
    });
    test4("an object comes back as written, with its content type as given", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.store.put(a, "docs/one.txt", bytes("hello"), {
        contentType: "text/plain; charset=utf-8"
      });
      const got = await s.store.get(a, "docs/one.txt");
      expect4(got?.key).toBe("docs/one.txt");
      expect4(text(got?.body ?? new Uint8Array)).toBe("hello");
      expect4(got?.size).toBe(5);
      expect4(sameMediaType(got?.contentType, "text/plain; charset=utf-8")).toBe(true);
      expect4(got?.lastModified).toBeInstanceOf(Date);
      expect4(Number.isNaN(got?.lastModified.getTime())).toBe(false);
      const info = await s.store.head(a, "docs/one.txt");
      expect4(info).toMatchObject({ key: "docs/one.txt", size: 5 });
      expect4(sameMediaType(info?.contentType, "text/plain; charset=utf-8")).toBe(true);
    });
    test4("a content type without parameters comes back byte for byte", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.store.put(a, "a.pdf", bytes("%PDF"), { contentType: "application/pdf" });
      expect4((await s.store.get(a, "a.pdf"))?.contentType).toBe("application/pdf");
      expect4((await s.store.head(a, "a.pdf"))?.contentType).toBe("application/pdf");
    });
    test4("a different media type or parameter value is not the same content type", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.store.put(a, "k", bytes("x"), { contentType: "text/plain; charset=utf-8" });
      const got = await s.store.head(a, "k");
      expect4(sameMediaType(got?.contentType, "text/html; charset=utf-8")).toBe(false);
      expect4(sameMediaType(got?.contentType, "text/plain; charset=latin1")).toBe(false);
      expect4(sameMediaType(got?.contentType, "text/plain")).toBe(false);
    });
    test4("without a content type the store says application/octet-stream", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.store.put(a, "blob", new Uint8Array([0, 255, 1, 254]));
      const got = await s.store.get(a, "blob");
      expect4(got?.contentType).toBe("application/octet-stream");
      expect4([...got?.body ?? []]).toEqual([0, 255, 1, 254]);
    });
    test4("content is stored as bytes whatever its content type claims", async () => {
      const s = await subject();
      const { a } = s.organizations;
      const html = bytes("<script>alert(1)</script>");
      await s.store.put(a, "liar.png", html, { contentType: "image/png" });
      const got = await s.store.get(a, "liar.png");
      expect4(text(got?.body ?? new Uint8Array)).toBe("<script>alert(1)</script>");
      expect4(got?.contentType).toBe("image/png");
    });
    test4("an empty object is stored", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.store.put(a, "empty", new Uint8Array);
      expect4((await s.store.get(a, "empty"))?.size).toBe(0);
    });
    test4.each([
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
      await expect4(s.store.put(a, "k", bytes("x"), { contentType })).rejects.toMatchObject({
        code: "storage.invalid_request"
      });
      expect4(await s.store.head(a, "k")).toBeUndefined();
    });
    test4("a body that is not bytes is refused", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await expect4(s.store.put(a, "k", "text")).rejects.toMatchObject({
        code: "storage.invalid_request"
      });
    });
    test4("an object over the size limit is refused and the limit itself is accepted", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await expect4(s.store.put(a, "big", new Uint8Array(s.maxObjectBytes + 1))).rejects.toMatchObject({ code: "storage.object_too_large" });
      expect4(await s.store.head(a, "big")).toBeUndefined();
      await s.store.put(a, "edge", new Uint8Array(s.maxObjectBytes));
      expect4((await s.store.head(a, "edge"))?.size).toBe(s.maxObjectBytes);
    });
    test4("a missing object reads as undefined", async () => {
      const s = await subject();
      const { a } = s.organizations;
      expect4(await s.store.get(a, "nothing")).toBeUndefined();
      expect4(await s.store.head(a, "nothing")).toBeUndefined();
    });
    test4("writing a key again replaces the object, and writing the same thing twice changes nothing", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.store.put(a, "k", bytes("one"), { contentType: "text/plain" });
      await s.store.put(a, "k", bytes("two"), { contentType: "text/csv" });
      await s.store.put(a, "k", bytes("two"), { contentType: "text/csv" });
      const got = await s.store.get(a, "k");
      expect4(text(got?.body ?? new Uint8Array)).toBe("two");
      expect4(got?.contentType).toBe("text/csv");
      expect4(await keysOf(s, a)).toEqual(["k"]);
    });
    test4("deleting removes the object, and deleting again or deleting nothing resolves", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.store.put(a, "k", bytes("x"));
      await s.store.delete(a, "k");
      expect4(await s.store.get(a, "k")).toBeUndefined();
      await s.store.delete(a, "k");
      await s.store.delete(a, "never-existed");
    });
    test4("a second Organization cannot read, head, list or delete the first one's objects", async () => {
      const s = await subject();
      const { a, b } = s.organizations;
      await s.store.put(a, "docs/plan.txt", bytes("a secret"));
      expect4(await s.store.get(b, "docs/plan.txt")).toBeUndefined();
      expect4(await s.store.head(b, "docs/plan.txt")).toBeUndefined();
      expect4(await keysOf(s, b)).toEqual([]);
      expect4(await keysOf(s, b, "docs/")).toEqual([]);
      await s.store.delete(b, "docs/plan.txt");
      expect4(text((await s.store.get(a, "docs/plan.txt"))?.body ?? new Uint8Array)).toBe("a secret");
    });
    test4("the same key in two Organizations holds two objects", async () => {
      const s = await subject();
      const { a, b } = s.organizations;
      await s.store.put(a, "same", bytes("from a"));
      await s.store.put(b, "same", bytes("from b"));
      expect4(text((await s.store.get(a, "same"))?.body ?? new Uint8Array)).toBe("from a");
      expect4(text((await s.store.get(b, "same"))?.body ?? new Uint8Array)).toBe("from b");
      await s.store.delete(a, "same");
      expect4(text((await s.store.get(b, "same"))?.body ?? new Uint8Array)).toBe("from b");
    });
    test4("an Organization whose id starts with another id is a different Organization", async () => {
      const s = await subject();
      const { a, aExtended } = s.organizations;
      await s.store.put(a, "one", bytes("a"));
      await s.store.put(aExtended, "two", bytes("extended"));
      expect4(await keysOf(s, a)).toEqual(["one"]);
      expect4(await keysOf(s, aExtended)).toEqual(["two"]);
      expect4(await s.store.get(a, "two")).toBeUndefined();
      expect4(await s.store.get(aExtended, "one")).toBeUndefined();
      await s.store.delete(a, "two");
      expect4(await keysOf(s, aExtended)).toEqual(["two"]);
    });
    test4("a key cannot name another Organization through a path", async () => {
      const s = await subject();
      const { a, b } = s.organizations;
      await s.store.put(b, "secret.txt", bytes("b only"));
      for (const key of [
        `../${b}/secret.txt`,
        `/${b}/secret.txt`,
        `${b}/../${b}/secret.txt`,
        `..%2f${b}%2fsecret.txt`
      ]) {
        await expect4(s.store.get(a, key)).rejects.toMatchObject({ code: "storage.invalid_request" });
        await expect4(s.store.delete(a, key)).rejects.toMatchObject({
          code: "storage.invalid_request"
        });
      }
      for (const prefix of ["../", `../${b}/`, "/", `${a}/../${b}/`, "%2e%2e/", "*", ".."]) {
        await expect4(s.store.list(a, { prefix })).rejects.toMatchObject({
          code: "storage.invalid_request"
        });
      }
      expect4(text((await s.store.get(b, "secret.txt"))?.body ?? new Uint8Array)).toBe("b only");
    });
    test4("a list is a page, in key order, that ends with no cursor", async () => {
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
        expect4(page.items.length).toBeLessThanOrEqual(2);
        seen.push(...page.items.map((item) => item.key));
        for (const item of page.items) {
          expect4(item.size).toBe(item.key.length);
          expect4(item.lastModified).toBeInstanceOf(Date);
        }
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== undefined && pages < 10);
      expect4(seen).toEqual(["a", "b/1", "b/2", "c", "d"]);
      expect4(pages).toBe(3);
    });
    test4("a list without a limit returns at most 100", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await Promise.all(Array.from({ length: 105 }, (_, i) => s.store.put(a, `n${String(i).padStart(3, "0")}`, bytes("x"))));
      const page = await s.store.list(a);
      expect4(page.items).toHaveLength(100);
      expect4(page.nextCursor).toBeDefined();
      const rest = await s.store.list(a, { cursor: page.nextCursor });
      expect4(rest.items).toHaveLength(5);
      expect4(rest.nextCursor).toBeUndefined();
    });
    test4("a prefix keeps only the keys that start with it", async () => {
      const s = await subject();
      const { a } = s.organizations;
      for (const key of ["docs/a.txt", "docs/b.txt", "docs2/c.txt", "other/d.txt", "docsx"]) {
        await s.store.put(a, key, bytes("x"));
      }
      expect4(await keysOf(s, a, "docs/")).toEqual(["docs/a.txt", "docs/b.txt"]);
      expect4(await keysOf(s, a, "docs/a")).toEqual(["docs/a.txt"]);
      expect4(await keysOf(s, a, "docs")).toEqual([
        "docs/a.txt",
        "docs/b.txt",
        "docs2/c.txt",
        "docsx"
      ]);
      expect4(await keysOf(s, a, "nothing/")).toEqual([]);
    });
    test4.each([[0], [-1], [1001], [1.5], [Number.NaN]])("a list limit of %p is refused", async (limit) => {
      const s = await subject();
      await expect4(s.store.list(s.organizations.a, { limit })).rejects.toMatchObject({
        code: "storage.invalid_request"
      });
    });
    test4("a forged cursor is refused", async () => {
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
        await expect4(s.store.list(a, { cursor })).rejects.toMatchObject({
          code: "storage.invalid_request"
        });
      }
    });
    test4("one Organization's cursor used by another lists only the second one's objects", async () => {
      const s = await subject();
      const { a, b } = s.organizations;
      for (const key of ["k1", "k2", "k3"]) {
        await s.store.put(a, key, bytes("a"));
      }
      await s.store.put(b, "k9", bytes("b"));
      const page = await s.store.list(a, { limit: 1 });
      const cursor = page.nextCursor;
      const other = await s.store.list(b, { cursor });
      expect4(other.items.map((item) => item.key)).toEqual(["k9"]);
    });
    test4("the body that get returns is a copy", async () => {
      const s = await subject();
      const { a } = s.organizations;
      const original = bytes("keep");
      await s.store.put(a, "k", original);
      original[0] = 0;
      const first = await s.store.get(a, "k");
      (first?.body)[1] = 0;
      expect4(text((await s.store.get(a, "k"))?.body ?? new Uint8Array)).toBe("keep");
    });
    describe4("streaming", () => {
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
      test4("a streamed object reads back the same, with its size and SHA-256", async () => {
        const s = await subject();
        const { a } = s.organizations;
        const data = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
        const result = await s.store.putStream(a, "rec/one.bin", chunksOf(data), {
          maxBytes: 5000,
          contentType: "audio/mpeg"
        });
        expect4(result).toEqual({ size: 1000, sha256: sha(data) });
        const got = await s.store.get(a, "rec/one.bin");
        expect4(Array.from(got?.body ?? [])).toEqual(Array.from(data));
        expect4(got?.contentType).toBe("audio/mpeg");
        const streamed = await s.store.getStream(a, "rec/one.bin");
        expect4(streamed?.size).toBe(1000);
        expect4(Array.from(await readAll(streamed.body))).toEqual(Array.from(data));
      });
      test4("a web stream and an empty stream are accepted", async () => {
        const s = await subject();
        const { a } = s.organizations;
        const web = new ReadableStream({
          start(controller) {
            controller.enqueue(bytes("hel"));
            controller.enqueue(bytes("lo"));
            controller.close();
          }
        });
        expect4((await s.store.putStream(a, "web", web, { maxBytes: 10 })).size).toBe(5);
        expect4(text((await s.store.get(a, "web"))?.body ?? new Uint8Array)).toBe("hello");
        const empty = await s.store.putStream(a, "empty", chunksOf(new Uint8Array), {
          maxBytes: 10
        });
        expect4(empty).toEqual({ size: 0, sha256: sha(new Uint8Array) });
        expect4((await s.store.head(a, "empty"))?.size).toBe(0);
      });
      test4("a stream over maxBytes is refused, leaves nothing readable and keeps an older object", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await s.store.put(a, "old", bytes("old"));
        await expect4(s.store.putStream(a, "new", chunksOf(new Uint8Array(100)), { maxBytes: 99 })).rejects.toMatchObject({ code: "storage.object_too_large" });
        await expect4(s.store.putStream(a, "old", chunksOf(new Uint8Array(100)), { maxBytes: 99 })).rejects.toMatchObject({ code: "storage.object_too_large" });
        expect4(await s.store.head(a, "new")).toBeUndefined();
        expect4(text((await s.store.get(a, "old"))?.body ?? new Uint8Array)).toBe("old");
        expect4((await s.store.putStream(a, "exact", chunksOf(new Uint8Array(99)), { maxBytes: 99 })).size).toBe(99);
      });
      test4("a stream that fails midway leaves nothing readable", async () => {
        const s = await subject();
        const { a } = s.organizations;
        async function* broken() {
          yield bytes("some");
          throw new Error("the client went away");
        }
        await expect4(s.store.putStream(a, "half", broken(), { maxBytes: 100 })).rejects.toMatchObject({ code: "storage.invalid_request" });
        expect4(await s.store.head(a, "half")).toBeUndefined();
      });
      test4("an aborted signal stops the write and leaves nothing readable", async () => {
        const s = await subject();
        const { a } = s.organizations;
        const controller = new AbortController;
        async function* slow() {
          yield bytes("first");
          controller.abort();
          yield bytes("second");
        }
        await expect4(s.store.putStream(a, "aborted", slow(), { maxBytes: 100, signal: controller.signal })).rejects.toMatchObject({ code: "storage.unavailable" });
        expect4(await s.store.head(a, "aborted")).toBeUndefined();
      });
      test4.each([[0], [-1], [1.5], [Number.NaN], [2 ** 31 + 1], ["5"]])("maxBytes %p is refused", async (maxBytes) => {
        const s = await subject();
        const { a } = s.organizations;
        await expect4(s.store.putStream(a, "k", chunksOf(bytes("x")), { maxBytes })).rejects.toMatchObject({ code: "storage.invalid_request" });
      });
      test4("a body that is not a stream, a bad key and a bad Organization are refused", async () => {
        const s = await subject();
        const { a } = s.organizations;
        const options = { maxBytes: 10 };
        await expect4(s.store.putStream(a, "k", "text", options)).rejects.toMatchObject({ code: "storage.invalid_request" });
        await expect4(s.store.putStream(a, "../k", chunksOf(bytes("x")), options)).rejects.toMatchObject({ code: "storage.invalid_request" });
        await expect4(s.store.putStream("bad/org", "k", chunksOf(bytes("x")), options)).rejects.toMatchObject({ code: "storage.invalid_request" });
      });
      test4("a second Organization cannot read the first one's streamed object", async () => {
        const s = await subject();
        const { a, b } = s.organizations;
        await s.store.putStream(a, "rec", chunksOf(bytes("private")), { maxBytes: 100 });
        expect4(await s.store.getStream(b, "rec")).toBeUndefined();
        expect4(await s.store.getStream(a, "missing")).toBeUndefined();
      });
    });
    describe4("presigned reads", () => {
      test4("a presigned URL returns the object, and a missing object gives nothing", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await s.store.put(a, "rec/one.mp3", bytes("the audio"));
        const url = await s.store.presignGet(a, "rec/one.mp3", { expiresInSeconds: 300 });
        const missing = await s.store.presignGet(a, "rec/none.mp3", { expiresInSeconds: 300 });
        expect4(typeof url).toBe("string");
        expect4(["http:", "https:"]).toContain(new URL(url).protocol);
        expect4(text(await s.readPresigned(url) ?? new Uint8Array)).toBe("the audio");
        expect4(await s.readPresigned(missing)).toBeUndefined();
      });
      test4("a second Organization's URL for the same key reaches only its own object", async () => {
        const s = await subject();
        const { a, b } = s.organizations;
        await s.store.put(a, "rec/one.mp3", bytes("first org"));
        const other = await s.store.presignGet(b, "rec/one.mp3", { expiresInSeconds: 300 });
        const mine = await s.store.presignGet(a, "rec/one.mp3", { expiresInSeconds: 300 });
        expect4(other).not.toBe(mine);
        expect4(await s.readPresigned(other)).toBeUndefined();
        await s.store.put(b, "rec/one.mp3", bytes("second org"));
        expect4(text(await s.readPresigned(other) ?? new Uint8Array)).toBe("second org");
        expect4(text(await s.readPresigned(mine) ?? new Uint8Array)).toBe("first org");
      });
      test4("the expiry is 1 to 900 seconds and defaults to 300", async () => {
        const s = await subject();
        const { a } = s.organizations;
        for (const expiresInSeconds of [1, 300, 900]) {
          expect4(typeof await s.store.presignGet(a, "k", { expiresInSeconds })).toBe("string");
        }
        expect4(typeof await s.store.presignGet(a, "k")).toBe("string");
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
          await expect4(s.store.presignGet(a, "k", { expiresInSeconds })).rejects.toMatchObject({ code: "storage.invalid_request" });
        }
      });
      test4("a bad key or Organization is refused, and the refusal does not repeat the key", async () => {
        const s = await subject();
        const { a } = s.organizations;
        for (const key of BAD_KEYS.slice(0, 6)) {
          await expect4(s.store.presignGet(a, key, { expiresInSeconds: 60 })).rejects.toMatchObject({
            code: "storage.invalid_request"
          });
        }
        await expect4(s.store.presignGet("bad/org", "k", { expiresInSeconds: 60 })).rejects.toMatchObject({ code: "storage.invalid_request" });
        try {
          await s.store.presignGet(a, "secret-name/../x", { expiresInSeconds: 60 });
        } catch (error) {
          expect4(String(error.message)).not.toContain("secret-name");
        }
      });
    });
  });
}
// src/transcribe/behaviour.ts
import { afterEach as afterEach5, describe as describe5, expect as expect5, test as test5 } from "bun:test";
function transcriberBehaviour(name, make, skip = false) {
  const run = skip ? describe5.skip : describe5;
  run(`Transcriber behaviour: ${name}`, () => {
    const open = [];
    afterEach5(async () => {
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
      expect5(result?.status === "done" || result?.status === "failed").toBe(true);
      return result;
    }
    async function finalResultWith(s, org, reference, vendorId) {
      const result = await waitForTranscription2(s.transcriber, org, reference, {
        maxAttempts: 120,
        intervalMs: s.pollIntervalMs ?? 0,
        vendorId
      });
      expect5(result?.status === "done" || result?.status === "failed").toBe(true);
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
    test5("a send is created once and repeating it creates nothing", async () => {
      const s = await subject();
      const { a } = s.organizations;
      const first = await s.transcriber.submit(a, send("call_1:1"));
      const again = await s.transcriber.submit(a, send("call_1:1"));
      expect5(first).toMatchObject({ clientReference: "call_1:1", created: true });
      expect5(again).toMatchObject({ clientReference: "call_1:1", created: false });
      expect5(await references(s, a)).toEqual(["call_1:1"]);
    });
    test5("the same reference with another mode, speaker cap or audio key is a conflict", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.transcriber.submit(a, send("call_1:1", { maxSpeakers: 2, audioKey: "rec/1:abc" }));
      const conflict = { code: "transcriber.conflict" };
      await expect5(s.transcriber.submit(a, send("call_1:1", { speakers: "split_channels", audioKey: "rec/1:abc" }))).rejects.toMatchObject(conflict);
      await expect5(s.transcriber.submit(a, send("call_1:1", { maxSpeakers: 3, audioKey: "rec/1:abc" }))).rejects.toMatchObject(conflict);
      await expect5(s.transcriber.submit(a, send("call_1:1", { maxSpeakers: 2, audioKey: "rec/2:def" }))).rejects.toMatchObject(conflict);
      expect5(await references(s, a)).toEqual(["call_1:1"]);
    });
    test5("a retry with a freshly presigned URL is the same send, not a conflict", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.transcriber.submit(a, send("call_1:1", { audioKey: "rec/1:abc" }));
      const again = await s.transcriber.submit(a, send("call_1:1", {
        audio: { url: "https://audio.example.test/call_1.mp3?sig=NEWSIGNATURE&expires=2" },
        audioKey: "rec/1:abc"
      }));
      expect5(again.created).toBe(false);
      expect5(await references(s, a)).toEqual(["call_1:1"]);
    });
    test5("a result is pending at first or final, and a final one passes the shared result check", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.transcriber.submit(a, send("call_1:1", { maxSpeakers: 2 }));
      const first = await s.transcriber.getResult(a, "call_1:1");
      expect5(["pending", "done", "failed"]).toContain(first?.status);
      const final = await finalResult(s, a, "call_1:1");
      checkTranscriptionResult2(final, { speakers: "diarize", maxSpeakers: 2 });
      expect5(checkTranscriptionResult2(await s.transcriber.getResult(a, "call_1:1"))).toEqual(final);
    });
    test5("a split-channels result carries the channel of every turn", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.transcriber.submit(a, send("call_1:2", { speakers: "split_channels" }));
      const final = await finalResult(s, a, "call_1:2");
      checkTranscriptionResult2(final, { speakers: "split_channels" });
    });
    test5("a send that was never made, or was deleted, has no result", async () => {
      const s = await subject();
      const { a } = s.organizations;
      expect5(await s.transcriber.getResult(a, "nope")).toBeUndefined();
      await s.transcriber.submit(a, send("call_1:1"));
      await s.transcriber.delete(a, "call_1:1");
      expect5(await s.transcriber.getResult(a, "call_1:1")).toBeUndefined();
    });
    test5("delete reports whether a copy existed and can be repeated", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.transcriber.submit(a, send("call_1:1"));
      expect5(await s.transcriber.delete(a, "call_1:1")).toEqual({ existed: true });
      expect5(await s.transcriber.delete(a, "call_1:1")).toEqual({ existed: false });
      expect5(await s.transcriber.delete(a, "never_sent:1")).toEqual({ existed: false });
      expect5(await references(s, a)).toEqual([]);
    });
    test5("a deleted reference can be sent again as a new send", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.transcriber.submit(a, send("call_1:1"));
      await s.transcriber.delete(a, "call_1:1");
      expect5((await s.transcriber.submit(a, send("call_1:1"))).created).toBe(true);
    });
    test5("list finds sends by reference prefix, in order, in pages", async () => {
      const s = await subject();
      const { a } = s.organizations;
      for (const reference of ["call_2:1", "call_1:2", "call_1:1", "call_1:3", "other"]) {
        await s.transcriber.submit(a, send(reference));
      }
      expect5(await references(s, a, "call_1:")).toEqual(["call_1:1", "call_1:2", "call_1:3"]);
      expect5(await references(s, a)).toEqual([
        "call_1:1",
        "call_1:2",
        "call_1:3",
        "call_2:1",
        "other"
      ]);
      const first = await s.transcriber.list(a, { prefix: "call_1:", limit: 2 });
      expect5(first.items).toHaveLength(2);
      expect5(first.nextCursor).toBeDefined();
      expect5(["pending", "done", "failed"]).toContain(first.items[0]?.status);
      const seen = first.items.map((item) => item.clientReference);
      let cursor = first.nextCursor;
      for (let pages = 0;cursor !== undefined && pages < 20; pages++) {
        const next = await s.transcriber.list(a, { prefix: "call_1:", limit: 2, cursor });
        seen.push(...next.items.map((item) => item.clientReference));
        cursor = next.nextCursor;
      }
      expect5(seen).toEqual(["call_1:1", "call_1:2", "call_1:3"]);
    });
    describe5("the vendor id", () => {
      test5("submit returns an opaque bounded id, the same one when the send is repeated", async () => {
        const s = await subject();
        const { a } = s.organizations;
        const first = await s.transcriber.submit(a, send("call_1:1"));
        const again = await s.transcriber.submit(a, send("call_1:1"));
        expect5(first.vendorId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
        expect5(again.vendorId).toBe(first.vendorId);
      });
      test5("list carries the id of each send", async () => {
        const s = await subject();
        const { a } = s.organizations;
        const one = await s.transcriber.submit(a, send("call_1:1"));
        const two = await s.transcriber.submit(a, send("call_1:2"));
        const page = await s.transcriber.list(a, { prefix: "call_1:" });
        const ids = new Map(page.items.map((item) => [item.clientReference, item.vendorId]));
        expect5(ids.get("call_1:1")).toBe(one.vendorId);
        expect5(ids.get("call_1:2")).toBe(two.vendorId);
      });
      test5("a read and a delete with the right id work as they do by reference alone", async () => {
        const s = await subject();
        const { a } = s.organizations;
        const { vendorId } = await s.transcriber.submit(a, send("call_1:1"));
        const result = await finalResultWith(s, a, "call_1:1", vendorId);
        expect5(result.status === "done" || result.status === "failed").toBe(true);
        expect5(await s.transcriber.delete(a, "call_1:1", { vendorId })).toEqual({ existed: true });
        expect5(await s.transcriber.getResult(a, "call_1:1", { vendorId })).toBeUndefined();
        expect5(await s.transcriber.delete(a, "call_1:1", { vendorId })).toEqual({ existed: false });
      });
      test5("an id that names another reference's send is ignored: the call is about the reference", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await s.transcriber.submit(a, send("call_1:1"));
        const other = await s.transcriber.submit(a, send("call_1:2"));
        expect5(await s.transcriber.getResult(a, "call_1:1", { vendorId: other.vendorId })).toBeDefined();
        expect5(await s.transcriber.delete(a, "call_1:1", { vendorId: other.vendorId })).toEqual({
          existed: true
        });
        expect5(await references(s, a)).toEqual(["call_1:2"]);
        expect5(await s.transcriber.getResult(a, "call_1:9", { vendorId: other.vendorId })).toBeUndefined();
        expect5(await s.transcriber.delete(a, "call_1:9", { vendorId: other.vendorId })).toEqual({
          existed: false
        });
        expect5(await references(s, a)).toEqual(["call_1:2"]);
      });
      test5("an id from another Organization is ignored and never reaches that Organization's send", async () => {
        const s = await subject();
        const { a, b } = s.organizations;
        const mine = await s.transcriber.submit(a, send("call_1:1"));
        await s.transcriber.submit(b, send("call_1:1", { speakers: "split_channels" }));
        expect5(await s.transcriber.delete(b, "call_1:1", { vendorId: mine.vendorId })).toEqual({
          existed: true
        });
        expect5(await references(s, a)).toEqual(["call_1:1"]);
        expect5(await references(s, b)).toEqual([]);
        expect5(await s.transcriber.getResult(b, "call_1:1", { vendorId: mine.vendorId })).toBeUndefined();
        expect5(await s.transcriber.delete(b, "call_1:1", { vendorId: mine.vendorId })).toEqual({
          existed: false
        });
        expect5(await s.transcriber.getResult(a, "call_1:1")).toBeDefined();
      });
      test5("an id the vendor does not know falls back to the reference", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await s.transcriber.submit(a, send("call_1:1"));
        expect5(await s.transcriber.getResult(a, "call_1:1", { vendorId: "unknown-id-1" })).toBeDefined();
        expect5(await s.transcriber.delete(a, "call_1:1", { vendorId: "unknown-id-1" })).toEqual({
          existed: true
        });
      });
      test5.each([
        ["empty", ""],
        ["with a space", "a b"],
        ["with a slash", "a/b"],
        ["over 128 characters", "a".repeat(129)],
        ["not a string", 5]
      ])("an id that is %s is refused", async (_label, vendorId) => {
        const s = await subject();
        const { a } = s.organizations;
        await s.transcriber.submit(a, send("call_1:1"));
        await expect5(s.transcriber.getResult(a, "call_1:1", { vendorId })).rejects.toMatchObject(invalid);
        await expect5(s.transcriber.delete(a, "call_1:1", { vendorId })).rejects.toMatchObject(invalid);
        expect5(await references(s, a)).toEqual(["call_1:1"]);
      });
      test5("a hint with the id of a deleted job is ignored and acts on the resubmitted one", async () => {
        const s = await subject();
        const { a } = s.organizations;
        const old = await s.transcriber.submit(a, send("call_1:1"));
        await s.transcriber.delete(a, "call_1:1");
        const fresh = await s.transcriber.submit(a, send("call_1:1"));
        expect5(fresh.created).toBe(true);
        expect5(await s.transcriber.getResult(a, "call_1:1", { vendorId: old.vendorId })).toBeDefined();
        expect5(await s.transcriber.delete(a, "call_1:1", { vendorId: old.vendorId })).toEqual({
          existed: true
        });
        expect5(await references(s, a)).toEqual([]);
      });
      test5("a send submitted through one instance is listed and deleted through another", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await s.transcriber.submit(a, send("call_1:1"));
        const other = await s.reopen();
        const found = await other.list(a, { prefix: "call_1:" });
        expect5(found.items.map((item) => item.clientReference)).toEqual(["call_1:1"]);
        expect5(await other.delete(a, "call_1:1")).toEqual({ existed: true });
        expect5(await references(s, a)).toEqual([]);
      });
      test5("a send whose id was never kept is found by listing for its reference and deleted without it", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await s.transcriber.submit(a, send("call_1:1"));
        await s.transcriber.submit(a, send("call_1:2"));
        await s.transcriber.submit(a, send("call_9:1"));
        const found = await s.transcriber.list(a, { prefix: "call_1:" });
        for (const entry of found.items) {
          expect5(entry.vendorId).toBeDefined();
          expect5(await s.transcriber.delete(a, entry.clientReference)).toEqual({ existed: true });
        }
        expect5(await references(s, a)).toEqual(["call_9:1"]);
      });
    });
    test5("concurrent submits of one reference create it once", async () => {
      const s = await subject();
      const { a } = s.organizations;
      const answers = await Promise.all(Array.from({ length: 8 }, () => s.transcriber.submit(a, send("call_1:1"))));
      expect5(answers.filter((answer) => answer.created)).toHaveLength(1);
      expect5(await references(s, a)).toEqual(["call_1:1"]);
    });
    test5("a prefix that ends with the separator does not match a longer id", async () => {
      const s = await subject();
      const { a } = s.organizations;
      for (const reference of ["call_1:1", "call_10:1"]) {
        await s.transcriber.submit(a, send(reference));
      }
      expect5(await references(s, a, "call_1:")).toEqual(["call_1:1"]);
    });
    test5("a purge by prefix removes sends the caller kept no record of", async () => {
      const s = await subject();
      const { a } = s.organizations;
      for (const reference of ["call_1:1", "call_1:2", "call_9:1"]) {
        await s.transcriber.submit(a, send(reference));
      }
      for (const reference of await references(s, a, "call_1:")) {
        await s.transcriber.delete(a, reference);
      }
      expect5(await references(s, a)).toEqual(["call_9:1"]);
    });
    test5("a second Organization cannot read, delete or list the first one's sends, and may reuse a reference", async () => {
      const s = await subject();
      const { a, b } = s.organizations;
      await s.transcriber.submit(a, send("call_1:1"));
      expect5(await s.transcriber.getResult(b, "call_1:1")).toBeUndefined();
      expect5(await s.transcriber.delete(b, "call_1:1")).toEqual({ existed: false });
      expect5(await references(s, b)).toEqual([]);
      expect5((await s.transcriber.submit(b, send("call_1:1", { speakers: "split_channels" }))).created).toBe(true);
      expect5(await references(s, a)).toEqual(["call_1:1"]);
      await s.transcriber.delete(b, "call_1:1");
      expect5(await s.transcriber.getResult(a, "call_1:1")).toBeDefined();
    });
    test5("an Organization whose id starts with another id is a different Organization", async () => {
      const s = await subject();
      const { a, aExtended } = s.organizations;
      await s.transcriber.submit(a, send("call_1:1"));
      expect5(await references(s, aExtended)).toEqual([]);
      expect5(await s.transcriber.getResult(aExtended, "call_1:1")).toBeUndefined();
    });
    test5.each([
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
      await expect5(s.transcriber.submit(a, { ...send("call_1:1"), ...change })).rejects.toMatchObject(invalid);
      expect5(await references(s, a)).toEqual([]);
    });
    test5("the refusal of a bad send never repeats the audio URL", async () => {
      const s = await subject();
      const { a } = s.organizations;
      const secret = "https://user:SECRETPASSWORD@example.test/a?sig=SECRETSIG";
      try {
        await s.transcriber.submit(a, { ...send("call_1:1"), audio: { url: secret } });
        throw new Error("the send was accepted");
      } catch (error) {
        expect5(JSON.stringify(error)).not.toContain("SECRET");
        expect5(String(error.message)).not.toContain("SECRET");
      }
    });
    test5.each([
      ["a bad Organization id", "bad/org", "call_1:1"],
      ["a bad reference", undefined, "bad ref"]
    ])("reads and deletes with %s are refused", async (_label, org, reference) => {
      const s = await subject();
      const id = org ?? s.organizations.a;
      await expect5(s.transcriber.getResult(id, reference)).rejects.toMatchObject(invalid);
      await expect5(s.transcriber.delete(id, reference)).rejects.toMatchObject(invalid);
    });
    test5.each([
      [{ limit: 0 }],
      [{ limit: 1001 }],
      [{ limit: 1.5 }],
      [{ prefix: "bad prefix" }],
      [{ cursor: "!!!" }]
    ])("list options %p are refused", async (options) => {
      const s = await subject();
      await expect5(s.transcriber.list(s.organizations.a, options)).rejects.toMatchObject(invalid);
    });
  });
}
// src/vector/behaviour.ts
import { afterEach as afterEach6, describe as describe6, expect as expect6, test as test6 } from "bun:test";
function vectorStoreBehaviour(name, make, skip = false) {
  const run = skip ? describe6.skip : describe6;
  run(`VectorStore behaviour: ${name}`, () => {
    const open = [];
    afterEach6(async () => {
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
    test6("a search returns the closest vectors first, with cosine scores and attributes", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await seed(s);
      const hits = await s.store.search(a, { vector: vec(s, 1, 0, 0), topK: 4 });
      expect6(ids(hits).slice(0, 2)).toEqual(["x", "xy"]);
      expect6(hits[0]?.score).toBeCloseTo(1, 4);
      expect6(hits[1]?.score).toBeCloseTo(Math.SQRT1_2, 4);
      expect6(hits[0]?.attributes).toEqual({ document_id: "doc_1", page: 1 });
      expect6(hits.find((hit) => hit.id === "z")?.attributes).toEqual({});
    });
    test6("a score does not depend on the length of either vector", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.store.upsert(a, [{ id: "long", vector: vec(s, 50, 0, 0) }]);
      const [hit] = await s.store.search(a, { vector: vec(s, 0.001, 0, 0), topK: 1 });
      expect6(hit?.id).toBe("long");
      expect6(hit?.score).toBeCloseTo(1, 4);
    });
    test6("topK bounds the results", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await seed(s);
      expect6(await s.store.search(a, { vector: vec(s, 1, 1, 1), topK: 2 })).toHaveLength(2);
      expect6(await s.store.search(a, { vector: vec(s, 1, 1, 1), topK: 100 })).toHaveLength(4);
      expect6(await s.store.search(s.organizations.b, { vector: vec(s, 1), topK: 5 })).toEqual([]);
    });
    test6.each([[0], [-1], [101], [1.5], [Number.NaN], ["5"]])("a topK of %p is refused", async (topK) => {
      const s = await subject();
      await expect6(s.store.search(s.organizations.a, { vector: vec(s, 1), topK })).rejects.toMatchObject(invalid);
    });
    test6("a filter keeps vectors whose attributes equal every entry", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await seed(s);
      const search = async (filter) => ids(await s.store.search(a, { vector: vec(s, 1, 1, 1), topK: 10, filter })).sort();
      expect6(await search({ document_id: "doc_1" })).toEqual(["x", "y"]);
      expect6(await search({ document_id: "doc_1", page: 2 })).toEqual(["y"]);
      expect6(await search({ final: true })).toEqual(["xy"]);
      expect6(await search({ page: 1 })).toEqual(["x", "xy"]);
      expect6(await search({ document_id: "nope" })).toEqual([]);
      expect6(await search({ page: "1" })).toEqual([]);
    });
    test6("a vector of the wrong length is a non-retryable dimension error and writes nothing", async () => {
      const s = await subject();
      const { a } = s.organizations;
      const code = { code: "vector.dimension_mismatch" };
      const short = Array.from({ length: s.store.dimensions - 1 }, () => 1);
      const long = Array.from({ length: s.store.dimensions + 1 }, () => 1);
      await expect6(s.store.search(a, { vector: short, topK: 1 })).rejects.toMatchObject(code);
      await expect6(s.store.search(a, { vector: long, topK: 1 })).rejects.toMatchObject(code);
      await expect6(s.store.upsert(a, [
        { id: "fine", vector: vec(s, 1) },
        { id: "short", vector: short }
      ])).rejects.toMatchObject(code);
      expect6(await s.store.search(a, { vector: vec(s, 1), topK: 10 })).toEqual([]);
    });
    test6.each([
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
      await expect6(s.store.upsert(a, [{ id: "v", vector }])).rejects.toMatchObject(invalid);
      await expect6(s.store.search(a, { vector, topK: 1 })).rejects.toMatchObject(invalid);
    });
    test6.each([
      ["an empty id", ""],
      ["a slash", "a/b"],
      ["a leading dot", ".x"],
      ["a space", "a b"],
      ["a long id", "x".repeat(65)]
    ])("an id with %s is refused", async (_label, id) => {
      const s = await subject();
      const { a } = s.organizations;
      await expect6(s.store.upsert(a, [{ id, vector: vec(s, 1) }])).rejects.toMatchObject(invalid);
      await expect6(s.store.delete(a, [id])).rejects.toMatchObject(invalid);
    });
    test6("a batch of 0 or 501 records, or one with a repeated id, is refused", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await expect6(s.store.upsert(a, [])).rejects.toMatchObject(invalid);
      const many = Array.from({ length: 501 }, (_, i) => ({ id: `v${i}`, vector: vec(s, 1) }));
      await expect6(s.store.upsert(a, many)).rejects.toMatchObject(invalid);
      await expect6(s.store.upsert(a, [
        { id: "same", vector: vec(s, 1) },
        { id: "same", vector: vec(s, 0, 1) }
      ])).rejects.toMatchObject(invalid);
      await expect6(s.store.delete(a, [])).rejects.toMatchObject(invalid);
      await expect6(s.store.delete(a, Array.from({ length: 501 }, (_, i) => `v${i}`))).rejects.toMatchObject(invalid);
      expect6(await s.store.search(a, { vector: vec(s, 1), topK: 10 })).toEqual([]);
    });
    test6.each([
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
      await expect6(s.store.upsert(a, [{ id: "v", vector: vec(s, 1), attributes }])).rejects.toMatchObject(invalid);
      await expect6(s.store.search(a, { vector: vec(s, 1), topK: 1, filter: attributes })).rejects.toMatchObject(invalid);
      await expect6(s.store.deleteByFilter(a, attributes)).rejects.toMatchObject(invalid);
    });
    test6("storing an id again replaces its vector and attributes, and doing it twice changes nothing", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.store.upsert(a, [{ id: "v", vector: vec(s, 1), attributes: { n: 1 } }]);
      const replacement = [{ id: "v", vector: vec(s, 0, 1), attributes: { n: 2 } }];
      await s.store.upsert(a, replacement);
      await s.store.upsert(a, replacement);
      const hits = await s.store.search(a, { vector: vec(s, 0, 1), topK: 10 });
      expect6(ids(hits)).toEqual(["v"]);
      expect6(hits[0]?.score).toBeCloseTo(1, 4);
      expect6(hits[0]?.attributes).toEqual({ n: 2 });
    });
    describe6("setAttributes", () => {
      const query = (s) => ({ vector: vec(s, 1, 1, 0), topK: 10 });
      test6("merges the attributes, leaves the others and the vector as they were", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await seed(s);
        const before = await s.store.search(a, query(s));
        const missing = await s.store.setAttributes(a, ["x", "xy"], { outcome: "won", seq: 2 });
        const after = await s.store.search(a, query(s));
        expect6(missing).toEqual([]);
        expect6(after.map((hit) => [hit.id, hit.score])).toEqual(before.map((hit) => [hit.id, hit.score]));
        const byId = Object.fromEntries(after.map((hit) => [hit.id, hit.attributes]));
        expect6(byId.x).toEqual({ document_id: "doc_1", page: 1, outcome: "won", seq: 2 });
        expect6(byId.xy).toEqual({
          document_id: "doc_2",
          page: 1,
          final: true,
          outcome: "won",
          seq: 2
        });
        expect6(byId.y).toEqual({ document_id: "doc_1", page: 2 });
        expect6(byId.z).toEqual({});
      });
      test6("overwrites a value that exists and keeps the rest", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await seed(s);
        await s.store.setAttributes(a, ["x"], { page: 9 });
        const hit = (await s.store.search(a, query(s))).find((item) => item.id === "x");
        expect6(hit?.attributes).toEqual({ document_id: "doc_1", page: 9 });
      });
      test6("reports ids it did not find, in order, and does not create them", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await seed(s);
        const missing = await s.store.setAttributes(a, ["nope", "x", "gone"], { outcome: "lost" });
        expect6(missing).toEqual(["nope", "gone"]);
        const all = await s.store.search(a, { vector: vec(s, 1), topK: 100 });
        expect6(ids(all).sort()).toEqual(["x", "xy", "y", "z"]);
        expect6(await s.store.setAttributes(s.organizations.b, ["x"], { n: 1 })).toEqual(["x"]);
      });
      test6("an Organization with no vectors reports every id and creates nothing", async () => {
        const s = await subject();
        const { a } = s.organizations;
        expect6(await s.store.setAttributes(a, ["x", "y"], { n: 1 })).toEqual(["x", "y"]);
        expect6(await s.store.search(a, { vector: vec(s, 1), topK: 10 })).toEqual([]);
      });
      test6("more than the upsert maximum, none, or a repeated id is refused and records nothing", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await seed(s);
        const many = ["x", ...Array.from({ length: 500 }, (_, i) => `v${i}`)];
        await expect6(s.store.setAttributes(a, many, { n: 1 })).rejects.toMatchObject(invalid);
        await expect6(s.store.setAttributes(a, [], { n: 1 })).rejects.toMatchObject(invalid);
        await expect6(s.store.setAttributes(a, ["x", "x"], { n: 1 })).rejects.toMatchObject(invalid);
        await expect6(s.store.setAttributes(a, ["bad id"], { n: 1 })).rejects.toMatchObject(invalid);
        const atMax = Array.from({ length: 500 }, (_, i) => `v${i}`);
        expect6(await s.store.setAttributes(a, atMax, { n: 1 })).toHaveLength(500);
        const x = (await s.store.search(a, { vector: vec(s, 1), topK: 1 }))[0];
        expect6(x?.attributes).toEqual({ document_id: "doc_1", page: 1 });
      });
      test6("a second Organization's vectors with the same ids are untouched", async () => {
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
        expect6(other).toEqual([]);
        const mine = await s.store.search(a, {
          vector: vec(s, 1),
          topK: 10,
          filter: { outcome: "won" }
        });
        expect6(ids(mine).sort()).toEqual(["x", "y"]);
      });
      test6("repeating the call changes nothing", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await seed(s);
        await s.store.setAttributes(a, ["x", "nope"], { outcome: "won" });
        const once = await s.store.search(a, query(s));
        const missing = await s.store.setAttributes(a, ["x", "nope"], { outcome: "won" });
        expect6(missing).toEqual(["nope"]);
        expect6(await s.store.search(a, query(s))).toEqual(once);
      });
      test6("a filter on the changed attribute sees the new value and not the old", async () => {
        const s = await subject();
        const { a } = s.organizations;
        await seed(s);
        await s.store.setAttributes(a, ["x"], { outcome: "open" });
        await s.store.setAttributes(a, ["x"], { outcome: "won" });
        const search = (outcome) => s.store.search(a, { vector: vec(s, 1), topK: 10, filter: { outcome } });
        expect6(ids(await search("won"))).toEqual(["x"]);
        expect6(await search("open")).toEqual([]);
      });
      test6.each([
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
        await expect6(s.store.setAttributes(a, ["x"], attributes)).rejects.toMatchObject(invalid);
        const x = (await s.store.search(a, { vector: vec(s, 1), topK: 1 }))[0];
        expect6(x?.attributes).toEqual({ document_id: "doc_1", page: 1 });
      });
      test6("a merge that would give a vector more than 16 attributes is refused and writes nothing", async () => {
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
        await expect6(s.store.setAttributes(a, ["room", "full"], { extra: 1 })).rejects.toMatchObject(invalid);
        const room = (await s.store.search(a, { vector: vec(s, 0, 1), topK: 2 })).find((hit) => hit.id === "room");
        expect6(room?.attributes).toEqual({ k0: 1 });
        expect6(await s.store.setAttributes(a, ["full"], { k0: 2 })).toEqual([]);
      });
      test6("an invalid Organization id is refused", async () => {
        const s = await subject();
        await expect6(s.store.setAttributes("not an org", ["x"], { n: 1 })).rejects.toMatchObject(invalid);
      });
    });
    test6("deleting by id removes those vectors, ignores unknown ids and can be repeated", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await seed(s);
      await s.store.delete(a, ["x", "missing"]);
      await s.store.delete(a, ["x", "missing"]);
      expect6(ids(await s.store.search(a, { vector: vec(s, 1, 1, 1), topK: 10 })).sort()).toEqual([
        "xy",
        "y",
        "z"
      ]);
    });
    test6("deleting by filter removes the matching vectors only, and an empty filter is refused", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await seed(s);
      await expect6(s.store.deleteByFilter(a, {})).rejects.toMatchObject(invalid);
      await s.store.deleteByFilter(a, { document_id: "doc_1" });
      await s.store.deleteByFilter(a, { document_id: "doc_1" });
      await s.store.deleteByFilter(a, { document_id: "never" });
      expect6(ids(await s.store.search(a, { vector: vec(s, 1, 1, 1), topK: 10 })).sort()).toEqual([
        "xy",
        "z"
      ]);
    });
    test6("a second Organization cannot search, overwrite or delete the first one's vectors", async () => {
      const s = await subject();
      const { a, b } = s.organizations;
      await seed(s, a);
      expect6(await s.store.search(b, { vector: vec(s, 1, 0, 0), topK: 100 })).toEqual([]);
      expect6(await s.store.search(b, {
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
      expect6(ids(mine).sort()).toEqual(["x", "xy", "y", "z"]);
      expect6(mine.find((hit) => hit.id === "x")?.attributes).toEqual({
        document_id: "doc_1",
        page: 1
      });
      const theirs = await s.store.search(b, { vector: vec(s, 1, 0, 0), topK: 100 });
      expect6(ids(theirs)).toEqual(["x"]);
      expect6(theirs[0]?.attributes).toEqual({ document_id: "b_doc" });
    });
    test6("an Organization whose id starts with another id is a different Organization", async () => {
      const s = await subject();
      const { a, aExtended } = s.organizations;
      await s.store.upsert(a, [{ id: "one", vector: vec(s, 1) }]);
      await s.store.upsert(aExtended, [{ id: "two", vector: vec(s, 1) }]);
      expect6(ids(await s.store.search(a, { vector: vec(s, 1), topK: 10 }))).toEqual(["one"]);
      expect6(ids(await s.store.search(aExtended, { vector: vec(s, 1), topK: 10 }))).toEqual(["two"]);
      await s.store.delete(a, ["two"]);
      await s.store.deleteByFilter(a, { n: 1 });
      expect6(ids(await s.store.search(aExtended, { vector: vec(s, 1), topK: 10 }))).toEqual(["two"]);
    });
    test6("an id of exactly 64 characters is accepted", async () => {
      const s = await subject();
      const { a } = s.organizations;
      const id = "x".repeat(64);
      await s.store.upsert(a, [{ id, vector: vec(s, 1) }]);
      expect6(ids(await s.store.search(a, { vector: vec(s, 1), topK: 1 }))).toEqual([id]);
    });
    test6("deleting everything an Organization has leaves other Organizations alone and can be repeated", async () => {
      const s = await subject();
      const { a, b, aExtended } = s.organizations;
      await seed(s, a);
      await seed(s, b);
      await seed(s, aExtended);
      await s.store.deleteAll(a);
      await s.store.deleteAll(a);
      await s.store.deleteAll(`${a.slice(0, -1)}9`);
      expect6(await s.store.search(a, { vector: vec(s, 1, 1, 1), topK: 10 })).toEqual([]);
      expect6(await s.store.search(b, { vector: vec(s, 1, 1, 1), topK: 10 })).toHaveLength(4);
      expect6(await s.store.search(aExtended, { vector: vec(s, 1, 1, 1), topK: 10 })).toHaveLength(4);
      await s.store.upsert(a, [{ id: "again", vector: vec(s, 1) }]);
      expect6(ids(await s.store.search(a, { vector: vec(s, 1), topK: 10 }))).toEqual(["again"]);
    });
    test6("warming an Organization changes nothing and works with or without data", async () => {
      const s = await subject();
      const { a, b } = s.organizations;
      await s.store.warm(b);
      await seed(s, a);
      await s.store.warm(a);
      await s.store.warm(a);
      expect6(await s.store.search(a, { vector: vec(s, 1, 1, 1), topK: 10 })).toHaveLength(4);
      expect6(await s.store.search(b, { vector: vec(s, 1, 1, 1), topK: 10 })).toEqual([]);
    });
    test6.each([
      ["empty", ""],
      ["a path", "org/../x"],
      ["a separator", "x/y"],
      ["an encoded separator", "x%2Fy"],
      ["a wildcard", "x*"],
      ["too long", "x".repeat(65)]
    ])("an Organization id that is %s is refused by every operation", async (_label, id) => {
      const s = await subject();
      await expect6(s.store.upsert(id, [{ id: "v", vector: vec(s, 1) }])).rejects.toMatchObject(invalid);
      await expect6(s.store.search(id, { vector: vec(s, 1), topK: 1 })).rejects.toMatchObject(invalid);
      await expect6(s.store.delete(id, ["v"])).rejects.toMatchObject(invalid);
      await expect6(s.store.deleteByFilter(id, { n: 1 })).rejects.toMatchObject(invalid);
      await expect6(s.store.deleteAll(id)).rejects.toMatchObject(invalid);
      await expect6(s.store.warm(id)).rejects.toMatchObject(invalid);
    });
  });
}
export {
  contactGuardBehaviour,
  objectStoreBehaviour,
  processedStoreBehaviour,
  queueBehaviour,
  transcriberBehaviour,
  vectorStoreBehaviour
};
