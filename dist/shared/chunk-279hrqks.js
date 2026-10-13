// src/clock.ts
var UNIT_MS = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
var DURATION_PATTERN = /^(\d+)(ms|s|m|h|d)$/;
function isUnit(unit) {
  return unit !== undefined && unit in UNIT_MS;
}
var systemClock2 = {
  now: () => new Date
};
function createFixedClock2(start) {
  let current = new Date(start).getTime();
  if (Number.isNaN(current)) {
    throw new TypeError(`createFixedClock needs a valid start time, got ${String(start)}`);
  }
  return {
    now: () => new Date(current),
    advance(duration) {
      const match = DURATION_PATTERN.exec(duration);
      const amount = match?.[1];
      const unit = match?.[2];
      if (amount === undefined || !isUnit(unit)) {
        throw new TypeError(`Invalid duration ${JSON.stringify(duration)}: use a whole number and ms, s, m, h or d`);
      }
      current += Number(amount) * UNIT_MS[unit];
    }
  };
}

// src/redact.ts
var REDACTED = "[redacted]";
var MAX_DEPTH = 32;
var SENSITIVE_KEYS = new Set([
  "password",
  "token",
  "accesstoken",
  "refreshtoken",
  "authorization",
  "cookie",
  "secret",
  "apikey",
  "recording",
  "transcript",
  "body"
]);
function isSensitiveKey(key) {
  return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[_-]/g, ""));
}
function serializeError(error, ancestors, depth) {
  const out = {
    name: error.name,
    message: error.message,
    stack: error.stack
  };
  const code = error.code;
  if (code !== undefined) {
    out.code = redactValue(code, ancestors, depth + 1);
  }
  return out;
}
function redactValue(value, ancestors, depth) {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (value instanceof Date) {
    return value;
  }
  if (ancestors.has(value)) {
    return "[circular]";
  }
  if (depth >= MAX_DEPTH) {
    return "[truncated]";
  }
  ancestors.add(value);
  try {
    if (value instanceof Error) {
      return serializeError(value, ancestors, depth);
    }
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, ancestors, depth + 1));
    }
    const toJSON = value.toJSON;
    if (typeof toJSON === "function") {
      try {
        return redactValue(toJSON.call(value), ancestors, depth + 1);
      } catch {
        return "[unserializable]";
      }
    }
    return redactRecord(value, ancestors, depth);
  } finally {
    ancestors.delete(value);
  }
}
function redactRecord(record, ancestors, depth) {
  const out = {};
  for (const key of Object.keys(record)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactValue(record[key], ancestors, depth + 1);
  }
  return out;
}
function redactFields(fields) {
  const ancestors = new Set([fields]);
  return redactRecord(fields, ancestors, 0);
}

export { systemClock2, createFixedClock2, redactFields };
