import {
  MAX_MESSAGE_BYTES2
} from "./shared/chunk-mjkmsg3r.js";

// src/queue/behaviour.ts
import { afterEach, describe, expect, test } from "bun:test";
function queueBehaviour(name, make, skip = false) {
  const run = skip ? describe.skip : describe;
  run(`Queue behaviour: ${name}`, () => {
    const open = [];
    afterEach(async () => {
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
    test("publishing an envelope of an unknown type is refused and nothing is sent", async () => {
      const s = await subject();
      const bad = { ...ping(s), type: "test.nope" };
      await expect(s.queue.publish(bad)).rejects.toMatchObject({ code: "queue.invalid_message" });
      expect(await none(s)).toEqual([]);
    });
    test("publishing a payload that fails its schema is refused", async () => {
      const s = await subject();
      const bad = { ...ping(s), payload: { n: "x" } };
      await expect(s.queue.publish(bad)).rejects.toMatchObject({ code: "queue.invalid_message" });
    });
    test("an organization message without an organization id is refused, and a global one with it", async () => {
      const s = await subject();
      const noOrg = { ...ping(s), organizationId: undefined };
      await expect(s.queue.publish(noOrg)).rejects.toMatchObject({ code: "queue.invalid_message" });
      const note = s.registry.create({ type: "test.note", payload: { text: "hi" }, traceId: "t" });
      const withOrg = { ...note, organizationId: "org_a" };
      await expect(s.queue.publish(withOrg)).rejects.toMatchObject({
        code: "queue.invalid_message"
      });
    });
    test("a message over 256 KiB is refused with a clear error", async () => {
      const s = await subject();
      const big = s.registry.create({
        type: "test.note",
        payload: { text: "x".repeat(MAX_MESSAGE_BYTES2) },
        traceId: "t"
      });
      await expect(s.queue.publish(big)).rejects.toMatchObject({ code: "queue.message_too_large" });
      expect(await none(s)).toEqual([]);
    });
    test("a batch of 11, an empty batch, or over 256 KiB in total is refused before anything is sent", async () => {
      const s = await subject();
      const eleven = Array.from({ length: 11 }, (_, i) => ping(s, i));
      await expect(s.queue.publishBatch(eleven)).rejects.toMatchObject({
        code: "queue.batch_too_large"
      });
      await expect(s.queue.publishBatch([])).rejects.toMatchObject({
        code: "queue.batch_too_large"
      });
      const half = (text) => s.registry.create({ type: "test.note", payload: { text }, traceId: "t" });
      const heavy = [half("a".repeat(150000)), half("b".repeat(150000))];
      await expect(s.queue.publishBatch(heavy)).rejects.toMatchObject({
        code: "queue.batch_too_large"
      });
      expect(await none(s)).toEqual([]);
    });
    test.each([
      [{ maxMessages: 0, visibilityTimeoutSeconds: 5, waitSeconds: 0 }],
      [{ maxMessages: 11, visibilityTimeoutSeconds: 5, waitSeconds: 0 }],
      [{ maxMessages: 1, visibilityTimeoutSeconds: -1, waitSeconds: 0 }],
      [{ maxMessages: 1, visibilityTimeoutSeconds: 5, waitSeconds: 21 }],
      [{ maxMessages: 1, visibilityTimeoutSeconds: 1.5, waitSeconds: 0 }]
    ])("receive with out-of-range arguments %j is refused", async (args) => {
      const s = await subject();
      await expect(s.queue.receive(args)).rejects.toMatchObject({ code: "queue.invalid_request" });
    });
    test("a body that is not a valid message comes back as invalid, with no body in it", async () => {
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
      expect(got).toHaveLength(cases.length);
      expect(got.every((delivery) => delivery.kind === "invalid")).toBe(true);
      const reasons = got.map((delivery) => delivery.kind === "invalid" ? delivery.reason : "");
      expect([...reasons].sort()).toEqual(cases.map(([, , reason]) => reason).sort());
      expect(JSON.stringify(got)).not.toContain(secret);
    });
    test("an invalid message that is never acknowledged is delivered maxReceiveCount times and then taken out of circulation", async () => {
      const s = await subject();
      await s.injectRaw('{"broken":');
      for (let round = 0;round < s.maxReceiveCount; round++) {
        const got = await take(s, 1);
        expect(got).toHaveLength(1);
        expect(got[0]?.receiveCount).toBe(round + 1);
        await s.queue.release(got[0].receipt);
      }
      expect(await none(s)).toEqual([]);
    });
    test("extending visibility of an acknowledged message is refused with queue.receipt_invalid", async () => {
      const s = await subject();
      await s.queue.publish(ping(s));
      const [got] = await take(s, 1);
      const receipt = got.receipt;
      await s.queue.acknowledge(receipt);
      await expect(s.queue.extendVisibility(receipt, 10)).rejects.toMatchObject({
        code: "queue.receipt_invalid"
      });
    });
    test("acknowledging twice resolves both times", async () => {
      const s = await subject();
      await s.queue.publish(ping(s));
      const [got] = await take(s, 1);
      const receipt = got.receipt;
      await s.queue.acknowledge(receipt);
      await expect(s.queue.acknowledge(receipt)).resolves.toBeUndefined();
    });
    test("a published message arrives with every envelope field intact", async () => {
      const s = await subject();
      const sent = ping(s, 7, "org_a", "msg_1");
      await s.queue.publish(sent);
      const [got] = await take(s, 1);
      expect(got?.kind).toBe("message");
      if (got?.kind === "message") {
        expect(got.envelope).toEqual(sent);
        expect(got.receiveCount).toBe(1);
      }
    });
    test("an empty queue gives an empty list", async () => {
      const s = await subject();
      expect(await none(s)).toEqual([]);
    });
    test("a batch publish reports every id as sent and delivers them all", async () => {
      const s = await subject();
      const batch = [ping(s, 1), ping(s, 2), ping(s, 3)];
      const result = await s.queue.publishBatch(batch);
      expect(result.failed).toEqual([]);
      expect(result.sent).toEqual(batch.map((envelope) => envelope.id));
      const got = await take(s, 3);
      expect(got).toHaveLength(3);
    });
    test("receive returns at most maxMessages", async () => {
      const s = await subject();
      await s.queue.publishBatch([ping(s, 1), ping(s, 2), ping(s, 3)]);
      const first = await s.queue.receive({
        maxMessages: 2,
        visibilityTimeoutSeconds: s.visibilitySeconds,
        waitSeconds: 1
      });
      expect(first.length).toBeLessThanOrEqual(2);
      expect(first.length).toBeGreaterThan(0);
    });
    test("a received message stays hidden until its visibility timeout, then returns with a higher count", async () => {
      const s = await subject();
      await s.queue.publish(ping(s, 1, "org_a", "msg_v"));
      expect(await take(s, 1)).toHaveLength(1);
      expect(await none(s)).toEqual([]);
      await s.pass(s.visibilitySeconds + 1);
      const [again] = await take(s, 1);
      expect(again?.kind === "message" && again.envelope.id).toBe("msg_v");
      expect(again?.receiveCount).toBe(2);
    });
    test("extending visibility keeps a message hidden past the original timeout", async () => {
      const s = await subject();
      await s.queue.publish(ping(s));
      const [got] = await take(s, 1);
      await s.queue.extendVisibility(got.receipt, s.visibilitySeconds * 4);
      await s.pass(s.visibilitySeconds + 1);
      expect(await none(s)).toEqual([]);
    });
    test("releasing a message makes it receivable at once", async () => {
      const s = await subject();
      await s.queue.publish(ping(s));
      const [got] = await take(s, 1);
      await s.queue.release(got.receipt);
      const [again] = await take(s, 1);
      expect(again?.receiveCount).toBe(2);
    });
    test("acknowledging with the receipt of an earlier delivery does not delete the redelivered message", async () => {
      const s = await subject();
      await s.queue.publish(ping(s, 1, "org_a", "msg_stale"));
      const [first] = await take(s, 1);
      await s.pass(s.visibilitySeconds + 1);
      const [second] = await take(s, 1);
      expect(second?.receiveCount).toBe(2);
      await s.queue.acknowledge(first.receipt);
      await s.queue.release(second.receipt);
      const [third] = await take(s, 1);
      expect(third?.kind === "message" && third.envelope.id).toBe("msg_stale");
      expect(third?.receiveCount).toBe(3);
    });
    test("an acknowledged message is not delivered again", async () => {
      const s = await subject();
      await s.queue.publish(ping(s));
      const [got] = await take(s, 1);
      await s.queue.acknowledge(got.receipt);
      await s.pass(s.visibilitySeconds + 1);
      expect(await none(s)).toEqual([]);
    });
    test("a message released maxReceiveCount times moves to the dead-letter queue instead of being delivered again", async () => {
      const s = await subject();
      await s.queue.publish(ping(s, 1, "org_a", "msg_dead"));
      for (let round = 1;round <= s.maxReceiveCount; round++) {
        const [got] = await take(s, 1);
        expect(got?.receiveCount).toBe(round);
        await s.queue.release(got.receipt);
      }
      expect(await none(s)).toEqual([]);
      const dead = await s.deadLetterIds();
      if (dead !== undefined) {
        expect(dead).toEqual(["msg_dead"]);
      }
    });
    test("two organizations' messages stay separate: each envelope keeps its own organization id", async () => {
      const s = await subject();
      await s.queue.publishBatch([ping(s, 1, "org_a", "same_id"), ping(s, 2, "org_b", "same_id")]);
      const got = await take(s, 2);
      const orgs = got.map((delivery) => delivery.kind === "message" ? delivery.envelope.organizationId : "");
      expect(orgs.sort()).toEqual(["org_a", "org_b"]);
    });
  });
}
// src/queue/store.behaviour.ts
import { afterEach as afterEach2, describe as describe2, expect as expect2, test as test2 } from "bun:test";
var key = { consumer: "c", organizationId: "org_a", messageId: "m1" };
async function claimed(store, k, lease = 60) {
  const result = await store.claim(k, lease);
  if (result.status !== "claimed") {
    throw new Error(`expected a claim, got ${result.status}`);
  }
  return result.token;
}
function processedStoreBehaviour(name, make) {
  describe2(`ProcessedStore behaviour: ${name}`, () => {
    const open = [];
    afterEach2(async () => {
      await Promise.all(open.splice(0).map((subject) => subject.close()));
    });
    async function subject() {
      const made = await make();
      open.push(made);
      return made;
    }
    test2("a live claim is busy for everyone else, and a done message stays done", async () => {
      const { store } = await subject();
      const token = await claimed(store, key);
      expect2(await store.claim(key, 60)).toMatchObject({ status: "busy" });
      expect2(await store.complete(key, token)).toBe(true);
      expect2(await store.claim(key, 60)).toEqual({ status: "done" });
    });
    test2("busy reports the seconds left on the lease, rounded up, at least one", async () => {
      const { store, pass } = await subject();
      await claimed(store, key);
      await pass(10);
      const busy = await store.claim(key, 60);
      expect2(busy.status).toBe("busy");
      if (busy.status === "busy") {
        expect2(busy.retryAfterSeconds).toBeGreaterThanOrEqual(49);
        expect2(busy.retryAfterSeconds).toBeLessThanOrEqual(51);
      }
    });
    test2("a lapsed claim can be taken again, and the old holder can no longer complete", async () => {
      const { store, pass } = await subject();
      const first = await claimed(store, key);
      await pass(61);
      const second = await claimed(store, key);
      expect2(second).not.toBe(first);
      expect2(await store.complete(key, first)).toBe(false);
      expect2(await store.complete(key, second)).toBe(true);
    });
    test2("release frees the claim for the next delivery; a stale token releases nothing", async () => {
      const { store } = await subject();
      const token = await claimed(store, key);
      await store.release(key, "wrong-token");
      expect2(await store.claim(key, 60)).toMatchObject({ status: "busy" });
      await store.release(key, token);
      expect2(await store.claim(key, 60)).toMatchObject({ status: "claimed" });
    });
    test2("the organization, the consumer and a missing organization are all part of the key", async () => {
      const { store } = await subject();
      await claimed(store, key);
      expect2(await store.claim({ ...key, organizationId: "org_b" }, 60)).toMatchObject({
        status: "claimed"
      });
      expect2(await store.claim({ ...key, organizationId: null }, 60)).toMatchObject({
        status: "claimed"
      });
      expect2(await store.claim({ ...key, consumer: "other" }, 60)).toMatchObject({
        status: "claimed"
      });
      expect2(await store.claim(key, 60)).toMatchObject({ status: "busy" });
    });
    test2("completing a message that was never claimed does nothing", async () => {
      const { store } = await subject();
      expect2(await store.complete(key, "nope")).toBe(false);
    });
    test2("renew pushes the lease out, and only for the holder of a live claim", async () => {
      const { store, pass } = await subject();
      const token = await claimed(store, key);
      await pass(50);
      expect2(await store.renew(key, token, 60)).toBe(true);
      await pass(50);
      expect2(await store.claim(key, 60)).toMatchObject({ status: "busy" });
      expect2(await store.renew(key, "wrong-token", 60)).toBe(false);
      await pass(20);
      expect2(await store.renew(key, token, 60)).toBe(false);
      expect2(await store.renew({ ...key, messageId: "never" }, token, 60)).toBe(false);
    });
    test2("a completed claim cannot be renewed", async () => {
      const { store } = await subject();
      const token = await claimed(store, key);
      await store.complete(key, token);
      expect2(await store.renew(key, token, 60)).toBe(false);
    });
    test2("purge removes old done records and lapsed claims, at most `limit`, and keeps the rest", async () => {
      const { store, pass, now } = await subject();
      for (const id of ["a", "b", "c"]) {
        const k = { ...key, messageId: id };
        await store.complete(k, await claimed(store, k));
      }
      const live = { ...key, messageId: "live" };
      await claimed(store, live, 3600);
      await pass(10);
      const cutoff = now();
      expect2(await store.purge(cutoff, 2)).toBe(2);
      expect2(await store.purge(cutoff, 10)).toBe(1);
      expect2(await store.claim({ ...key, messageId: "a" }, 60)).toMatchObject({ status: "claimed" });
      expect2(await store.claim(live, 60)).toMatchObject({ status: "busy" });
    });
  });
}
// src/storage/behaviour.ts
import { afterEach as afterEach3, describe as describe3, expect as expect3, test as test3 } from "bun:test";
var bytes = (text) => new TextEncoder().encode(text);
var text = (data) => new TextDecoder().decode(data);
function objectStoreBehaviour(name, make, skip = false) {
  const run = skip ? describe3.skip : describe3;
  run(`ObjectStore behaviour: ${name}`, () => {
    const open = [];
    afterEach3(async () => {
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
    test3.each(BAD_KEYS.map((key) => [JSON.stringify(key.slice(0, 40)), key]))("the key %s is refused by every operation", async (_label, key) => {
      const s = await subject();
      const { a } = s.organizations;
      const code = { code: "storage.invalid_request" };
      await expect3(s.store.put(a, key, bytes("x"))).rejects.toMatchObject(code);
      await expect3(s.store.get(a, key)).rejects.toMatchObject(code);
      await expect3(s.store.head(a, key)).rejects.toMatchObject(code);
      await expect3(s.store.delete(a, key)).rejects.toMatchObject(code);
    });
    test3.each([
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
      await expect3(s.store.put(id, "k", bytes("x"))).rejects.toMatchObject(code);
      await expect3(s.store.get(id, "k")).rejects.toMatchObject(code);
      await expect3(s.store.head(id, "k")).rejects.toMatchObject(code);
      await expect3(s.store.delete(id, "k")).rejects.toMatchObject(code);
      await expect3(s.store.list(id)).rejects.toMatchObject(code);
    });
    test3("an id built from another Organization id and a path does not reach it", async () => {
      const s = await subject();
      const { a, b } = s.organizations;
      await s.store.put(b, "secret.txt", bytes("b only"));
      for (const id of [`${a}/../${b}`, `${a}/${b}`, `../${b}`, `${b}/`, `${b}/.`]) {
        await expect3(s.store.get(id, "secret.txt")).rejects.toMatchObject({
          code: "storage.invalid_request"
        });
        await expect3(s.store.list(id)).rejects.toMatchObject({ code: "storage.invalid_request" });
      }
    });
    test3("an object comes back as written, with its content type as given", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.store.put(a, "docs/one.txt", bytes("hello"), {
        contentType: "text/plain; charset=utf-8"
      });
      const got = await s.store.get(a, "docs/one.txt");
      expect3(got?.key).toBe("docs/one.txt");
      expect3(text(got?.body ?? new Uint8Array)).toBe("hello");
      expect3(got?.size).toBe(5);
      expect3(got?.contentType).toBe("text/plain; charset=utf-8");
      expect3(got?.lastModified).toBeInstanceOf(Date);
      expect3(Number.isNaN(got?.lastModified.getTime())).toBe(false);
      const info = await s.store.head(a, "docs/one.txt");
      expect3(info).toMatchObject({
        key: "docs/one.txt",
        size: 5,
        contentType: "text/plain; charset=utf-8"
      });
    });
    test3("without a content type the store says application/octet-stream", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.store.put(a, "blob", new Uint8Array([0, 255, 1, 254]));
      const got = await s.store.get(a, "blob");
      expect3(got?.contentType).toBe("application/octet-stream");
      expect3([...got?.body ?? []]).toEqual([0, 255, 1, 254]);
    });
    test3("content is stored as bytes whatever its content type claims", async () => {
      const s = await subject();
      const { a } = s.organizations;
      const html = bytes("<script>alert(1)</script>");
      await s.store.put(a, "liar.png", html, { contentType: "image/png" });
      const got = await s.store.get(a, "liar.png");
      expect3(text(got?.body ?? new Uint8Array)).toBe("<script>alert(1)</script>");
      expect3(got?.contentType).toBe("image/png");
    });
    test3("an empty object is stored", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.store.put(a, "empty", new Uint8Array);
      expect3((await s.store.get(a, "empty"))?.size).toBe(0);
    });
    test3.each([
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
      await expect3(s.store.put(a, "k", bytes("x"), { contentType })).rejects.toMatchObject({
        code: "storage.invalid_request"
      });
      expect3(await s.store.head(a, "k")).toBeUndefined();
    });
    test3("a body that is not bytes is refused", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await expect3(s.store.put(a, "k", "text")).rejects.toMatchObject({
        code: "storage.invalid_request"
      });
    });
    test3("an object over the size limit is refused and the limit itself is accepted", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await expect3(s.store.put(a, "big", new Uint8Array(s.maxObjectBytes + 1))).rejects.toMatchObject({ code: "storage.object_too_large" });
      expect3(await s.store.head(a, "big")).toBeUndefined();
      await s.store.put(a, "edge", new Uint8Array(s.maxObjectBytes));
      expect3((await s.store.head(a, "edge"))?.size).toBe(s.maxObjectBytes);
    });
    test3("a missing object reads as undefined", async () => {
      const s = await subject();
      const { a } = s.organizations;
      expect3(await s.store.get(a, "nothing")).toBeUndefined();
      expect3(await s.store.head(a, "nothing")).toBeUndefined();
    });
    test3("writing a key again replaces the object, and writing the same thing twice changes nothing", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.store.put(a, "k", bytes("one"), { contentType: "text/plain" });
      await s.store.put(a, "k", bytes("two"), { contentType: "text/csv" });
      await s.store.put(a, "k", bytes("two"), { contentType: "text/csv" });
      const got = await s.store.get(a, "k");
      expect3(text(got?.body ?? new Uint8Array)).toBe("two");
      expect3(got?.contentType).toBe("text/csv");
      expect3(await keysOf(s, a)).toEqual(["k"]);
    });
    test3("deleting removes the object, and deleting again or deleting nothing resolves", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await s.store.put(a, "k", bytes("x"));
      await s.store.delete(a, "k");
      expect3(await s.store.get(a, "k")).toBeUndefined();
      await s.store.delete(a, "k");
      await s.store.delete(a, "never-existed");
    });
    test3("a second Organization cannot read, head, list or delete the first one's objects", async () => {
      const s = await subject();
      const { a, b } = s.organizations;
      await s.store.put(a, "docs/plan.txt", bytes("a secret"));
      expect3(await s.store.get(b, "docs/plan.txt")).toBeUndefined();
      expect3(await s.store.head(b, "docs/plan.txt")).toBeUndefined();
      expect3(await keysOf(s, b)).toEqual([]);
      expect3(await keysOf(s, b, "docs/")).toEqual([]);
      await s.store.delete(b, "docs/plan.txt");
      expect3(text((await s.store.get(a, "docs/plan.txt"))?.body ?? new Uint8Array)).toBe("a secret");
    });
    test3("the same key in two Organizations holds two objects", async () => {
      const s = await subject();
      const { a, b } = s.organizations;
      await s.store.put(a, "same", bytes("from a"));
      await s.store.put(b, "same", bytes("from b"));
      expect3(text((await s.store.get(a, "same"))?.body ?? new Uint8Array)).toBe("from a");
      expect3(text((await s.store.get(b, "same"))?.body ?? new Uint8Array)).toBe("from b");
      await s.store.delete(a, "same");
      expect3(text((await s.store.get(b, "same"))?.body ?? new Uint8Array)).toBe("from b");
    });
    test3("an Organization whose id starts with another id is a different Organization", async () => {
      const s = await subject();
      const { a, aExtended } = s.organizations;
      await s.store.put(a, "one", bytes("a"));
      await s.store.put(aExtended, "two", bytes("extended"));
      expect3(await keysOf(s, a)).toEqual(["one"]);
      expect3(await keysOf(s, aExtended)).toEqual(["two"]);
      expect3(await s.store.get(a, "two")).toBeUndefined();
      expect3(await s.store.get(aExtended, "one")).toBeUndefined();
      await s.store.delete(a, "two");
      expect3(await keysOf(s, aExtended)).toEqual(["two"]);
    });
    test3("a key cannot name another Organization through a path", async () => {
      const s = await subject();
      const { a, b } = s.organizations;
      await s.store.put(b, "secret.txt", bytes("b only"));
      for (const key of [
        `../${b}/secret.txt`,
        `/${b}/secret.txt`,
        `${b}/../${b}/secret.txt`,
        `..%2f${b}%2fsecret.txt`
      ]) {
        await expect3(s.store.get(a, key)).rejects.toMatchObject({ code: "storage.invalid_request" });
        await expect3(s.store.delete(a, key)).rejects.toMatchObject({
          code: "storage.invalid_request"
        });
      }
      for (const prefix of ["../", `../${b}/`, "/", `${a}/../${b}/`, "%2e%2e/", "*", ".."]) {
        await expect3(s.store.list(a, { prefix })).rejects.toMatchObject({
          code: "storage.invalid_request"
        });
      }
      expect3(text((await s.store.get(b, "secret.txt"))?.body ?? new Uint8Array)).toBe("b only");
    });
    test3("a list is a page, in key order, that ends with no cursor", async () => {
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
        expect3(page.items.length).toBeLessThanOrEqual(2);
        seen.push(...page.items.map((item) => item.key));
        for (const item of page.items) {
          expect3(item.size).toBe(item.key.length);
          expect3(item.lastModified).toBeInstanceOf(Date);
        }
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== undefined && pages < 10);
      expect3(seen).toEqual(["a", "b/1", "b/2", "c", "d"]);
      expect3(pages).toBe(3);
    });
    test3("a list without a limit returns at most 100", async () => {
      const s = await subject();
      const { a } = s.organizations;
      await Promise.all(Array.from({ length: 105 }, (_, i) => s.store.put(a, `n${String(i).padStart(3, "0")}`, bytes("x"))));
      const page = await s.store.list(a);
      expect3(page.items).toHaveLength(100);
      expect3(page.nextCursor).toBeDefined();
      const rest = await s.store.list(a, { cursor: page.nextCursor });
      expect3(rest.items).toHaveLength(5);
      expect3(rest.nextCursor).toBeUndefined();
    });
    test3("a prefix keeps only the keys that start with it", async () => {
      const s = await subject();
      const { a } = s.organizations;
      for (const key of ["docs/a.txt", "docs/b.txt", "docs2/c.txt", "other/d.txt", "docsx"]) {
        await s.store.put(a, key, bytes("x"));
      }
      expect3(await keysOf(s, a, "docs/")).toEqual(["docs/a.txt", "docs/b.txt"]);
      expect3(await keysOf(s, a, "docs/a")).toEqual(["docs/a.txt"]);
      expect3(await keysOf(s, a, "docs")).toEqual([
        "docs/a.txt",
        "docs/b.txt",
        "docs2/c.txt",
        "docsx"
      ]);
      expect3(await keysOf(s, a, "nothing/")).toEqual([]);
    });
    test3.each([[0], [-1], [1001], [1.5], [Number.NaN]])("a list limit of %p is refused", async (limit) => {
      const s = await subject();
      await expect3(s.store.list(s.organizations.a, { limit })).rejects.toMatchObject({
        code: "storage.invalid_request"
      });
    });
    test3("a forged cursor is refused", async () => {
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
        await expect3(s.store.list(a, { cursor })).rejects.toMatchObject({
          code: "storage.invalid_request"
        });
      }
    });
    test3("one Organization's cursor used by another lists only the second one's objects", async () => {
      const s = await subject();
      const { a, b } = s.organizations;
      for (const key of ["k1", "k2", "k3"]) {
        await s.store.put(a, key, bytes("a"));
      }
      await s.store.put(b, "k9", bytes("b"));
      const page = await s.store.list(a, { limit: 1 });
      const cursor = page.nextCursor;
      const other = await s.store.list(b, { cursor });
      expect3(other.items.map((item) => item.key)).toEqual(["k9"]);
    });
    test3("the body that get returns is a copy", async () => {
      const s = await subject();
      const { a } = s.organizations;
      const original = bytes("keep");
      await s.store.put(a, "k", original);
      original[0] = 0;
      const first = await s.store.get(a, "k");
      (first?.body)[1] = 0;
      expect3(text((await s.store.get(a, "k"))?.body ?? new Uint8Array)).toBe("keep");
    });
  });
}
export {
  objectStoreBehaviour,
  processedStoreBehaviour,
  queueBehaviour
};
