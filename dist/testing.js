import {
  parseAuditEntry2,
  CONTACT_UNAVAILABLE2,
  isContactGuardRequest2,
  DEFAULT_LLM_TIMEOUT_MS2,
  MAX_LLM_TIMEOUT_MS2,
  DEFAULT_LLM_MAX_INPUT_TOKENS2,
  MAX_LLM_MAX_INPUT_TOKENS2,
  DEFAULT_LLM_MAX_OUTPUT_TOKENS2,
  MAX_LLM_MAX_OUTPUT_TOKENS2,
  MAX_LLM_MESSAGES2,
  MODEL_TIERS2,
  ESTIMATED_CHARS_PER_TOKEN2,
  estimateTokens2,
  DEFAULT_LLM_RETRY_POLICY2,
  llmRetryDelayMs2,
  scrubText2,
  prepareFields,
  signTwilioRequest2,
  TELEPHONY_ERROR_CODES2,
  TelephonyError2,
  invalid,
  checkOrganizationId,
  checkCallId,
  checkIdentity,
  checkNumber,
  checkProviderId,
  checkDisclosure,
  checkRingIdentities,
  checkDestinationUrl,
  resolveTimeout,
  requireDisclosure,
  startMessagingDeadline,
  AttemptAborted,
  raceAbort,
  withMessagingRetry,
  requireConsent,
  invalid2,
  checkSendRequest,
  verifyAndParseWebhook,
  shouldReportError2,
  STREAMING_TRANSCRIBE_ERROR_CODES2,
  StreamingTranscribeError2,
  DEFAULT_STREAMING_TRANSCRIBE_TIMEOUT_MS2,
  MAX_STREAMING_TRANSCRIBE_TIMEOUT_MS2,
  MAX_AUDIO_CHUNK_BYTES2,
  DEFAULT_RECONNECT_POLICY2,
  reconnectDelayMs2,
  TtsAudioChunk2,
  DEFAULT_TTS_TIMEOUT_MS2,
  MAX_TTS_TIMEOUT_MS2,
  DEFAULT_TTS_FIRST_CHUNK_TIMEOUT_MS2,
  MAX_TTS_FIRST_CHUNK_TIMEOUT_MS2,
  DEFAULT_TTS_MAX_TEXT_CHARS2,
  MAX_TTS_MAX_TEXT_CHARS2,
  MAX_TTS_AUDIO_CHUNK_BYTES2,
  DEFAULT_TTS_RETRY_POLICY2,
  ttsRetryDelayMs2,
  VECTOR_ERROR_CODES2,
  VectorError2,
  MAX_UPSERT_BATCH2,
  MAX_DELETE_BATCH2,
  MAX_TOP_K2,
  MAX_DIMENSIONS2,
  MAX_ATTRIBUTES2,
  MAX_ATTRIBUTE_STRING2
} from "./shared/chunk-mnvbt65g.js";
import {
  CalendarConnection2,
  CALENDAR_ERROR_CODES2,
  CalendarError2,
  DEFAULT_CALENDAR_TIMEOUT_MS2,
  MAX_CALENDAR_TIMEOUT_MS2,
  MAX_BUSY_RANGE_MS2,
  MAX_BUSY_INTERVALS2,
  MAX_EVENT_DURATION_MS2,
  MAX_EVENT_ATTENDEES2,
  DEFAULT_CALENDAR_RETRY_POLICY2,
  calendarRetryDelayMs2,
  LLM_ERROR_CODES2,
  LlmError2,
  MessagingError2,
  isReportableMessagingError2,
  DEFAULT_TELEPHONY_TIMEOUT_MS2,
  MAX_WEBHOOK_BODY_BYTES2,
  TRANSCRIBER_ERROR_CODES2,
  TranscriberError2,
  MAX_CLIENT_REFERENCE_LENGTH2,
  MAX_AUDIO_URL_LENGTH2,
  MAX_SPEAKERS2,
  DEFAULT_TRANSCRIBER_LIST_LIMIT2,
  MAX_TRANSCRIBER_LIST_LIMIT2,
  MAX_VENDOR_ID_LENGTH2,
  checkTranscriptionResult2,
  TTS_ERROR_CODES2,
  TtsError2
} from "./shared/chunk-q819sn0x.js";
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

// src/audit/memory.ts
function createMemoryAuditRecorder(options = {}) {
  const clock = options.clock ?? systemClock2;
  const stored = new Map;
  return {
    async record(input) {
      const entry = parseAuditEntry2(input);
      const key = `${entry.organizationId}\x00${entry.id}`;
      const duplicate = stored.has(key);
      if (!duplicate) {
        stored.set(key, structuredClone({ ...entry, occurredAt: entry.occurredAt ?? clock.now().toISOString() }));
      }
      options.logger?.info("audit entry recorded", {
        eventId: entry.id,
        action: entry.action,
        metadataKeys: Object.keys(entry.metadata ?? {}).length,
        duplicate
      });
    },
    entries: () => [...stored.values()].map((entry) => structuredClone(entry))
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
// src/calendar/deadline.ts
function startCalendarDeadline(timeoutMs, caller) {
  const controller = new AbortController;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCaller = () => controller.abort();
  if (caller?.aborted) {
    controller.abort();
  }
  caller?.addEventListener("abort", onCaller, { once: true });
  return {
    signal: controller.signal,
    check() {
      if (timedOut) {
        throw new CalendarError2(CALENDAR_ERROR_CODES2.timeout, "The call took too long", {
          details: { timeoutMs }
        });
      }
      if (controller.signal.aborted) {
        throw new CalendarError2(CALENDAR_ERROR_CODES2.aborted, "The call was cancelled");
      }
    },
    stop() {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onCaller);
    }
  };
}
function isRetryableCalendarError(error) {
  return error instanceof CalendarError2 && error.code === CALENDAR_ERROR_CODES2.unavailable;
}
async function withCalendarRetry(attempt, options) {
  const sleep = options.sleep ?? systemSleep2;
  for (let n = 1;; n++) {
    options.deadline.check();
    try {
      return await attempt(n);
    } catch (error) {
      options.deadline.check();
      if (!isRetryableCalendarError(error) || n > options.policy.maxRetries) {
        throw error;
      }
      const delayMs = calendarRetryDelayMs2(n, options.policy, options.random);
      options.onRetry?.(n, delayMs);
      await sleep(delayMs, options.deadline.signal);
    }
  }
}

// src/calendar/validate.ts
import { organizationIdSchema } from "tula-closeline-contract";
import { z } from "zod";
function invalid3(what) {
  throw new CalendarError2(CALENDAR_ERROR_CODES2.invalidRequest, `${what} is not acceptable`);
}
function integerIn(value, min, max) {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}
function checkOptions(options) {
  if (options !== undefined && (typeof options !== "object" || options === null)) {
    invalid3("options");
  }
  const timeoutMs = options?.timeoutMs ?? DEFAULT_CALENDAR_TIMEOUT_MS2;
  if (!integerIn(timeoutMs, 1, MAX_CALENDAR_TIMEOUT_MS2)) {
    invalid3("timeoutMs");
  }
  if (options?.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    invalid3("signal");
  }
  const policy = options?.retry;
  const maxRetries = policy?.maxRetries ?? DEFAULT_CALENDAR_RETRY_POLICY2.maxRetries;
  const baseDelayMs = policy?.baseDelayMs ?? DEFAULT_CALENDAR_RETRY_POLICY2.baseDelayMs;
  const maxDelayMs = policy?.maxDelayMs ?? DEFAULT_CALENDAR_RETRY_POLICY2.maxDelayMs;
  if (!integerIn(maxRetries, 0, 5)) {
    invalid3("retry.maxRetries");
  }
  if (!integerIn(baseDelayMs, 1, 60000)) {
    invalid3("retry.baseDelayMs");
  }
  if (!integerIn(maxDelayMs, baseDelayMs, 60000)) {
    invalid3("retry.maxDelayMs");
  }
  return {
    timeoutMs,
    retry: { maxRetries, baseDelayMs, maxDelayMs },
    ...options?.signal === undefined ? {} : { signal: options.signal }
  };
}
function parse(schema, value, what) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.filter((p) => typeof p === "string").join(".");
    return invalid3(path ? `${what}.${path}` : what);
  }
  return parsed.data;
}
var instant = z.iso.datetime({ offset: true });
var requestIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
var eventIdSchema = z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/);
var attendeeSchema = z.strictObject({
  email: z.email().max(254),
  name: z.string().min(1).max(200).optional()
});
var titleSchema = z.string().min(1).max(256);
var descriptionSchema = z.string().max(8192);
var locationSchema = z.string().max(512);
var attendeesSchema = z.array(attendeeSchema).max(MAX_EVENT_ATTENDEES2);
var eventSchema = z.strictObject({
  title: titleSchema,
  start: instant,
  end: instant,
  description: descriptionSchema.optional(),
  location: locationSchema.optional(),
  attendees: attendeesSchema.optional(),
  conferencing: z.enum(["video", "none"]).optional()
});
var changesSchema = z.strictObject({
  title: titleSchema.optional(),
  start: instant.optional(),
  end: instant.optional(),
  description: descriptionSchema.optional(),
  location: locationSchema.optional(),
  attendees: attendeesSchema.optional()
}).refine((c) => Object.values(c).some((v) => v !== undefined));
var grantSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("authorization_code"),
    code: z.string().min(1).max(4096),
    redirectUri: z.url().max(2048),
    codeVerifier: z.string().min(1).max(256).optional()
  }),
  z.strictObject({ kind: z.literal("refresh_token"), refreshToken: z.string().min(1).max(4096) })
]);
function checkOrganizationId2(value) {
  return organizationIdSchema.safeParse(value).success ? value : invalid3("organizationId");
}
function checkBase(request) {
  if (typeof request !== "object" || request === null) {
    return invalid3("request");
  }
  checkOrganizationId2(request.organizationId);
  if (!(request.connection instanceof CalendarConnection2)) {
    return invalid3("connection");
  }
  if (request.connection.organizationId !== request.organizationId) {
    return invalid3("connection");
  }
  return request.connection;
}
function checkGrant(value) {
  return parse(grantSchema, value, "grant");
}
function checkRequestId(value) {
  return parse(requestIdSchema, value, "requestId");
}
function checkEventId(value) {
  return parse(eventIdSchema, value, "eventId");
}
function checkRange(from, to) {
  const fromMs = Date.parse(parse(instant, from, "from"));
  const toMs = Date.parse(parse(instant, to, "to"));
  if (!(fromMs < toMs) || toMs - fromMs > MAX_BUSY_RANGE_MS2) {
    invalid3("range");
  }
  return { fromMs, toMs };
}
function checkEventTimes(startMs, endMs) {
  if (!(startMs < endMs) || endMs - startMs > MAX_EVENT_DURATION_MS2) {
    invalid3("event.times");
  }
}
function checkEvent(value) {
  const event = parse(eventSchema, value, "event");
  const startMs = Date.parse(event.start);
  const endMs = Date.parse(event.end);
  checkEventTimes(startMs, endMs);
  return { event, startMs, endMs };
}
function checkChanges(value) {
  return parse(changesSchema, value, "changes");
}

