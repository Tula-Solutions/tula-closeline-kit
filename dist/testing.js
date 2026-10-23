import {
  CONTACT_UNAVAILABLE2,
  isContactGuardRequest2,
  scrubText2,
  prepareFields,
  shouldReportError2,
  TELEPHONY_ERROR_CODES2,
  TelephonyError2,
  VECTOR_ERROR_CODES2,
  VectorError2,
  MAX_UPSERT_BATCH2,
  MAX_DELETE_BATCH2,
  MAX_TOP_K2,
  MAX_DIMENSIONS2,
  MAX_ATTRIBUTES2,
  MAX_ATTRIBUTE_STRING2
} from "./shared/chunk-a56avm11.js";
import {
  systemClock2,
  createFixedClock2,
  QUEUE_ERROR_CODES2,
  QueueError2,
  MAX_MESSAGE_BYTES2,
  defineMessage2,
  createMessageRegistry2
} from "./shared/chunk-mjkmsg3r.js";
import {
  STORAGE_ERROR_CODES2,
  StorageError2
} from "./shared/chunk-5sf8d2rb.js";
import {
  checkStreamLimit,
  checkIdleTimeout,
  readChunks,
  tooLarge,
  createOrganizationIdGuard,
  encodeCursor,
  createStorageValidator
} from "./shared/chunk-d77yh0fk.js";
import {
  DEFAULT_TELEPHONY_TIMEOUT_MS2,
  MAX_TELEPHONY_TIMEOUT_MS2,
  MAX_DISCLOSURE_TEXT_LENGTH2,
  MAX_RING_LEGS2,
  MAX_WEBHOOK_BODY_BYTES2,
  TRANSCRIBER_ERROR_CODES2,
  TranscriberError2,
  MAX_CLIENT_REFERENCE_LENGTH2,
  MAX_AUDIO_URL_LENGTH2,
  MAX_SPEAKERS2,
  DEFAULT_TRANSCRIBER_LIST_LIMIT2,
  MAX_TRANSCRIBER_LIST_LIMIT2,
  MAX_VENDOR_ID_LENGTH2,
  checkTranscriptionResult2
} from "./shared/chunk-0xwm31t3.js";
import {
  systemSleep2,
  assertReceiveOptions2,
  assertVisibility2,
  assertBatchCount2
} from "./shared/chunk-h070fpj8.js";

// src/reporting/testing.ts
function copyContext(context) {
  try {
    const copy = { ...context };
    if (context?.tags !== undefined) {
      copy.tags = { ...context.tags };
    }
    return copy;
  } catch {
    return {};
  }
}
function createMemoryErrorReporter() {
  const captured = [];
  const flushes = [];
  const closes = [];
  return {
    captured,
    flushes,
    closes,
    capture(error, context) {
      if (closes.length === 0 && shouldReportError2(error)) {
        captured.push({ error, context: copyContext(context) });
      }
    },
    flush(timeoutMs) {
      flushes.push(timeoutMs);
      return Promise.resolve(closes.length === 0);
    },
    close(timeoutMs) {
      closes.push(timeoutMs);
      return Promise.resolve(true);
    }
  };
}

