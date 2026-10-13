import {
  scrubText2,
  prepareFields,
  shouldReportError2,
  VECTOR_ERROR_CODES2,
  VectorError2,
  MAX_UPSERT_BATCH2,
  MAX_DELETE_BATCH2,
  MAX_TOP_K2,
  MAX_DIMENSIONS2,
  MAX_ATTRIBUTES2,
  MAX_ATTRIBUTE_STRING2
} from "./shared/chunk-wvahtrty.js";
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
  createOrganizationIdGuard,
  encodeCursor,
  createStorageValidator
} from "./shared/chunk-kjet3m0h.js";
import"./shared/chunk-r2rshw7g.js";
import {
  assertReceiveOptions2,
  assertVisibility2,
  assertBatchCount2,
  systemSleep2
} from "./shared/chunk-dpkegc79.js";

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
function createMemoryObjectStore(options = {}) {
  const clock = options.clock ?? systemClock2;
  const check = createStorageValidator({
    maxObjectBytes: options.maxObjectBytes,
    isOrganizationId: options.isOrganizationId
  });
  const organizations = new Map;
  const info = (key, entry) => ({
    key,
    size: entry.body.byteLength,
    contentType: entry.contentType,
    lastModified: new Date(entry.lastModified)
  });
  return {
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
    async get(organizationId, key) {
      const org = check.organization(organizationId);
      const name = check.key(key);
      const entry = organizations.get(org)?.get(name);
      if (entry === undefined) {
        return;
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
}
// src/vector/validate.ts
var VECTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
var ATTRIBUTE_NAME = /^[a-z][a-z0-9_]{0,63}$/;
var bad = (message) => new VectorError2(VECTOR_ERROR_CODES2.invalidRequest, message);
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
      throw bad("a vector must be an array of numbers");
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
        throw bad("a vector holds only finite numbers");
      }
      out[i] = x;
      const stored = out[i];
      if (!Number.isFinite(stored)) {
        throw bad("a vector holds only finite numbers");
      }
      norm += stored * stored;
    }
    if (!(norm > 0) || !Number.isFinite(norm)) {
      throw bad("a vector must not be all zeros or too large to compare");
    }
    return out;
  }
  function attributes(value, what) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw bad(`${what} must be an object`);
    }
    const names = Object.keys(value);
    if (names.length > MAX_ATTRIBUTES2) {
      throw bad(`${what} has at most 16 entries`);
    }
    const out = {};
    for (const name of names) {
      const item = value[name];
      const okValue = typeof item === "boolean" || typeof item === "number" && Number.isFinite(item) || typeof item === "string" && item.length <= MAX_ATTRIBUTE_STRING2;
      if (!ATTRIBUTE_NAME.test(name) || !okValue) {
        throw bad(`${what} names are lower-case snake_case; values are booleans, finite numbers or strings of at most 512 characters`);
      }
      out[name] = item;
    }
    return out;
  }
  function id(value) {
    if (typeof value !== "string" || !VECTOR_ID.test(value)) {
      throw bad('a vector id is 1 to 128 letters, digits, ".", "_", ":" or "-"');
    }
    return value;
  }
  return {
    dimensions,
    organization(value) {
      if (!isOrganization(value)) {
        throw bad("the Organization id is not valid");
      }
      return value;
    },
    records(value) {
      if (!Array.isArray(value) || value.length < 1 || value.length > MAX_UPSERT_BATCH2) {
        throw bad("an upsert takes 1 to 500 records");
      }
      const seen = new Set;
      return value.map((record) => {
        if (typeof record !== "object" || record === null) {
          throw bad("a record must be an object");
        }
        const raw = record;
        const recordId = id(raw.id);
        if (seen.has(recordId)) {
          throw bad("an upsert holds each id once");
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
        throw bad("a search must be an object");
      }
      const raw = value;
      if (typeof raw.topK !== "number" || !Number.isInteger(raw.topK) || raw.topK < 1 || raw.topK > MAX_TOP_K2) {
        throw bad("topK must be a whole number from 1 to 100");
      }
      return {
        vector: vector(raw.vector),
        topK: raw.topK,
        filter: raw.filter === undefined ? {} : attributes(raw.filter, "filter")
      };
    },
    ids(value) {
      if (!Array.isArray(value) || value.length < 1 || value.length > MAX_DELETE_BATCH2) {
        throw bad("a delete takes 1 to 500 ids");
      }
      return value.map(id);
    },
    nonEmptyFilter(value) {
      const filter = attributes(value, "filter");
      if (Object.keys(filter).length === 0) {
        throw bad("the filter must have at least one entry");
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
  createMemoryErrorReporter,
  createMemoryLogger,
  createMemoryObjectStore,
  createMemoryQueue,
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