// src/calendar/memory.ts
function iso(ms) {
  return new Date(ms).toISOString();
}
function ref(event) {
  return {
    eventId: event.eventId,
    start: iso(event.startMs),
    end: iso(event.endMs),
    ...event.joinUrl === undefined ? {} : { joinUrl: event.joinUrl }
  };
}
function createMemoryCalendar(options = {}) {
  const sleep = options.sleep ?? systemSleep2;
  const allowed = new Set;
  const accounts = new Map;
  const replays = new Map;
  const script = [];
  const requests = [];
  let serial = 0;
  function report(error, organizationId) {
    if (!(error instanceof CalendarError2) || error.code !== CALENDAR_ERROR_CODES2.unavailable && error.code !== CALENDAR_ERROR_CODES2.rejected) {
      return;
    }
    try {
      options.reporter?.capture(error, { organizationId, tags: { feature: "calendar" } });
    } catch {}
  }
  function account(connection) {
    const found = accounts.get(connection.connectionId);
    if (found === undefined || found.organizationId !== connection.organizationId) {
      invalid3("connection");
    }
    return found;
  }
  async function vendorRequest(kind, organizationId, signal, connection, effect) {
    const entry = { view: { kind, organizationId, aborted: false, outcome: "pending" } };
    const view = entry.view;
    requests.push(entry);
    signal.addEventListener("abort", () => {
      if (view.outcome === "pending") {
        view.aborted = true;
        view.outcome = "aborted";
      }
    }, { once: true });
    const abortedError = () => new CalendarError2(CALENDAR_ERROR_CODES2.aborted, "The call was cancelled");
    const fail = (error) => {
      if (view.outcome === "pending") {
        view.outcome = "failed";
      }
      throw error;
    };
    if (signal.aborted) {
      throw abortedError();
    }
    if (connection !== undefined && kind !== "revoke" && account(connection).revoked) {
      fail(new CalendarError2(CALENDAR_ERROR_CODES2.revoked, "The calendar connection was revoked"));
    }
    const step = script.shift();
    if (step?.kind === "fail") {
      fail(new CalendarError2(step.code, "The vendor failed"));
    }
    if (step?.kind === "hang") {
      await new Promise((resolve) => signal.addEventListener("abort", () => resolve()));
      throw abortedError();
    }
    let result;
    try {
      result = effect();
    } catch (error) {
      view.outcome = "failed";
      throw error;
    }
    if (step?.kind === "lose") {
      fail(new CalendarError2(CALENDAR_ERROR_CODES2.unavailable, "The vendor connection was lost"));
    }
    view.outcome = "ok";
    return result;
  }
  async function call(kind, organizationId, connection, callOptions, effect) {
    const checked = checkOptions(callOptions);
    const deadline = startCalendarDeadline(checked.timeoutMs, checked.signal);
    try {
      return await withCalendarRetry(() => vendorRequest(kind, organizationId, deadline.signal, connection, effect), {
        policy: kind === "connect" ? { ...checked.retry, maxRetries: 0 } : checked.retry,
        deadline,
        sleep,
        ...options.random === undefined ? {} : { random: options.random },
        onRetry: (retry, delayMs) => options.logger?.warn("A calendar call is retrying", { kind, retry, delayMs })
      });
    } catch (error) {
      report(error, organizationId);
      throw error;
    } finally {
      deadline.stop();
    }
  }
  function replay(key, fingerprint, make) {
    const seen = replays.get(key);
    if (seen !== undefined) {
      if (seen.fingerprint !== fingerprint) {
        invalid3("requestId");
      }
      return { result: seen.result, first: false };
    }
    const result = make();
    replays.set(key, { fingerprint, result });
    return { result, first: true };
  }
  function busyIntervals(acct, fromMs, toMs) {
    const blocks = [
      ...acct.foreignBusy,
      ...[...acct.events.values()].map((e) => ({ startMs: e.startMs, endMs: e.endMs }))
    ].map((b) => ({ startMs: Math.max(b.startMs, fromMs), endMs: Math.min(b.endMs, toMs) })).filter((b) => b.startMs < b.endMs).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    const merged = [];
    for (const block of blocks) {
      const last = merged.at(-1);
      if (last !== undefined && block.startMs <= last.endMs) {
        last.endMs = Math.max(last.endMs, block.endMs);
      } else {
        merged.push({ ...block });
      }
    }
    if (merged.length > MAX_BUSY_INTERVALS2) {
      throw new CalendarError2(CALENDAR_ERROR_CODES2.rejected, "The calendar has too many busy intervals", {
        details: { reason: "too_many_intervals", max: MAX_BUSY_INTERVALS2 }
      });
    }
    return merged.map((b) => ({ start: iso(b.startMs), end: iso(b.endMs) }));
  }
  function fingerprintOf(value) {
    return JSON.stringify(value);
  }
  function eventFromInput(input, startMs, endMs) {
    serial += 1;
    const eventId = `evt_${serial}_${crypto.randomUUID()}`;
    return {
      eventId,
      title: input.title,
      startMs,
      endMs,
      attendees: (input.attendees ?? []).map((a) => ({ ...a })),
      ...input.description === undefined ? {} : { description: input.description },
      ...input.location === undefined ? {} : { location: input.location },
      ...input.conferencing === "video" ? { joinUrl: `https://meet.memory.test/${eventId}` } : {}
    };
  }
  const port = {
    async connect(request, callOptions) {
      checkOrganizationId2(request?.organizationId);
      const grant = checkGrant(request.grant);
      const secret = grant.kind === "authorization_code" ? grant.code : grant.refreshToken;
      return call("connect", request.organizationId, undefined, callOptions, () => {
        if (!allowed.has(secret)) {
          throw new CalendarError2(CALENDAR_ERROR_CODES2.rejected, "The vendor refused the grant");
        }
        serial += 1;
        const connectionId = `calconn_${serial}_${crypto.randomUUID()}`;
        accounts.set(connectionId, {
          organizationId: request.organizationId,
          revoked: false,
          events: new Map,
          foreignBusy: []
        });
        return new CalendarConnection2({
          organizationId: request.organizationId,
          provider: "memory",
          connectionId,
          credential: `access-${connectionId}-${secret}`
        });
      });
    },
    async busy(request, callOptions) {
      const connection = checkBase(request);
      const { fromMs, toMs } = checkRange(request.from, request.to);
      return call("busy", request.organizationId, connection, callOptions, () => busyIntervals(account(connection), fromMs, toMs));
    },
    async createEvent(request, callOptions) {
      const connection = checkBase(request);
      const requestId = checkRequestId(request.requestId);
      const { event, startMs, endMs } = checkEvent(request.event);
      return call("create", request.organizationId, connection, callOptions, () => {
        const acct = account(connection);
        const { result, first } = replay(`${connection.connectionId}:create:${requestId}`, fingerprintOf({
          ...event,
          start: startMs,
          end: endMs,
          conferencing: event.conferencing ?? "none"
        }), () => {
          const stored = eventFromInput(event, startMs, endMs);
          acct.events.set(stored.eventId, stored);
          return stored.eventId;
        });
        const stored = acct.events.get(result);
        if (stored === undefined) {
          throw new CalendarError2(CALENDAR_ERROR_CODES2.rejected, "The event was removed since", {
            details: { reason: "event_deleted" }
          });
        }
        return { ...ref(stored), created: first };
      });
    },
    async updateEvent(request, callOptions) {
      const connection = checkBase(request);
      const eventId = checkEventId(request.eventId);
      const requestId = checkRequestId(request.requestId);
      const changes = checkChanges(request.changes);
      return call("update", request.organizationId, connection, callOptions, () => {
        const acct = account(connection);
        return replay(`${connection.connectionId}:update:${requestId}`, fingerprintOf({ eventId, changes }), () => {
          const stored = acct.events.get(eventId);
          if (stored === undefined) {
            throw new CalendarError2(CALENDAR_ERROR_CODES2.notFound, "The event does not exist");
          }
          const startMs = changes.start === undefined ? stored.startMs : Date.parse(changes.start);
          const endMs = changes.end === undefined ? stored.endMs : Date.parse(changes.end);
          checkEventTimes(startMs, endMs);
          stored.startMs = startMs;
          stored.endMs = endMs;
          if (changes.title !== undefined) {
            stored.title = changes.title;
          }
          if (changes.description !== undefined) {
            stored.description = changes.description;
          }
          if (changes.location !== undefined) {
            stored.location = changes.location;
          }
          if (changes.attendees !== undefined) {
            stored.attendees = changes.attendees.map((a) => ({ ...a }));
          }
          return ref(stored);
        }).result;
      });
    },
    async deleteEvent(request, callOptions) {
      const connection = checkBase(request);
      const eventId = checkEventId(request.eventId);
      const requestId = checkRequestId(request.requestId);
      return call("delete", request.organizationId, connection, callOptions, () => {
        const acct = account(connection);
        return replay(`${connection.connectionId}:delete:${requestId}`, fingerprintOf({ eventId }), () => ({ deleted: acct.events.delete(eventId) })).result;
      });
    },
    async revoke(request, callOptions) {
      const connection = checkBase(request);
      await call("revoke", request.organizationId, connection, callOptions, () => {
        account(connection).revoked = true;
      });
    },
    allowGrant(secret) {
      allowed.add(secret);
    },
    addBusy(connection, interval) {
      const { fromMs, toMs } = checkRange(interval.start, interval.end);
      account(connection).foreignBusy.push({ startMs: fromMs, endMs: toMs });
    },
    failNext(code, times = 1) {
      for (let i = 0;i < times; i++) {
        script.push({ kind: "fail", code });
      }
    },
    loseNextResponse(times = 1) {
      for (let i = 0;i < times; i++) {
        script.push({ kind: "lose" });
      }
    },
    hangNext() {
      script.push({ kind: "hang" });
    },
    revokeAtProvider(connection) {
      account(connection).revoked = true;
    },
    events(connection) {
      return [...account(connection).events.values()].map((e) => ({
        eventId: e.eventId,
        title: e.title,
        start: iso(e.startMs),
        end: iso(e.endMs),
        attendees: e.attendees.map((a) => ({ ...a })),
        ...e.description === undefined ? {} : { description: e.description },
        ...e.location === undefined ? {} : { location: e.location },
        ...e.joinUrl === undefined ? {} : { joinUrl: e.joinUrl }
      }));
    },
    requests() {
      return requests.map((entry) => ({ ...entry.view }));
    }
  };
  return port;
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
// src/llm/deadline.ts
function startDeadline(timeoutMs, caller) {
  const controller = new AbortController;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCaller = () => controller.abort();
  if (caller?.aborted) {
    controller.abort();
  }
  caller?.addEventListener("abort", onCaller, { once: true });
  return {
    signal: controller.signal,
    check() {
      if (timedOut) {
        throw new LlmError2(LLM_ERROR_CODES2.timeout, "The call took too long", {
          details: { timeoutMs }
        });
      }
      if (controller.signal.aborted) {
        throw new LlmError2(LLM_ERROR_CODES2.aborted, "The call was cancelled");
      }
    },
    cancel() {
      controller.abort();
    },
    stop() {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onCaller);
    }
  };
}
function isRetryableLlmError(error) {
  return error instanceof LlmError2 && error.code === LLM_ERROR_CODES2.unavailable;
}
async function withLlmRetry(attempt, options) {
  const sleep = options.sleep ?? systemSleep2;
  for (let n = 1;; n++) {
    options.deadline.check();
    try {
      return await attempt(n);
    } catch (error) {
      options.deadline.check();
      if (!isRetryableLlmError(error) || n > options.policy.maxRetries) {
        throw error;
      }
      const delayMs = llmRetryDelayMs2(n, options.policy, options.random);
      options.onRetry?.(n, delayMs);
      await sleep(delayMs, options.deadline.signal);
    }
  }
}