// src/auth/testing.ts
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { formatId } from "tula-closeline-contract";
var testUserId = (n = 1) => formatId("usr", n.toString(16).padStart(32, "0"));
var testOrganizationId = (n = 1) => formatId("org", n.toString(16).padStart(32, "0"));
async function createTestKeyPair(kid = "test-key-1") {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  const jwk = await exportJWK(publicKey);
  if (jwk.x === undefined) {
    throw new Error("Ed25519 public key has no x");
  }
  return {
    kid,
    privateKey,
    publicJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x, kid, use: "sig", alg: "EdDSA" }
  };
}
function createTestJwks(...pairs) {
  return { keys: pairs.map((pair) => pair.publicJwk) };
}
var DEFAULT_TEST_ORGANIZATION_ID = testOrganizationId(1);
var DEFAULT_TEST_USER_ID = testUserId(1);
async function mintTestToken(options) {
  const nowSeconds = Math.floor(options.clock.now().getTime() / 1000);
  const iat = nowSeconds + (options.issuedAtOffsetSeconds ?? 0);
  const payload = {
    iss: options.issuer ?? "https://auth.test",
    aud: options.audience ?? "closeline",
    sub: DEFAULT_TEST_USER_ID,
    org: DEFAULT_TEST_ORGANIZATION_ID,
    role: "rep",
    region: "us",
    iat,
    exp: nowSeconds + (options.expiresInSeconds ?? 900),
    ...options.notBeforeSeconds === undefined ? {} : { nbf: nowSeconds + options.notBeforeSeconds },
    ...options.claims
  };
  const header = {
    alg: "EdDSA",
    kid: options.keyPair.kid,
    typ: "at+jwt",
    ...options.header
  };
  const jwt = new SignJWT(Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined)));
  jwt.setProtectedHeader(Object.fromEntries(Object.entries(header).filter(([, value]) => value !== undefined)));
  return jwt.sign(options.keyPair.privateKey);
}
// src/consent/memory.ts
import {
  formatId as formatId2
} from "tula-closeline-contract";
var MEMORY_CALLER = "memory";
function key(target, channel) {
  const who = target.prospectId !== undefined ? `prospect:${target.prospectId}` : target.email !== undefined ? `email:${target.email}` : target.phone !== undefined ? `phone:${target.phone}` : `linkedin:${target.linkedinUrl}`;
  return JSON.stringify([target.organizationId, who, channel]);
}
var counter = 0;
function checkId() {
  counter += 1;
  return formatId2("chk", counter.toString(16).padStart(32, "0"));
}
function createMemoryContactGuard() {
  const presets = new Map;
  const calls = [];
  let unavailable = false;
  const guard = {
    calls,
    async check(request) {
      if (!isContactGuardRequest2(request, MEMORY_CALLER)) {
        return CONTACT_UNAVAILABLE2;
      }
      calls.push({ ...request });
      if (unavailable) {
        return CONTACT_UNAVAILABLE2;
      }
      return presets.get(key(request, request.channel)) ?? {
        allowed: false,
        checkId: checkId(),
        code: "consent.missing",
        suppressionReason: null
      };
    },
    allow(target, channel, basis = "consent_granted") {
      presets.set(key(target, channel), { allowed: true, checkId: checkId(), basis });
      return guard;
    },
    deny(target, channel, code = "consent.missing", suppressionReason) {
      const reason = code === "consent.suppressed" ? suppressionReason ?? "manual" : null;
      presets.set(key(target, channel), {
        allowed: false,
        checkId: checkId(),
        code,
        suppressionReason: reason
      });
      return guard;
    },
    setUnavailable(value = true) {
      unavailable = value;
      return guard;
    },
    reset() {
      presets.clear();
      calls.length = 0;
      unavailable = false;
    }
  };
  return guard;
}
// src/queue/memory.ts
function bytesOf(body) {
  return new TextEncoder().encode(body).length;
}
function createMemoryQueue(options) {
  const { registry, clock } = options;
  const sleep = options.sleep ?? systemSleep2;
  const maxReceiveCount = options.maxReceiveCount ?? 5;
  const entries = new Map;
  const dead = [];
  let nextId = 1;
  const waiters = new Set;
  function add(body) {
    const id = nextId++;
    entries.set(id, { id, body, receiveCount: 0, visibleAt: 0, inFlight: false });
    for (const wake of [...waiters]) {
      wake();
    }
  }
  function findByReceipt(receipt) {
    const id = Number(receipt.split(".")[0]?.slice(1));
    return receipt.startsWith("m") && Number.isInteger(id) ? entries.get(id) : undefined;
  }
  function inFlight(receipt) {
    const entry = findByReceipt(receipt);
    const count = Number(receipt.split(".")[1]);
    if (entry === undefined || !entry.inFlight || entry.receiveCount !== count || entry.visibleAt <= clock.now().getTime()) {
      throw new QueueError2(QUEUE_ERROR_CODES2.receiptInvalid, "the message is not in flight");
    }
    return entry;
  }
  function take(max, visibilityTimeoutSeconds) {
    const now = clock.now().getTime();
    const out = [];
    const candidates = [...entries.values()];
    if (options.random !== undefined) {
      for (let i = candidates.length - 1;i > 0; i--) {
        const j = Math.floor(options.random() * (i + 1));
        const swap = candidates[i];
        candidates[i] = candidates[j];
        candidates[j] = swap;
      }
    }
    for (const entry of candidates) {
      if (out.length >= max) {
        break;
      }
      if (entry.visibleAt > now) {
        continue;
      }
      if (entry.receiveCount >= maxReceiveCount) {
        entries.delete(entry.id);
        const decoded = registry.decode(entry.body);
        dead.push({
          messageId: decoded.ok ? decoded.envelope.id : decoded.messageId,
          receiveCount: entry.receiveCount
        });
        continue;
      }
      entry.receiveCount += 1;
      entry.inFlight = true;
      entry.visibleAt = now + visibilityTimeoutSeconds * 1000;
      const receipt = `m${entry.id}.${entry.receiveCount}`;
      const decoded = registry.decode(entry.body);
      out.push(decoded.ok ? {
        kind: "message",
        envelope: decoded.envelope,
        receipt,
        receiveCount: entry.receiveCount
      } : {
        kind: "invalid",
        reason: decoded.reason,
        issues: decoded.issues,
        ...decoded.messageId === undefined ? {} : { messageId: decoded.messageId },
        receipt,
        receiveCount: entry.receiveCount
      });
    }
    return out;
  }
  function encodeChecked(envelope) {
    const body = registry.encode(envelope);
    if (bytesOf(body) > MAX_MESSAGE_BYTES2) {
      throw new QueueError2(QUEUE_ERROR_CODES2.messageTooLarge, "the message is over 256 KiB");
    }
    return body;
  }
  function setVisibility(receipt, seconds) {
    assertVisibility2(seconds);
    const entry = inFlight(receipt);
    entry.visibleAt = clock.now().getTime() + seconds * 1000;
    if (seconds === 0) {
      entry.inFlight = false;
      for (const wake of [...waiters]) {
        wake();
      }
    }
  }
  return {
    async publish(envelope) {
      add(encodeChecked(envelope));
    },
    async publishBatch(envelopes) {
      assertBatchCount2(envelopes.length);
      const bodies = envelopes.map(encodeChecked);
      if (bodies.reduce((sum, body) => sum + bytesOf(body), 0) > MAX_MESSAGE_BYTES2) {
        throw new QueueError2(QUEUE_ERROR_CODES2.batchTooLarge, "a batch is at most 256 KiB in total");
      }
      for (const body of bodies) {
        add(body);
      }
      const result = { sent: envelopes.map((envelope) => envelope.id), failed: [] };
      return result;
    },
    async receive(receiveOptions) {
      assertReceiveOptions2(receiveOptions);
      const { maxMessages, visibilityTimeoutSeconds, waitSeconds, signal } = receiveOptions;
      let found = take(maxMessages, visibilityTimeoutSeconds);
      if (found.length > 0 || waitSeconds === 0 || signal?.aborted) {
        return found;
      }
      const wake = new AbortController;
      const published = new Promise((resolve) => {
        const listener = () => {
          waiters.delete(listener);
          resolve();
        };
        waiters.add(listener);
        wake.signal.addEventListener("abort", () => waiters.delete(listener), { once: true });
      });
      const stop = new AbortController;
      signal?.addEventListener("abort", () => stop.abort(), { once: true });
      try {
        await Promise.race([published, sleep(waitSeconds * 1000, stop.signal)]);
      } finally {
        wake.abort();
        stop.abort();
      }
      found = signal?.aborted ? [] : take(maxMessages, visibilityTimeoutSeconds);
      return found;
    },
    async acknowledge(receipt) {
      const entry = findByReceipt(receipt);
      if (entry !== undefined && entry.receiveCount === Number(receipt.split(".")[1])) {
        entries.delete(entry.id);
      }
    },
    async extendVisibility(receipt, seconds) {
      setVisibility(receipt, seconds);
    },
    async release(receipt) {
      setVisibility(receipt, 0);
    },
    deadLetters: () => [...dead],
    depth() {
      const now = clock.now().getTime();
      let visible = 0;
      let hidden = 0;
      for (const entry of entries.values()) {
        if (entry.visibleAt > now) {
          hidden += 1;
        } else {
          visible += 1;
        }
      }
      return { visible, inFlight: hidden };
    },
    publishRaw: add
  };
}
// src/queue/testing.ts
import { z } from "zod";
var SETTLE_ROUNDS = 8;
function createVirtualTime() {
  const clock = createFixedClock2("2026-01-01T00:00:00.000Z");
  const sleepers = new Set;
  const settle = async () => {
    for (let round = 0;round < SETTLE_ROUNDS; round++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  return {
    clock,
    settle,
    pending: () => sleepers.size,
    sleep: (ms, signal) => new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const sleeper = {
        due: clock.now().getTime() + ms,
        wake: () => {
          sleepers.delete(sleeper);
          signal?.removeEventListener("abort", sleeper.wake);
          resolve();
        }
      };
      sleepers.add(sleeper);
      signal?.addEventListener("abort", sleeper.wake, { once: true });
    }),
    async advance(ms) {
      const target = clock.now().getTime() + ms;
      await settle();
      for (;; ) {
        const due = [...sleepers].filter((sleeper) => sleeper.due <= target);
        const next = due.sort((a, b) => a.due - b.due)[0];
        if (next === undefined) {
          break;
        }
        const step = Math.max(0, next.due - clock.now().getTime());
        clock.advance(`${step}ms`);
        next.wake();
        await settle();
      }
      clock.advance(`${Math.max(0, target - clock.now().getTime())}ms`);
      await settle();
    }
  };
}
var testPing = defineMessage2({
  type: "test.ping",
  version: 1,
  scope: "organization",
  payload: z.object({ n: z.number().int() })
});
var testNote = defineMessage2({
  type: "test.note",
  version: 1,
  scope: "global",
  payload: z.object({ text: z.string() })
});
function createTestRegistry(options = {}) {
  return createMessageRegistry2([testPing, testNote], {
    organizationIdSchema: z.string().min(1).max(64),
    ...options
  });
}
// src/storage/memory.ts
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
function createMemoryObjectStore(options = {}) {
  const clock = options.clock ?? systemClock2;
  const check = createStorageValidator({
    maxObjectBytes: options.maxObjectBytes,
    isOrganizationId: options.isOrganizationId
  });
  const organizations = new Map;
  const secret = randomBytes(32);
  const sign = (org, name, expires) => createHmac("sha256", secret).update(`${org}
${name}
${expires}`).digest("hex");
  const info = (key, entry) => ({
    key,
    size: entry.body.byteLength,
    contentType: entry.contentType,
    lastModified: new Date(entry.lastModified)
  });
  const store = {
    async presignGet(organizationId, key, presignOptions) {
      const org = check.organization(organizationId);
      const name = check.key(key);
      const seconds = check.expiry(presignOptions);
      const expires = clock.now().getTime() + seconds * 1000;
      return `http://memory.object-store.invalid/${org}/${name}?expires=${expires}&sig=${sign(org, name, expires)}`;
    },
    async resolvePresigned(url) {
      try {
        const parsed = new URL(url);
        const [, org, ...rest] = parsed.pathname.split("/");
        const name = rest.join("/");
        const expires = Number(parsed.searchParams.get("expires"));
        const given = parsed.searchParams.get("sig") ?? "";
        if (parsed.host !== "memory.object-store.invalid" || org === undefined || !Number.isSafeInteger(expires)) {
          return;
        }
        const wanted = Buffer.from(sign(org, name, expires));
        const got = Buffer.from(given);
        if (got.length !== wanted.length || !timingSafeEqual(got, wanted)) {
          return;
        }
        if (clock.now().getTime() > expires) {
          return;
        }
        return await store.get(org, name);
      } catch {
        return;
      }
    },
    async put(organizationId, key, body, putOptions) {
      const org = check.organization(organizationId);
      const name = check.key(key);
      const bytes = check.body(body);
      const contentType = check.contentType(putOptions?.contentType);
      let objects = organizations.get(org);
      if (objects === undefined) {
        objects = new Map;
        organizations.set(org, objects);
      }
      objects.set(name, { body: bytes.slice(), contentType, lastModified: clock.now() });
    },
    async putStream(organizationId, key, body, putOptions) {
      const org = check.organization(organizationId);
      const name = check.key(key);
      const contentType = check.contentType(putOptions?.contentType);
      const maxBytes = checkStreamLimit(putOptions?.maxBytes);
      const hash = createHash("sha256");
      const parts = [];
      let size = 0;
      for await (const chunk of readChunks(body, putOptions?.signal, checkIdleTimeout(putOptions?.idleTimeoutMs))) {
        size += chunk.byteLength;
        if (size > maxBytes) {
          throw tooLarge(maxBytes);
        }
        hash.update(chunk);
        parts.push(chunk.slice());
      }
      const whole = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        whole.set(part, offset);
        offset += part.byteLength;
      }
      let objects = organizations.get(org);
      if (objects === undefined) {
        objects = new Map;
        organizations.set(org, objects);
      }
      objects.set(name, { body: whole, contentType, lastModified: clock.now() });
      return { size, sha256: hash.digest("hex") };
    },
    async getStream(organizationId, key) {
      const org = check.organization(organizationId);
      const name = check.key(key);
      const entry = organizations.get(org)?.get(name);
      if (entry === undefined) {
        return;
      }
      const bytes = entry.body.slice();
      let offset = 0;
      const body = new ReadableStream({
        pull(controller) {
          if (offset >= bytes.byteLength) {
            controller.close();
            return;
          }
          controller.enqueue(bytes.subarray(offset, offset + 65536));
          offset += 65536;
        }
      });
      return { ...info(name, entry), body };
    },
    async get(organizationId, key) {
      const org = check.organization(organizationId);
      const name = check.key(key);
      const entry = organizations.get(org)?.get(name);
      if (entry === undefined) {
        return;
      }
      if (entry.body.byteLength > check.maxObjectBytes) {
        throw new StorageError2(STORAGE_ERROR_CODES2.objectTooLarge, "the object is too large", {
          details: { limitBytes: check.maxObjectBytes }
        });
      }
      const stored = { ...info(name, entry), body: entry.body.slice() };
      return stored;
    },
    async head(organizationId, key) {
      const org = check.organization(organizationId);
      const name = check.key(key);
      const entry = organizations.get(org)?.get(name);
      return entry === undefined ? undefined : info(name, entry);
    },
    async delete(organizationId, key) {
      const org = check.organization(organizationId);
      const name = check.key(key);
      organizations.get(org)?.delete(name);
    },
    async list(organizationId, listOptions) {
      const org = check.organization(organizationId);
      const { prefix, after, limit } = check.list(listOptions);
      const matches = [];
      for (const pair of organizations.get(org) ?? []) {
        if (pair[0].startsWith(prefix) && (after === undefined || pair[0] > after)) {
          matches.push(pair);
        }
      }
      matches.sort((x, y) => x[0] < y[0] ? -1 : 1);
      const items = matches.slice(0, limit).map(([name, entry]) => {
        const { key, size, lastModified } = info(name, entry);
        return { key, size, lastModified };
      });
      const last = items.at(-1);
      const result = { items };
      if (matches.length > limit && last !== undefined) {
        result.nextCursor = encodeCursor(last.key);
      }
      return result;
    }
  };
  return store;
}
// src/telephony/memory.ts
import { createHmac as createHmac2, randomBytes as randomBytes2, timingSafeEqual as timingSafeEqual2 } from "node:crypto";

