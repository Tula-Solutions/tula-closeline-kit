import {
  AUDIT_LIMITS2,
  AUDIT_DENIED_METADATA_KEYS2,
  auditMetadataSchema2,
  auditActorSchema2,
  auditSubjectSchema2,
  auditEventPayloadSchema2,
  auditEntrySchema2,
  parseAuditEntry2,
  CONTACT_UNAVAILABLE2,
  isContactGuardRequest2,
  withCaller2,
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
  isSensitiveKey,
  dropHighSurrogate2,
  cutText2,
  scrubText2,
  redactFields,
  prepareFields,
  signTwilioRequest2,
  twilioUrlVariants,
  sameText,
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
  classifyMessageIntent2,
  verifyAndParseWebhook,
  shouldReportError2,
  STREAMING_TRANSCRIBE_ERROR_CODES2,
  StreamingTranscribeError2,
  DEFAULT_STREAMING_TRANSCRIBE_TIMEOUT_MS2,
  MAX_STREAMING_TRANSCRIBE_TIMEOUT_MS2,
  MAX_AUDIO_CHUNK_BYTES2,
  MAX_REPLAY_AUDIO_BYTES2,
  MAX_WORDS_PER_TURN2,
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
  MAX_VECTOR_ID_LENGTH2,
  MAX_TOP_K2,
  MAX_DIMENSIONS2,
  MAX_ATTRIBUTES2,
  MAX_ATTRIBUTE_STRING2
} from "./shared/chunk-wrcc1eww.js";
import {
  systemClock2,
  createFixedClock2,
  QUEUE_ERROR_CODES2,
  QueueError2,
  MAX_MESSAGE_BYTES2,
  defineMessage2,
  INVALID_REASONS2,
  createMessageRegistry2
} from "./shared/chunk-mjkmsg3r.js";
import {
  AUDIT_ERROR_CODES2,
  AuditError2,
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
  MESSAGING_ERROR_CODES2,
  MessagingError2,
  isReportableMessagingError2,
  DEFAULT_MESSAGING_TIMEOUT_MS2,
  MAX_MESSAGING_TIMEOUT_MS2,
  MAX_MESSAGE_BODY_CHARS2,
  MAX_TEMPLATE_VARIABLES2,
  MAX_TEMPLATE_VARIABLE_CHARS2,
  MAX_MESSAGING_WEBHOOK_BYTES2,
  MESSAGING_CHANNELS2,
  MESSAGING_PURPOSES2,
  DEFAULT_MESSAGING_RETRY_POLICY2,
  messagingRetryDelayMs2,
  InboundMessage2,
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
  MAX_TRANSCRIPT_TURNS2,
  MAX_TURN_TEXT2,
  MAX_VENDOR_ID_LENGTH2,
  MAX_TRANSCRIPT_RESPONSE_BYTES2,
  MAX_AUDIO_MS2,
  MAX_TRANSCRIPT_CHARS2,
  MAX_SPEAKER_LABEL2,
  MAX_CHANNELS2,
  TRANSCRIPTION_FAILURES2,
  checkTranscriptionResult2,
  TTS_ERROR_CODES2,
  TtsError2
} from "./shared/chunk-q819sn0x.js";
import {
  STORAGE_ERROR_CODES2,
  StorageError2,
  MAX_KEY_BYTES2,
  MAX_KEY_SEGMENTS2,
  DEFAULT_MAX_OBJECT_BYTES2,
  MAX_OBJECT_BYTES_LIMIT2,
  DEFAULT_LIST_LIMIT2,
  MAX_LIST_LIMIT2,
  DEFAULT_CONTENT_TYPE2,
  MAX_STREAM_BYTES_LIMIT2,
  MAX_PRESIGN_SECONDS2,
  DEFAULT_PRESIGN_SECONDS2,
  STREAM_IDLE_TIMEOUT_MS2
} from "./shared/chunk-5sf8d2rb.js";
import {
  systemSleep2,
  MAX_BATCH_SIZE2,
  MAX_WAIT_SECONDS2,
  MAX_VISIBILITY_SECONDS2,
  assertReceiveOptions2,
  assertVisibility2,
  assertBatchCount2
} from "./shared/chunk-h070fpj8.js";
import {
  waitForTranscription2
} from "./shared/chunk-83cpvtqk.js";
import {
  AppError2,
  isAppError2,
  toErrorBody2
} from "./shared/chunk-tya44yhr.js";
// src/audit/message.ts
var auditRecordedMessage = defineMessage2({
  type: "audit.recorded",
  version: 1,
  scope: "organization",
  payload: auditEventPayloadSchema2
});
// src/audit/queue.ts
function createQueueAuditRecorder(options) {
  const clock = options.clock ?? systemClock2;
  return {
    async record(input) {
      const { id, organizationId, ...payload } = parseAuditEntry2(input, clock);
      const { occurredAt } = payload;
      const envelope = {
        id,
        type: auditRecordedMessage.type,
        version: auditRecordedMessage.version,
        occurredAt,
        organizationId,
        traceId: payload.requestId ?? id,
        payload
      };
      try {
        await options.queue.publish(envelope);
      } catch (cause) {
        throw new AuditError2(AUDIT_ERROR_CODES2.unavailable, "the audit event could not be queued", {
          cause
        });
      }
      options.logger?.info("audit entry recorded", {
        eventId: id,
        action: payload.action,
        metadataKeys: Object.keys(payload.metadata ?? {}).length
      });
    }
  };
}
// src/auth/claims.ts
import {
  organizationIdSchema,
  regionSchema,
  roleSchema,
  userIdSchema
} from "tula-closeline-contract";
import { z } from "zod";
var MAX_TOKEN_LENGTH = 4096;
var accessTokenClaimsSchema = z.object({
  sub: userIdSchema,
  org: organizationIdSchema,
  role: roleSchema,
  region: regionSchema,
  iat: z.number().finite(),
  exp: z.number().finite()
});
// src/auth/errors.ts
var MESSAGES = {
  expired: "Token expired",
  invalid: "Token rejected",
  unavailable: "Token verification unavailable"
};

class TokenVerificationError extends Error {
  reason;
  constructor(reason) {
    super(MESSAGES[reason]);
    this.name = "TokenVerificationError";
    this.reason = reason;
  }
}
// src/auth/keys.ts
import { importJWK } from "jose";
import { z as z2 } from "zod";
var MAX_JWKS_KEYS = 20;
var MAX_JWKS_BYTES = 64 * 1024;
var publicJwkSchema = z2.object({
  kty: z2.literal("OKP"),
  crv: z2.literal("Ed25519"),
  x: z2.string().min(1).max(100),
  kid: z2.string().min(1).max(128),
  use: z2.literal("sig").optional(),
  alg: z2.literal("EdDSA").optional(),
  d: z2.never().optional()
});
var jwksSchema = z2.object({ keys: z2.array(z2.unknown()).max(MAX_JWKS_KEYS) });
async function importPublicKey(raw) {
  const parsed = publicJwkSchema.safeParse(raw);
  if (!parsed.success) {
    return;
  }
  try {
    const { kty, crv, x, kid } = parsed.data;
    const key = await importJWK({ kty, crv, x }, "EdDSA");
    return key instanceof Uint8Array ? undefined : [kid, key];
  } catch {
    return;
  }
}
function carriesPrivateKey(raw) {
  return typeof raw === "object" && raw !== null && Object.hasOwn(raw, "d");
}
async function importAll(jwks) {
  const parsed = jwksSchema.safeParse(jwks);
  if (!parsed.success) {
    return;
  }
  const keys = new Map;
  let privateEntries = 0;
  for (const raw of parsed.data.keys) {
    if (carriesPrivateKey(raw)) {
      privateEntries++;
    }
    const entry = await importPublicKey(raw);
    if (entry !== undefined && !keys.has(entry[0])) {
      keys.set(entry[0], entry[1]);
    }
  }
  const received = parsed.data.keys.length;
  return { keys, received, skipped: received - keys.size, privateEntries };
}
async function createStaticKeySet(jwks) {
  const parsed = jwksSchema.safeParse(jwks);
  if (!parsed.success || parsed.data.keys.length === 0) {
    throw new TypeError(`JWKS must hold 1 to ${MAX_JWKS_KEYS} keys`);
  }
  const keys = new Map;
  for (const raw of parsed.data.keys) {
    const entry = await importPublicKey(raw);
    if (entry === undefined || keys.has(entry[0])) {
      throw new TypeError("JWKS holds a key that is not a unique public Ed25519 key with a kid");
    }
    keys.set(entry[0], entry[1]);
  }
  return {
    getKey: async (kid) => keys.get(kid),
    available: () => true,
    confirmsAbsent: (kid) => !keys.has(kid)
  };
}