// src/llm/validate.ts
import { organizationIdSchema as organizationIdSchema2 } from "tula-closeline-contract";
import { z as z2 } from "zod";
var SCHEMA_NAME = /^[A-Za-z0-9_-]{1,64}$/;
function invalid4(what) {
  throw new LlmError2(LLM_ERROR_CODES2.invalidRequest, `${what} is not acceptable`);
}
function integerIn2(value, min, max) {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}
function resolveRetryPolicy(policy) {
  const maxRetries = policy?.maxRetries ?? DEFAULT_LLM_RETRY_POLICY2.maxRetries;
  const baseDelayMs = policy?.baseDelayMs ?? DEFAULT_LLM_RETRY_POLICY2.baseDelayMs;
  const maxDelayMs = policy?.maxDelayMs ?? DEFAULT_LLM_RETRY_POLICY2.maxDelayMs;
  if (!integerIn2(maxRetries, 0, 5)) {
    invalid4("retry.maxRetries");
  }
  if (!integerIn2(baseDelayMs, 1, 60000)) {
    invalid4("retry.baseDelayMs");
  }
  if (!integerIn2(maxDelayMs, baseDelayMs, 60000)) {
    invalid4("retry.maxDelayMs");
  }
  return { maxRetries, baseDelayMs, maxDelayMs };
}
function checkRequest(request) {
  if (typeof request !== "object" || request === null) {
    return invalid4("request");
  }
  if (!organizationIdSchema2.safeParse(request.organizationId).success) {
    invalid4("organizationId");
  }
  if (!MODEL_TIERS2.includes(request.tier)) {
    invalid4("tier");
  }
  if (request.system !== undefined && typeof request.system !== "string") {
    invalid4("system");
  }
  const messages = request.messages;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_LLM_MESSAGES2) {
    invalid4("messages");
  }
  for (const message of messages) {
    const m = message;
    if (typeof m !== "object" || m === null || m.role !== "user" && m.role !== "assistant" || typeof m.content !== "string" || m.content.length < 1) {
      invalid4("messages");
    }
  }
  if (messages.at(-1)?.role !== "user") {
    invalid4("messages");
  }
  const timeoutMs = request.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS2;
  if (!integerIn2(timeoutMs, 1, MAX_LLM_TIMEOUT_MS2)) {
    invalid4("timeoutMs");
  }
  const maxInputTokens = request.maxInputTokens ?? DEFAULT_LLM_MAX_INPUT_TOKENS2;
  if (!integerIn2(maxInputTokens, 1, MAX_LLM_MAX_INPUT_TOKENS2)) {
    invalid4("maxInputTokens");
  }
  const maxOutputTokens = request.maxOutputTokens ?? DEFAULT_LLM_MAX_OUTPUT_TOKENS2;
  if (!integerIn2(maxOutputTokens, 1, MAX_LLM_MAX_OUTPUT_TOKENS2)) {
    invalid4("maxOutputTokens");
  }
  if (request.signal !== undefined && !(request.signal instanceof AbortSignal)) {
    invalid4("signal");
  }
  const retry = resolveRetryPolicy(request.retry);
  const inputTokens = estimateTokens2(request.system ?? "") + messages.reduce((sum, m) => sum + estimateTokens2(m.content), 0);
  if (inputTokens > maxInputTokens) {
    throw new LlmError2(LLM_ERROR_CODES2.inputTooLarge, "The prompt is over the input token budget", {
      details: { maxInputTokens }
    });
  }
  return { timeoutMs, maxInputTokens, maxOutputTokens, retry, inputTokens };
}
function checkCompleteRequest(request) {
  const checked = checkRequest(request);
  if (!(request.schema instanceof z2.ZodType)) {
    invalid4("schema");
  }
  if (typeof request.schemaName !== "string" || !SCHEMA_NAME.test(request.schemaName)) {
    invalid4("schemaName");
  }
  let jsonSchema;
  try {
    jsonSchema = z2.toJSONSchema(request.schema, { io: "input" });
  } catch {
    return invalid4("schema");
  }
  return { checked, jsonSchema };
}
function parseModelOutput(schema, text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new LlmError2(LLM_ERROR_CODES2.invalidOutput, "The model did not answer in JSON", {
      details: { reason: "not_json" }
    });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new LlmError2(LLM_ERROR_CODES2.invalidOutput, "The model answer does not fit the schema", {
      details: { reason: "schema", issues: parsed.error.issues.length }
    });
  }
  return parsed.data;
}