// src/telephony/validate.ts
import {
  callIdSchema,
  e164PhoneSchema,
  membershipIdSchema,
  organizationIdSchema
} from "tula-closeline-contract";
var PROVIDER_ID = /^[A-Za-z0-9._:-]{1,128}$/;
var CONTROL = /[\u0000-\u001f\u007f]/;
function invalid(what) {
  throw new TelephonyError2(TELEPHONY_ERROR_CODES2.invalidRequest, `${what} is not acceptable`);
}
function checkOrganizationId(value) {
  return organizationIdSchema.safeParse(value).success ? value : invalid("organizationId");
}
function checkCallId(value) {
  return callIdSchema.safeParse(value).success ? value : invalid("callId");
}
function checkIdentity(value) {
  return membershipIdSchema.safeParse(value).success ? value : invalid("identity");
}
function checkNumber(value, what) {
  return e164PhoneSchema.safeParse(value).success ? value : invalid(what);
}
function checkProviderId(value, what) {
  return typeof value === "string" && PROVIDER_ID.test(value) ? value : invalid(what);
}
function checkDisclosure(version, text, aiAssisted) {
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    invalid("wordingVersion");
  }
  if (typeof text !== "string" || text.trim().length === 0 || text.length > MAX_DISCLOSURE_TEXT_LENGTH2 || CONTROL.test(text)) {
    invalid("text");
  }
  if (typeof aiAssisted !== "boolean") {
    invalid("aiAssisted");
  }
}
function checkRingIdentities(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_RING_LEGS2) {
    invalid("ringIdentities");
  }
  const identities = value.map(checkIdentity);
  return [...new Set(identities)];
}
function checkDestinationUrl(value, allowPlain) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    invalid("destinationUrl");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return invalid("destinationUrl");
  }
  const secure = url.protocol === "wss:";
  if (!(secure || allowPlain && url.protocol === "ws:") || url.username || url.password) {
    invalid("destinationUrl");
  }
  return value;
}
function resolveTimeout(options, fallback) {
  const value = options?.timeoutMs ?? fallback;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TELEPHONY_TIMEOUT_MS2) {
    invalid("timeoutMs");
  }
  return value;
}