class RetryableFetchError extends Error {
}
function assertUrl(raw, allowInsecureLocalhost) {
  const url = new URL(raw);
  if (url.username !== "" || url.password !== "") {
    throw new TypeError("The JWKS URL must not carry credentials");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local && allowInsecureLocalhost)) {
    throw new TypeError("The JWKS URL must be https");
  }
  return url;
}
function assertPositive(name, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number`);
  }
}
async function readBounded(response) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_JWKS_BYTES) {
    throw new Error("JWKS response too large");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return "";
  }
  const decoder = new TextDecoder;
  let total = 0;
  let text = "";
  for (;; ) {
    const { done, value } = await reader.read();
    if (done) {
      return text + decoder.decode();
    }
    total += value.byteLength;
    if (total > MAX_JWKS_BYTES) {
      await reader.cancel();
      throw new Error("JWKS response too large");
    }
    text += decoder.decode(value, { stream: true });
  }
}
function createRemoteKeySet(options) {
  const url = assertUrl(options.url, options.allowInsecureLocalhost === true);
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 3000;
  const retries = options.retries ?? 1;
  const cooldownMs = options.cooldownMs ?? 30000;
  const maxAgeMs = options.maxAgeMs ?? 3600000;
  const maxStaleMs = options.maxStaleMs ?? 86400000;
  const lookupDeadlineMs = options.lookupDeadlineMs ?? 5000;
  assertPositive("maxStaleMs", maxStaleMs);
  assertPositive("lookupDeadlineMs", lookupDeadlineMs);
  if (maxStaleMs <= maxAgeMs) {
    throw new TypeError("maxStaleMs must be greater than maxAgeMs");
  }
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const random = options.random ?? Math.random;
  let keys = new Map;
  let loadedAt;
  let lastAttemptAt;
  let lastAttemptSucceeded = false;
  let inflight;
  const now = () => options.clock.now().getTime();
  function log(level, message, fields) {
    try {
      options.logger?.[level](message, fields);
    } catch {}
  }
  const hasElapsed = (since, ms) => {
    const elapsed = now() - since;
    return elapsed < 0 || elapsed >= ms;
  };
  function isStale() {
    return loadedAt !== undefined && Math.max(0, now() - loadedAt) >= maxStaleMs;
  }
  async function fetchOnce() {
    let response;
    try {
      response = await doFetch(url, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch {
      throw new RetryableFetchError("JWKS request failed");
    }
    if (response.status >= 500 || response.status === 429) {
      await response.body?.cancel();
      throw new RetryableFetchError("JWKS request failed");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`JWKS request returned ${response.status}`);
    }
    return JSON.parse(await readBounded(response));
  }
  async function fetchWithRetry() {
    for (let attempt = 0;; attempt++) {
      try {
        return await fetchOnce();
      } catch (error) {
        if (!(error instanceof RetryableFetchError) || attempt >= retries) {
          throw error;
        }
        await sleep(100 + Math.floor(random() * 100));
      }
    }
  }
  async function refresh() {
    try {
      const fresh = await importAll(await fetchWithRetry());
      if (fresh === undefined) {
        throw new Error("JWKS was not well-formed");
      }
      if (fresh.privateEntries > 0) {
        log("error", "jwks entry carries private key material", {
          privateEntries: fresh.privateEntries
        });
      }
      if (fresh.keys.size === 0 && fresh.received > 0) {
        throw new Error("JWKS held no usable key");
      }
      if (fresh.skipped > 0) {
        log("warn", "jwks entries skipped", { skipped: fresh.skipped, received: fresh.received });
      }
      keys = fresh.keys;
      loadedAt = now();
      lastAttemptSucceeded = true;
    } catch (error) {
      lastAttemptSucceeded = false;
      log("warn", "jwks refresh failed", {
        reason: error instanceof Error ? error.message : "unknown",
        keysServed: keys.size
      });
    }
  }
  function startRefresh() {
    lastAttemptAt = now();
    lastAttemptSucceeded = false;
    const run = refresh().finally(() => {
      if (inflight === run) {
        inflight = undefined;
      }
    });
    inflight = run;
    return run;
  }
  function cooldownElapsed() {
    return lastAttemptAt === undefined || hasElapsed(lastAttemptAt, cooldownMs);
  }
  function dropIfStale() {
    if (isStale()) {
      keys = new Map;
      loadedAt = undefined;
      log("error", "jwks keys dropped as stale", { maxStaleMs });
    }
  }
  async function waitForRefresh(run) {
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve("deadline"), lookupDeadlineMs);
    });
    try {
      if (await Promise.race([run, deadline]) === "deadline") {
        log("warn", "jwks lookup deadline exceeded", { lookupDeadlineMs });
      }
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    async getKey(kid) {
      dropIfStale();
      const cached = keys.get(kid);
      if (cached !== undefined) {
        if (loadedAt !== undefined && hasElapsed(loadedAt, maxAgeMs) && !inflight && cooldownElapsed()) {
          startRefresh();
        }
        return cached;
      }
      const pending = inflight ?? (cooldownElapsed() ? startRefresh() : undefined);
      if (pending !== undefined) {
        await waitForRefresh(pending);
      }
      return keys.get(kid);
    },
    available() {
      dropIfStale();
      return loadedAt !== undefined;
    },
    confirmsAbsent(kid) {
      dropIfStale();
      return loadedAt !== undefined && lastAttemptSucceeded && !inflight && !keys.has(kid);
    },
    warm() {
      return inflight ?? startRefresh();
    }
  };
}
// src/auth/middleware.ts
var BEARER = /^Bearer ([^\s]+)$/i;
function unauthenticated() {
  return new AppError2({
    code: "auth.unauthenticated",
    status: 401,
    message: "Authentication is required."
  });
}
function errorClass(error) {
  return error instanceof Error ? error.constructor?.name ?? "Error" : typeof error;
}
function unavailable() {
  return new AppError2({
    code: "auth.unavailable",
    status: 503,
    message: "Authentication is temporarily unavailable."
  });
}
var ERROR_LOG_INTERVAL_MS = 1000;
function createErrorLimiter(logger, clock) {
  let lastWrittenAt;
  let suppressed = 0;
  return (message, fields) => {
    if (logger === undefined) {
      return;
    }
    const now = clock.now().getTime();
    const elapsed = lastWrittenAt === undefined ? Number.POSITIVE_INFINITY : now - lastWrittenAt;
    if (elapsed >= 0 && elapsed < ERROR_LOG_INTERVAL_MS) {
      suppressed++;
      return;
    }
    lastWrittenAt = now;
    logger.error(message, suppressed > 0 ? { ...fields, suppressed } : fields);
    suppressed = 0;
  };
}
function toAppError(error, logger, logError) {
  if (!(error instanceof TokenVerificationError)) {
    logError("token verification failed unexpectedly", { errorClass: errorClass(error) });
    return unavailable();
  }
  if (error.reason === "unavailable") {
    logError("token verification unavailable", { reason: error.reason });
    return unavailable();
  }
  logger?.warn("request rejected", { reason: error.reason });
  return new AppError2({
    code: error.reason === "expired" ? "auth.token_expired" : "auth.token_invalid",
    status: 401,
    message: error.reason === "expired" ? "The access token has expired." : "The access token is not valid."
  });
}
function createAuthMiddleware(options) {
  const { verifier, logger } = options;
  const logError = createErrorLimiter(logger, options.clock ?? systemClock2);
  return async (c, next) => {
    const header = c.req.header("authorization");
    const token = header !== undefined && header.length <= MAX_TOKEN_LENGTH + 7 ? BEARER.exec(header)?.[1] : undefined;
    if (token === undefined) {
      logger?.warn("request rejected", { reason: "unauthenticated" });
      throw unauthenticated();
    }
    let verified;
    try {
      verified = await verifier.verify(token);
    } catch (error) {
      throw toAppError(error, logger, logError);
    }
    c.set("organizationId", verified.organizationId);
    c.set("userId", verified.userId);
    c.set("role", verified.role);
    c.set("region", verified.region);
    await next();
  };
}
// src/auth/verifier.ts
import { decodeProtectedHeader, errors as joseErrors, jwtVerify } from "jose";
var ALGORITHM = "EdDSA";
var TOKEN_TYPE = "at+jwt";
var MAX_KID_LENGTH = 128;
var MAX_CLOCK_TOLERANCE_SECONDS = 120;
function reject(reason = "invalid") {
  throw new TokenVerificationError(reason);
}
function createTokenVerifier(options) {
  const { issuer, audience, keys, clock } = options;
  const toleranceSeconds = options.clockToleranceSeconds ?? 30;
  if (issuer === "" || audience === "") {
    throw new TypeError("issuer and audience are required");
  }
  if (!Number.isFinite(toleranceSeconds) || toleranceSeconds < 0 || toleranceSeconds > MAX_CLOCK_TOLERANCE_SECONDS) {
    throw new TypeError(`clockToleranceSeconds must be 0 to ${MAX_CLOCK_TOLERANCE_SECONDS}`);
  }
  function readKid(token) {
    let header;
    try {
      header = decodeProtectedHeader(token);
    } catch {
      return reject();
    }
    if (header.alg !== ALGORITHM) {
      return reject();
    }
    if (header.typ !== TOKEN_TYPE) {
      return reject();
    }
    const kid = header.kid;
    if (typeof kid !== "string" || kid === "" || kid.length > MAX_KID_LENGTH) {
      return reject();
    }
    return kid;
  }
  return {
    async verify(token) {
      if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
        return reject();
      }
      const kid = readKid(token);
      const key = await keys.getKey(kid);
      if (key === undefined) {
        return reject(keys.confirmsAbsent(kid) ? "invalid" : "unavailable");
      }
      const now = clock.now();
      let payload;
      try {
        const result = await jwtVerify(token, key, {
          algorithms: [ALGORITHM],
          typ: TOKEN_TYPE,
          issuer,
          audience,
          clockTolerance: toleranceSeconds,
          currentDate: now,
          requiredClaims: ["exp", "iat", "sub"]
        });
        payload = result.payload;
      } catch (error) {
        return reject(error instanceof joseErrors.JWTExpired ? "expired" : "invalid");
      }
      const claims = accessTokenClaimsSchema.safeParse(payload);
      if (!claims.success) {
        return reject();
      }
      const { sub, org, role, region, iat, exp } = claims.data;
      if (iat > now.getTime() / 1000 + toleranceSeconds || exp <= iat) {
        return reject();
      }
      return {
        userId: sub,
        organizationId: org,
        role,
        region,
        issuedAt: new Date(iat * 1000),
        expiresAt: new Date(exp * 1000)
      };
    }
  };
}
// src/consent/http.ts
import {
  CONSENT_ROUTES,
  contactCheckRequestSchema,
  contactCheckResultSchema
} from "tula-closeline-contract";

// src/http/internal.ts
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { isIPv4 } from "node:net";
var INTERNAL_IDEMPOTENCY_HEADER = "Idempotency-Key";
var INTERNAL_DEFAULT_TIMEOUT_MS = 5000;
var INTERNAL_DEFAULT_MAX_SOCKETS = 32;
var INTERNAL_DEFAULT_MAX_FREE_SOCKETS = 8;
var INTERNAL_DEFAULT_IDLE_TIMEOUT_MS = 4000;
var INTERNAL_DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
var INTERNAL_MAX_REQUEST_BYTES = 1024 * 1024;
var INTERNAL_DEFAULT_RETRY = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 2000,
  retryAfterCapMs: 5000
};
var INTERNAL_RETRY_STATUSES = [429, 502, 503, 504];
var IDEMPOTENT_METHODS = ["GET", "HEAD", "PUT", "DELETE", "OPTIONS"];
var FORBIDDEN_HEADERS = new Set([
  "authorization",
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "proxy-authorization"
]);
var INTERNAL_CALL_FAILURES = [
  "connection",
  "stale_connection",
  "timeout",
  "aborted",
  "redirect",
  "response_too_large",
  "response_invalid"
];
var INTERNAL_MAX_ATTEMPTS = 10;

class InternalCallError extends Error {
  failure;
  method;
  path;
  status;
  attempts;
  constructor(init) {
    const status = init.status === undefined ? "" : `, HTTP ${init.status}`;
    super(`internal call ${init.method} ${init.path} failed (${init.failure}${status}, ` + `${init.attempts} attempt${init.attempts === 1 ? "" : "s"})`);
    this.name = "InternalCallError";
    this.failure = init.failure;
    this.method = init.method;
    this.path = init.path;
    this.status = init.status;
    this.attempts = init.attempts;
  }
}
function isLoopbackHost(host) {
  const bare = host.replace(/^\[|\]$/g, "");
  return isIPv4(bare) && bare.startsWith("127.") || bare === "::1";
}
function parseBase(baseUrl, environment) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError("the internal base URL is not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("the internal base URL must use http or https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new TypeError("the internal base URL must not carry a user name or password");
  }
  if (url.search !== "" || url.hash !== "" || baseUrl.includes("?") || baseUrl.includes("#")) {
    throw new TypeError("the internal base URL must not have a query or a fragment");
  }
  if (url.hostname === "") {
    throw new TypeError("the internal base URL has no host");
  }
  if (url.protocol === "http:" && environment !== "local" && !isLoopbackHost(url.hostname)) {
    throw new TypeError("the internal base URL must use https outside the local environment and loopback");
  }
  return {
    secure: url.protocol === "https:",
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: url.port === "" ? url.protocol === "https:" ? 443 : 80 : Number(url.port),
    prefix: url.pathname.replace(/\/+$/, "")
  };
}
function pathOnly(path) {
  const cut = path.search(/[?#]/);
  return cut === -1 ? path : path.slice(0, cut);
}
function checkPath(path) {
  if (!path.startsWith("/") || path.startsWith("//") || /[\s#\\]/.test(path)) {
    throw new TypeError('an internal call path must start with a single "/" and hold no spaces');
  }
}
function retryAfterMs(value) {
  const text = Array.isArray(value) ? value[0] : value;
  if (text === undefined || !/^\d{1,9}$/.test(text.trim())) {
    return;
  }
  return Number(text.trim()) * 1000;
}
function parseJson(text) {
  if (text.trim() === "") {
    return;
  }
  try {
    return JSON.parse(text);
  } catch {
    return;
  }
}
function createInternalClient(options) {
  const base = parseBase(options.baseUrl, options.environment);
  if (!/^[\x21-\x7e]+$/.test(options.secret)) {
    throw new TypeError("the internal secret must be a non-empty string of printable characters");
  }
  const authorization = `Bearer ${options.secret}`;
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" && options.environment !== "local") {
    throw new TypeError("NODE_TLS_REJECT_UNAUTHORIZED=0 turns off certificate checks; unset it outside local");
  }
  const retry = { ...INTERNAL_DEFAULT_RETRY, ...options.retry };
  const maxAttempts = retry.maxAttempts;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > INTERNAL_MAX_ATTEMPTS) {
    throw new TypeError(`retry.maxAttempts must be an integer from 1 to ${INTERNAL_MAX_ATTEMPTS}`);
  }
  for (const name of ["baseDelayMs", "maxDelayMs", "retryAfterCapMs"]) {
    if (!isNonNegative(retry[name])) {
      throw new TypeError(`retry.${name} must be a finite number, zero or more`);
    }
  }
  const timeoutMs = options.timeoutMs ?? INTERNAL_DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? INTERNAL_DEFAULT_MAX_RESPONSE_BYTES;
  if (!isPositive(timeoutMs) || !isPositive(maxBytes)) {
    throw new TypeError("timeoutMs and maxResponseBytes must be finite numbers above zero");
  }
  if (options.keepAlive !== undefined && typeof options.keepAlive !== "boolean") {
    throw new TypeError("keepAlive must be true or false");
  }
  const keepAlive = options.keepAlive === true;
  if (!keepAlive && (options.maxSockets !== undefined || options.maxFreeSockets !== undefined || options.idleTimeoutMs !== undefined)) {
    throw new TypeError("maxSockets, maxFreeSockets and idleTimeoutMs need keepAlive: true");
  }
  const maxSockets = options.maxSockets ?? INTERNAL_DEFAULT_MAX_SOCKETS;
  if (!Number.isInteger(maxSockets) || maxSockets < 1) {
    throw new TypeError("maxSockets must be an integer of 1 or more");
  }
  const maxFreeSockets = options.maxFreeSockets ?? Math.min(INTERNAL_DEFAULT_MAX_FREE_SOCKETS, maxSockets);
  if (!Number.isInteger(maxFreeSockets) || maxFreeSockets < 1 || maxFreeSockets > maxSockets) {
    throw new TypeError("maxFreeSockets must be an integer from 1 to maxSockets");
  }
  const idleTimeoutMs = options.idleTimeoutMs ?? INTERNAL_DEFAULT_IDLE_TIMEOUT_MS;
  if (!isPositive(idleTimeoutMs)) {
    throw new TypeError("idleTimeoutMs must be a finite number above zero");
  }
  const sleep = options.sleep ?? timerSleep;
  const random = options.random ?? Math.random;
  const send = base.secure ? httpsRequest : httpRequest;
  const agent = keepAlive ? new (base.secure ? HttpsAgent : HttpAgent)({
    keepAlive: true,
    maxSockets,
    maxFreeSockets,
    timeout: idleTimeoutMs,
    scheduling: "lifo",
    ...base.secure ? { rejectUnauthorized: true } : {},
    ...options.ca === undefined ? {} : { ca: options.ca }
  }) : undefined;
  const lifetime = new AbortController;
  let active = 0;
  const waiting = [];
  const acquire = (signal) => new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Failure("timeout"));
      return;
    }
    const grant = () => {
      active += 1;
      let released = false;
      resolve(() => {
        if (!released) {
          released = true;
          active -= 1;
          waiting.shift()?.();
        }
      });
    };
    if (active < maxSockets) {
      grant();
      return;
    }
    const turn = () => {
      signal.removeEventListener("abort", leave);
      grant();
    };
    const leave = () => {
      const at = waiting.indexOf(turn);
      if (at !== -1) {
        waiting.splice(at, 1);
      }
      reject(new Failure("timeout"));
    };
    signal.addEventListener("abort", leave, { once: true });
    waiting.push(turn);
  });
  const attempt = async (method, target, headers, body, signal, fresh) => {
    if (agent === undefined) {
      return await onWire(method, target, headers, body, signal, false);
    }
    const release = await acquire(signal);
    try {
      return await onWire(method, target, headers, body, signal, fresh);
    } finally {
      release();
    }
  };
  const onWire = (method, target, headers, body, signal, fresh) => new Promise((resolve, reject) => {
    let answered = false;
    const outgoing = send({
      host: base.host,
      port: base.port,
      path: target,
      method,
      headers,
      agent: fresh || agent === undefined ? false : agent,
      signal,
      ...base.secure ? { rejectUnauthorized: true } : {},
      ...options.ca === undefined ? {} : { ca: options.ca }
    }, (response) => {
      answered = true;
      const status = response.statusCode ?? 0;
      const retryAfter = retryAfterMs(response.headers["retry-after"]);
      if (status >= 300 && status < 400) {
        reject(new Failure("redirect", status));
        response.destroy();
        return;
      }
      const declared = Number(response.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) {
        reject(new Failure("response_too_large", status));
        response.destroy();
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) {
          reject(new Failure("response_too_large", status));
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        resolve({ status, text: Buffer.concat(chunks).toString("utf8"), retryAfter });
      });
      const broken = () => reject(new Failure(signal.aborted ? "timeout" : "connection"));
      response.on("error", broken);
      response.on("aborted", broken);
    });
    outgoing.on("error", (error) => {
      const reset = error.code === "ECONNRESET" || error.code === "EPIPE";
      reject(new Failure(signal.aborted ? "timeout" : !answered && agent !== undefined && outgoing.reusedSocket && reset ? "stale_connection" : "connection"));
    });
    outgoing.end(body);
  });
  return {
    close() {
      lifetime.abort();
      agent?.destroy();
    },
    async request(call) {
      if (lifetime.signal.aborted) {
        throw new TypeError("the internal client is closed");
      }
      checkPath(call.path);
      if (call.body !== undefined && (call.method === "GET" || call.method === "HEAD")) {
        throw new TypeError("a GET or HEAD internal call has no body");
      }
      const extra = {};
      for (const [name, value] of Object.entries(call.headers ?? {})) {
        if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
          throw new TypeError(`the header ${name} is set by the client and cannot be passed`);
        }
        if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
          throw new TypeError("a header holds a line break");
        }
        extra[name] = value;
      }
      if (call.idempotencyKey !== undefined) {
        if (!/^[\x21-\x7e]{1,255}$/.test(call.idempotencyKey)) {
          throw new TypeError("the idempotency key must be 1 to 255 printable characters");
        }
        extra[INTERNAL_IDEMPOTENCY_HEADER] = call.idempotencyKey;
      }
      const payload = call.body === undefined ? undefined : JSON.stringify(call.body);
      if (payload !== undefined && Buffer.byteLength(payload) > INTERNAL_MAX_REQUEST_BYTES) {
        throw new TypeError("the internal call body is too large");
      }
      const headers = {
        accept: "application/json",
        "user-agent": options.userAgent ?? "closeline-internal",
        ...payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
        ...extra,
        authorization
      };
      const target = `${base.prefix}${call.path}`;
      const path = pathOnly(call.path);
      const safeToRepeat = IDEMPOTENT_METHODS.includes(call.method) || call.idempotencyKey !== undefined;
      const perAttempt = call.timeoutMs ?? timeoutMs;
      if (!isPositive(perAttempt)) {
        throw new TypeError("timeoutMs must be a finite number above zero");
      }
      let staleResent = false;
      let fresh = false;
      for (let attempts = 1;; attempts += 1) {
        const fail = (failure, status) => new InternalCallError({ failure, method: call.method, path, status, attempts });
        if (call.signal?.aborted || lifetime.signal.aborted) {
          throw fail("aborted");
        }
        const useFresh = fresh;
        fresh = false;
        const timeout = AbortSignal.timeout(perAttempt);
        const signal = AbortSignal.any(call.signal ? [call.signal, timeout, lifetime.signal] : [timeout, lifetime.signal]);
        let retryAfter;
        let reason;
        try {
          const wire = await attempt(call.method, target, headers, payload, signal, useFresh);
          const settled = () => ({
            status: wire.status,
            json: answerJson(wire),
            attempts,
            ...wire.retryAfter === undefined ? {} : { retryAfterMs: wire.retryAfter }
          });
          if (!INTERNAL_RETRY_STATUSES.includes(wire.status)) {
            return settled();
          }
          if (!safeToRepeat || attempts >= maxAttempts) {
            return settled();
          }
          retryAfter = wire.retryAfter;
          reason = `HTTP ${wire.status}`;
        } catch (caught) {
          if (call.signal?.aborted || lifetime.signal.aborted) {
            throw fail("aborted");
          }
          const failure = caught instanceof Failure ? caught : new Failure("connection");
          const retryable = failure.kind === "connection" || failure.kind === "stale_connection" || failure.kind === "timeout";
          if (failure.kind === "stale_connection" && safeToRepeat && !staleResent) {
            staleResent = true;
            fresh = true;
          } else if (failure.kind === "stale_connection") {
            throw fail(failure.kind);
          }
          if (!retryable) {
            throw fail(failure.kind, failure.status);
          }
          if (!safeToRepeat || attempts >= maxAttempts) {
            throw fail(failure.kind);
          }
          reason = failure.kind;
        }
        const ceiling = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempts - 1));
        const delay = reason === "stale_connection" ? 0 : retryAfter === undefined ? Math.floor(random() * ceiling) : Math.min(retryAfter, retry.retryAfterCapMs);
        options.logger?.warn("internal call failed, retrying", {
          method: call.method,
          path,
          reason,
          attempt: attempts,
          delayMs: delay
        });
        await pauseOrAbort(sleep, delay, call.signal, lifetime.signal);
      }
    }
  };
}

class Failure {
  kind;
  status;
  constructor(kind, status) {
    this.kind = kind;
    this.status = status;
  }
}
function answerJson(wire) {
  const json = parseJson(wire.text);
  if (json === undefined && wire.status >= 200 && wire.status < 300 && wire.text.trim() !== "") {
    throw new Failure("response_invalid", wire.status);
  }
  return json;
}
function isPositive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function isNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function timerSleep(ms, signal) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
async function pauseOrAbort(sleep, ms, signal, lifetime) {
  const stop = new AbortController;
  const watched = signal === undefined ? [lifetime] : [signal, lifetime];
  let onAbort;
  try {
    await Promise.race([
      sleep(ms, stop.signal),
      new Promise((resolve) => {
        onAbort = () => resolve();
        for (const watch of watched) {
          watch.addEventListener("abort", onAbort, { once: true });
        }
      })
    ]);
  } finally {
    if (onAbort !== undefined) {
      for (const watch of watched) {
        watch.removeEventListener("abort", onAbort);
      }
    }
    stop.abort();
  }
}

// src/consent/http.ts
var CONTACT_GUARD_TIMEOUT_MS = 500;
var CONTACT_GUARD_RETRY_DELAY_MS = 50;
async function attempt(client, body) {
  const route = CONSENT_ROUTES.contactCheck;
  try {
    const response = await client.request({
      method: route.method,
      path: route.path,
      body,
      timeoutMs: CONTACT_GUARD_TIMEOUT_MS
    });
    if (response.status >= 500) {
      return { kind: "failed", reason: "http_5xx", retry: true, status: response.status };
    }
    if (response.status !== 200) {
      return { kind: "failed", reason: "http_unexpected", retry: false, status: response.status };
    }
    const parsed = contactCheckResultSchema.safeParse(response.json);
    return parsed.success ? { kind: "answer", result: parsed.data } : { kind: "failed", reason: "malformed_response", retry: false };
  } catch (error) {
    return {
      kind: "failed",
      reason: error instanceof InternalCallError ? error.failure : "error",
      retry: true
    };
  }
}
function createHttpContactGuard(options) {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(options.caller)) {
    throw new TypeError("the caller must be a short lower-case service name");
  }
  const { caller, logger } = options;
  const sleep = options.sleep ?? systemSleep2;
  const random = options.random ?? Math.random;
  const client = createInternalClient({
    baseUrl: options.baseUrl,
    secret: options.secret,
    environment: options.environment,
    userAgent: `closeline-${caller}`,
    timeoutMs: CONTACT_GUARD_TIMEOUT_MS,
    retry: { maxAttempts: 1 },
    ...options.ca === undefined ? {} : { ca: options.ca },
    ...options.keepAlive === undefined ? {} : { keepAlive: options.keepAlive }
  });
  return {
    async check(request) {
      const body = withCaller2(request, caller);
      const valid = contactCheckRequestSchema.safeParse(body);
      if (!valid.success) {
        logger.warn("contact check refused: the request is not valid, contact denied", {
          reason: "invalid_request"
        });
        return CONTACT_UNAVAILABLE2;
      }
      const where = { channel: valid.data.channel, purpose: valid.data.purpose };
      for (let n = 1;n <= 2; n++) {
        const outcome = await attempt(client, valid.data);
        if (outcome.kind === "answer") {
          return outcome.result;
        }
        const again = n === 1 && outcome.retry;
        logger.warn(again ? "contact check failed, retrying once" : "contact check failed, contact denied as unavailable", {
          reason: outcome.reason,
          attempt: n,
          ...outcome.status === undefined ? {} : { status: outcome.status },
          ...where
        });
        if (!again) {
          break;
        }
        await sleep(Math.floor(CONTACT_GUARD_RETRY_DELAY_MS * (0.5 + random())));
      }
      return CONTACT_UNAVAILABLE2;
    },
    close: () => client.close()
  };
}
// src/logger.ts
import pino from "pino";
function wrap(base) {
  const emit = (level) => (message, fields) => {
    if (base.isLevelEnabled(level)) {
      base[level](prepareFields(fields), scrubText2(message));
    }
  };
  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    child: (fields) => wrap(base.child(prepareFields(fields)))
  };
}
function createLogger(options) {
  const config = {
    level: options.level ?? "info",
    base: { service: options.service },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: { err: (value) => value }
  };
  return wrap(options.destination ? pino(config, options.destination) : pino(config));
}
// src/messaging/twilio.ts
import { createHash as createHash2 } from "node:crypto";
import { e164PhoneSchema } from "tula-closeline-contract";

// src/telephony/twilio.ts
import { createHash, createHmac, randomBytes } from "node:crypto";
import { SignJWT } from "jose";

// src/telephony/twilio-http.ts
var TWILIO_MAX_ATTEMPTS = 3;
var TWILIO_RETRY_BASE_MS = 100;
var TWILIO_RETRY_MAX_MS = 1000;
var TWILIO_MAX_RESPONSE_BYTES = 1048576;
var CALL_ENDED_CODES = new Set([21220, 21221, 21222, 21224]);
function unavailable2(reason, details) {
  return new TelephonyError2(TELEPHONY_ERROR_CODES2.unavailable, `The provider did not answer: ${reason}`, details === undefined ? {} : { details });
}
function mapTwilioFailure(status, body) {
  const twilioCode = typeof body?.code === "number" ? body.code : undefined;
  const details = {
    status,
    ...twilioCode === undefined ? {} : { twilioCode }
  };
  const fail = (code, message) => new TelephonyError2(code, message, { details });
  if (twilioCode !== undefined && CALL_ENDED_CODES.has(twilioCode)) {
    return fail(TELEPHONY_ERROR_CODES2.callEnded, "The call is not in progress");
  }
  if (status === 404) {
    return fail(TELEPHONY_ERROR_CODES2.notFound, "The provider has no such resource");
  }
  if (status === 429 || status >= 500) {
    return fail(TELEPHONY_ERROR_CODES2.unavailable, "The provider is unavailable");
  }
  if (status === 401 || status === 403) {
    return fail(TELEPHONY_ERROR_CODES2.rejected, "The provider refused the credentials");
  }
  return fail(TELEPHONY_ERROR_CODES2.rejected, "The provider refused the request");
}
function retryable(status) {
  return status === 429 || status >= 500;
}
function guardBody(response, timer, signal, timedOut) {
  const source = response.body;
  if (source === null) {
    clearTimeout(timer);
    return response;
  }
  const reader = source.getReader();
  const aborted = new Promise((_, reject) => {
    const fail = () => reject(unavailable2(timedOut() ? "timed out" : "the request failed"));
    if (signal.aborted) {
      fail();
    } else {
      signal.addEventListener("abort", fail, { once: true });
    }
  });
  aborted.catch(() => {
    return;
  });
  const guarded = new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await Promise.race([reader.read(), aborted]);
        if (chunk.done) {
          clearTimeout(timer);
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        clearTimeout(timer);
        reader.cancel().catch(() => {
          return;
        });
        controller.error(error);
      }
    },
    cancel(reason) {
      clearTimeout(timer);
      return reader.cancel(reason);
    }
  });
  return new Response(guarded, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}
function createTwilioHttp(options) {
  const maxAttempts = options.maxAttempts ?? TWILIO_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new TypeError("maxAttempts must be an integer from 1 to 10");
  }
  async function send(request, mode, allow) {
    const headers = {
      Authorization: options.authorization,
      Accept: mode === "json" ? "application/json" : "*/*"
    };
    let body;
    if (request.form !== undefined) {
      const params = new URLSearchParams;
      for (const [name, value] of Object.entries(request.form)) {
        for (const item of typeof value === "string" ? [value] : value) {
          params.append(name, item);
        }
      }
      body = params.toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    if (request.idempotencyToken !== undefined) {
      headers["I-Twilio-Idempotency-Token"] = request.idempotencyToken;
    }
    let last;
    for (let attempt = 1;attempt <= maxAttempts; attempt++) {
      const remaining = request.deadline - options.now();
      if (remaining <= 0) {
        throw last ?? unavailable2("timed out");
      }
      const controller = new AbortController;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, remaining);
      let keepTimer = false;
      try {
        const response = await options.fetch(`${options.baseUrl}${request.path}`, {
          method: request.method,
          headers,
          ...body === undefined ? {} : { body },
          redirect: mode === "stream" ? "follow" : "manual",
          signal: controller.signal
        });
        const ok = response.status >= 200 && response.status < 300;
        if (ok && mode === "stream") {
          keepTimer = true;
          return {
            status: response.status,
            json: null,
            response: guardBody(response, timer, controller.signal, () => timedOut)
          };
        }
        const json = await readJson(response, ok || allow.includes(response.status));
        if (ok || allow.includes(response.status)) {
          return { status: response.status, json };
        }
        response.body?.cancel().catch(() => {
          return;
        });
        const failure = mapTwilioFailure(response.status, json);
        if (!retryable(response.status)) {
          throw failure;
        }
        last = failure;
      } catch (error) {
        if (error instanceof TelephonyError2 && error !== last) {
          throw error;
        }
        if (timedOut) {
          throw unavailable2("timed out");
        }
        if (!(error instanceof TelephonyError2)) {
          last = unavailable2("the request failed");
        }
      } finally {
        if (!keepTimer) {
          clearTimeout(timer);
        }
      }
      if (attempt < maxAttempts) {
        const base = Math.min(TWILIO_RETRY_MAX_MS, TWILIO_RETRY_BASE_MS * 2 ** (attempt - 1));
        const pause = Math.min(Math.floor(base * (0.5 + options.random())), Math.max(0, request.deadline - options.now()));
        await options.sleep(pause);
      }
    }
    throw last ?? unavailable2("the request failed");
  }
  return {
    json: (request, opts) => send(request, "json", opts?.allow ?? []),
    stream: (request) => send(request, "stream", [])
  };
}
async function readJson(response, mustParse) {
  if (response.status >= 300 && response.status < 400) {
    throw new TelephonyError2(TELEPHONY_ERROR_CODES2.badResponse, "The provider answered with a redirect", { details: { status: response.status } });
  }
  let text;
  try {
    text = await readBounded2(response);
  } catch (error) {
    if (error instanceof TelephonyError2) {
      throw error;
    }
    throw unavailable2("the answer could not be read");
  }
  if (text.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    if (mustParse && response.status !== 204) {
      throw new TelephonyError2(TELEPHONY_ERROR_CODES2.badResponse, "The provider answered with something that is not JSON", { details: { status: response.status } });
    }
    return null;
  }
}
async function readBounded2(response) {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const chunks = [];
  let total = 0;
  for (;; ) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.length;
    if (total > TWILIO_MAX_RESPONSE_BYTES) {
      reader.cancel().catch(() => {
        return;
      });
      throw new TelephonyError2(TELEPHONY_ERROR_CODES2.badResponse, "The provider answered with more than this adapter reads");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// src/telephony/twilio.ts
var TWILIO_REGIONS = ["us1", "ie1", "au1"];
var TWILIO_DEFAULT_EDGES = {
  us1: "ashburn",
  ie1: "dublin",
  au1: "sydney"
};
var EDGE = /^[a-z][a-z0-9-]{1,30}$/;
function createMemoryTwilioStore() {
  const calls = new Map;
  const recordings = new Map;
  const placements = new Map;
  const chains = new Map;
  return {
    withCall: async (id, fn) => {
      const previous = chains.get(id) ?? Promise.resolve();
      const run = async () => fn(calls.get(id) ?? null);
      const next = previous.then(run, run);
      chains.set(id, next);
      try {
        return await next;
      } finally {
        if (chains.get(id) === next) {
          chains.delete(id);
        }
      }
    },
    getCall: async (id) => calls.get(id) ?? null,
    putCall: async (id, record) => {
      calls.set(id, record);
    },
    claimCall: async (id, record) => {
      const existing = calls.get(id);
      if (existing) {
        return existing;
      }
      calls.set(id, record);
      return record;
    },
    getRecording: async (id) => {
      const providerCallId = recordings.get(id);
      return providerCallId === undefined ? null : { providerCallId };
    },
    putRecording: async (id, providerCallId) => {
      recordings.set(id, providerCallId);
    },
    getPlacement: async (org, key) => placements.get(`${org}\x00${key}`) ?? null,
    putPlacement: async (org, key, placement) => {
      placements.set(`${org}\x00${key}`, placement);
    }
  };
}
var SID = {
  account: /^AC[0-9a-f]{32}$/,
  apiKey: /^SK[0-9a-f]{32}$/,
  app: /^AP[0-9a-f]{32}$/
};
var LANGUAGE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;
var HOLD_SECONDS = 3600;
function estimateSpeechMs(text) {
  const words = text.trim().split(/\s+/).length;
  return Math.ceil(Math.max(words * 400 * 1.25, text.length * 90)) + 1000;
}
function escapeXml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function hold() {
  return `<Response><Pause length="${HOLD_SECONDS}"/></Response>`;
}
function badResponse(what) {
  return new TelephonyError2(TELEPHONY_ERROR_CODES2.badResponse, `The provider answered without a usable ${what}`);
}
function unavailable3() {
  return new TelephonyError2(TELEPHONY_ERROR_CODES2.unavailable, "The provider did not answer in time");
}
function notFound() {
  return new TelephonyError2(TELEPHONY_ERROR_CODES2.notFound, "There is no such call or Recording");
}
function sid(json, prefix) {
  const value = json?.sid;
  if (typeof value !== "string" || !new RegExp(`^${prefix}[0-9a-zA-Z]{32}$`).test(value)) {
    throw badResponse("id");
  }
  return value;
}
function withTag(url, organizationId, callId) {
  const tagged = new URL(url);
  tagged.searchParams.set("organizationId", organizationId);
  if (callId !== null) {
    tagged.searchParams.set("callId", callId);
  }
  return tagged.toString();
}
function twilioApiHost(region, edge) {
  if (region === undefined) {
    if (edge !== undefined) {
      throw new TypeError("edge needs a region");
    }
    return "api.twilio.com";
  }
  if (!TWILIO_REGIONS.includes(region)) {
    throw new TypeError("region is not one of us1, ie1, au1");
  }
  const chosen = edge ?? TWILIO_DEFAULT_EDGES[region];
  if (!EDGE.test(chosen)) {
    throw new TypeError("edge is not acceptable");
  }
  return `api.${chosen}.${region}.twilio.com`;
}
function createTwilioTelephony(options) {
  if (!SID.account.test(options.accountSid)) {
    throw new TypeError("accountSid is not an Account SID");
  }
  if (!SID.apiKey.test(options.apiKeySid)) {
    throw new TypeError("apiKeySid is not an API key SID");
  }
  if (typeof options.apiKeySecret !== "string" || options.apiKeySecret.length < 16) {
    throw new TypeError("apiKeySecret must be at least 16 characters");
  }
  if (!SID.app.test(options.twimlAppSid)) {
    throw new TypeError("twimlAppSid is not a TwiML App SID");
  }
  if (options.authToken !== undefined && (typeof options.authToken !== "string" || options.authToken.length < 16)) {
    throw new TypeError("authToken must be at least 16 characters");
  }
  const language = options.disclosureLanguage ?? "en-US";
  if (!LANGUAGE.test(language)) {
    throw new TypeError("disclosureLanguage is not a language tag");
  }
  for (const url of [options.statusCallbackUrl, options.recordingStatusCallbackUrl]) {
    if (url !== undefined) {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        throw new TypeError("a callback URL is not a URL");
      }
      const plainOk = options.environment === "local" && parsed.protocol === "http:";
      if (parsed.protocol !== "https:" && !plainOk || parsed.username || parsed.password) {
        throw new TypeError("a callback URL must be https without credentials");
      }
    }
  }
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TELEPHONY_TIMEOUT_MS2;
  resolveTimeout(undefined, defaultTimeoutMs);
  const { accountSid, apiKeySid, apiKeySecret, twimlAppSid } = options;
  const environment = options.environment ?? "prod";
  const clock = options.clock ?? systemClock2;
  const nowMs = options.nowMs ?? Date.now;
  const sleep = options.sleep ?? systemSleep2;
  const random = options.random ?? Math.random;
  if (options.store === undefined && environment !== "local" && environment !== "dev") {
    throw new TypeError("a durable store is required outside the local and dev environments");
  }
  const store = options.store ?? createMemoryTwilioStore();
  const authToken = options.authToken;
  const base = `/2010-04-01/Accounts/${accountSid}`;
  const http = createTwilioHttp({
    baseUrl: `https://${twilioApiHost(options.region, options.edge)}`,
    authorization: `Basic ${Buffer.from(`${apiKeySid}:${apiKeySecret}`).toString("base64")}`,
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    sleep,
    random,
    now: nowMs,
    ...options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }
  });
  function deadlineFor(opts) {
    return nowMs() + resolveTimeout(opts, defaultTimeoutMs);
  }
  function token(...parts) {
    return createHash("sha256").update([accountSid, ...parts].join("\x00")).digest("hex");
  }
  async function patchCall(providerCallId, patch) {
    await store.withCall(providerCallId, async (current) => {
      if (current === null) {
        throw notFound();
      }
      await store.putCall(providerCallId, { ...current, ...patch });
    });
  }
  async function holdUnlessDisclosing(providerCallId, deadline) {
    await store.withCall(providerCallId, async (fresh) => {
      if (fresh !== null && fresh.disclosure === null && fresh.disclosureStarted !== true) {
        await updateCall(providerCallId, { Twiml: hold() }, deadline);
      }
    });
  }
  async function ownedCall(organizationId, providerCallId) {
    const record = await store.getCall(providerCallId);
    if (!record || record.organizationId !== organizationId) {
      throw notFound();
    }
    return record;
  }
  function refOf(request) {
    return {
      organizationId: checkOrganizationId(request.organizationId),
      providerCallId: checkProviderId(request.providerCallId, "providerCallId")
    };
  }
  async function updateCall(providerCallId, form, deadline) {
    await http.json({
      method: "POST",
      path: `${base}/Calls/${providerCallId}.json`,
      form,
      deadline
    });
  }
  async function callIsUp(providerCallId, deadline) {
    const { json } = await http.json({
      method: "GET",
      path: `${base}/Calls/${providerCallId}.json`,
      deadline
    });
    const status = json?.status;
    if (typeof status !== "string") {
      throw badResponse("status");
    }
    return status === "in-progress";
  }
  function callEnded() {
    return new TelephonyError2(TELEPHONY_ERROR_CODES2.callEnded, "The call is not in progress");
  }
  return {
    async placeCall(request, opts) {
      const organizationId = checkOrganizationId(request.organizationId);
      const callId = checkCallId(request.callId);
      const key = checkProviderId(request.idempotencyKey, "idempotencyKey");
      const from = checkNumber(request.from, "from");
      const to = checkNumber(request.to, "to");
      const deadline = deadlineFor(opts);
      const fingerprint = createHmac("sha256", apiKeySecret).update(`${from}\x00${to}`).digest("hex");
      const earlier = await store.getPlacement(organizationId, key);
      if (earlier) {
        if (earlier.fingerprint !== fingerprint) {
          invalid("idempotencyKey");
        }
        return { providerCallId: earlier.providerCallId, created: false };
      }
      const form = { To: to, From: from, Twiml: hold() };
      if (options.statusCallbackUrl !== undefined) {
        form.StatusCallback = withTag(options.statusCallbackUrl, organizationId, callId);
        form.StatusCallbackMethod = "POST";
        form.StatusCallbackEvent = ["initiated", "ringing", "answered", "completed"];
      }
      const { json } = await http.json({
        method: "POST",
        path: `${base}/Calls.json`,
        form,
        idempotencyToken: token("call", organizationId, key),
        deadline
      });
      const providerCallId = sid(json, "CA");
      await store.putCall(providerCallId, {
        organizationId,
        callId,
        direction: "outbound",
        disclosure: null,
        bridgedTo: null,
        ringIdentities: [],
        recordingId: null,
        streamId: null
      });
      await store.putPlacement(organizationId, key, { providerCallId, fingerprint });
      return { providerCallId, created: true };
    },
    async answerCall(request, opts) {
      const { organizationId, providerCallId } = refOf(request);
      const callId = checkCallId(request.callId);
      const identities = checkRingIdentities(request.ringIdentities);
      const deadline = deadlineFor(opts);
      const known = await store.getCall(providerCallId);
      if (known) {
        if (known.organizationId !== organizationId) {
          throw notFound();
        }
        if (known.direction === "inbound" && known.callId === callId && known.disclosure === null && known.disclosureStarted !== true) {
          await holdUnlessDisclosing(providerCallId, deadline);
        }
        return { ringing: known.ringIdentities.length };
      }
      if (!await callIsUp(providerCallId, deadline)) {
        throw callEnded();
      }
      const claimed = await store.claimCall(providerCallId, {
        organizationId,
        callId,
        direction: "inbound",
        disclosure: null,
        bridgedTo: null,
        ringIdentities: identities,
        recordingId: null,
        streamId: null
      });
      if (claimed.organizationId !== organizationId) {
        throw notFound();
      }
      await holdUnlessDisclosing(providerCallId, deadline);
      return { ringing: claimed.ringIdentities.length };
    },
    async playDisclosure(request, opts) {
      const { organizationId, providerCallId } = refOf(request);
      checkDisclosure(request.wordingVersion, request.text, request.aiAssisted);
      const deadline = deadlineFor(opts);
      const record = await ownedCall(organizationId, providerCallId);
      const earlier = record.disclosure;
      if (earlier && earlier.wordingVersion === request.wordingVersion) {
        return earlier;
      }
      const waitMs = estimateSpeechMs(request.text);
      if (options.disclosureDone === undefined && nowMs() + waitMs > deadline) {
        throw unavailable3();
      }
      await store.withCall(providerCallId, async (fresh) => {
        if (fresh === null) {
          throw notFound();
        }
        await store.putCall(providerCallId, { ...fresh, disclosureStarted: true });
        await updateCall(providerCallId, {
          Twiml: `<Response><Say language="${language}">${escapeXml(request.text)}</Say><Pause length="${HOLD_SECONDS}"/></Response>`
        }, deadline);
      });
      if (options.disclosureDone) {
        await options.disclosureDone({ organizationId, providerCallId, deadline });
      } else {
        await sleep(waitMs);
      }
      if (nowMs() > deadline) {
        throw unavailable3();
      }
      if (!await callIsUp(providerCallId, deadline)) {
        throw callEnded();
      }
      const played = {
        wordingVersion: request.wordingVersion,
        aiAssisted: request.aiAssisted,
        playedAt: clock.now().toISOString()
      };
      await patchCall(providerCallId, { disclosure: played, bridgedTo: null });
      return played;
    },
    async bridge(request, opts) {
      const { organizationId, providerCallId } = refOf(request);
      const rep = checkIdentity(request.repIdentity);
      const deadline = deadlineFor(opts);
      const record = await ownedCall(organizationId, providerCallId);
      requireDisclosure(record.disclosure);
      if (record.bridgedTo === rep) {
        return;
      }
      await updateCall(providerCallId, {
        Twiml: `<Response><Dial answerOnBridge="true"><Client><Identity>${escapeXml(rep)}</Identity><Parameter name="organizationId" value="${escapeXml(organizationId)}"/></Client></Dial></Response>`
      }, deadline);
      await patchCall(providerCallId, { bridgedTo: rep });
    },
    async startRecording(request, opts) {
      const { organizationId, providerCallId } = refOf(request);
      const deadline = deadlineFor(opts);
      const record = await ownedCall(organizationId, providerCallId);
      requireDisclosure(record.disclosure);
      if (record.recordingId !== null) {
        return { recordingId: record.recordingId, channels: 2 };
      }
      const form = {
        RecordingChannels: "dual",
        RecordingTrack: "both"
      };
      if (options.recordingStatusCallbackUrl !== undefined) {
        form.RecordingStatusCallback = withTag(options.recordingStatusCallbackUrl, organizationId, record.callId);
        form.RecordingStatusCallbackMethod = "POST";
        form.RecordingStatusCallbackEvent = ["completed"];
      }
      const { json } = await http.json({
        method: "POST",
        path: `${base}/Calls/${providerCallId}/Recordings.json`,
        form,
        idempotencyToken: token("recording", providerCallId),
        deadline
      });
      const recordingId = sid(json, "RE");
      await store.putRecording(recordingId, providerCallId);
      await patchCall(providerCallId, { recordingId });
      return { recordingId, channels: 2 };
    },
    async forkTracks(request, opts) {
      const { organizationId, providerCallId } = refOf(request);
      const destination = checkDestinationUrl(request.destinationUrl, environment === "local");
      const deadline = deadlineFor(opts);
      const record = await ownedCall(organizationId, providerCallId);
      requireDisclosure(record.disclosure, true);
      if (record.streamId !== null) {
        return { streamId: record.streamId, tracks: ["rep", "prospect"] };
      }
      const { json } = await http.json({
        method: "POST",
        path: `${base}/Calls/${providerCallId}/Streams.json`,
        form: { Url: destination, Track: "both_tracks" },
        idempotencyToken: token("stream", providerCallId),
        deadline
      });
      const streamId = sid(json, "MZ");
      await patchCall(providerCallId, { streamId });
      return { streamId, tracks: ["rep", "prospect"] };
    },
    async hangUp(request, opts) {
      const { organizationId, providerCallId } = refOf(request);
      if (request.by !== undefined && request.by !== "rep" && request.by !== "system") {
        invalid("by");
      }
      const deadline = deadlineFor(opts);
      await ownedCall(organizationId, providerCallId);
      try {
        await updateCall(providerCallId, { Status: "completed" }, deadline);
      } catch (error) {
        if (error instanceof TelephonyError2 && error.code === TELEPHONY_ERROR_CODES2.callEnded) {
          return;
        }
        throw error;
      }
    },
    async fetchRecording(request, opts) {
      const organizationId = checkOrganizationId(request.organizationId);
      const recordingId = checkProviderId(request.recordingId, "recordingId");
      const deadline = deadlineFor(opts);
      const owner = await store.getRecording(recordingId);
      if (!owner) {
        throw notFound();
      }
      await ownedCall(organizationId, owner.providerCallId);
      const { json } = await http.json({
        method: "GET",
        path: `${base}/Recordings/${recordingId}.json`,
        deadline
      });
      const status = json?.status;
      if (status === "in-progress" || status === "paused" || status === "processing") {
        throw new TelephonyError2(TELEPHONY_ERROR_CODES2.recordingNotReady, "The Recording is not finished yet");
      }
      if (status !== "completed") {
        throw notFound();
      }
      if (json?.channels !== 2) {
        throw badResponse("channel count");
      }
      const { response } = await http.stream({
        method: "GET",
        path: `${base}/Recordings/${recordingId}.wav?RequestedChannels=2`,
        deadline
      });
      if (!response?.body) {
        throw badResponse("body");
      }
      const length = Number(response.headers.get("content-length"));
      return {
        body: response.body,
        contentType: response.headers.get("content-type")?.split(";")[0]?.trim() || "audio/wav",
        sizeBytes: Number.isSafeInteger(length) && length > 0 ? length : null,
        channels: 2
      };
    },
    async deleteRecording(request, opts) {
      const organizationId = checkOrganizationId(request.organizationId);
      const recordingId = checkProviderId(request.recordingId, "recordingId");
      const deadline = deadlineFor(opts);
      const owner = await store.getRecording(recordingId);
      if (!owner) {
        return { existed: false };
      }
      const record = await store.getCall(owner.providerCallId);
      if (!record || record.organizationId !== organizationId) {
        return { existed: false };
      }
      const answer = await http.json({ method: "DELETE", path: `${base}/Recordings/${recordingId}.json`, deadline }, { allow: [404] });
      return { existed: answer.status !== 404 };
    },
    verifyWebhook(request) {
      try {
        if (authToken === undefined || typeof request?.url !== "string" || typeof request.body !== "string" || typeof request.signature !== "string" || request.signature.length === 0 || request.signature.length > 256 || Buffer.byteLength(request.body, "utf8") > MAX_WEBHOOK_BODY_BYTES2) {
          return false;
        }
        let entries = [];
        let hashed = null;
        try {
          hashed = new URL(request.url).searchParams.get("bodySHA256");
        } catch {
          return false;
        }
        if (hashed !== null) {
          const actual = createHash("sha256").update(request.body, "utf8").digest("hex");
          if (!sameText(actual, hashed.toLowerCase())) {
            return false;
          }
        } else if (request.body.length > 0) {
          entries = [...new URLSearchParams(request.body).entries()];
        }
        let matched = false;
        for (const url of twilioUrlVariants(request.url)) {
          const expected = signTwilioRequest2(authToken, url, entries);
          matched = sameText(expected, request.signature) || matched;
        }
        return matched;
      } catch {
        return false;
      }
    },
    async mintBrowserToken(request, opts) {
      resolveTimeout(opts, defaultTimeoutMs);
      const organizationId = checkOrganizationId(request.organizationId);
      const identity = checkIdentity(request.identity);
      const ttl = request.ttlSeconds ?? 900;
      if (!Number.isInteger(ttl) || ttl < 60 || ttl > 3600) {
        invalid("ttlSeconds");
      }
      const issuedAt = Math.floor(clock.now().getTime() / 1000);
      const jwt = await new SignJWT({
        grants: {
          identity,
          voice: {
            incoming: { allow: true },
            outgoing: { application_sid: twimlAppSid, params: { organizationId } }
          }
        }
      }).setProtectedHeader({ alg: "HS256", typ: "JWT", cty: "twilio-fpa;v=1" }).setIssuer(apiKeySid).setSubject(accountSid).setJti(`${apiKeySid}-${randomBytes(12).toString("hex")}`).setIssuedAt(issuedAt).setExpirationTime(issuedAt + ttl).sign(new TextEncoder().encode(apiKeySecret));
      return {
        token: jwt,
        identity: request.identity,
        ttlSeconds: ttl,
        expiresAt: new Date((issuedAt + ttl) * 1000).toISOString()
      };
    }
  };
}