// src/llm/memory.ts
function createMemoryLlm(options = {}) {
  const sleep = options.sleep ?? systemSleep2;
  const replies = [];
  const failures = [];
  const requests = [];
  function report(error, organizationId, tier) {
    if (!(error instanceof LlmError2) || error.code !== LLM_ERROR_CODES2.unavailable && error.code !== LLM_ERROR_CODES2.rejected && error.code !== LLM_ERROR_CODES2.badResponse && error.code !== LLM_ERROR_CODES2.invalidOutput) {
      return;
    }
    try {
      options.reporter?.capture(error, { organizationId, tags: { feature: "llm", tier } });
    } catch {}
  }
  async function vendorRequest(kind, base, signal) {
    const entry = {
      view: { kind, ...base, aborted: false, outcome: "pending" }
    };
    requests.push(entry);
    signal.addEventListener("abort", () => {
      if (entry.view.outcome === "pending") {
        entry.view.aborted = true;
        entry.view.outcome = "aborted";
      }
    }, { once: true });
    const abortedError = () => new LlmError2(LLM_ERROR_CODES2.aborted, "The call was cancelled");
    if (signal.aborted) {
      throw abortedError();
    }
    const code = failures.shift();
    if (code !== undefined) {
      entry.view.outcome = "failed";
      throw new LlmError2(code, "The vendor failed");
    }
    const next = replies.shift();
    if (next === undefined) {
      entry.view.outcome = "failed";
      throw new LlmError2(LLM_ERROR_CODES2.badResponse, "The vendor sent nothing usable");
    }
    if (next.hang) {
      await new Promise((resolve) => signal.addEventListener("abort", () => resolve()));
    } else if ((next.delayMs ?? 0) > 0) {
      await sleep(next.delayMs ?? 0, signal);
    }
    if (signal.aborted) {
      throw abortedError();
    }
    if (kind === "complete") {
      entry.view.outcome = "ok";
    }
    return { reply: next, entry };
  }
  const port = {
    async complete(request) {
      const { checked } = checkCompleteRequest(request);
      const deadline = startDeadline(checked.timeoutMs, request.signal);
      try {
        const { reply } = await withLlmRetry(() => vendorRequest("complete", request, deadline.signal), {
          policy: checked.retry,
          deadline,
          sleep,
          ...options.random === undefined ? {} : { random: options.random },
          onRetry: (retry, delayMs) => options.logger?.warn("A model call is retrying", {
            tier: request.tier,
            retry,
            delayMs
          })
        });
        const outputTokens = reply.outputTokens ?? estimateTokens2(reply.text);
        if (outputTokens > checked.maxOutputTokens) {
          throw new LlmError2(LLM_ERROR_CODES2.invalidOutput, "The model answer was cut off by the output token budget", { details: { reason: "truncated", maxOutputTokens: checked.maxOutputTokens } });
        }
        const value = parseModelOutput(request.schema, reply.text);
        return {
          value,
          usage: { inputTokens: reply.inputTokens ?? checked.inputTokens, outputTokens }
        };
      } catch (error) {
        report(error, request.organizationId, request.tier);
        throw error;
      } finally {
        deadline.stop();
      }
    },
    stream(request) {
      const checked = checkRequest(request);
      async function* run() {
        const deadline = startDeadline(checked.timeoutMs, request.signal);
        let entry;
        try {
          const started = await withLlmRetry(() => vendorRequest("stream", request, deadline.signal), {
            policy: checked.retry,
            deadline,
            sleep,
            ...options.random === undefined ? {} : { random: options.random },
            onRetry: (retry, delayMs) => options.logger?.warn("A model call is retrying", {
              tier: request.tier,
              retry,
              delayMs
            })
          });
          const reply = started.reply;
          entry = started.entry;
          const cap = checked.maxOutputTokens * ESTIMATED_CHARS_PER_TOKEN2;
          const truncated = reply.text.length > cap;
          let remaining = cap;
          const pieces = reply.chunks ?? reply.text.match(/\S+\s*/g) ?? [];
          let delivered = 0;
          let emittedChars = 0;
          for (const piece of pieces) {
            if (remaining <= 0) {
              break;
            }
            if (reply.failAfterChunks !== undefined && delivered >= reply.failAfterChunks) {
              throw new LlmError2(LLM_ERROR_CODES2.unavailable, "The vendor stream broke");
            }
            deadline.check();
            const text = piece.slice(0, remaining);
            remaining -= text.length;
            emittedChars += text.length;
            delivered += 1;
            if (text.length > 0) {
              yield { type: "text", text };
            }
          }
          deadline.check();
          if (entry !== undefined) {
            entry.view.outcome = "ok";
          }
          const usage = {
            inputTokens: reply.inputTokens ?? checked.inputTokens,
            outputTokens: Math.min(reply.outputTokens ?? Math.ceil(emittedChars / ESTIMATED_CHARS_PER_TOKEN2), checked.maxOutputTokens)
          };
          yield { type: "done", stopReason: truncated ? "max_tokens" : "end", usage };
        } catch (error) {
          if (entry?.view.outcome === "pending") {
            entry.view.outcome = "failed";
          }
          report(error, request.organizationId, request.tier);
          throw error;
        } finally {
          deadline.cancel();
          deadline.stop();
        }
      }
      return run();
    },
    reply(reply) {
      const scripted = typeof reply === "string" ? { text: reply } : reply;
      if (typeof scripted.text !== "string") {
        invalid4("reply text");
      }
      if (scripted.chunks !== undefined && scripted.chunks.join("") !== scripted.text) {
        invalid4("reply chunks");
      }
      replies.push({ ...scripted });
    },
    failNext(code, times = 1) {
      for (let i = 0;i < times; i++) {
        failures.push(code);
      }
    },
    requests() {
      return requests.map((entry) => ({ ...entry.view }));
    }
  };
  return port;
}
// src/messaging/memory.ts
import { createHash, randomBytes } from "node:crypto";
var MEMORY_MESSAGING_AUTH_TOKEN = "memory-messaging-auth-token-0123456789";
var MEMORY_MESSAGING_WEBHOOK_URL = "https://messaging.memory.test/webhooks/messaging";
function newSid(prefix) {
  return `${prefix}${randomBytes(16).toString("hex")}`;
}
function failure(code) {
  switch (code) {
    case "messaging.unavailable":
      return new MessagingError2(code, "The messaging provider is unavailable", {
        details: { status: 503 }
      });
    case "messaging.rejected":
      return new MessagingError2(code, "The messaging provider refused the request", {
        details: { status: 400 }
      });
    case "messaging.bad_response":
      return new MessagingError2(code, "The messaging provider sent an unusable answer");
    case "messaging.recipient_opted_out":
      return new MessagingError2(code, "The recipient has opted out of this sender", {
        details: { twilioCode: 21610 }
      });
    case "messaging.template_required":
      return new MessagingError2(code, "Only a template can start this conversation", {
        details: { twilioCode: 63016 }
      });
  }
}
function createMemoryMessaging(options) {
  const sleep = options.sleep ?? systemSleep2;
  const clock = options.clock ?? systemClock2;
  const views = [];
  const bodies = [];
  const script = [];
  const stored = new Map;
  function report(error, organizationId) {
    if (!isReportableMessagingError2(error)) {
      return;
    }
    try {
      options.reporter?.capture(error, { organizationId, tags: { feature: "messaging" } });
    } catch {}
  }
  async function vendor(request, signal) {
    const view = {
      organizationId: request.organizationId,
      channel: request.channel,
      contentKind: request.content.kind,
      bodyChars: request.content.kind === "text" ? request.content.body.length : 0,
      aborted: false,
      outcome: "pending"
    };
    views.push(view);
    const next = script.shift();
    try {
      if (next?.kind === "hang") {
        await raceAbort(new Promise(() => {
          return;
        }), signal);
      }
      if (next?.kind === "fail") {
        throw failure(next.code);
      }
      if (signal.aborted) {
        throw new AttemptAborted;
      }
      view.outcome = "ok";
      if (request.content.kind === "text") {
        bodies.push(request.content.body);
      }
      return { providerMessageId: newSid("SM") };
    } catch (error) {
      if (error instanceof AttemptAborted) {
        view.aborted = true;
        view.outcome = "aborted";
      } else {
        view.outcome = "failed";
      }
      throw error;
    }
  }
  return {
    failNext(code, times = 1) {
      for (let i = 0;i < times; i++) {
        script.push({ kind: "fail", code });
      }
    },
    hangNext(times = 1) {
      for (let i = 0;i < times; i++) {
        script.push({ kind: "hang" });
      }
    },
    requests() {
      return views.map((view) => ({ ...view }));
    },
    sentBodies() {
      return [...bodies];
    },
    inbound(fields) {
      const channel = fields.channel ?? "sms";
      const prefix = channel === "whatsapp" ? "whatsapp:" : "";
      return this.signedWebhook({
        MessageSid: fields.providerMessageId ?? newSid("SM"),
        From: `${prefix}${fields.from}`,
        To: `${prefix}${fields.to}`,
        Body: fields.body,
        NumMedia: String(fields.mediaCount ?? 0)
      });
    },
    status(fields) {
      return this.signedWebhook({
        MessageSid: fields.providerMessageId,
        MessageStatus: fields.status,
        ...fields.errorCode === undefined ? {} : { ErrorCode: String(fields.errorCode) }
      });
    },
    signedWebhook(fields) {
      const body = new URLSearchParams(fields).toString();
      return {
        url: MEMORY_MESSAGING_WEBHOOK_URL,
        signature: signTwilioRequest2(MEMORY_MESSAGING_AUTH_TOKEN, MEMORY_MESSAGING_WEBHOOK_URL, fields),
        body,
        contentType: "application/x-www-form-urlencoded"
      };
    },
    async receive(request) {
      return verifyAndParseWebhook(request, MEMORY_MESSAGING_AUTH_TOKEN, clock);
    },
    async send(request) {
      const checked = checkSendRequest(request);
      const deadline = startMessagingDeadline(checked.timeoutMs, checked.signal);
      try {
        const { consentCheckId, numberConsentCheckId } = await requireConsent(options.guard, checked, deadline);
        const fingerprint = createHash("sha256").update(JSON.stringify([
          checked.prospectId,
          checked.channel,
          checked.purpose,
          checked.to,
          checked.content
        ])).digest("hex");
        const key = `${checked.organizationId}|${checked.idempotencyKey}`;
        const existing = stored.get(key);
        if (existing !== undefined) {
          if (existing.fingerprint !== fingerprint) {
            return invalid2("idempotencyKey");
          }
          return existing.result;
        }
        const result = (async () => {
          try {
            const answer = await withMessagingRetry(async () => {
              try {
                return await vendor(checked, deadline.signal);
              } catch (error) {
                if (error instanceof AttemptAborted) {
                  deadline.check();
                }
                throw error;
              }
            }, {
              policy: checked.retry,
              deadline,
              sleep,
              ...options.random === undefined ? {} : { random: options.random },
              onRetry: (retry, delayMs) => options.logger?.warn("Messaging send retried", {
                feature: "messaging",
                channel: checked.channel,
                retry,
                delayMs
              })
            });
            return {
              consentCheckId,
              numberConsentCheckId,
              providerMessageId: answer.providerMessageId,
              channel: checked.channel,
              status: "queued",
              idempotencyKey: checked.idempotencyKey
            };
          } catch (error) {
            report(error, checked.organizationId);
            throw error;
          }
        })();
        stored.set(key, { fingerprint, result });
        try {
          return await result;
        } catch (error) {
          stored.delete(key);
          throw error;
        }
      } finally {
        deadline.stop();
      }
    }
  };
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
import { z as z3 } from "zod";
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
  payload: z3.object({ n: z3.number().int() })
});
var testNote = defineMessage2({
  type: "test.note",
  version: 1,
  scope: "global",
  payload: z3.object({ text: z3.string() })
});
function createTestRegistry(options = {}) {
  return createMessageRegistry2([testPing, testNote], {
    organizationIdSchema: z3.string().min(1).max(64),
    ...options
  });
}
// src/storage/memory.ts
import { createHash as createHash2, createHmac, randomBytes as randomBytes2, timingSafeEqual } from "node:crypto";
function createMemoryObjectStore(options = {}) {
  const clock = options.clock ?? systemClock2;
  const check = createStorageValidator({
    maxObjectBytes: options.maxObjectBytes,
    isOrganizationId: options.isOrganizationId
  });
  const organizations = new Map;
  const secret = randomBytes2(32);
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
      const hash = createHash2("sha256");
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
// src/streaming-transcribe/validate.ts
import { callIdSchema, organizationIdSchema as organizationIdSchema3 } from "tula-closeline-contract";
var LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
var SAMPLE_RATES = [8000, 16000, 24000, 48000];
var ENCODINGS = ["pcm_s16le", "pcm_mulaw"];
var TRACKS = ["rep", "prospect"];
function invalid5(what) {
  throw new StreamingTranscribeError2(STREAMING_TRANSCRIBE_ERROR_CODES2.invalidRequest, `${what} is not acceptable`);
}
function integerIn3(value, min, max) {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}
function checkOpenRequest(request) {
  if (typeof request !== "object" || request === null) {
    return invalid5("request");
  }
  if (!organizationIdSchema3.safeParse(request.organizationId).success) {
    invalid5("organizationId");
  }
  if (!callIdSchema.safeParse(request.callId).success) {
    invalid5("callId");
  }
  if (!TRACKS.includes(request.track)) {
    invalid5("track");
  }
  if (!ENCODINGS.includes(request.encoding)) {
    invalid5("encoding");
  }
  if (!SAMPLE_RATES.includes(request.sampleRate)) {
    invalid5("sampleRate");
  }
  if (request.language !== undefined && !(typeof request.language === "string" && LANGUAGE.test(request.language))) {
    invalid5("language");
  }
  if (typeof request.onEvent !== "function") {
    invalid5("onEvent");
  }
  return resolveReconnectPolicy(request.reconnect);
}
function resolveReconnectPolicy(policy) {
  const maxAttempts = policy?.maxAttempts ?? DEFAULT_RECONNECT_POLICY2.maxAttempts;
  const baseDelayMs = policy?.baseDelayMs ?? DEFAULT_RECONNECT_POLICY2.baseDelayMs;
  const maxDelayMs = policy?.maxDelayMs ?? DEFAULT_RECONNECT_POLICY2.maxDelayMs;
  if (!integerIn3(maxAttempts, 0, 10)) {
    invalid5("reconnect.maxAttempts");
  }
  if (!integerIn3(baseDelayMs, 1, 60000)) {
    invalid5("reconnect.baseDelayMs");
  }
  if (!integerIn3(maxDelayMs, baseDelayMs, 60000)) {
    invalid5("reconnect.maxDelayMs");
  }
  return { maxAttempts, baseDelayMs, maxDelayMs };
}
function resolveTimeout2(options) {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_STREAMING_TRANSCRIBE_TIMEOUT_MS2;
  return integerIn3(timeoutMs, 1, MAX_STREAMING_TRANSCRIBE_TIMEOUT_MS2) ? timeoutMs : invalid5("timeoutMs");
}
function checkChunk(chunk) {
  if (!(chunk instanceof Uint8Array) || chunk.length < 1 || chunk.length > MAX_AUDIO_CHUNK_BYTES2) {
    return invalid5("chunk");
  }
  return chunk;
}

// src/streaming-transcribe/memory.ts
var WORD_MS = 200;
function wordsOf(text, startMs) {
  return text.split(" ").filter((word) => word.length > 0).map((word, index) => ({
    text: word,
    startMs: startMs + index * WORD_MS,
    endMs: startMs + (index + 1) * WORD_MS
  }));
}
function checkScript(turns) {
  if (!Array.isArray(turns) || turns.length > 1000) {
    invalid5("turns");
  }
  let previous = 0;
  for (const turn of turns) {
    const count = typeof turn?.text === "string" ? wordsOf(turn.text, 0).length : 0;
    if (count < 1 || count > 200) {
      invalid5("turn text");
    }
    if (!Number.isInteger(turn.afterBytes) || turn.afterBytes < previous) {
      invalid5("afterBytes");
    }
    if (turn.interims !== undefined && !(Number.isInteger(turn.interims) && turn.interims >= 0 && turn.interims < count)) {
      invalid5("interims");
    }
    previous = turn.afterBytes;
  }
  return [...turns];
}
function createMemoryStreamingTranscribe(options = {}) {
  const sleep = options.sleep ?? systemSleep2;
  const random = options.random ?? Math.random;
  const scripts = new Map;
  const live = new Set;
  const all = new Map;
  const openFailures = [];
  let reconnectFailures = 0;
  let counter = 0;
  const scriptKey = (organizationId, callId, track) => `${organizationId}|${callId}|${track}`;
  function emit(stream, event) {
    try {
      stream.request.onEvent(event);
    } catch {
      options.logger?.warn("A stream listener threw", { streamId: stream.view.streamId });
    }
  }
  function turnEvent(stream, isFinal, endOfTurn, text) {
    stream.sequence += 1;
    const words = wordsOf(text, stream.lastWordEndMs);
    emit(stream, {
      type: "turn",
      turnId: `turn-${stream.turnCounter}`,
      sequence: stream.sequence,
      isFinal,
      endOfTurn,
      text,
      words
    });
    if (isFinal) {
      stream.lastWordEndMs = words.at(-1)?.endMs ?? stream.lastWordEndMs;
    }
  }
  function pump(stream) {
    const script = stream.script;
    while (script !== undefined && stream.view.state === "open" && script.next < script.turns.length) {
      const turn = script.turns[script.next];
      if (turn === undefined || stream.view.audioBytes < turn.afterBytes) {
        return;
      }
      script.next += 1;
      const words = turn.text.split(" ").filter((word) => word.length > 0);
      const interims = turn.interims ?? Math.min(2, words.length - 1);
      for (let i = 1;i <= interims; i++) {
        const take = Math.max(1, Math.floor(words.length * i / (interims + 1)));
        turnEvent(stream, false, false, words.slice(0, take).join(" "));
      }
      const endOfTurn = turn.endOfTurn ?? true;
      turnEvent(stream, true, endOfTurn, words.join(" "));
      if (endOfTurn) {
        stream.turnCounter += 1;
      }
    }
  }
  function finish(stream, state) {
    stream.view.state = state;
    live.delete(stream.key);
    stream.abort.abort();
  }
  function fail(stream, attempts) {
    finish(stream, "failed");
    emit(stream, {
      type: "failed",
      code: STREAMING_TRANSCRIBE_ERROR_CODES2.unavailable,
      attempts
    });
    try {
      options.logger?.error("A stream could not be restored", {
        streamId: stream.view.streamId,
        track: stream.view.track,
        attempts
      });
      options.reporter?.capture(new StreamingTranscribeError2(STREAMING_TRANSCRIBE_ERROR_CODES2.unavailable, "The stream could not be restored", { details: { attempts, track: stream.view.track } }), {
        organizationId: stream.view.organizationId,
        tags: { feature: "streaming-transcribe", track: stream.view.track }
      });
    } catch {}
  }
  async function reconnect(stream) {
    stream.view.state = "reconnecting";
    for (let attempt = 1;attempt <= stream.policy.maxAttempts; attempt++) {
      const delayMs = reconnectDelayMs2(attempt, stream.policy, random);
      emit(stream, { type: "reconnecting", attempt, delayMs });
      options.logger?.warn("A stream is reconnecting", {
        streamId: stream.view.streamId,
        attempt,
        delayMs
      });
      await sleep(delayMs, stream.abort.signal);
      if (stream.view.state !== "reconnecting") {
        return;
      }
      if (reconnectFailures > 0) {
        reconnectFailures -= 1;
        continue;
      }
      stream.view.state = "open";
      stream.view.reconnects += 1;
      emit(stream, { type: "reconnected", attempts: attempt });
      pump(stream);
      return;
    }
    fail(stream, stream.policy.maxAttempts);
  }
  const port = {
    async open(request, opts) {
      const policy = checkOpenRequest(request);
      resolveTimeout2(opts);
      const code = openFailures.shift();
      if (code !== undefined) {
        throw new StreamingTranscribeError2(code, "The vendor failed");
      }
      const key = scriptKey(request.organizationId, request.callId, request.track);
      if (live.has(key)) {
        throw new StreamingTranscribeError2(STREAMING_TRANSCRIBE_ERROR_CODES2.conflict, "A stream for this Call and track is already open");
      }
      counter += 1;
      const streamId = `memstream-${counter.toString(16).padStart(8, "0")}`;
      const stream = {
        view: {
          streamId,
          organizationId: request.organizationId,
          callId: request.callId,
          track: request.track,
          state: "open",
          audioBytes: 0,
          reconnects: 0
        },
        key,
        request,
        policy,
        script: scripts.get(key),
        abort: new AbortController,
        sequence: 0,
        turnCounter: 1,
        lastWordEndMs: 0
      };
      live.add(key);
      all.set(streamId, stream);
      const handle = {
        streamId,
        sendAudio(chunk) {
          const bytes = checkChunk(chunk);
          if (stream.view.state === "closed" || stream.view.state === "failed") {
            throw new StreamingTranscribeError2(STREAMING_TRANSCRIBE_ERROR_CODES2.closed, "The stream has ended");
          }
          stream.view.audioBytes += bytes.length;
          pump(stream);
        },
        async close() {
          if (stream.view.state === "closed" || stream.view.state === "failed") {
            return;
          }
          finish(stream, "closed");
          emit(stream, { type: "closed" });
        }
      };
      return handle;
    },
    script(organizationId, callId, track, turns) {
      scripts.set(scriptKey(organizationId, callId, track), {
        turns: checkScript(turns),
        next: 0
      });
    },
    async dropConnection(streamId) {
      const stream = all.get(streamId);
      if (stream?.view.state === "open") {
        await reconnect(stream);
      }
    },
    failReconnects(times = 1) {
      reconnectFailures += times;
    },
    failNextOpen(code, times = 1) {
      for (let i = 0;i < times; i++) {
        openFailures.push(code);
      }
    },
    streams() {
      return [...all.values()].map((stream) => ({ ...stream.view }));
    }
  };
  return port;
}
// src/telephony/memory.ts
import { createHmac as createHmac2, randomBytes as randomBytes3, timingSafeEqual as timingSafeEqual2 } from "node:crypto";
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
  function needDisclosure(call, needsAi = false) {
    return requireDisclosure(call.disclosure, needsAi);
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
        needDisclosure(call, true);
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
          token: `memtok.${randomBytes3(24).toString("base64url")}`,
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
import { createHash as createHash3 } from "node:crypto";

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
  const vendorIdOf = (org, reference) => `mem_${createHash3("sha256").update(`${org}\x00${reference}`).digest("hex").slice(0, 20)}`;
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
// src/tts/deadline.ts
function startTtsDeadline(timeoutMs, caller) {
  const controller = new AbortController;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();
  const onCaller = () => controller.abort();
  if (caller?.aborted) {
    controller.abort();
  }
  caller?.addEventListener("abort", onCaller, { once: true });
  return {
    signal: controller.signal,
    check() {
      if (timedOut) {
        throw new TtsError2(TTS_ERROR_CODES2.timeout, "The stream took too long", {
          details: { phase: "overall", timeoutMs }
        });
      }
      if (controller.signal.aborted) {
        throw new TtsError2(TTS_ERROR_CODES2.aborted, "The stream was cancelled");
      }
    },
    cancel() {
      controller.abort();
    },
    stop() {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onCaller);
    }
  };
}
function watchFirstChunk(signals, firstChunkTimeoutMs) {
  const own = new AbortController;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    own.abort();
  }, firstChunkTimeoutMs);
  return {
    signal: AbortSignal.any([own.signal, ...signals]),
    check() {
      if (timedOut) {
        throw new TtsError2(TTS_ERROR_CODES2.timeout, "The first audio chunk took too long", {
          details: { phase: "first_chunk", firstChunkTimeoutMs }
        });
      }
    },
    stop() {
      clearTimeout(timer);
    }
  };
}
function isRetryableTtsError(error) {
  return error instanceof TtsError2 && error.code === TTS_ERROR_CODES2.unavailable;
}
async function withTtsRetry(attempt, options) {
  const sleep = options.sleep ?? systemSleep2;
  for (let n = 1;; n++) {
    options.deadline.check();
    try {
      return await attempt(n);
    } catch (error) {
      options.deadline.check();
      if (!isRetryableTtsError(error) || n > options.policy.maxRetries) {
        throw error;
      }
      const delayMs = ttsRetryDelayMs2(n, options.policy, options.random);
      options.onRetry?.(n, delayMs);
      await sleep(delayMs, options.deadline.signal);
    }
  }
}

