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

// src/errors.ts
var CODE_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

class AppError2 extends Error {
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
function isAppError2(value) {
  return value instanceof AppError2;
}
function toErrorBody2(error) {
  const body = { error: { code: error.code, message: error.message } };
  if (error.details !== undefined) {
    body.error.details = error.details;
  }
  return body;
}

// src/pii.ts
var MAX_LOCAL_PART = 64;
var MAX_DOMAIN = 255;
var MAX_RUN_DIGITS = 64;
var MAX_CARD_DIGITS = 19;
function isDigit(code) {
  return code >= 48 && code <= 57;
}
function isLetter(code) {
  return code >= 65 && code <= 90 || code >= 97 && code <= 122;
}
var UNICODE_WORD = /[\p{L}\p{M}\p{N}]/u;
function isWideWordCode(code, char) {
  return code > 127 && (code >= 55296 && code <= 57343 || UNICODE_WORD.test(char));
}
function isLocalPartCode(code, char) {
  return isDigit(code) || isLetter(code) || isWideWordCode(code, char) || code === 46 || code === 95 || code === 37 || code === 43 || code === 45;
}
function isDomainCode(code, char) {
  return isDigit(code) || isLetter(code) || isWideWordCode(code, char) || code === 46 || code === 45;
}
function isWordLetter(code) {
  return isLetter(code) || code === 95;
}
function maskEmails(text, mask) {
  let at = text.indexOf("@");
  if (at === -1) {
    return text;
  }
  let out = "";
  let copied = 0;
  while (at !== -1) {
    let start = at;
    const floor = Math.max(copied, at - MAX_LOCAL_PART);
    while (start > floor && isLocalPartCode(text.charCodeAt(start - 1), text[start - 1])) {
      start--;
    }
    let end = at + 1;
    const ceiling = Math.min(text.length, at + 1 + MAX_DOMAIN);
    while (end < ceiling && isDomainCode(text.charCodeAt(end), text[end])) {
      end++;
    }
    while (end > at + 1 && (text[end - 1] === "." || text[end - 1] === "-")) {
      end--;
    }
    const dot = text.slice(at + 1, end).lastIndexOf(".");
    const tld = dot > 0 ? text.slice(at + 2 + dot, end) : "";
    if (start < at && tld.length >= 2 && tld.length <= 24 && /^\p{L}+$/u.test(tld)) {
      out += text.slice(copied, start) + mask;
      copied = end;
      at = text.indexOf("@", end);
    } else {
      at = text.indexOf("@", at + 1);
    }
  }
  return copied === 0 ? text : out + text.slice(copied);
}
function readRun(text, from, maxDigits) {
  let p = from;
  let plus = false;
  let paren = false;
  if (text[p] === "+") {
    plus = true;
    p++;
  }
  if (text[p] === "(") {
    paren = true;
    p++;
  }
  if (!isDigit(text.charCodeAt(p))) {
    return null;
  }
  const doubleZero = !plus && text.charCodeAt(p) === 48 && text.charCodeAt(p + 1) === 48;
  const run = {
    start: from,
    end: p,
    plus,
    paren,
    groupEnds: [],
    groups: [],
    seps: [],
    digits: 0
  };
  for (;; ) {
    let q = p;
    while (isDigit(text.charCodeAt(q))) {
      q++;
    }
    run.groups.push(q - p);
    run.groupEnds.push(q);
    run.digits += q - p;
    run.end = q;
    if (run.digits >= maxDigits) {
      break;
    }
    let k = q;
    let sep = "";
    if (text[k] === ")") {
      sep = ")";
      k++;
    }
    const next = text[k];
    if (next === " " || next === "-" || next === ".") {
      sep += next;
      k++;
    }
    if (text[k] === "(") {
      if (sep === "" && !(plus || doubleZero)) {
        break;
      }
      sep = sep === "" ? "(" : sep;
      k++;
    }
    if (sep === "") {
      break;
    }
    if (!isDigit(text.charCodeAt(k))) {
      break;
    }
    const cardTail = run.groups.length === 3 && run.groups.every((length) => length === 4) && !paren;
    if (!(plus || doubleZero && run.groups.length <= 3 || cardTail) && !isDigit(text.charCodeAt(k + 1))) {
      break;
    }
    run.seps.push(sep);
    p = k;
  }
  return run;
}
function passesLuhn(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1;i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) {
        n -= 9;
      }
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}
function digitsOf(text, run) {
  return text.slice(run.start, run.end).replace(/\D/g, "");
}
function leadingNonPhoneGroups(text, run) {
  if (run.plus || startsDoubleZero(text, run)) {
    return 0;
  }
  const { groups, seps } = run;
  if (groups[0] === 4 && groups[1] === 2 && groups[2] === 2 && seps[0] === "-" && seps[1] === "-") {
    const month = Number(text.slice(run.groupEnds[0] + 1, run.groupEnds[1]));
    const day = Number(text.slice(run.groupEnds[1] + 1, run.groupEnds[2]));
    return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? 3 : 0;
  }
  if (groups.length >= 4 && groups.slice(0, 4).every((length) => length <= 3) && seps.slice(0, 3).every((sep) => sep === ".")) {
    return 4;
  }
  return 0;
}
function isAlnum(code) {
  return isDigit(code) || isLetter(code);
}
function attachedBefore(text, index, labelled) {
  if (index === 0) {
    return false;
  }
  const code = text.charCodeAt(index - 1);
  if (isWordLetter(code) || isDigit(code)) {
    return true;
  }
  if (code === 45 || code === 46) {
    const two = index >= 2 ? text.charCodeAt(index - 2) : 0;
    if (!labelled) {
      return isAlnum(two);
    }
    return isDigit(two) || code === 45 && (two | 32) >= 97 && (two | 32) <= 102;
  }
  return code === 58 && index >= 2 && isDigit(text.charCodeAt(index - 2));
}
function attachedAfter(text, index) {
  if (index >= text.length) {
    return false;
  }
  const code = text.charCodeAt(index);
  if (isWordLetter(code)) {
    return true;
  }
  return (code === 45 || code === 46) && isAlnum(text.charCodeAt(index + 1));
}
function isUuidLayout(run) {
  const { groups, seps } = run;
  return groups.length === 5 && groups[0] === 8 && groups[1] === 4 && groups[2] === 4 && groups[3] === 4 && groups[4] === 12 && seps.every((sep) => sep === "-");
}
function hasIssuerPrefix(digits) {
  const first = digits[0];
  if (first === "4" || first === "5" || first === "6") {
    return true;
  }
  if (first === "3") {
    return digits[1] !== "1" && digits[1] !== "2" && digits[1] !== "3";
  }
  if (first === "2") {
    const prefix = Number(digits.slice(0, 4));
    return prefix >= 2221 && prefix <= 2720;
  }
  return digits.startsWith("81") || digits.startsWith("86");
}
function isCardLayout(groups) {
  const last = groups.length - 1;
  if (groups.length === 1) {
    return true;
  }
  if (groups.slice(0, last).every((length) => length === 4)) {
    return groups[last] <= 4;
  }
  return groups.length === 3 && groups[0] === 4 && groups[1] === 6 && (groups[2] === 5 || groups[2] === 4);
}
function isCard(text, run) {
  if (run.digits < 13 || run.digits > 19 || run.paren || run.plus) {
    return false;
  }
  if (!run.seps.every((sep) => sep === " " || sep === "-" || sep === ".") || !isCardLayout(run.groups)) {
    return false;
  }
  const digits = digitsOf(text, run);
  if (digits[0] === "1") {
    return run.groups.length === 4 && run.groups.every((length) => length === 4) && passesLuhn(digits);
  }
  return hasIssuerPrefix(digits) && passesLuhn(digits);
}
var TWO_DIGIT_CODES = new Set("20 27 30 31 32 33 34 36 39 40 41 43 44 45 46 47 48 49 51 52 53 54 55 56 57 58 60 61 62 63 64 65 66 81 82 84 86 90 91 92 93 94 95 98".split(" "));
var THREE_DIGIT_PREFIXES = new Set("21 22 23 24 25 26 29 35 37 38 42 50 59 67 68 69 85 87 88 96 97 99".split(" "));
function isCountryCode(code) {
  if (code.length === 1) {
    return code === "1" || code === "7";
  }
  if (code.length === 2) {
    return TWO_DIGIT_CODES.has(code);
  }
  return code.length === 3 && THREE_DIGIT_PREFIXES.has(code.slice(0, 2));
}
function startsDoubleZero(text, run) {
  return !run.plus && !run.paren && text.charCodeAt(run.start) === 48 && text.charCodeAt(run.start + 1) === 48;
}
function trunkParenAt(text, run) {
  for (let i = 1;i <= 2 && i < run.groups.length; i++) {
    const end = run.groupEnds[i];
    if (run.groups[i] === 1 && text.charCodeAt(end - 1) === 48 && text[end - 2] === "(" && text[end] === ")") {
      return i;
    }
  }
  return -1;
}
function numberDigits(text, run) {
  return run.digits - (trunkParenAt(text, run) === -1 ? 0 : 1);
}
function codeLength(digits) {
  if (digits[0] === "1" || digits[0] === "7") {
    return 1;
  }
  if (TWO_DIGIT_CODES.has(digits.slice(0, 2))) {
    return 2;
  }
  return digits.length >= 3 && THREE_DIGIT_PREFIXES.has(digits.slice(0, 2)) ? 3 : 0;
}
function opensAsInternational(text, run) {
  const { groups, groupEnds } = run;
  const first = groups[0];
  let tail;
  if (first === 2) {
    const second = groups[1];
    if (groups.length < 2) {
      return false;
    }
    const digits = text.slice(groupEnds[0] + 1, groupEnds[1]);
    if (second >= 4 ? codeLength(digits) === 0 : !isCountryCode(digits) || groups.length < 3) {
      return false;
    }
    tail = groups.slice(2);
  } else {
    if (first < 3 || groups.length < 2) {
      return false;
    }
    const digits = text.slice(run.start + 2, groupEnds[0]);
    if (first > 5 ? codeLength(digits) === 0 : !isCountryCode(digits)) {
      return false;
    }
    tail = groups.slice(1);
  }
  const trunk = trunkParenAt(text, run);
  const lone = tail.filter((length, i) => length === 1 && i + (groups.length - tail.length) !== trunk).length;
  if (lone > 1) {
    return false;
  }
  for (let i = 1;i < groups.length; i++) {
    if (text.charCodeAt(groupEnds[i] - groups[i]) !== 48) {
      return true;
    }
  }
  return false;
}
function isGluedInternational(text, run) {
  return startsDoubleZero(text, run) && run.groups.length === 1 && run.digits >= 10 && run.digits <= 17 && codeLength(text.slice(run.start + 2, run.end)) > 0;
}
function hasPhoneLead(text, run) {
  if (run.plus) {
    return true;
  }
  if (run.paren) {
    return run.seps[0]?.startsWith(")") === true;
  }
  if (startsDoubleZero(text, run)) {
    return opensAsInternational(text, run);
  }
  const first = run.groups[0];
  return text.charCodeAt(run.start) === 48 && first >= 2 && first <= 5 && run.seps.every((sep) => sep === run.seps[0]);
}
function isPhone(text, run) {
  if (!hasPhoneLead(text, run)) {
    return false;
  }
  if (run.plus) {
    return numberDigits(text, run) >= 8 && numberDigits(text, run) <= 15;
  }
  if (startsDoubleZero(text, run)) {
    return numberDigits(text, run) >= 10 && numberDigits(text, run) <= 17;
  }
  if (run.digits < 9 || run.digits > 15) {
    return false;
  }
  const { groups, seps } = run;
  const dotted = seps.every((sep) => sep === ".");
  const limit = dotted ? 4 : 8;
  if (dotted && groups.length < 3) {
    return false;
  }
  return groups.every((length, i) => length <= limit && (i === 0 || length >= 2));
}
function isSeveralNumbers(text, run) {
  const trunk = trunkParenAt(text, run);
  if (numberDigits(text, run) < 16 || !run.groups.every((length, i) => i === 0 || length >= 2 || i === trunk)) {
    return false;
  }
  if (hasPhoneLead(text, run)) {
    return true;
  }
  if (run.digits < 20 || run.groups.length < 5 || !run.groups.slice(0, 4).every((length) => length === 4) || !run.seps.slice(0, 3).every((sep) => sep === " " || sep === "-")) {
    return false;
  }
  const card = digitsOf(text, run).slice(0, 16);
  return card[0] !== "1" && hasIssuerPrefix(card) && passesLuhn(card);
}
function maskNumbers(text, mask) {
  let out = "";
  let copied = 0;
  let i = 0;
  let sequenceEnd = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (!(isDigit(code) || code === 43 || code === 40)) {
      i++;
      continue;
    }
    const inside = isDigit(code) && i < sequenceEnd;
    const run = readRun(text, i, inside ? MAX_CARD_DIGITS + 1 : MAX_RUN_DIGITS);
    if (run === null) {
      i++;
      continue;
    }
    const before = i === 0 ? 0 : text.charCodeAt(i - 1);
    if (run.paren && !run.plus && run.seps[0]?.startsWith(")") !== true) {
      i++;
      continue;
    }
    if (isUuidLayout(run)) {
      i = run.end;
      continue;
    }
    const skip = leadingNonPhoneGroups(text, run);
    if (skip > 0) {
      i = run.groupEnds[skip - 1];
      continue;
    }
    const labelled = run.plus || run.paren || startsDoubleZero(text, run);
    let masked = false;
    if (run.groups.length === 1 && !run.plus) {
      masked = (before !== 46 || startsDoubleZero(text, run)) && !attachedBefore(text, i, startsDoubleZero(text, run)) && !attachedAfter(text, run.end) && (isCard(text, run) || isGluedInternational(text, run));
    } else if (!attachedBefore(text, i, labelled) && !attachedAfter(text, run.end)) {
      masked = isCard(text, run) || !inside && (isPhone(text, run) || isSeveralNumbers(text, run));
    }
    if (masked) {
      const end = run.paren && text[run.end] === ")" ? run.end + 1 : run.end;
      out += text.slice(copied, run.start) + mask;
      copied = end;
      i = end;
    } else {
      if (run.groups.length > 1) {
        sequenceEnd = Math.max(sequenceEnd, run.end);
      }
      i = run.groups.length > 1 ? run.groupEnds[0] : run.end;
    }
  }
  return copied === 0 ? text : out + text.slice(copied);
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
  "body",
  "pass",
  "pwd",
  "passwd",
  "passphrase",
  "auth",
  "sig",
  "sid",
  "session",
  "sessionid",
  "sessid",
  "signature"
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
  "secretaccesskey",
  "signature",
  "signature256",
  "passwordhash",
  "sessionkey",
  "accesskey",
  "connectionstring",
  "passwd",
  "sessionid",
  "sessid",
  "authorizationheader",
  "body",
  "otp",
  "cvv",
  "dsn",
  "credential",
  "bodies"
];
var SENSITIVE_WORD_SEGMENTS = new Set(["pass", "sig", "sid", "auth"]);
var SENSITIVE_LAST_SEGMENTS = new Set(["session"]);
function wordsOf(key) {
  const words = [];
  for (const part of key.split(/[_.-]+/)) {
    const pieces = part.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g);
    if (pieces !== null) {
      for (const piece of pieces) {
        words.push(piece.toLowerCase());
      }
    }
  }
  return words;
}
function normalizeKey(key) {
  return key.toLowerCase().replace(/[_-]/g, "");
}
function isSensitiveKey(key) {
  const normalized = normalizeKey(key);
  const singular = normalized.endsWith("s") ? normalized.slice(0, -1) : normalized;
  if ([normalized, singular].some((name) => SENSITIVE_WORDS.has(name) || SENSITIVE_SUFFIXES.some((suffix) => name.endsWith(suffix)))) {
    return true;
  }
  const words = wordsOf(key);
  return words.some((word) => SENSITIVE_WORD_SEGMENTS.has(word)) || SENSITIVE_LAST_SEGMENTS.has(words.at(-1) ?? "");
}
function mayBeTokenCount(key) {
  return normalizeKey(key).endsWith("tokens");
}