// src/messaging/twilio.ts
var ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;
var SERVICE_SID = /^MG[0-9a-fA-F]{32}$/;
var MESSAGE_SID = /^(SM|MM)[0-9a-fA-F]{32}$/;
var MAX_RESPONSE_BYTES = 65536;
var DEFAULT_ATTEMPT_TIMEOUT_MS = 5000;
var OPTED_OUT = 21610;
var TEMPLATE_REQUIRED = 63016;
var QUEUED = new Set(["queued", "accepted", "scheduled", "sending"]);
var SENT = new Set(["sent", "delivered"]);
function unavailable4(phase, status) {
  return new MessagingError2(MESSAGING_ERROR_CODES2.unavailable, "The messaging provider is unavailable", {
    details: { phase, ...status === undefined ? {} : { status } }
  });
}
function badResponse2(reason, status) {
  return new MessagingError2(MESSAGING_ERROR_CODES2.badResponse, "The messaging provider sent an unusable answer", { details: { reason, ...status === undefined ? {} : { status } } });
}
async function readBounded3(response) {
  const body = response.body;
  if (body === null) {
    return "";
  }
  const reader = body.getReader();
  const decoder = new TextDecoder;
  let total = 0;
  let text = "";
  for (;; ) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {
        return;
      });
      throw badResponse2("too_large");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