// src/telephony/memory.ts
var DEFAULT_SECRET = "memory-webhook-secret";
var DEFAULT_TTL_SECONDS = 900;
var FAKE_AUDIO = new TextEncoder().encode("RIFF....WAVEmemory-recording");
function chunked(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice());
      controller.close();
    }
  });
}
function createMemoryTelephony(options = {}) {
  const clock = options.clock ?? systemClock2;
  const allowPlainSocket = (options.environment ?? "local") === "local";
  const secret = options.webhookSecret ?? DEFAULT_SECRET;
  if (secret.length < 16) {
    throw new TypeError("createMemoryTelephony needs a webhookSecret of at least 16 characters");
  }
  const defaultTimeout = options.defaultTimeoutMs ?? DEFAULT_TELEPHONY_TIMEOUT_MS2;
  try {
    resolveTimeout(undefined, defaultTimeout);
  } catch {
    throw new TypeError("createMemoryTelephony needs a defaultTimeoutMs from 1 to 60000");
  }
  const audio = options.recordingAudio ?? FAKE_AUDIO;
  const calls = new Map;
  const recordings = new Map;
  const placed = new Map;
  const scripts = new Map;
  const failures = new Map;
  const stalls = new Map;
  const events = [];
  const operations = [];
  let taken = 0;
  let counter = 0;
  const nextId = (prefix) => {
    counter += 1;
    return `${prefix}${counter.toString(16).padStart(8, "0")}`;
  };
  const sign = (url, body) => createHmac2("sha256", secret).update(url).update(`
`).update(body).digest("base64");
  function emit(call, type, extra = {}) {
    events.push({
      eventId: nextId("evt-"),
      organizationId: call.organizationId,
      providerCallId: call.providerCallId,
      type,
      at: clock.now().toISOString(),
      ...extra
    });
  }
  function finishRecording(call) {
    const recording = call.recordingId === null ? undefined : recordings.get(call.recordingId);
    if (recording && !recording.ready) {
      recording.ready = true;
      emit(call, "recording_ready", { recordingId: recording.recordingId });
    }
  }
  function end(call, by) {
    call.state = "ended";
    call.endedBy = by;
    emit(call, "completed", { endedBy: by });
    finishRecording(call);
  }
  function fail(call, reason) {
    call.state = "ended";
    call.endedBy = "system";
    emit(call, "failed", { failureReason: reason });
    finishRecording(call);
  }
  function find(organizationId, providerCallId) {
    const call = calls.get(providerCallId);
    if (!call || call.organizationId !== organizationId) {
      throw new TelephonyError2(TELEPHONY_ERROR_CODES2.notFound, "There is no such call");
    }
    return call;
  }
  function live(call) {
    if (call.state === "ended") {
      throw new TelephonyError2(TELEPHONY_ERROR_CODES2.callEnded, "The call has ended");
    }
    if (call.state === "incoming") {
      invalid("call: it has not been answered, so it");
    }
  }
  function needDisclosure(call) {
    if (call.disclosure === null) {
      throw new TelephonyError2(TELEPHONY_ERROR_CODES2.disclosureRequired, "The Disclosure has not played on this call");
    }
    return call.disclosure;
  }
  function checkRef(request) {
    checkOrganizationId(request.organizationId);
    checkProviderId(request.providerCallId, "providerCallId");
  }
  async function run(operation, opts, body) {
    const timeoutMs = resolveTimeout(opts, defaultTimeout);
    const stalled = stalls.get(operation) ?? 0;
    if (stalled > 0) {
      stalls.set(operation, stalled - 1);
      await new Promise((resolve) => setTimeout(resolve, timeoutMs));
      throw new TelephonyError2(TELEPHONY_ERROR_CODES2.unavailable, "The provider did not answer in time");
    }
    const code = failures.get(operation)?.shift();
    if (code !== undefined) {
      throw new TelephonyError2(code, "The provider failed");
    }
    return body();
  }
  function record(operation, providerCallId) {
    operations.push({ operation, providerCallId });
  }
  const port = {
    events,
    operations,
    placeCall(request, opts) {
      return run("placeCall", opts, () => {
        checkOrganizationId(request.organizationId);
        checkCallId(request.callId);
        checkProviderId(request.idempotencyKey, "idempotencyKey");
        checkNumber(request.from, "from");
        checkNumber(request.to, "to");
        const key = `${request.organizationId}|${request.idempotencyKey}`;
        const existing = placed.get(key);
        if (existing !== undefined) {
          const first = calls.get(existing);
          if (first && (first.to !== request.to || first.from !== request.from)) {
            invalid("idempotencyKey: it was used for another call, so it");
          }
          return { providerCallId: existing, created: false };
        }
        const script = scripts.get(request.to) ?? { kind: "answers" };
        const call = {
          organizationId: request.organizationId,
          providerCallId: nextId("memcall-"),
          callId: request.callId,
          direction: "outbound",
          state: "connected",
          to: request.to,
          from: request.from,
          script,
          disclosure: null,
          bridgedTo: null,
          recordingId: null,
          streamId: null,
          ringing: null,
          endedBy: null
        };
        calls.set(call.providerCallId, call);
        placed.set(key, call.providerCallId);
        record("placeCall", call.providerCallId);
        emit(call, "ringing");
        if (script.kind === "no_answer") {
          call.state = "ended";
          emit(call, "no_answer", { failureReason: "no_answer" });
        } else if (script.kind === "busy") {
          call.state = "ended";
          emit(call, "busy", { failureReason: "busy" });
        } else if (script.kind === "carrier_failure" && (script.when ?? "dial") === "dial") {
          fail(call, script.reason ?? "carrier_rejected");
        } else {
          emit(call, "answered");
        }
        return { providerCallId: call.providerCallId, created: true };
      });
    },
    answerCall(request, opts) {
      return run("answerCall", opts, () => {
        checkRef(request);
        checkCallId(request.callId);
        const identities = checkRingIdentities(request.ringIdentities);
        const call = find(request.organizationId, request.providerCallId);
        if (call.state === "ended") {
          throw new TelephonyError2(TELEPHONY_ERROR_CODES2.callEnded, "The call has ended");
        }
        if (call.state === "incoming") {
          call.state = "connected";
          call.callId = request.callId;
          call.ringing = identities.length;
          record("answerCall", call.providerCallId);
          emit(call, "answered");
        }
        return { ringing: call.ringing ?? identities.length };
      });
    },
    playDisclosure(request, opts) {
      return run("playDisclosure", opts, () => {
        checkRef(request);
        checkDisclosure(request.wordingVersion, request.text, request.aiAssisted);
        const call = find(request.organizationId, request.providerCallId);
        if (call.disclosure !== null && call.disclosure.wordingVersion === request.wordingVersion) {
          return call.disclosure;
        }
        live(call);
        if (call.script.kind === "hangs_up" && call.script.when === "during_disclosure") {
          end(call, "prospect");
          throw new TelephonyError2(TELEPHONY_ERROR_CODES2.callEnded, "The Prospect hung up");
        }
        const played = {
          wordingVersion: request.wordingVersion,
          aiAssisted: request.aiAssisted,
          playedAt: clock.now().toISOString()
        };
        call.disclosure = played;
        record("playDisclosure", call.providerCallId);
        return played;
      });
    },
    bridge(request, opts) {
      return run("bridge", opts, () => {
        checkRef(request);
        checkIdentity(request.repIdentity);
        const call = find(request.organizationId, request.providerCallId);
        live(call);
        needDisclosure(call);
        if (call.bridgedTo === request.repIdentity) {
          return;
        }
        call.bridgedTo = request.repIdentity;
        record("bridge", call.providerCallId);
        if (call.script.kind === "hangs_up" && call.script.when === "after_bridge") {
          end(call, "prospect");
        } else if (call.script.kind === "carrier_failure" && call.script.when === "after_bridge") {
          fail(call, call.script.reason ?? "carrier_dropped");
        }
      });
    },
    startRecording(request, opts) {
      return run("startRecording", opts, () => {
        checkRef(request);
        const call = find(request.organizationId, request.providerCallId);
        if (call.recordingId !== null) {
          return { recordingId: call.recordingId, channels: 2 };
        }
        live(call);
        needDisclosure(call);
        const recordingId = nextId("memrec-");
        recordings.set(recordingId, {
          organizationId: call.organizationId,
          recordingId,
          providerCallId: call.providerCallId,
          ready: false
        });
        call.recordingId = recordingId;
        record("startRecording", call.providerCallId);
        return { recordingId, channels: 2 };
      });
    },
    forkTracks(request, opts) {
      return run("forkTracks", opts, () => {
        checkRef(request);
        checkDestinationUrl(request.destinationUrl, allowPlainSocket);
        const call = find(request.organizationId, request.providerCallId);
        if (call.streamId !== null) {
          return { streamId: call.streamId, tracks: ["rep", "prospect"] };
        }
        live(call);
        const disclosure = needDisclosure(call);
        if (!disclosure.aiAssisted) {
          throw new TelephonyError2(TELEPHONY_ERROR_CODES2.disclosureRequired, "The Disclosure did not say an AI takes part");
        }
        call.streamId = nextId("memstream-");
        record("forkTracks", call.providerCallId);
        return { streamId: call.streamId, tracks: ["rep", "prospect"] };
      });
    },
    hangUp(request, opts) {
      return run("hangUp", opts, () => {
        checkRef(request);
        if (request.by !== undefined && request.by !== "rep" && request.by !== "system") {
          invalid("by");
        }
        const call = find(request.organizationId, request.providerCallId);
        if (call.state === "ended") {
          return;
        }
        record("hangUp", call.providerCallId);
        end(call, request.by ?? "system");
      });
    },
    fetchRecording(request, opts) {
      return run("fetchRecording", opts, () => {
        checkOrganizationId(request.organizationId);
        checkProviderId(request.recordingId, "recordingId");
        const found = recordings.get(request.recordingId);
        if (!found || found.organizationId !== request.organizationId) {
          throw new TelephonyError2(TELEPHONY_ERROR_CODES2.notFound, "There is no such Recording");
        }
        if (!found.ready) {
          throw new TelephonyError2(TELEPHONY_ERROR_CODES2.recordingNotReady, "The Recording is not finished");
        }
        record("fetchRecording", found.providerCallId);
        return {
          body: chunked(audio),
          contentType: "audio/wav",
          sizeBytes: audio.length,
          channels: 2
        };
      });
    },
    deleteRecording(request, opts) {
      return run("deleteRecording", opts, () => {
        checkOrganizationId(request.organizationId);
        checkProviderId(request.recordingId, "recordingId");
        const found = recordings.get(request.recordingId);
        if (!found || found.organizationId !== request.organizationId) {
          return { existed: false };
        }
        recordings.delete(request.recordingId);
        record("deleteRecording", found.providerCallId);
        return { existed: true };
      });
    },
    verifyWebhook(request) {
      if (typeof request !== "object" || request === null || typeof request.url !== "string" || typeof request.body !== "string" || typeof request.signature !== "string" || request.signature.length === 0 || Buffer.byteLength(request.body) > MAX_WEBHOOK_BODY_BYTES2) {
        return false;
      }
      const expected = Buffer.from(sign(request.url, request.body));
      const got = Buffer.from(request.signature);
      return got.length === expected.length && timingSafeEqual2(got, expected);
    },
    mintBrowserToken(request, opts) {
      return run("mintBrowserToken", opts, () => {
        checkOrganizationId(request.organizationId);
        checkIdentity(request.identity);
        const ttl = request.ttlSeconds ?? DEFAULT_TTL_SECONDS;
        if (!Number.isInteger(ttl) || ttl < 60 || ttl > 3600) {
          invalid("ttlSeconds");
        }
        return {
          token: `memtok.${randomBytes2(24).toString("base64url")}`,
          identity: request.identity,
          ttlSeconds: ttl,
          expiresAt: new Date(clock.now().getTime() + ttl * 1000).toISOString()
        };
      });
    },
    script(number, behaviour) {
      checkNumber(number, "number");
      scripts.set(number, behaviour);
    },
    receiveInbound(organizationId, from, to) {
      checkOrganizationId(organizationId);
      checkNumber(from, "from");
      checkNumber(to, "to");
      const call = {
        organizationId,
        providerCallId: nextId("memcall-"),
        callId: null,
        direction: "inbound",
        state: "incoming",
        to,
        from,
        script: { kind: "answers" },
        disclosure: null,
        bridgedTo: null,
        recordingId: null,
        streamId: null,
        ringing: null,
        endedBy: null
      };
      calls.set(call.providerCallId, call);
      emit(call, "ringing");
      return call.providerCallId;
    },
    prospectHangsUp(organizationId, providerCallId) {
      const call = find(organizationId, providerCallId);
      if (call.state !== "ended") {
        record("prospectHangsUp", providerCallId);
        end(call, "prospect");
      }
    },
    failNext(operation, code, times = 1) {
      const queue = failures.get(operation) ?? [];
      for (let i = 0;i < times; i++) {
        queue.push(code);
      }
      failures.set(operation, queue);
    },
    stallNext(operation, times = 1) {
      stalls.set(operation, (stalls.get(operation) ?? 0) + times);
    },
    takeEvents() {
      const fresh = events.slice(taken);
      taken = events.length;
      return fresh;
    },
    calls(organizationId) {
      return [...calls.values()].filter((call) => organizationId === undefined || call.organizationId === organizationId).map((call) => ({
        organizationId: call.organizationId,
        providerCallId: call.providerCallId,
        callId: call.callId,
        direction: call.direction,
        state: call.state,
        disclosure: call.disclosure,
        bridgedTo: call.bridgedTo,
        recordingId: call.recordingId,
        streamId: call.streamId,
        endedBy: call.endedBy
      }));
    },
    webhookFor(event) {
      const url = "https://voice.example.test/webhooks/telephony";
      const body = JSON.stringify(event);
      return { url, body, signature: sign(url, body) };
    },
    sign,
    recordingCount: () => recordings.size
  };
  return port;
}
// src/transcribe/memory.ts
import { createHash as createHash2 } from "node:crypto";