// src/tts/validate.ts
import { organizationIdSchema as organizationIdSchema4 } from "tula-closeline-contract";
var VOICE = /^[A-Za-z0-9_.:-]{1,128}$/;
var ENCODINGS2 = ["pcm_s16le", "pcm_mulaw"];
var SAMPLE_RATES2 = [8000, 16000, 24000, 48000];
function invalid6(what) {
  throw new TtsError2(TTS_ERROR_CODES2.invalidRequest, `${what} is not acceptable`);
}
function integerIn4(value, min, max) {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}
function resolveTtsRetryPolicy(policy) {
  if (policy !== undefined && (typeof policy !== "object" || policy === null)) {
    invalid6("retry");
  }
  const maxRetries = policy?.maxRetries ?? DEFAULT_TTS_RETRY_POLICY2.maxRetries;
  const baseDelayMs = policy?.baseDelayMs ?? DEFAULT_TTS_RETRY_POLICY2.baseDelayMs;
  const maxDelayMs = policy?.maxDelayMs ?? DEFAULT_TTS_RETRY_POLICY2.maxDelayMs;
  if (!integerIn4(maxRetries, 0, 5)) {
    invalid6("retry.maxRetries");
  }
  if (!integerIn4(baseDelayMs, 1, 60000)) {
    invalid6("retry.baseDelayMs");
  }
  if (!integerIn4(maxDelayMs, baseDelayMs, 60000)) {
    invalid6("retry.maxDelayMs");
  }
  return { maxRetries, baseDelayMs, maxDelayMs };
}
function checkOpenRequest2(request) {
  if (typeof request !== "object" || request === null) {
    return invalid6("request");
  }
  if (!organizationIdSchema4.safeParse(request.organizationId).success) {
    invalid6("organizationId");
  }
  if (typeof request.voice !== "string" || !VOICE.test(request.voice)) {
    invalid6("voice");
  }
  if (!ENCODINGS2.includes(request.encoding)) {
    invalid6("encoding");
  }
  if (!SAMPLE_RATES2.includes(request.sampleRate)) {
    invalid6("sampleRate");
  }
  const timeoutMs = request.timeoutMs ?? DEFAULT_TTS_TIMEOUT_MS2;
  if (!integerIn4(timeoutMs, 1, MAX_TTS_TIMEOUT_MS2)) {
    invalid6("timeoutMs");
  }
  const firstChunkTimeoutMs = request.firstChunkTimeoutMs ?? DEFAULT_TTS_FIRST_CHUNK_TIMEOUT_MS2;
  if (!integerIn4(firstChunkTimeoutMs, 1, MAX_TTS_FIRST_CHUNK_TIMEOUT_MS2)) {
    invalid6("firstChunkTimeoutMs");
  }
  const maxTextChars = request.maxTextChars ?? DEFAULT_TTS_MAX_TEXT_CHARS2;
  if (!integerIn4(maxTextChars, 1, MAX_TTS_MAX_TEXT_CHARS2)) {
    invalid6("maxTextChars");
  }
  if (request.signal !== undefined && !(request.signal instanceof AbortSignal)) {
    invalid6("signal");
  }
  return {
    timeoutMs,
    firstChunkTimeoutMs,
    maxTextChars,
    retry: resolveTtsRetryPolicy(request.retry)
  };
}

