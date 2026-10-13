import {
  systemClock2,
  createFixedClock2,
  AppError2,
  isAppError2,
  toErrorBody2,
  isSensitiveKey,
  cutText2,
  scrubText2,
  redactFields,
  prepareFields,
  shouldReportError2
} from "./shared/chunk-r1sa3cwf.js";

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
// src/http/internal.ts
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIPv4 } from "node:net";
var INTERNAL_IDEMPOTENCY_HEADER = "Idempotency-Key";
var INTERNAL_DEFAULT_TIMEOUT_MS = 5000;
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
  const sleep = options.sleep ?? timerSleep;
  const random = options.random ?? Math.random;
  const send = base.secure ? httpsRequest : httpRequest;
  const attempt = (method, target, headers, body, signal) => new Promise((resolve, reject) => {
    const outgoing = send({
      host: base.host,
      port: base.port,
      path: target,
      method,
      headers,
      agent: false,
      signal,
      ...base.secure ? { rejectUnauthorized: true } : {},
      ...options.ca === undefined ? {} : { ca: options.ca }
    }, (response) => {
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
    outgoing.on("error", () => reject(new Failure(signal.aborted ? "timeout" : "connection")));
    outgoing.end(body);
  });
  return {
    async request(call) {
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
      for (let attempts = 1;; attempts += 1) {
        const fail = (failure, status) => new InternalCallError({ failure, method: call.method, path, status, attempts });
        if (call.signal?.aborted) {
          throw fail("aborted");
        }
        const timeout = AbortSignal.timeout(perAttempt);
        const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout;
        let retryAfter;
        let reason;
        try {
          const wire = await attempt(call.method, target, headers, payload, signal);
          const settled = () => ({ status: wire.status, json: answerJson(wire), attempts });
          if (!INTERNAL_RETRY_STATUSES.includes(wire.status)) {
            return settled();
          }
          if (!safeToRepeat || attempts >= maxAttempts) {
            return settled();
          }
          retryAfter = wire.retryAfter;
          reason = `HTTP ${wire.status}`;
        } catch (caught) {
          if (call.signal?.aborted) {
            throw fail("aborted");
          }
          const failure = caught instanceof Failure ? caught : new Failure("connection");
          const retryable = failure.kind === "connection" || failure.kind === "timeout";
          if (!retryable) {
            throw fail(failure.kind, failure.status);
          }
          if (!safeToRepeat || attempts >= maxAttempts) {
            throw fail(failure.kind);
          }
          reason = failure.kind;
        }
        const ceiling = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempts - 1));
        const delay = retryAfter === undefined ? Math.floor(random() * ceiling) : Math.min(retryAfter, retry.retryAfterCapMs);
        options.logger?.warn("internal call failed, retrying", {
          method: call.method,
          path,
          reason,
          attempt: attempts,
          delayMs: delay
        });
        await pauseOrAbort(sleep, delay, call.signal);
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
async function pauseOrAbort(sleep, ms, signal) {
  if (signal === undefined) {
    await sleep(ms);
    return;
  }
  const stop = new AbortController;
  let onAbort;
  try {
    await Promise.race([
      sleep(ms, stop.signal),
      new Promise((resolve) => {
        onAbort = () => resolve();
        signal.addEventListener("abort", onAbort, { once: true });
      })
    ]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
    stop.abort();
  }
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
  AppError2 as AppError,
  ENVIRONMENTS,
  INTERNAL_CALL_FAILURES,
  INTERNAL_DEFAULT_MAX_RESPONSE_BYTES,
  INTERNAL_DEFAULT_RETRY,
  INTERNAL_DEFAULT_TIMEOUT_MS,
  INTERNAL_IDEMPOTENCY_HEADER,
  INTERNAL_MAX_ATTEMPTS,
  INTERNAL_MAX_REQUEST_BYTES,
  INTERNAL_RETRY_STATUSES,
  InternalCallError,
  MAX_JWKS_BYTES,
  MAX_JWKS_KEYS,
  MAX_TOKEN_LENGTH,
  PACKAGE,
  TokenVerificationError,
  accessTokenClaimsSchema,
  createAuthMiddleware,
  createErrorReporter,
  createFixedClock2 as createFixedClock,
  createInternalClient,
  createLogger,
  createNoopErrorReporter,
  createRemoteKeySet,
  createStaticKeySet,
  createTokenVerifier,
  cutText2 as cutText,
  environmentSchema,
  isAppError2 as isAppError,
  isSentryDsn,
  requireSentryDsn,
  scrubText2 as scrubText,
  sentryDsnSchema,
  shouldReportError2 as shouldReportError,
  systemClock2 as systemClock,
  toErrorBody2 as toErrorBody
};