// src/transcribe/validate.ts
var REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
var AUDIO_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
var VENDOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
var CURSOR = /^[A-Za-z0-9_-]{1,300}$/;
var bad = (message) => new TranscriberError2(TRANSCRIBER_ERROR_CODES2.invalidRequest, message);
function encodeReferenceCursor(reference) {
  return Buffer.from(reference, "utf8").toString("base64url");
}
function checkUrl(value, what, allowHttp) {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_AUDIO_URL_LENGTH2) {
    throw bad(`${what} must be a URL of at most 4096 characters`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw bad(`${what} must be a URL`);
  }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:") || url.hostname === "" || url.username !== "" || url.password !== "") {
    throw bad(`${what} must be an https URL without user information (http only in local)`);
  }
  return value;
}
function createTranscriberValidator(options) {
  const allowHttp = options.environment === "local";
  const isOrganization = createOrganizationIdGuard(options.isOrganizationId);
  const reference = (value) => {
    if (typeof value !== "string" || value.length > MAX_CLIENT_REFERENCE_LENGTH2 || !REFERENCE.test(value)) {
      throw bad('a client reference is 1 to 128 letters, digits, ".", "_", ":" or "-"');
    }
    return value;
  };
  const audioKey = (value) => {
    if (typeof value !== "string" || !AUDIO_KEY.test(value)) {
      throw bad('an audio key is required: 1 to 256 letters, digits, ".", "_", ":", "/" or "-"');
    }
    return value;
  };
  const vendorId = (value) => {
    if (typeof value !== "string" || value.length > MAX_VENDOR_ID_LENGTH2 || !VENDOR_ID.test(value)) {
      throw bad('a vendor id is 1 to 128 letters, digits, ".", "_", ":" or "-"');
    }
    return value;
  };
  return {
    vendorId,
    hint(value) {
      if (value === undefined) {
        return;
      }
      if (typeof value !== "object" || value === null) {
        throw bad("the hint must be an object");
      }
      return value.vendorId === undefined ? undefined : vendorId(value.vendorId);
    },
    organization(value) {
      if (!isOrganization(value)) {
        throw bad("the Organization id is not valid");
      }
      return value;
    },
    reference,
    request(value) {
      if (typeof value !== "object" || value === null) {
        throw bad("a send must be an object");
      }
      const raw = value;
      const audio = raw.audio;
      if (typeof audio !== "object" || audio === null) {
        throw bad("audio must be an object with a url");
      }
      if (raw.speakers !== "split_channels" && raw.speakers !== "diarize") {
        throw bad('speakers must be "split_channels" or "diarize"');
      }
      let maxSpeakers;
      if (raw.maxSpeakers !== undefined) {
        if (raw.speakers !== "diarize" || typeof raw.maxSpeakers !== "number" || !Number.isInteger(raw.maxSpeakers) || raw.maxSpeakers < 1 || raw.maxSpeakers > MAX_SPEAKERS2) {
          throw bad('maxSpeakers is a whole number from 1 to 10 and only goes with "diarize"');
        }
        maxSpeakers = raw.maxSpeakers;
      }
      return {
        clientReference: reference(raw.clientReference),
        audioUrl: checkUrl(audio.url, "the audio url", allowHttp),
        speakers: raw.speakers,
        maxSpeakers,
        callbackUrl: raw.callbackUrl === undefined ? undefined : checkUrl(raw.callbackUrl, "the callback url", allowHttp),
        audioKey: audioKey(raw.audioKey)
      };
    },
    list(listOptions) {
      const raw = listOptions ?? {};
      if (typeof raw !== "object" || raw === null) {
        throw bad("list options must be an object");
      }
      let prefix = "";
      if (raw.prefix !== undefined) {
        if (typeof raw.prefix !== "string" || raw.prefix.length > MAX_CLIENT_REFERENCE_LENGTH2 || raw.prefix !== "" && !REFERENCE.test(raw.prefix)) {
          throw bad('the prefix is up to 128 letters, digits, ".", "_", ":" or "-"');
        }
        prefix = raw.prefix;
      }
      let after;
      if (raw.cursor !== undefined) {
        if (typeof raw.cursor !== "string" || !CURSOR.test(raw.cursor)) {
          throw bad("the cursor is not valid");
        }
        const decoded = Buffer.from(raw.cursor, "base64url").toString("utf8");
        if (encodeReferenceCursor(decoded) !== raw.cursor || !REFERENCE.test(decoded)) {
          throw bad("the cursor is not valid");
        }
        after = decoded;
      }
      const limit = raw.limit ?? DEFAULT_TRANSCRIBER_LIST_LIMIT2;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_TRANSCRIBER_LIST_LIMIT2) {
        throw bad("the limit is a whole number from 1 to 1000");
      }
      return { prefix, after, limit };
    }
  };
}
function sameSend(x, y) {
  return x.audioKey === y.audioKey && x.speakers === y.speakers && x.maxSpeakers === y.maxSpeakers;
}