// src/tts/memory.ts
var INSPECT = Symbol.for("nodejs.util.inspect.custom");

class MemoryTtsStream {
  #host;
  #deadline;
  #state = "open";
  #chars = 0;
  #wake;
  #iterator;
  constructor(host) {
    this.#host = host;
    this.#deadline = startTtsDeadline(host.checked.timeoutMs, host.request.signal);
  }
  write(text) {
    this.#assertOpen();
    this.#deadline.check();
    if (typeof text !== "string") {
      invalid6("text");
    }
    if (text.length === 0) {
      return;
    }
    const max = this.#host.checked.maxTextChars;
    if (this.#chars + text.length > max) {
      throw new TtsError2(TTS_ERROR_CODES2.textTooLarge, "The text is over the length limit", {
        details: { maxTextChars: max }
      });
    }
    this.#chars += text.length;
    this.#wake?.();
  }
  finish() {
    if (this.#state === "closed") {
      throw closedError("The stream is closed");
    }
    if (this.#state !== "open") {
      return;
    }
    this.#state = "finished";
    this.#wake?.();
  }
  cancel() {
    if (this.#state === "closed" || this.#state === "cancelled") {
      return;
    }
    this.#state = "cancelled";
    this.#deadline.cancel();
    this.#deadline.stop();
    this.#wake?.();
  }
  async close() {
    if (this.#state === "closed") {
      return;
    }
    this.#state = "closed";
    this.#deadline.cancel();
    this.#deadline.stop();
    this.#wake?.();
    this.#host.released();
  }
  [Symbol.asyncIterator]() {
    if (this.#iterator === undefined) {
      const inner = this.#produce();
      const self = this;
      this.#iterator = {
        next() {
          if (self.#state === "closed") {
            return Promise.reject(closedError("The stream is closed"));
          }
          return inner.next();
        },
        return() {
          self.cancel();
          return inner.return(undefined);
        }
      };
    }
    return this.#iterator;
  }
  toJSON() {
    return { state: this.#state, chars: this.#chars };
  }
  toString() {
    return `MemoryTtsStream(${this.#state}, ${this.#chars} chars)`;
  }
  [INSPECT]() {
    return this.toString();
  }
  #assertOpen() {
    if (this.#state === "closed") {
      throw closedError("The stream is closed");
    }
    if (this.#state === "cancelled") {
      throw closedError("The stream was cancelled");
    }
    if (this.#state === "ended") {
      throw closedError("The stream has ended");
    }
    if (this.#state === "finished") {
      throw closedError("The stream was finished");
    }
  }
  #stopped() {
    return this.#state === "cancelled" || this.#state === "closed";
  }
  async#waitUntil(ready) {
    while (!ready() && !this.#stopped()) {
      this.#deadline.check();
      await new Promise((resolve) => {
        const done = () => {
          this.#deadline.signal.removeEventListener("abort", done);
          resolve();
        };
        this.#wake = done;
        this.#deadline.signal.addEventListener("abort", done, { once: true });
      });
      this.#wake = undefined;
    }
  }
  async* #produce() {
    const host = this.#host;
    const deadline = this.#deadline;
    let entry;
    try {
      await this.#waitUntil(() => this.#chars > 0 || this.#state === "finished");
      if (this.#stopped()) {
        return;
      }
      deadline.check();
      if (this.#chars === 0) {
        return;
      }
      const started = await withTtsRetry(async () => {
        const attempt = host.vendorRequest(this.#chars);
        entry = attempt.entry;
        const watch = watchFirstChunk([deadline.signal], host.checked.firstChunkTimeoutMs);
        deadline.signal.addEventListener("abort", () => markAborted(attempt.entry), {
          once: true
        });
        try {
          if (attempt.speech.hang) {
            await new Promise((resolve) => watch.signal.addEventListener("abort", () => resolve(), { once: true }));
          } else if ((attempt.speech.firstChunkDelayMs ?? 0) > 0) {
            await host.sleep(attempt.speech.firstChunkDelayMs ?? 0, watch.signal);
          }
          if (this.#stopped()) {
            return;
          }
          deadline.check();
          watch.check();
          return attempt;
        } catch (error) {
          if (error instanceof TtsError2 && (error.code === TTS_ERROR_CODES2.timeout || error.code === TTS_ERROR_CODES2.aborted)) {
            markAborted(attempt.entry);
          } else if (attempt.entry.view.outcome === "pending") {
            attempt.entry.view.outcome = "failed";
          }
          throw error;
        } finally {
          watch.stop();
        }
      }, {
        policy: host.checked.retry,
        deadline,
        sleep: host.sleep,
        ...host.options.random === undefined ? {} : { random: host.options.random },
        onRetry: (retry, delayMs) => host.options.logger?.warn("A speech request is retrying", {
          voice: host.request.voice,
          retry,
          delayMs
        })
      });
      if (started === undefined || this.#stopped()) {
        return;
      }
      const { speech } = started;
      const chunks = speech.chunks;
      for (let i = 0;i < chunks.length; i++) {
        if (i > 0) {
          if (speech.failAfterChunks === i) {
            throw new TtsError2(TTS_ERROR_CODES2.unavailable, "The vendor stream broke");
          }
          if ((speech.chunkDelayMs ?? 0) > 0) {
            await host.sleep(speech.chunkDelayMs ?? 0, deadline.signal);
          }
          if (this.#stopped()) {
            return;
          }
          deadline.check();
        }
        yield new TtsAudioChunk2(i, chunks[i]);
        if (this.#stopped()) {
          return;
        }
      }
      if (speech.failAfterChunks === chunks.length) {
        throw new TtsError2(TTS_ERROR_CODES2.unavailable, "The vendor stream broke");
      }
      started.entry.view.outcome = "ok";
      await this.#waitUntil(() => this.#state === "finished");
      deadline.check();
    } catch (error) {
      if (this.#stopped()) {
        return;
      }
      if (entry?.view.outcome === "pending") {
        entry.view.outcome = "failed";
      }
      host.report(error);
      throw error;
    } finally {
      if (this.#state === "open" || this.#state === "finished") {
        this.#state = "ended";
      }
      deadline.stop();
      this.#chars = 0;
    }
  }
}
function closedError(message) {
  return new TtsError2(TTS_ERROR_CODES2.closed, message);
}
function markAborted(entry) {
  if (entry.view.outcome === "pending") {
    entry.view.aborted = true;
    entry.view.outcome = "aborted";
  }
}
function createMemoryTts(options = {}) {
  const sleep = options.sleep ?? systemSleep2;
  const scripts = [];
  const failures = [];
  const requests = [];
  let open = 0;
  return {
    open(request) {
      const checked = checkOpenRequest2(request);
      open += 1;
      let released = false;
      return new MemoryTtsStream({
        options,
        sleep,
        request,
        checked,
        vendorRequest(chars) {
          const entry = {
            view: {
              organizationId: request.organizationId,
              voice: request.voice,
              chars,
              aborted: false,
              outcome: "pending"
            }
          };
          requests.push(entry);
          const code = failures.shift();
          if (code !== undefined) {
            entry.view.outcome = "failed";
            throw new TtsError2(code, "The vendor failed");
          }
          const speech = scripts.shift();
          if (speech === undefined) {
            entry.view.outcome = "failed";
            throw new TtsError2(TTS_ERROR_CODES2.badResponse, "The vendor sent nothing usable");
          }
          return { speech, entry };
        },
        report(error) {
          if (!(error instanceof TtsError2) || error.code !== TTS_ERROR_CODES2.unavailable && error.code !== TTS_ERROR_CODES2.rejected && error.code !== TTS_ERROR_CODES2.badResponse) {
            return;
          }
          try {
            options.reporter?.capture(error, {
              organizationId: request.organizationId,
              tags: { feature: "tts" }
            });
          } catch {}
        },
        released() {
          if (!released) {
            released = true;
            open -= 1;
          }
        }
      });
    },
    speak(speech) {
      const scripted = Array.isArray(speech) ? { chunks: speech } : speech;
      if (typeof scripted !== "object" || scripted === null || !Array.isArray(scripted.chunks) || scripted.chunks.some((c) => !(c instanceof Uint8Array) || c.byteLength < 1 || c.byteLength > MAX_TTS_AUDIO_CHUNK_BYTES2)) {
        invalid6("speech chunks");
      }
      const failAfter = scripted.failAfterChunks;
      if (failAfter !== undefined && (!Number.isInteger(failAfter) || failAfter < 1 || failAfter > scripted.chunks.length)) {
        invalid6("speech failAfterChunks");
      }
      scripts.push({ ...scripted });
    },
    failNext(code, times = 1) {
      for (let i = 0;i < times; i++) {
        failures.push(code);
      }
    },
    requests() {
      return requests.map((entry) => ({ ...entry.view }));
    },
    openStreams() {
      return open;
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
  MEMORY_MESSAGING_AUTH_TOKEN,
  MEMORY_MESSAGING_WEBHOOK_URL,
  createMemoryAuditRecorder,
  createMemoryCalendar,
  createMemoryContactGuard,
  createMemoryErrorReporter,
  createMemoryLlm,
  createMemoryLogger,
  createMemoryMessaging,
  createMemoryObjectStore,
  createMemoryQueue,
  createMemoryStreamingTranscribe,
  createMemoryTelephony,
  createMemoryTranscriber,
  createMemoryTts,
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
