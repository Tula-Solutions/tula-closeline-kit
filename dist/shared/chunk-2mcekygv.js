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

// src/sensitive.ts
var SENSITIVE_WORDS = new Set([
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
var SENSITIVE_SUFFIXES = [
  "token",
  "secret",
  "password",
  "apikey",
  "cookie",
  "authorization",
  "secretkey",
  "privatekey",
  "authorizationheader",
  "body",
  "bodies"
];
function normalizeKey(key) {
  return key.toLowerCase().replace(/[_-]/g, "");
}
function isSensitiveKey(key) {
  const normalized = normalizeKey(key);
  const singular = normalized.endsWith("s") ? normalized.slice(0, -1) : normalized;
  return [normalized, singular].some((name) => SENSITIVE_WORDS.has(name) || SENSITIVE_SUFFIXES.some((suffix) => name.endsWith(suffix)));
}
function mayBeTokenCount(key) {
  return normalizeKey(key).endsWith("tokens");
}

// src/scrub.ts
var MASK = "[redacted]";
var TRUNCATED = "[truncated]";
var UNSCRUBBABLE = "[unscrubbable]";
var MAX_TEXT_LENGTH = 32768;
var CONNECTION_STRING = /\b((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql|sqlserver|nats|kafka|jdbc:[a-z0-9]{1,20}):\/\/)\S+/gi;
var URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/?#]+@/gi;
var BEARER = /\bbearer\s+[A-Za-z0-9._~+/=-]+/gi;
var TOKEN_WORD = /[A-Za-z0-9_.-]{16,}/g;
var SECRET_WORDS = [
  /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.?$/,
  /^(?:AKIA|ASIA)[0-9A-Z]{16}/,
  /^(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/,
  /^(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/,
  /^sk-[A-Za-z0-9_-]{16,}/,
  /^xox[abprs]-[A-Za-z0-9-]{10,}/
];
var KEY_AND_SEPARATOR = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{1,64})["']?\s*[:=]\s*/g;
var LINE_VALUE_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie"
]);
function isWordCode(code) {
  return code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122 || code === 95 || code === 46 || code === 45 || code === 126 || code === 43 || code === 47 || code === 61;
}
function cap(text) {
  if (text.length <= MAX_TEXT_LENGTH) {
    return text;
  }
  let end = MAX_TEXT_LENGTH;
  while (end > 0 && isWordCode(text.charCodeAt(end - 1))) {
    end--;
  }
  return `${text.slice(0, end)}${TRUNCATED}`;
}
function maskSecretWords(text) {
  return text.replace(TOKEN_WORD, (word) => SECRET_WORDS.some((pattern) => pattern.test(word)) ? MASK : word);
}
function valueEnd(text, start, lineValue) {
  const first = text[start];
  if (first === '"' || first === "'") {
    for (let i = start + 1;i < text.length; i++) {
      if (text[i] === "\\") {
        i++;
      } else if (text[i] === first) {
        return i + 1;
      }
    }
    return text.length;
  }
  if (lineValue) {
    const newline = text.indexOf(`
`, start);
    return newline === -1 ? text.length : newline;
  }
  let end = start;
  while (end < text.length && !/[\s,;&"']/.test(text[end])) {
    end++;
  }
  return end;
}
function maskPairs(text) {
  const pattern = KEY_AND_SEPARATOR;
  pattern.lastIndex = 0;
  let out = "";
  let copied = 0;
  try {
    for (let match = pattern.exec(text);match !== null; match = pattern.exec(text)) {
      const key = match[1];
      const start = pattern.lastIndex;
      if (!isSensitiveKey(key)) {
        continue;
      }
      const end = valueEnd(text, start, LINE_VALUE_KEYS.has(normalizeKey(key)));
      if (end === start) {
        continue;
      }
      if (mayBeTokenCount(key) && /^[0-9]+$/.test(text.slice(start, end))) {
        continue;
      }
      out += text.slice(copied, start) + MASK;
      copied = end;
      pattern.lastIndex = end;
    }
  } finally {
    pattern.lastIndex = 0;
  }
  return copied === 0 ? text : out + text.slice(copied);
}
function scrubText2(text) {
  try {
    const raw = typeof text === "string" ? text : String(text);
    if (raw.length === 0) {
      return raw;
    }
    let value = cap(raw);
    if (value.includes("://")) {
      value = value.replace(CONNECTION_STRING, `$1${MASK}`).replace(URL_CREDENTIALS, `$1${MASK}@`);
    }
    value = value.replace(BEARER, `Bearer ${MASK}`);
    value = maskSecretWords(value);
    return maskPairs(value);
  } catch {
    return UNSCRUBBABLE;
  }
}

// src/redact.ts
var REDACTED = "[redacted]";
var CIRCULAR = "[circular]";
var TRUNCATED2 = "[truncated]";
var UNSERIALIZABLE = "[unserializable]";
var MAX_DEPTH = 32;
var MAX_ARRAY_ITEMS = 100;
var MAX_OBJECT_KEYS = 200;
var MAX_NODES = 5000;
var MAX_VALUES = 20000;
var RESERVED_KEYS = ["level", "time", "msg", "service"];
function spend(state, depth) {
  if (depth === 0) {
    return true;
  }
  state.values++;
  return state.values <= MAX_VALUES;
}
function attempt(read) {
  try {
    return read();
  } catch {
    return UNSERIALIZABLE;
  }
}
function put(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true
  });
}
function summarizeBinary(value) {
  const buffer = value;
  return { type: Object.prototype.toString.call(value).slice(8, -1), byteLength: buffer.byteLength };
}
function isBinary(value) {
  return ArrayBuffer.isView(value) || value instanceof ArrayBuffer || typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer;
}
function scrubbedErrorText(read) {
  const value = attempt(read);
  return typeof value === "string" && value !== UNSERIALIZABLE ? scrubText2(value) : value;
}
function redactError(error, state, ancestors, depth) {
  const out = {};
  put(out, "name", attempt(() => error.name));
  put(out, "message", scrubbedErrorText(() => error.message));
  put(out, "stack", scrubbedErrorText(() => error.stack));
  const code = attempt(() => error.code);
  if (code !== undefined) {
    put(out, "code", redactValue(code, state, ancestors, depth + 1));
  }
  const cause = attempt(() => error.cause);
  if (cause !== undefined) {
    put(out, "cause", redactValue(cause, state, ancestors, depth + 1));
  }
  return out;
}
function redactList(items, size, state, ancestors, depth) {
  const out = [];
  for (const item of items) {
    if (out.length >= MAX_ARRAY_ITEMS) {
      break;
    }
    if (!spend(state, depth + 1)) {
      out.push(TRUNCATED2);
      return out;
    }
    out.push(redactValue(item, state, ancestors, depth + 1));
  }
  if (size > MAX_ARRAY_ITEMS) {
    out.push(`[+${size - MAX_ARRAY_ITEMS} more]`);
  }
  return out;
}
function redactMap(map, state, ancestors, depth) {
  const out = {};
  let index = 0;
  for (const [key, value] of map) {
    if (index >= MAX_OBJECT_KEYS) {
      break;
    }
    const name = typeof key === "string" ? key : `[key ${index}]`;
    if (!spend(state, depth + 1)) {
      put(out, "[more]", TRUNCATED2);
      return out;
    }
    const hidden = isSensitiveKey(name) && !(mayBeTokenCount(name) && typeof value === "number");
    put(out, name, hidden ? REDACTED : redactValue(value, state, ancestors, depth + 1));
    index++;
  }
  if (map.size > MAX_OBJECT_KEYS) {
    put(out, "[more]", `[+${map.size - MAX_OBJECT_KEYS} more]`);
  }
  return out;
}
function redactRecord(record, state, ancestors, depth) {
  const keys = Object.keys(record);
  const kept = keys.slice(0, MAX_OBJECT_KEYS);
  const out = {};
  const nested = [];
  let spent = false;
  for (const key of kept) {
    if (!spend(state, depth)) {
      spent = true;
      break;
    }
    const sensitive = isSensitiveKey(key);
    if (sensitive && !mayBeTokenCount(key)) {
      put(out, key, REDACTED);
      continue;
    }
    const value = attempt(() => record[key]);
    if (sensitive && typeof value !== "number") {
      put(out, key, REDACTED);
      continue;
    }
    if (typeof value === "object" && value !== null) {
      put(out, key, undefined);
      nested.push([key, value]);
    } else {
      put(out, key, value);
    }
  }
  for (const [key, value] of nested) {
    put(out, key, redactValue(value, state, ancestors, depth + 1));
  }
  if (spent) {
    put(out, "[more]", TRUNCATED2);
  } else if (keys.length > MAX_OBJECT_KEYS) {
    put(out, "[more]", `[+${keys.length - MAX_OBJECT_KEYS} more]`);
  }
  return out;
}
function redactObject(value, state, ancestors, depth) {
  if (value instanceof Date) {
    return value;
  }
  if (isBinary(value)) {
    return summarizeBinary(value);
  }
  if (value instanceof Error) {
    return redactError(value, state, ancestors, depth);
  }
  if (Array.isArray(value)) {
    return redactList(value, value.length, state, ancestors, depth);
  }
  if (value instanceof Map) {
    return redactMap(value, state, ancestors, depth);
  }
  if (value instanceof Set) {
    return redactList(value, value.size, state, ancestors, depth);
  }
  const toJSON = value.toJSON;
  if (typeof toJSON === "function") {
    return redactValue(toJSON.call(value), state, ancestors, depth + 1);
  }
  return redactRecord(value, state, ancestors, depth);
}
function redactValue(value, state, ancestors, depth) {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (ancestors.has(value)) {
    return CIRCULAR;
  }
  state.nodes++;
  if (state.nodes > MAX_NODES || depth >= MAX_DEPTH) {
    return TRUNCATED2;
  }
  ancestors.add(value);
  try {
    return redactObject(value, state, ancestors, depth);
  } catch {
    return UNSERIALIZABLE;
  } finally {
    ancestors.delete(value);
  }
}
function redactFields(fields) {
  try {
    return redactRecord(fields, { nodes: 0, values: 0 }, new Set([fields]), 0);
  } catch {
    return { fields: UNSERIALIZABLE };
  }
}
function prepareFields(fields) {
  const prepared = redactFields(fields ?? {});
  for (const key of RESERVED_KEYS) {
    if (key in prepared) {
      put(prepared, `field_${key}`, prepared[key]);
      delete prepared[key];
    }
  }
  return prepared;
}

// src/reporting/port.ts
function isAppErrorShaped(error) {
  return typeof error === "object" && error !== null && error.name === "AppError" && typeof error.status === "number";
}
function shouldReportError2(error) {
  try {
    return !(isAppErrorShaped(error) && error.status < 500);
  } catch {
    return true;
  }
}

export { systemClock2, createFixedClock2, isSensitiveKey, scrubText2, redactFields, prepareFields, shouldReportError2 };