// src/transcribe/memory.ts
function defaultTurns(request) {
  const split = request.speakers === "split_channels";
  return [0, 1, 2, 3].map((index) => {
    const channel = index % 2;
    return {
      speaker: split ? `ch${channel}` : channel === 0 ? "A" : "B",
      ...split ? { channel } : {},
      startMs: index * 5000,
      endMs: index * 5000 + 4000,
      text: `Turn ${index + 1} of the scripted conversation.`
    };
  });
}
function defaultOutcome(request) {
  return {
    pendingReads: 1,
    result: { status: "done", durationMs: 20000, turns: defaultTurns(request) }
  };
}
function checkOutcome(outcome) {
  checkTranscriptionResult2(outcome.result);
  const reads = outcome.pendingReads ?? 1;
  if (!Number.isInteger(reads) || reads < 0 || reads > 1000) {
    throw new TypeError("pendingReads must be a whole number from 0 to 1000");
  }
  return { pendingReads: reads, result: outcome.result };
}
function createMemoryTranscriber(options = {}) {
  const check = createTranscriberValidator({
    isOrganizationId: options.isOrganizationId,
    environment: options.environment ?? "local"
  });
  const organizations = new Map;
  const scripts = new Map;
  const failures = [];
  let acceptThenFail = 0;
  const vendorIdOf = (org, reference) => `mem_${createHash2("sha256").update(`${org}\x00${reference}`).digest("hex").slice(0, 20)}`;
  const scriptKey = (org, reference) => `${org}\x00${reference}`;
  function maybeFail(operation) {
    const at = failures.findIndex((entry) => entry.operation === operation);
    if (at >= 0) {
      const [entry] = failures.splice(at, 1);
      throw new TranscriberError2(entry.code, "the scripted failure of the stand-in");
    }
  }
  const stateOf = (copy, consume) => {
    if (copy.pendingReads > 0) {
      if (consume) {
        copy.pendingReads -= 1;
      }
      return { status: "pending" };
    }
    return copy.outcome.status === "done" ? {
      status: "done",
      durationMs: copy.outcome.durationMs,
      turns: copy.outcome.turns.map((turn) => ({ ...turn }))
    } : { status: "failed", reason: copy.outcome.reason };
  };
  return {
    async submit(organizationId, request) {
      maybeFail("submit");
      const org = check.organization(organizationId);
      const checked = check.request(request);
      let sends = organizations.get(org);
      if (sends === undefined) {
        sends = new Map;
        organizations.set(org, sends);
      }
      const existing = sends.get(checked.clientReference);
      if (existing !== undefined) {
        if (!sameSend(existing.request, checked)) {
          throw new TranscriberError2(TRANSCRIBER_ERROR_CODES2.conflict, "the client reference is already used by a different send");
        }
        return {
          clientReference: checked.clientReference,
          created: false,
          vendorId: existing.vendorId
        };
      }
      const scripted = scripts.get(scriptKey(org, checked.clientReference)) ?? options.outcome?.({
        speakers: checked.speakers,
        ...checked.maxSpeakers === undefined ? {} : { maxSpeakers: checked.maxSpeakers }
      }) ?? defaultOutcome(checked);
      const outcome = checkOutcome(scripted);
      const vendorId = vendorIdOf(org, checked.clientReference);
      sends.set(checked.clientReference, {
        request: checked,
        vendorId,
        pendingReads: outcome.pendingReads ?? 1,
        outcome: outcome.result
      });
      if (acceptThenFail > 0) {
        acceptThenFail -= 1;
        throw new TranscriberError2(TRANSCRIBER_ERROR_CODES2.unavailable, "the stand-in accepted the send and then failed to answer");
      }
      return { clientReference: checked.clientReference, created: true, vendorId };
    },
    async getResult(organizationId, clientReference, hint) {
      maybeFail("getResult");
      const org = check.organization(organizationId);
      const reference = check.reference(clientReference);
      check.hint(hint);
      const copy = organizations.get(org)?.get(reference);
      return copy === undefined ? undefined : stateOf(copy, true);
    },
    async delete(organizationId, clientReference, hint) {
      maybeFail("delete");
      const org = check.organization(organizationId);
      const reference = check.reference(clientReference);
      check.hint(hint);
      const existed = organizations.get(org)?.delete(reference) === true;
      scripts.delete(scriptKey(org, reference));
      return { existed };
    },
    async list(organizationId, listOptions) {
      maybeFail("list");
      const org = check.organization(organizationId);
      const { prefix, after, limit } = check.list(listOptions);
      const matches = [];
      for (const pair of organizations.get(org) ?? []) {
        if (pair[0].startsWith(prefix) && (after === undefined || pair[0] > after)) {
          matches.push(pair);
        }
      }
      matches.sort((x, y) => x[0] < y[0] ? -1 : 1);
      const items = matches.slice(0, limit).map(([clientReference, copy]) => ({
        clientReference,
        vendorId: copy.vendorId,
        status: stateOf(copy, false).status
      }));
      const last = items.at(-1);
      const page = { items };
      if (matches.length > limit && last !== undefined) {
        page.nextCursor = encodeReferenceCursor(last.clientReference);
      }
      return page;
    },
    script(organizationId, clientReference, outcome) {
      const org = check.organization(organizationId);
      const reference = check.reference(clientReference);
      const checked = checkOutcome(outcome);
      scripts.set(scriptKey(org, reference), checked);
      const copy = organizations.get(org)?.get(reference);
      if (copy !== undefined) {
        copy.outcome = checked.result;
        copy.pendingReads = checked.pendingReads ?? 1;
      }
    },
    failNext(operation, code, times = 1) {
      for (let i = 0;i < times; i++) {
        failures.push({ operation, code });
      }
    },
    acceptThenFailNext(times = 1) {
      acceptThenFail += times;
    },
    copies(organizationId) {
      const held = [];
      for (const [org, sends] of [...organizations].sort((x, y) => x[0] < y[0] ? -1 : 1)) {
        if (organizationId !== undefined && org !== organizationId) {
          continue;
        }
        for (const [clientReference, copy] of [...sends].sort((x, y) => x[0] < y[0] ? -1 : 1)) {
          held.push({
            organizationId: org,
            clientReference,
            vendorId: copy.vendorId,
            status: stateOf(copy, false).status
          });
        }
      }
      return held;
    }
  };
}
// src/vector/validate.ts
var VECTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
var ATTRIBUTE_NAME = /^[a-z][a-z0-9_]{0,63}$/;
var RESERVED_ATTRIBUTE_NAMES = new Set(["id", "vector"]);
var bad2 = (message) => new VectorError2(VECTOR_ERROR_CODES2.invalidRequest, message);
function attributesMatch(attributes, filter) {
  for (const name of Object.keys(filter)) {
    if (!Object.hasOwn(attributes, name) || attributes[name] !== filter[name]) {
      return false;
    }
  }
  return true;
}
function createVectorValidator(options) {
  const { dimensions } = options;
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > MAX_DIMENSIONS2) {
    throw new TypeError("dimensions must be a whole number from 1 to 4096");
  }
  const isOrganization = createOrganizationIdGuard(options.isOrganizationId);
  function vector(value) {
    if (typeof value !== "object" || value === null || typeof value.length !== "number") {
      throw bad2("a vector must be an array of numbers");
    }
    const source = value;
    if (source.length !== dimensions) {
      throw new VectorError2(VECTOR_ERROR_CODES2.dimensionMismatch, `a vector must have ${dimensions} dimensions`, { details: { expected: dimensions, actual: source.length } });
    }
    const out = new Float32Array(dimensions);
    let norm = 0;
    for (let i = 0;i < dimensions; i++) {
      const x = source[i];
      if (typeof x !== "number") {
        throw bad2("a vector holds only finite numbers");
      }
      out[i] = x;
      const stored = out[i];
      if (!Number.isFinite(stored)) {
        throw bad2("a vector holds only finite numbers");
      }
      norm += stored * stored;
    }
    if (!(norm > 0) || !Number.isFinite(norm)) {
      throw bad2("a vector must not be all zeros or too large to compare");
    }
    return out;
  }
  function attributes(value, what) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw bad2(`${what} must be an object`);
    }
    const names = Object.keys(value);
    if (names.length > MAX_ATTRIBUTES2) {
      throw bad2(`${what} has at most 16 entries`);
    }
    const out = {};
    for (const name of names) {
      const item = value[name];
      const okValue = typeof item === "boolean" || typeof item === "number" && Number.isFinite(item) || typeof item === "string" && item.length <= MAX_ATTRIBUTE_STRING2;
      if (!ATTRIBUTE_NAME.test(name) || RESERVED_ATTRIBUTE_NAMES.has(name) || !okValue) {
        throw bad2(`${what} names are lower-case snake_case; values are booleans, finite numbers or strings of at most 512 characters; "id" and "vector" are reserved`);
      }
      out[name] = item;
    }
    return out;
  }
  function id(value) {
    if (typeof value !== "string" || !VECTOR_ID.test(value)) {
      throw bad2('a vector id is 1 to 64 letters, digits, ".", "_", ":" or "-"');
    }
    return value;
  }
  return {
    dimensions,
    organization(value) {
      if (!isOrganization(value)) {
        throw bad2("the Organization id is not valid");
      }
      return value;
    },
    records(value) {
      if (!Array.isArray(value) || value.length < 1 || value.length > MAX_UPSERT_BATCH2) {
        throw bad2("an upsert takes 1 to 500 records");
      }
      const seen = new Set;
      return value.map((record) => {
        if (typeof record !== "object" || record === null) {
          throw bad2("a record must be an object");
        }
        const raw = record;
        const recordId = id(raw.id);
        if (seen.has(recordId)) {
          throw bad2("an upsert holds each id once");
        }
        seen.add(recordId);
        return {
          id: recordId,
          vector: vector(raw.vector),
          attributes: raw.attributes === undefined ? {} : attributes(raw.attributes, "attributes")
        };
      });
    },
    query(value) {
      if (typeof value !== "object" || value === null) {
        throw bad2("a search must be an object");
      }
      const raw = value;
      if (typeof raw.topK !== "number" || !Number.isInteger(raw.topK) || raw.topK < 1 || raw.topK > MAX_TOP_K2) {
        throw bad2("topK must be a whole number from 1 to 100");
      }
      return {
        vector: vector(raw.vector),
        topK: raw.topK,
        filter: raw.filter === undefined ? {} : attributes(raw.filter, "filter")
      };
    },
    ids(value) {
      if (!Array.isArray(value) || value.length < 1 || value.length > MAX_DELETE_BATCH2) {
        throw bad2("a delete takes 1 to 500 ids");
      }
      return value.map(id);
    },
    updateIds(value) {
      if (!Array.isArray(value) || value.length < 1 || value.length > MAX_UPSERT_BATCH2) {
        throw bad2("an attribute update takes 1 to 500 ids");
      }
      const checked = value.map(id);
      if (new Set(checked).size !== checked.length) {
        throw bad2("an attribute update holds each id once");
      }
      return checked;
    },
    nonEmptyAttributes(value) {
      const checked = attributes(value, "attributes");
      if (Object.keys(checked).length === 0) {
        throw bad2("attributes must have at least one entry");
      }
      return checked;
    },
    nonEmptyFilter(value) {
      const filter = attributes(value, "filter");
      if (Object.keys(filter).length === 0) {
        throw bad2("the filter must have at least one entry");
      }
      return filter;
    }
  };
}

