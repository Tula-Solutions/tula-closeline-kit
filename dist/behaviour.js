import {
  MAX_MESSAGE_BYTES2
} from "./shared/chunk-vk3tcs4x.js";

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
export {
  processedStoreBehaviour,
  queueBehaviour
};