// src/scrub.ts
var MASK = "[redacted]";
var TRUNCATED = "[truncated]";
var UNSCRUBBABLE = "[unscrubbable]";
var MAX_TEXT_LENGTH = 32768;
var CONNECTION_SCHEME = /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql|sqlserver|nats|kafka|jdbc:[a-z0-9]{1,20}):\/\//gi;
var MAX_USERINFO = 128;
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
var FRAME_POSITION = /\d{1,9}:\d{1,9}/y;
var KEY_DETAIL = /\bKey \(([^()\n]{1,200})\)=\(/g;
var KEY_DETAIL_END = /\)(?=[ \t]+(?:already|is\b|conflicts)|[ \t]*[.,;]?[ \t]*(?:\r?\n|$))/g;
var MAX_KEY_DETAIL_VALUE = 500;
function isWordCode(code) {
  return code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122 || code === 95 || code === 46 || code === 45 || code === 126 || code === 43 || code === 47 || code === 61;
}
function cutText2(text, max) {
  if (text.length <= max) {
    return text;
  }
  let end = max;
  while (end > 0 && isWordCode(text.charCodeAt(end - 1))) {
    end--;
  }
  return `${text.slice(0, end)}${TRUNCATED}`;
}
function maskSecretWords(text) {
  return text.replace(TOKEN_WORD, (word) => SECRET_WORDS.some((pattern) => pattern.test(word)) ? MASK : word);
}
function bracketEnd(text, start) {
  let depth = 0;
  for (let i = start;i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      i = quotedEnd(text, i) - 1;
    } else if (c === "{" || c === "[") {
      depth++;
    } else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) {
        return i + 1;
      }
    }
  }
  return text.length;
}
function quotedEnd(text, start) {
  const first = text[start];
  for (let i = start + 1;i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
    } else if (text[i] === first) {
      if (text[i + 1] !== first) {
        return i + 1;
      }
      i++;
    }
  }
  return text.length;
}
function valueEnd(text, start, inQuery, jsonKey) {
  const first = text[start];
  if (first === '"' || first === "'") {
    return quotedEnd(text, start);
  }
  if (jsonKey && (first === "{" || first === "[")) {
    return bracketEnd(text, start);
  }
  let end = start;
  if (inQuery) {
    while (end < text.length && !/[\s,;&#"']/.test(text[end])) {
      end++;
    }
    return end;
  }
  if (jsonKey) {
    while (end < text.length && !/[\s,}\]]/.test(text[end])) {
      end++;
    }
    return end;
  }
  while (end < text.length && text.charCodeAt(end) !== 10 && text.charCodeAt(end) !== 13) {
    end++;
  }
  return end;
}
function isFramePosition(text, keyStart, valueStart) {
  const before = text[keyStart - 1];
  if (before !== "/" && before !== "\\" || text[valueStart - 1] !== ":") {
    return false;
  }
  FRAME_POSITION.lastIndex = valueStart;
  return FRAME_POSITION.test(text);
}
function connectionEnd(text, start) {
  const limit = Math.min(text.length, start + MAX_USERINFO);
  let at = -1;
  for (let i = start;i < limit; i++) {
    const c = text[i];
    if (c === "@") {
      at = i;
      break;
    }
    if (c === "/" || c === "?" || c === "#") {
      break;
    }
  }
  let end = at === -1 ? start : at + 1;
  while (end < text.length && !/\s/.test(text[end])) {
    end++;
  }
  return end;
}
function maskConnectionStrings(text) {
  const pattern = CONNECTION_SCHEME;
  pattern.lastIndex = 0;
  let out = "";
  let copied = 0;
  try {
    for (let match = pattern.exec(text);match !== null; match = pattern.exec(text)) {
      const start = match.index + match[0].length;
      const end = connectionEnd(text, start);
      if (end === start) {
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
function maskKeyDetails(text) {
  if (!text.includes("Key (")) {
    return text;
  }
  const pattern = KEY_DETAIL;
  pattern.lastIndex = 0;
  let out = "";
  let copied = 0;
  try {
    for (let match = pattern.exec(text);match !== null; match = pattern.exec(text)) {
      const start = pattern.lastIndex;
      const window = text.slice(start, start + MAX_KEY_DETAIL_VALUE + 1);
      KEY_DETAIL_END.lastIndex = 0;
      const close = KEY_DETAIL_END.exec(window);
      let end;
      if (close !== null) {
        end = start + close.index;
      } else {
        const newline = window.indexOf(`
`);
        end = start + (newline === -1 ? window.length : newline);
      }
      out += text.slice(copied, start) + MASK;
      copied = end;
      pattern.lastIndex = end;
    }
  } finally {
    pattern.lastIndex = 0;
    KEY_DETAIL_END.lastIndex = 0;
  }
  return copied === 0 ? text : out + text.slice(copied);
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
      if (!isSensitiveKey(key) || isFramePosition(text, match.index, start)) {
        continue;
      }
      const before = text[match.index - 1];
      const jsonKey = match[0].charAt(key.length) === '"' || match[0].charAt(key.length) === "'";
      if (mayBeTokenCount(key) && /^[0-9]{1,24}(?=[\s,;&]|$)/.test(text.slice(start, start + 25))) {
        continue;
      }
      const end = valueEnd(text, start, before === "?" || before === "&", jsonKey);
      if (end === start) {
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
    let value = cutText2(raw, MAX_TEXT_LENGTH);
    if (value.includes("://")) {
      value = maskConnectionStrings(value).replace(URL_CREDENTIALS, `$1${MASK}@`);
    }
    value = value.replace(BEARER, `Bearer ${MASK}`);
    value = maskSecretWords(value);
    value = maskKeyDetails(value);
    value = maskPairs(value);
    return maskNumbers(maskEmails(value, MASK), MASK);
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
    if (isAppError2(error)) {
      return error.status >= 500;
    }
    return !(isAppErrorShaped(error) && error.status < 500);
  } catch {
    return true;
  }
}

export { systemClock2, createFixedClock2, AppError2, isAppError2, toErrorBody2, isSensitiveKey, cutText2, scrubText2, redactFields, prepareFields, shouldReportError2 };