// src/vector/memory.ts
function normalise(vector) {
  let norm = 0;
  for (const x of vector) {
    norm += x * x;
  }
  const scale = 1 / Math.sqrt(norm);
  return vector.map((x) => x * scale);
}
function createMemoryVectorStore(options) {
  const check = createVectorValidator(options);
  const organizations = new Map;
  return {
    dimensions: check.dimensions,
    async warm(organizationId) {
      check.organization(organizationId);
    },
    async deleteAll(organizationId) {
      organizations.delete(check.organization(organizationId));
    },
    async upsert(organizationId, records) {
      const org = check.organization(organizationId);
      const checked = check.records(records);
      let vectors = organizations.get(org);
      if (vectors === undefined) {
        vectors = new Map;
        organizations.set(org, vectors);
      }
      for (const record of checked) {
        vectors.set(record.id, {
          unit: normalise(record.vector),
          attributes: { ...record.attributes }
        });
      }
    },
    async search(organizationId, query) {
      const org = check.organization(organizationId);
      const { vector, topK, filter } = check.query(query);
      const unit = normalise(vector);
      const hits = [];
      for (const [id, stored] of organizations.get(org) ?? []) {
        if (!attributesMatch(stored.attributes, filter)) {
          continue;
        }
        let dot = 0;
        for (let i = 0;i < unit.length; i++) {
          dot += unit[i] * stored.unit[i];
        }
        hits.push({ id, score: dot, attributes: { ...stored.attributes } });
      }
      hits.sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : 1));
      return hits.slice(0, topK);
    },
    async setAttributes(organizationId, ids, attributes) {
      const org = check.organization(organizationId);
      const checkedIds = check.updateIds(ids);
      const changes = check.nonEmptyAttributes(attributes);
      const vectors = organizations.get(org);
      const missing = [];
      const merged = [];
      for (const id of checkedIds) {
        const stored = vectors?.get(id);
        if (stored === undefined) {
          missing.push(id);
          continue;
        }
        const next = { ...stored.attributes, ...changes };
        if (Object.keys(next).length > MAX_ATTRIBUTES2) {
          throw new VectorError2(VECTOR_ERROR_CODES2.invalidRequest, "a vector has at most 16 attributes");
        }
        merged.push([stored, next]);
      }
      for (const [stored, next] of merged) {
        stored.attributes = next;
      }
      return missing;
    },
    async delete(organizationId, ids) {
      const org = check.organization(organizationId);
      const checked = check.ids(ids);
      const vectors = organizations.get(org);
      for (const id of checked) {
        vectors?.delete(id);
      }
    },
    async deleteByFilter(organizationId, filter) {
      const org = check.organization(organizationId);
      const checked = check.nonEmptyFilter(filter);
      const vectors = organizations.get(org);
      for (const [id, stored] of vectors ?? []) {
        if (attributesMatch(stored.attributes, checked)) {
          vectors?.delete(id);
        }
      }
    }
  };
}

