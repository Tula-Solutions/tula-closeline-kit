import {
  systemClock2,
  createFixedClock2,
  prepareFields
} from "./shared/chunk-gxr4ppv8.js";

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
class TokenVerificationError extends Error {
  reason;
  constructor(reason) {
    super(reason === "expired" ? "Token expired" : "Token rejected");
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
async function importAll(jwks) {
  const parsed = jwksSchema.safeParse(jwks);
  if (!parsed.success) {
    return;
  }
  const keys = new Map;
  for (const raw of parsed.data.keys) {
    const entry = await importPublicKey(raw);
    if (entry !== undefined && !keys.has(entry[0])) {
      keys.set(entry[0], entry[1]);
    }
  }
  return keys;
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
  return { getKey: async (kid) => keys.get(kid) };
}

class RetryableFetchError extends Error {
}
function assertUrl(raw) {
  const url = new URL(raw);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new TypeError("The JWKS URL must be https");
  }
  return url;
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
  const url = assertUrl(options.url);
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 3000;
  const retries = options.retries ?? 1;
  const cooldownMs = options.cooldownMs ?? 30000;
  const maxAgeMs = options.maxAgeMs ?? 3600000;
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const random = options.random ?? Math.random;
  let keys = new Map;
  let loadedAt;
  let lastAttemptAt;
  let inflight;
  const now = () => options.clock.now().getTime();
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
      if (fresh === undefined || fresh.size === 0) {
        throw new Error("JWKS held no usable key");
      }
      keys = fresh;
      loadedAt = now();
    } catch (error) {
      options.logger?.warn("jwks refresh failed", {
        reason: error instanceof Error ? error.message : "unknown",
        keysServed: keys.size
      });
    }
  }
  function startRefresh() {
    lastAttemptAt = now();
    const run = refresh().finally(() => {
      if (inflight === run) {
        inflight = undefined;
      }
    });
    inflight = run;
    return run;
  }
  function cooldownElapsed() {
    return lastAttemptAt === undefined || now() - lastAttemptAt >= cooldownMs;
  }
  return {
    async getKey(kid) {
      const cached = keys.get(kid);
      if (cached !== undefined) {
        if (loadedAt !== undefined && now() - loadedAt >= maxAgeMs && !inflight && cooldownElapsed()) {
          startRefresh();
        }
        return cached;
      }
      if (inflight) {
        await inflight;
      } else if (cooldownElapsed()) {
        await startRefresh();
      }
      return keys.get(kid);
    },
    warm() {
      return inflight ?? startRefresh();
    }
  };
}
// src/errors.ts
var CODE_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

class AppError extends Error {
  code;
  status;
  details;
  constructor(init) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    if (!CODE_PATTERN.test(init.code)) {
      throw new TypeError(`AppError code must look like "area.reason", got ${JSON.stringify(init.code)}`);
    }
    if (!Number.isInteger(init.status) || init.status < 100 || init.status > 599) {
      throw new TypeError(`AppError status must be an HTTP status, got ${init.status}`);
    }
    this.name = "AppError";
    this.code = init.code;
    this.status = init.status;
    if (init.details !== undefined) {
      this.details = init.details;
    }
  }
}
function isAppError(value) {
  return value instanceof AppError;
}
function toErrorBody(error) {
  const body = { error: { code: error.code, message: error.message } };
  if (error.details !== undefined) {
    body.error.details = error.details;
  }
  return body;
}

// src/auth/middleware.ts
var BEARER = /^Bearer ([^\s]+)$/i;
function unauthenticated() {
  return new AppError({
    code: "auth.unauthenticated",
    status: 401,
    message: "Authentication is required."
  });
}
function createAuthMiddleware(options) {
  const { verifier, logger } = options;
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
      const reason = error instanceof TokenVerificationError ? error.reason : "invalid";
      logger?.warn("request rejected", { reason });
      throw new AppError({
        code: reason === "expired" ? "auth.token_expired" : "auth.token_invalid",
        status: 401,
        message: reason === "expired" ? "The access token has expired." : "The access token is not valid."
      });
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
      const key = await keys.getKey(readKid(token));
      if (key === undefined) {
        return reject();
      }
      const now = clock.now();
      let payload;
      try {
        const result = await jwtVerify(token, key, {
          algorithms: [ALGORITHM],
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
// src/logger.ts
import pino from "pino";
function wrap(base) {
  const emit = (level) => (message, fields) => {
    if (base.isLevelEnabled(level)) {
      base[level](prepareFields(fields), message);
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

// src/index.ts
var PACKAGE = "tula-closeline-kit";
export {
  AppError,
  MAX_JWKS_BYTES,
  MAX_JWKS_KEYS,
  MAX_TOKEN_LENGTH,
  PACKAGE,
  TokenVerificationError,
  accessTokenClaimsSchema,
  createAuthMiddleware,
  createFixedClock2 as createFixedClock,
  createLogger,
  createRemoteKeySet,
  createStaticKeySet,
  createTokenVerifier,
  isAppError,
  systemClock2 as systemClock,
  toErrorBody
};