function parseJson2(text) {
  try {
    const value = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
function fail4xx(status, json) {
  const rawCode = json?.code;
  const twilioCode = typeof rawCode === "number" && Number.isInteger(rawCode) ? rawCode : undefined;
  if (twilioCode === OPTED_OUT) {
    return new MessagingError2(MESSAGING_ERROR_CODES2.recipientOptedOut, "The recipient has opted out of this sender", { details: { status, twilioCode } });
  }
  if (twilioCode === TEMPLATE_REQUIRED) {
    return new MessagingError2(MESSAGING_ERROR_CODES2.templateRequired, "Only a template can start this conversation", { details: { status, twilioCode } });
  }
  return new MessagingError2(MESSAGING_ERROR_CODES2.rejected, "The messaging provider refused the request", { details: { status, ...twilioCode === undefined ? {} : { twilioCode } } });
}
function createTwilioMessaging(options) {
  if (typeof options.accountSid !== "string" || !ACCOUNT_SID.test(options.accountSid)) {
    throw new TypeError("accountSid is not an Account SID");
  }
  if (typeof options.authToken !== "string" || options.authToken.length < 16) {
    throw new TypeError("authToken must be at least 16 characters");
  }
  if (options.guard === undefined || typeof options.guard.check !== "function") {
    throw new TypeError("a ContactGuard is required");
  }
  if (options.messagingServiceSid !== undefined && !SERVICE_SID.test(options.messagingServiceSid)) {
    throw new TypeError("messagingServiceSid is not a Messaging Service SID");
  }
  for (const number of [options.fromNumber, options.whatsappFrom]) {
    if (number !== undefined && !e164PhoneSchema.safeParse(number).success) {
      throw new TypeError("a sender number is not E.164");
    }
  }
  if (options.messagingServiceSid !== undefined && options.fromNumber !== undefined) {
    throw new TypeError("give messagingServiceSid or fromNumber, not both");
  }
  if (options.statusCallbackUrl !== undefined) {
    let parsed;
    try {
      parsed = new URL(options.statusCallbackUrl);
    } catch {
      throw new TypeError("statusCallbackUrl is not a URL");
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new TypeError("statusCallbackUrl must be https without credentials");
    }
  }
  const attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  if (!Number.isInteger(attemptTimeoutMs) || attemptTimeoutMs < 1 || attemptTimeoutMs > 60000) {
    throw new TypeError("attemptTimeoutMs must be 1 to 60000");
  }
  const { accountSid, authToken, guard } = options;
  const clock = options.clock ?? systemClock2;
  const sleep = options.sleep ?? systemSleep2;
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const url = `https://${twilioApiHost(options.region, options.edge)}/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const authorization = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;
  function form(request) {
    const whatsapp = request.channel === "whatsapp";
    const params = new URLSearchParams;
    params.set("To", whatsapp ? `whatsapp:${request.to}` : request.to);
    if (whatsapp && options.whatsappFrom !== undefined) {
      params.set("From", `whatsapp:${options.whatsappFrom}`);
    } else if (options.messagingServiceSid !== undefined) {
      params.set("MessagingServiceSid", options.messagingServiceSid);
    } else if (!whatsapp && options.fromNumber !== undefined) {
      params.set("From", options.fromNumber);
    } else {
      invalid2("channel");
    }
    if (request.content.kind === "text") {
      params.set("Body", request.content.body);
    } else {
      params.set("ContentSid", request.content.templateId);
      if (request.content.variables !== undefined) {
        params.set("ContentVariables", JSON.stringify(request.content.variables));
      }
    }
    if (options.statusCallbackUrl !== undefined) {
      params.set("StatusCallback", options.statusCallbackUrl);
    }
    return params;
  }
  function idempotencyToken(request) {
    return createHash2("sha256").update([accountSid, request.organizationId, request.idempotencyKey].join("\x00")).digest("hex");
  }
  async function attempt(params, token, overall) {
    const own = new AbortController;
    let attemptTimedOut = false;
    const timer = setTimeout(() => {
      attemptTimedOut = true;
      own.abort();
    }, attemptTimeoutMs);
    timer.unref?.();
    const signal = AbortSignal.any([overall, own.signal]);
    try {
      const response = await raceAbort(doFetch(url, {
        method: "POST",
        redirect: "manual",
        signal,
        headers: {
          authorization,
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          "i-twilio-idempotency-token": token
        },
        body: params
      }), signal);
      const status = response.status;
      const text = await raceAbort(readBounded3(response), signal);
      if (status === 429 || status >= 500) {
        throw unavailable4("http", status);
      }
      if (status >= 400) {
        throw fail4xx(status, parseJson2(text));
      }
      if (status < 200 || status >= 300) {
        throw badResponse2("status", status);
      }
      const json = parseJson2(text);
      const sid = json?.sid;
      const state = json?.status;
      if (typeof sid !== "string" || !MESSAGE_SID.test(sid) || typeof state !== "string") {
        throw badResponse2("shape", status);
      }
      if (QUEUED.has(state)) {
        return { providerMessageId: sid, status: "queued" };
      }
      if (SENT.has(state)) {
        return { providerMessageId: sid, status: "sent" };
      }
      throw badResponse2("state", status);
    } catch (error) {
      if (error instanceof MessagingError2) {
        throw error;
      }
      if (error instanceof AttemptAborted && !attemptTimedOut) {
        throw error;
      }
      throw unavailable4(attemptTimedOut ? "attempt_timeout" : "network");
    } finally {
      clearTimeout(timer);
    }
  }
  function report(error, request) {
    if (!isReportableMessagingError2(error)) {
      return;
    }
    try {
      options.reporter?.capture(error, {
        organizationId: request.organizationId,
        tags: { feature: "messaging" }
      });
    } catch {}
  }
  return {
    async send(request) {
      const checked = checkSendRequest(request);
      const body = form(checked);
      const token = idempotencyToken(checked);
      const text = body.toString();
      const deadline = startMessagingDeadline(checked.timeoutMs, checked.signal);
      try {
        const { consentCheckId, numberConsentCheckId } = await requireConsent(guard, checked, deadline);
        const answer = await withMessagingRetry(async () => {
          try {
            return await attempt(text, token, deadline.signal);
          } catch (error) {
            if (error instanceof AttemptAborted) {
              deadline.check();
              throw unavailable4("attempt_timeout");
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
          status: answer.status,
          idempotencyKey: checked.idempotencyKey
        };
      } catch (error) {
        report(error, checked);
        throw error;
      } finally {
        deadline.stop();
      }
    },
    async receive(request) {
      return verifyAndParseWebhook(request, authToken, clock);
    }
  };
}
// src/queue/store.ts
function keyOf(key) {
  return JSON.stringify([key.consumer, key.organizationId, key.messageId]);
}
function createMemoryProcessedStore(options) {
  const records = new Map;
  const newToken = options.newToken ?? (() => crypto.randomUUID());
  const now = () => options.clock.now().getTime();
  return {
    async claim(key, leaseSeconds) {
      const id = keyOf(key);
      const existing = records.get(id);
      if (existing?.state === "done") {
        return { status: "done" };
      }
      if (existing !== undefined && existing.at > now()) {
        return {
          status: "busy",
          retryAfterSeconds: Math.max(1, Math.ceil((existing.at - now()) / 1000))
        };
      }
      const token = newToken();
      records.set(id, { state: "claimed", token, at: now() + leaseSeconds * 1000 });
      return { status: "claimed", token };
    },
    async renew(key, token, leaseSeconds) {
      const id = keyOf(key);
      const existing = records.get(id);
      if (existing?.state !== "claimed" || existing.token !== token || existing.at <= now()) {
        return false;
      }
      existing.at = now() + leaseSeconds * 1000;
      return true;
    },
    async complete(key, token) {
      const id = keyOf(key);
      const existing = records.get(id);
      if (existing?.state !== "claimed" || existing.token !== token) {
        return false;
      }
      records.set(id, { state: "done", token, at: now() });
      return true;
    },
    async release(key, token) {
      const id = keyOf(key);
      const existing = records.get(id);
      if (existing?.state === "claimed" && existing.token === token) {
        records.delete(id);
      }
    },
    async purge(before, limit) {
      let removed = 0;
      for (const [id, record] of records) {
        if (removed >= limit) {
          break;
        }
        const stale = record.state === "done" ? record.at < before.getTime() : record.at <= now();
        if (stale) {
          records.delete(id);
          removed += 1;
        }
      }
      return removed;
    }
  };
}
// src/reporting/env.ts
import { z as z3 } from "zod";
var ENVIRONMENTS = ["local", "dev", "staging", "prod"];
var environmentSchema = z3.enum(ENVIRONMENTS);
var DSN_PATTERN = /^(https?):\/\/(\w+)(?::(\w+))?@(\[[:.%\w]+\]|[\w.-]+)(?::(\d+))?\/(?:[\w.-]+\/)*(\d+)$/;
var MAX_DSN_LENGTH = 1024;
function hasDsnShape(value) {
  return value.length <= MAX_DSN_LENGTH ? DSN_PATTERN.exec(value) : null;
}
function isSentryDsn(value, environment) {
  const match = hasDsnShape(value);
  return match !== null && (match[1] === "https" || environment === "local");
}
var sentryDsnSchema = z3.preprocess((value) => {
  const trimmed = typeof value === "string" ? value.trim() : value;
  return trimmed === "" ? undefined : trimmed;
}, z3.string().refine((value) => hasDsnShape(value) !== null, {
  message: "SENTRY_DSN must look like https://<key>@<host>/<project id>"
}).optional());
function requireSentryDsn(env, ctx) {
  if (env.ENVIRONMENT !== "local" && env.SENTRY_DSN === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["SENTRY_DSN"],
      message: `SENTRY_DSN is required when ENVIRONMENT is ${env.ENVIRONMENT}`
    });
  } else if (env.SENTRY_DSN !== undefined && hasDsnShape(env.SENTRY_DSN) !== null && !isSentryDsn(env.SENTRY_DSN, env.ENVIRONMENT)) {
    ctx.addIssue({
      code: "custom",
      path: ["SENTRY_DSN"],
      message: `SENTRY_DSN must use https when ENVIRONMENT is ${env.ENVIRONMENT}`
    });
  }
}

// src/reporting/noop.ts
var NOOP = Object.freeze({
  capture: () => {
    return;
  },
  flush: () => Promise.resolve(true),
  close: () => Promise.resolve(true)
});
function createNoopErrorReporter() {
  return NOOP;
}

// src/reporting/sentry.ts
import {
  defaultStackParser,
  linkedErrorsIntegration,
  makeFetchTransport,
  NodeClient,
  Scope
} from "@sentry/bun";

// src/reporting/scrub-event.ts
var CODE_KEYS = new Set([
  "vars",
  "pre_context",
  "context_line",
  "post_context"
]);
function isPlain(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function scrubTree(value) {
  if (typeof value === "string") {
    return scrubText2(value);
  }
  if (Array.isArray(value)) {
    return value.map(scrubTree);
  }
  if (isPlain(value) && !(value instanceof Date)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (!CODE_KEYS.has(key)) {
        Object.defineProperty(out, scrubText2(key), {
          value: scrubTree(item),
          enumerable: true,
          writable: true,
          configurable: true
        });
      }
    }
    return out;
  }
  return value;
}
function withoutQuery(url) {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}
function scrubRequest(request) {
  delete request.data;
  delete request.cookies;
  delete request.query_string;
  if (typeof request.url === "string") {
    request.url = withoutQuery(request.url);
  }
  if (isPlain(request.headers)) {
    for (const name of Object.keys(request.headers)) {
      if (isSensitiveKey(name)) {
        delete request.headers[name];
      }
    }
  }
}
function scrubEvent(event) {
  try {
    const { sdkProcessingMetadata, ...rest } = event;
    const clean = scrubTree(redactFields(rest));
    delete clean.user;
    if (isPlain(clean.request)) {
      scrubRequest(clean.request);
    }
    if (sdkProcessingMetadata !== undefined) {
      clean.sdkProcessingMetadata = sdkProcessingMetadata;
    }
    return clean;
  } catch {
    return null;
  }
}

// src/reporting/sentry.ts
var MAX_TAGS = 20;
var MAX_TAG_VALUE = 200;
var MAX_FLUSH_MS = 60000;
var DATA_COLLECTION_OFF = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
  frameContextLines: 0
};
var TAG_KEY = /^[A-Za-z0-9_.:-]{1,32}$/;
var ID_SHAPES = [
  /^[a-z]{2,5}_[0-9a-f]{32}$/,
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  /^[0-9a-fA-F]{32}$/
];
var INVALID_IDENTIFIER = "[invalid]";
var MASK = "[redacted]";
var MAX_MESSAGE = 8192;
var MAX_NAME = 200;
var MAX_LINKED_ERRORS = 6;
var MAX_GROUP_CHILDREN = 5;
var MAX_STACK_SOURCE_MESSAGE = 1048576;
var MAX_STACK_TAIL = 16384;
var MAX_STACK_HEADER = 1024;
var MAX_EXCEPTIONS = 12;
var MAX_FRAMES = 200;
var MAX_STRING_VALUE = 512;
var EVENT_ID = /^[0-9a-f]{32}$/;
var PLATFORM = "node";
var RUNTIME = Object.freeze({
  name: "bun",
  version: typeof Bun === "undefined" ? "unknown" : Bun.version
});
function text(value, max) {
  return scrubText2(String(value)).slice(0, max);
}
function identifier(value) {
  return typeof value === "string" && ID_SHAPES.some((shape) => shape.test(value)) ? value : INVALID_IDENTIFIER;
}
function pathWithoutQuery(path) {
  const end = path.search(/[?#]/);
  return end === -1 ? path : path.slice(0, end);
}
function buildTags(base, context, error) {
  const tags = {};
  if (context.tags !== undefined) {
    for (const [key, value] of Object.entries(context.tags).slice(0, MAX_TAGS)) {
      if (TAG_KEY.test(key)) {
        tags[key] = isSensitiveKey(key) ? MASK : text(value, MAX_TAG_VALUE);
      }
    }
  }
  Object.assign(tags, base);
  if (context.organizationId !== undefined) {
    tags.organization_id = identifier(context.organizationId);
  }
  if (context.requestId !== undefined) {
    tags.request_id = identifier(context.requestId);
  }
  if (context.method !== undefined) {
    tags.http_method = text(context.method, 16);
  }
  if (typeof context.status === "number" && Number.isFinite(context.status)) {
    tags.http_status = String(Math.trunc(context.status));
  }
  if (isAppError2(error)) {
    tags.error_code = text(error.code, MAX_TAG_VALUE);
  }
  return tags;
}
function buildRequestContext(context) {
  const out = {};
  if (context.method !== undefined) {
    out.method = text(context.method, 16);
  }
  if (context.path !== undefined) {
    out.path = text(pathWithoutQuery(String(context.path)), 512);
  }
  if (typeof context.status === "number" && Number.isFinite(context.status)) {
    out.status = Math.trunc(context.status);
  }
  return out;
}
function read(get) {
  try {
    return get();
  } catch {
    return;
  }
}
function isErrorLike(value) {
  return value instanceof Error || typeof value === "object" && value !== null && Object.prototype.toString.call(value) === "[object Error]";
}
function messageEnd(stack, message) {
  if (message === "") {
    const newline = stack.indexOf(`
`);
    return newline === -1 ? stack.length : newline;
  }
  let from = 0;
  for (let attempt = 0;attempt < 3; attempt++) {
    const at = stack.indexOf(message, from);
    if (at === -1 || at > MAX_STACK_HEADER) {
      return -1;
    }
    const end = at + message.length;
    if (end === stack.length || stack[end] === `
`) {
      return end;
    }
    from = at + 1;
  }
  return -1;
}
function framesOf(stack, message) {
  if (typeof stack !== "string") {
    return "";
  }
  const limit = message.length + MAX_STACK_HEADER + MAX_STACK_TAIL;
  const head = stack.length > limit ? stack.slice(0, limit) : stack;
  const end = messageEnd(head, message);
  if (end === -1) {
    return "";
  }
  const lines = head.slice(end).split(`
`);
  if (head !== stack) {
    lines.pop();
  }
  return lines.filter((line) => /^\s+at /.test(line)).join(`
`);
}
function define(target, key, value) {
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
}
function boundedCopy(source, budget) {
  budget.left--;
  const rawMessage = read(() => source.message);
  const rawName = read(() => source.name);
  const message = typeof rawMessage === "string" ? cutText2(rawMessage, MAX_MESSAGE) : "the error message could not be read";
  const name = typeof rawName === "string" && rawName !== "" ? cutText2(rawName, MAX_NAME).replace(/[\r\n]+/g, " ") : "Error";
  const copy = new Error(message);
  define(copy, "name", name);
  const header = `${name}: ${message.split(`
`, 1)[0]}`;
  const frames = typeof rawMessage === "string" && rawMessage.length <= MAX_STACK_SOURCE_MESSAGE ? framesOf(read(() => source.stack), rawMessage) : "";
  define(copy, "stack", frames === "" ? header : `${header}
${frames}`);
  if (budget.left > 0) {
    const cause = read(() => source.cause);
    if (isErrorLike(cause)) {
      define(copy, "cause", boundedCopy(cause, budget));
    }
  }
  if (budget.left > 0) {
    const errors = read(() => source.errors);
    if (Array.isArray(errors)) {
      const children = [];
      const count = Math.min(errors.length, MAX_GROUP_CHILDREN);
      for (let i = 0;i < count && budget.left > 0; i++) {
        const child = read(() => errors[i]);
        if (isErrorLike(child)) {
          children.push(boundedCopy(child, budget));
        }
      }
      define(copy, "errors", children);
    }
  }
  return copy;
}
function toReportable(value) {
  try {
    if (isErrorLike(value)) {
      return boundedCopy(value, { left: MAX_LINKED_ERRORS });
    }
    const type = value === null ? "null" : typeof value;
    if (typeof value === "string") {
      return new Error(`non-Error value thrown (string): ${cutText2(scrubText2(value), MAX_STRING_VALUE)}`);
    }
    return new Error(`non-Error value thrown (${type})`);
  } catch {
    return new Error("an error that could not be read was thrown");
  }
}
function isPlain2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function ownFrame(frame) {
  const out = {};
  if (typeof frame.filename === "string") {
    out.filename = frame.filename;
  }
  if (typeof frame.function === "string") {
    out.function = frame.function;
  }
  if (typeof frame.lineno === "number" && Number.isFinite(frame.lineno)) {
    out.lineno = frame.lineno;
  }
  if (typeof frame.colno === "number" && Number.isFinite(frame.colno)) {
    out.colno = frame.colno;
  }
  return out;
}
function ownMechanism(mechanism) {
  const out = {};
  if (typeof mechanism.type === "string") {
    out.type = mechanism.type.slice(0, 64);
  }
  if (typeof mechanism.handled === "boolean") {
    out.handled = mechanism.handled;
  }
  for (const key of ["exception_id", "parent_id"]) {
    const value = mechanism[key];
    if (typeof value === "number" && Number.isSafeInteger(value)) {
      out[key] = value;
    }
  }
  if (typeof mechanism.source === "string" && /^[a-z_]{1,32}$/.test(mechanism.source)) {
    out.source = mechanism.source;
  }
  if (typeof mechanism.is_exception_group === "boolean") {
    out.is_exception_group = mechanism.is_exception_group;
  }
  return out;
}
function ownException(exception) {
  if (!isPlain2(exception) || !Array.isArray(exception.values)) {
    return;
  }
  const values = [];
  for (const entry of exception.values.slice(0, MAX_EXCEPTIONS)) {
    if (!isPlain2(entry)) {
      continue;
    }
    const out = {};
    if (typeof entry.type === "string") {
      out.type = entry.type;
    }
    if (typeof entry.value === "string") {
      out.value = entry.value;
    }
    const frames = isPlain2(entry.stacktrace) ? entry.stacktrace.frames : undefined;
    if (Array.isArray(frames)) {
      out.stacktrace = { frames: frames.slice(-MAX_FRAMES).filter(isPlain2).map(ownFrame) };
    }
    if (isPlain2(entry.mechanism)) {
      out.mechanism = ownMechanism(entry.mechanism);
    }
    values.push(out);
  }
  return { values };
}
function confine(event, hint, expected) {
  const own = hint.data;
  const kept = {};
  const eventId = [event.event_id, hint.event_id].find((id) => typeof id === "string" && EVENT_ID.test(id));
  if (eventId !== undefined) {
    kept.event_id = eventId;
  }
  if (typeof event.timestamp === "number" && Number.isFinite(event.timestamp)) {
    kept.timestamp = event.timestamp;
  }
  kept.platform = PLATFORM;
  if (expected.release !== undefined) {
    kept.release = expected.release;
  }
  kept.environment = expected.environment;
  if (expected.sdk !== undefined) {
    kept.sdk = { name: expected.sdk.name, version: expected.sdk.version };
  }
  kept.level = "error";
  kept.tags = own?.tags ?? {};
  const exception = ownException(event.exception);
  if (exception !== undefined) {
    kept.exception = exception;
  }
  kept.contexts = {
    runtime: RUNTIME,
    ...own === undefined ? {} : { closeline: own.closeline }
  };
  hint.attachments = [];
  return kept;
}
function withDeadline(work, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    work.then((done) => {
      clearTimeout(timer);
      resolve(done);
    }, () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}
function boundedTimeout(timeoutMs) {
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, MAX_FLUSH_MS) : 1;
}
function createSentryReporter(options) {
  const client = new NodeClient({
    dsn: isSentryDsn(options.dsn, options.environment) ? options.dsn : undefined,
    release: options.release,
    environment: options.environment,
    stackParser: defaultStackParser,
    transport: options.transport ?? makeFetchTransport,
    runtime: { ...RUNTIME },
    includeServerName: false,
    integrations: [linkedErrorsIntegration()],
    dataCollection: DATA_COLLECTION_OFF,
    maxBreadcrumbs: 0,
    sendClientReports: false,
    traceLifecycle: "static",
    enableRuntimeChannelInjection: false,
    beforeSend: (event, hint) => {
      try {
        const metadata = client.getOptions()._metadata?.sdk;
        const sdk = typeof metadata?.name === "string" && typeof metadata.version === "string" ? { name: metadata.name, version: metadata.version } : undefined;
        const { tags, ...rest } = confine(event, hint, { ...options, sdk });
        const clean = scrubEvent(rest);
        return clean === null ? null : { ...clean, tags };
      } catch {
        return null;
      }
    }
  });
  client.init();
  const integrations = client.getOptions().integrations.map((integration) => integration.name);
  const base = {
    service: text(options.service, MAX_TAG_VALUE),
    environment: options.environment,
    region: options.region
  };
  const warn = (message) => {
    try {
      options.logger.warn(message);
    } catch {}
  };
  if (client.getDsn() === undefined) {
    warn("error reporting is off: SENTRY_DSN is not a valid Sentry DSN (https is required outside local)");
  }
  let closed = false;
  let closing;
  const reporter = {
    client,
    integrations,
    capture(error, context) {
      try {
        if (closed || !shouldReportError2(error)) {
          return;
        }
        const scope = new Scope;
        let tags = base;
        let closeline = {};
        try {
          const given = context ?? {};
          tags = buildTags(base, given, error);
          closeline = buildRequestContext(given);
        } catch {
          warn("error reporter could not read the error context");
        }
        scope.setTags(tags);
        scope.setContext("closeline", closeline);
        const data = { tags, closeline };
        const reportable = toReportable(error);
        client.captureException(reportable, { originalException: reportable, data }, scope);
      } catch {
        warn("error reporter failed to capture an error");
      }
    },
    flush(timeoutMs) {
      try {
        if (closed) {
          return Promise.resolve(false);
        }
        const ms = boundedTimeout(timeoutMs);
        return withDeadline(Promise.resolve(client.flush(ms)), ms);
      } catch {
        return Promise.resolve(false);
      }
    },
    close(timeoutMs) {
      closed = true;
      if (closing === undefined) {
        const ms = boundedTimeout(timeoutMs);
        try {
          closing = withDeadline(Promise.resolve(client.close(ms)), ms);
        } catch {
          closing = Promise.resolve(false);
        }
      }
      return closing;
    }
  };
  return reporter;
}

// src/reporting/create.ts
function createErrorReporter(options) {
  const dsn = options.dsn?.trim();
  if (dsn === undefined || dsn === "") {
    const message = "error reporting is off: no SENTRY_DSN";
    if (options.environment === "local") {
      options.logger.info(message);
    } else {
      options.logger.warn(message);
    }
    return createNoopErrorReporter();
  }
  if (!isSentryDsn(dsn, options.environment)) {
    options.logger.warn("error reporting is off: SENTRY_DSN is not a valid Sentry DSN");
    return createNoopErrorReporter();
  }
  const reporter = createSentryReporter({ ...options, dsn });
  if (reporter.client.getDsn() === undefined) {
    reporter.close(1);
    return createNoopErrorReporter();
  }
  return reporter;
}

// src/index.ts
var PACKAGE = "tula-closeline-kit";
export {
  AUDIT_DENIED_METADATA_KEYS2 as AUDIT_DENIED_METADATA_KEYS,
  AUDIT_ERROR_CODES2 as AUDIT_ERROR_CODES,
  AUDIT_LIMITS2 as AUDIT_LIMITS,
  AppError2 as AppError,
  AuditError2 as AuditError,
  CALENDAR_ERROR_CODES2 as CALENDAR_ERROR_CODES,
  CONTACT_GUARD_RETRY_DELAY_MS,
  CONTACT_GUARD_TIMEOUT_MS,
  CONTACT_UNAVAILABLE2 as CONTACT_UNAVAILABLE,
  CalendarConnection2 as CalendarConnection,
  CalendarError2 as CalendarError,
  DEFAULT_CALENDAR_RETRY_POLICY2 as DEFAULT_CALENDAR_RETRY_POLICY,
  DEFAULT_CALENDAR_TIMEOUT_MS2 as DEFAULT_CALENDAR_TIMEOUT_MS,
  DEFAULT_CONTENT_TYPE2 as DEFAULT_CONTENT_TYPE,
  DEFAULT_LIST_LIMIT2 as DEFAULT_LIST_LIMIT,
  DEFAULT_LLM_MAX_INPUT_TOKENS2 as DEFAULT_LLM_MAX_INPUT_TOKENS,
  DEFAULT_LLM_MAX_OUTPUT_TOKENS2 as DEFAULT_LLM_MAX_OUTPUT_TOKENS,
  DEFAULT_LLM_RETRY_POLICY2 as DEFAULT_LLM_RETRY_POLICY,
  DEFAULT_LLM_TIMEOUT_MS2 as DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_MAX_OBJECT_BYTES2 as DEFAULT_MAX_OBJECT_BYTES,
  DEFAULT_MESSAGING_RETRY_POLICY2 as DEFAULT_MESSAGING_RETRY_POLICY,
  DEFAULT_MESSAGING_TIMEOUT_MS2 as DEFAULT_MESSAGING_TIMEOUT_MS,
  DEFAULT_PRESIGN_SECONDS2 as DEFAULT_PRESIGN_SECONDS,
  DEFAULT_RECONNECT_POLICY2 as DEFAULT_RECONNECT_POLICY,
  DEFAULT_STREAMING_TRANSCRIBE_TIMEOUT_MS2 as DEFAULT_STREAMING_TRANSCRIBE_TIMEOUT_MS,
  DEFAULT_TELEPHONY_TIMEOUT_MS2 as DEFAULT_TELEPHONY_TIMEOUT_MS,
  DEFAULT_TRANSCRIBER_LIST_LIMIT2 as DEFAULT_TRANSCRIBER_LIST_LIMIT,
  DEFAULT_TTS_FIRST_CHUNK_TIMEOUT_MS2 as DEFAULT_TTS_FIRST_CHUNK_TIMEOUT_MS,
  DEFAULT_TTS_MAX_TEXT_CHARS2 as DEFAULT_TTS_MAX_TEXT_CHARS,
  DEFAULT_TTS_RETRY_POLICY2 as DEFAULT_TTS_RETRY_POLICY,
  DEFAULT_TTS_TIMEOUT_MS2 as DEFAULT_TTS_TIMEOUT_MS,
  ENVIRONMENTS,
  ESTIMATED_CHARS_PER_TOKEN2 as ESTIMATED_CHARS_PER_TOKEN,
  INTERNAL_CALL_FAILURES,
  INTERNAL_DEFAULT_IDLE_TIMEOUT_MS,
  INTERNAL_DEFAULT_MAX_FREE_SOCKETS,
  INTERNAL_DEFAULT_MAX_RESPONSE_BYTES,
  INTERNAL_DEFAULT_MAX_SOCKETS,
  INTERNAL_DEFAULT_RETRY,
  INTERNAL_DEFAULT_TIMEOUT_MS,
  INTERNAL_IDEMPOTENCY_HEADER,
  INTERNAL_MAX_ATTEMPTS,
  INTERNAL_MAX_REQUEST_BYTES,
  INTERNAL_RETRY_STATUSES,
  INVALID_REASONS2 as INVALID_REASONS,
  InboundMessage2 as InboundMessage,
  InternalCallError,
  LLM_ERROR_CODES2 as LLM_ERROR_CODES,
  LlmError2 as LlmError,
  MAX_ATTRIBUTES2 as MAX_ATTRIBUTES,
  MAX_ATTRIBUTE_STRING2 as MAX_ATTRIBUTE_STRING,
  MAX_AUDIO_CHUNK_BYTES2 as MAX_AUDIO_CHUNK_BYTES,
  MAX_AUDIO_MS2 as MAX_AUDIO_MS,
  MAX_AUDIO_URL_LENGTH2 as MAX_AUDIO_URL_LENGTH,
  MAX_BATCH_SIZE2 as MAX_BATCH_SIZE,
  MAX_BUSY_INTERVALS2 as MAX_BUSY_INTERVALS,
  MAX_BUSY_RANGE_MS2 as MAX_BUSY_RANGE_MS,
  MAX_CALENDAR_TIMEOUT_MS2 as MAX_CALENDAR_TIMEOUT_MS,
  MAX_CHANNELS2 as MAX_CHANNELS,
  MAX_CLIENT_REFERENCE_LENGTH2 as MAX_CLIENT_REFERENCE_LENGTH,
  MAX_DELETE_BATCH2 as MAX_DELETE_BATCH,
  MAX_DIMENSIONS2 as MAX_DIMENSIONS,
  MAX_DISCLOSURE_TEXT_LENGTH2 as MAX_DISCLOSURE_TEXT_LENGTH,
  MAX_EVENT_ATTENDEES2 as MAX_EVENT_ATTENDEES,
  MAX_EVENT_DURATION_MS2 as MAX_EVENT_DURATION_MS,
  MAX_JWKS_BYTES,
  MAX_JWKS_KEYS,
  MAX_KEY_BYTES2 as MAX_KEY_BYTES,
  MAX_KEY_SEGMENTS2 as MAX_KEY_SEGMENTS,
  MAX_LIST_LIMIT2 as MAX_LIST_LIMIT,
  MAX_LLM_MAX_INPUT_TOKENS2 as MAX_LLM_MAX_INPUT_TOKENS,
  MAX_LLM_MAX_OUTPUT_TOKENS2 as MAX_LLM_MAX_OUTPUT_TOKENS,
  MAX_LLM_MESSAGES2 as MAX_LLM_MESSAGES,
  MAX_LLM_TIMEOUT_MS2 as MAX_LLM_TIMEOUT_MS,
  MAX_MESSAGE_BODY_CHARS2 as MAX_MESSAGE_BODY_CHARS,
  MAX_MESSAGE_BYTES2 as MAX_MESSAGE_BYTES,
  MAX_MESSAGING_TIMEOUT_MS2 as MAX_MESSAGING_TIMEOUT_MS,
  MAX_MESSAGING_WEBHOOK_BYTES2 as MAX_MESSAGING_WEBHOOK_BYTES,
  MAX_OBJECT_BYTES_LIMIT2 as MAX_OBJECT_BYTES_LIMIT,
  MAX_PRESIGN_SECONDS2 as MAX_PRESIGN_SECONDS,
  MAX_REPLAY_AUDIO_BYTES2 as MAX_REPLAY_AUDIO_BYTES,
  MAX_RING_LEGS2 as MAX_RING_LEGS,
  MAX_SPEAKERS2 as MAX_SPEAKERS,
  MAX_SPEAKER_LABEL2 as MAX_SPEAKER_LABEL,
  MAX_STREAMING_TRANSCRIBE_TIMEOUT_MS2 as MAX_STREAMING_TRANSCRIBE_TIMEOUT_MS,
  MAX_STREAM_BYTES_LIMIT2 as MAX_STREAM_BYTES_LIMIT,
  MAX_TELEPHONY_TIMEOUT_MS2 as MAX_TELEPHONY_TIMEOUT_MS,
  MAX_TEMPLATE_VARIABLES2 as MAX_TEMPLATE_VARIABLES,
  MAX_TEMPLATE_VARIABLE_CHARS2 as MAX_TEMPLATE_VARIABLE_CHARS,
  MAX_TOKEN_LENGTH,
  MAX_TOP_K2 as MAX_TOP_K,
  MAX_TRANSCRIBER_LIST_LIMIT2 as MAX_TRANSCRIBER_LIST_LIMIT,
  MAX_TRANSCRIPT_CHARS2 as MAX_TRANSCRIPT_CHARS,
  MAX_TRANSCRIPT_RESPONSE_BYTES2 as MAX_TRANSCRIPT_RESPONSE_BYTES,
  MAX_TRANSCRIPT_TURNS2 as MAX_TRANSCRIPT_TURNS,
  MAX_TTS_AUDIO_CHUNK_BYTES2 as MAX_TTS_AUDIO_CHUNK_BYTES,
  MAX_TTS_FIRST_CHUNK_TIMEOUT_MS2 as MAX_TTS_FIRST_CHUNK_TIMEOUT_MS,
  MAX_TTS_MAX_TEXT_CHARS2 as MAX_TTS_MAX_TEXT_CHARS,
  MAX_TTS_TIMEOUT_MS2 as MAX_TTS_TIMEOUT_MS,
  MAX_TURN_TEXT2 as MAX_TURN_TEXT,
  MAX_UPSERT_BATCH2 as MAX_UPSERT_BATCH,
  MAX_VECTOR_ID_LENGTH2 as MAX_VECTOR_ID_LENGTH,
  MAX_VENDOR_ID_LENGTH2 as MAX_VENDOR_ID_LENGTH,
  MAX_VISIBILITY_SECONDS2 as MAX_VISIBILITY_SECONDS,
  MAX_WAIT_SECONDS2 as MAX_WAIT_SECONDS,
  MAX_WEBHOOK_BODY_BYTES2 as MAX_WEBHOOK_BODY_BYTES,
  MAX_WORDS_PER_TURN2 as MAX_WORDS_PER_TURN,
  MESSAGING_CHANNELS2 as MESSAGING_CHANNELS,
  MESSAGING_ERROR_CODES2 as MESSAGING_ERROR_CODES,
  MESSAGING_PURPOSES2 as MESSAGING_PURPOSES,
  MODEL_TIERS2 as MODEL_TIERS,
  MessagingError2 as MessagingError,
  PACKAGE,
  QUEUE_ERROR_CODES2 as QUEUE_ERROR_CODES,
  QueueError2 as QueueError,
  STORAGE_ERROR_CODES2 as STORAGE_ERROR_CODES,
  STREAMING_TRANSCRIBE_ERROR_CODES2 as STREAMING_TRANSCRIBE_ERROR_CODES,
  STREAM_IDLE_TIMEOUT_MS2 as STREAM_IDLE_TIMEOUT_MS,
  StorageError2 as StorageError,
  StreamingTranscribeError2 as StreamingTranscribeError,
  TELEPHONY_ERROR_CODES2 as TELEPHONY_ERROR_CODES,
  TRANSCRIBER_ERROR_CODES2 as TRANSCRIBER_ERROR_CODES,
  TRANSCRIPTION_FAILURES2 as TRANSCRIPTION_FAILURES,
  TTS_ERROR_CODES2 as TTS_ERROR_CODES,
  TWILIO_DEFAULT_EDGES,
  TWILIO_REGIONS,
  TelephonyError2 as TelephonyError,
  TokenVerificationError,
  TranscriberError2 as TranscriberError,
  TtsAudioChunk2 as TtsAudioChunk,
  TtsError2 as TtsError,
  VECTOR_ERROR_CODES2 as VECTOR_ERROR_CODES,
  VectorError2 as VectorError,
  accessTokenClaimsSchema,
  assertBatchCount2 as assertBatchCount,
  assertReceiveOptions2 as assertReceiveOptions,
  assertVisibility2 as assertVisibility,
  auditActorSchema2 as auditActorSchema,
  auditEntrySchema2 as auditEntrySchema,
  auditEventPayloadSchema2 as auditEventPayloadSchema,
  auditMetadataSchema2 as auditMetadataSchema,
  auditRecordedMessage,
  auditSubjectSchema2 as auditSubjectSchema,
  calendarRetryDelayMs2 as calendarRetryDelayMs,
  checkTranscriptionResult2 as checkTranscriptionResult,
  classifyMessageIntent2 as classifyMessageIntent,
  createAuthMiddleware,
  createErrorReporter,
  createFixedClock2 as createFixedClock,
  createHttpContactGuard,
  createInternalClient,
  createLogger,
  createMemoryProcessedStore,
  createMemoryTwilioStore,
  createMessageRegistry2 as createMessageRegistry,
  createNoopErrorReporter,
  createQueueAuditRecorder,
  createRemoteKeySet,
  createStaticKeySet,
  createTokenVerifier,
  createTwilioMessaging,
  createTwilioTelephony,
  cutText2 as cutText,
  defineMessage2 as defineMessage,
  dropHighSurrogate2 as dropHighSurrogate,
  environmentSchema,
  estimateSpeechMs,
  estimateTokens2 as estimateTokens,
  isAppError2 as isAppError,
  isContactGuardRequest2 as isContactGuardRequest,
  isReportableMessagingError2 as isReportableMessagingError,
  isSentryDsn,
  llmRetryDelayMs2 as llmRetryDelayMs,
  messagingRetryDelayMs2 as messagingRetryDelayMs,
  parseAuditEntry2 as parseAuditEntry,
  reconnectDelayMs2 as reconnectDelayMs,
  requireSentryDsn,
  scrubText2 as scrubText,
  sentryDsnSchema,
  shouldReportError2 as shouldReportError,
  signTwilioRequest2 as signTwilioRequest,
  systemClock2 as systemClock,
  systemSleep2 as systemSleep,
  toErrorBody2 as toErrorBody,
  ttsRetryDelayMs2 as ttsRetryDelayMs,
  twilioApiHost,
  waitForTranscription2 as waitForTranscription,
  withCaller2 as withCaller
};