// src/testing.ts
function build(entries, bound) {
  const record = (level) => (message, fields) => {
    entries.push({
      level,
      message: scrubText2(message),
      fields: { ...bound, ...prepareFields(fields) }
    });
  };
  return {
    entries,
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    child: (fields) => build(entries, { ...bound, ...prepareFields(fields) })
  };
}
function createMemoryLogger() {
  return build([], {});
}
function createTestDeps(overrides = {}) {
  return {
    clock: overrides.clock ?? createFixedClock2("2026-01-01T00:00:00.000Z"),
    logger: overrides.logger ?? createMemoryLogger(),
    errorReporter: overrides.errorReporter ?? createMemoryErrorReporter()
  };
}
export {
  DEFAULT_TEST_ORGANIZATION_ID,
  DEFAULT_TEST_USER_ID,
  createMemoryContactGuard,
  createMemoryErrorReporter,
  createMemoryLogger,
  createMemoryObjectStore,
  createMemoryQueue,
  createMemoryTelephony,
  createMemoryTranscriber,
  createMemoryVectorStore,
  createTestDeps,
  createTestJwks,
  createTestKeyPair,
  createTestRegistry,
  createVirtualTime,
  mintTestToken,
  testNote,
  testOrganizationId,
  testPing,
  testUserId
};
