import {
  AUDIT_ERROR_CODES2,
  AuditError2,
  CalendarConnection2,
  CALENDAR_ERROR_CODES2,
  CalendarError2,
  MESSAGING_ERROR_CODES2,
  MessagingError2,
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
  DEFAULT_CALENDAR_TIMEOUT_MS2,
  MAX_CALENDAR_TIMEOUT_MS2,
  MAX_BUSY_RANGE_MS2,
  MAX_EVENT_DURATION_MS2,
  MAX_EVENT_ATTENDEES2,
  DEFAULT_CALENDAR_RETRY_POLICY2,
  calendarRetryDelayMs2,
  MAX_TELEPHONY_TIMEOUT_MS2,
  MAX_DISCLOSURE_TEXT_LENGTH2,
  MAX_RING_LEGS2,
  TTS_ERROR_CODES2,
  TtsError2
} from "./chunk-y4v94n67.js";
import {
  systemSleep2
} from "./chunk-hybwyj31.js";
import {
  systemClock2
} from "./chunk-5cxd570z.js";
import {
  AppError2,
  isAppError2
} from "./chunk-tya44yhr.js";

// src/audit/entry.ts
import { organizationIdSchema, prospectIdSchema } from "tula-closeline-contract";
import { z } from "zod";
var AUDIT_LIMITS2 = {
  maxMetadataKeys: 20,
  maxStringChars: 200,
  maxEntryBytes: 4096
};
var AUDIT_DENIED_METADATA_KEYS2 = [
  "body",
  "content",
  "text",
  "message",
  "transcript",
  "token",
  "secret",
  "password",
  "email"
];
var DENIED = new Set(AUDIT_DENIED_METADATA_KEYS2);
function isDeniedKey(key) {
  if (DENIED.has(key.toLowerCase().replace(/[^a-z0-9]/g, ""))) {
    return true;
  }
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).some((part) => DENIED.has(part.toLowerCase()));
}
var label = z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/);
var id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
var metadataKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/).refine((key) => !isDeniedKey(key));
var metadataValue = z.union([
  z.string().max(AUDIT_LIMITS2.maxStringChars),
  z.number().finite(),
  z.boolean()
]);
var auditMetadataSchema2 = z.record(metadataKey, metadataValue).refine((record) => Object.keys(record).length <= AUDIT_LIMITS2.maxMetadataKeys);
var auditActorSchema2 = z.strictObject({
  kind: z.enum(["member", "agent", "api_key", "system"]),
  id: id.optional()
}).refine((actor) => actor.kind === "system" || actor.id !== undefined);
var auditSubjectSchema2 = z.strictObject({ type: label, id });
var auditEventPayloadSchema2 = z.strictObject({
  actor: auditActorSchema2,
  action: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/).max(64),
  subject: auditSubjectSchema2,
  instructionVersion: z.number().int().positive().optional(),
  prospectId: prospectIdSchema.nullish(),
  requestId: id.optional(),
  occurredAt: z.iso.datetime().optional(),
  metadata: auditMetadataSchema2.optional()
});
var auditEntrySchema2 = auditEventPayloadSchema2.extend({
  id,
  organizationId: organizationIdSchema
});
function issuesOf(error) {
  return error.issues.slice(0, 20).map((issue) => `${issue.path.map(String).join(".")}: ${issue.code}`);
}
function parseAuditEntry2(input, clock = systemClock2) {
  const parsed = auditEntrySchema2.safeParse(input);
  if (!parsed.success) {
    throw new AuditError2(AUDIT_ERROR_CODES2.invalidEntry, "the audit entry is not valid", {
      details: { issues: issuesOf(parsed.error) }
    });
  }
  const entry = { ...parsed.data, occurredAt: parsed.data.occurredAt ?? clock.now().toISOString() };
  const bytes = new TextEncoder().encode(JSON.stringify(entry)).length;
  if (bytes > AUDIT_LIMITS2.maxEntryBytes) {
    throw new AuditError2(AUDIT_ERROR_CODES2.entryTooLarge, "the audit entry is too large", {
      details: { bytes, maxBytes: AUDIT_LIMITS2.maxEntryBytes }
    });
  }
  return entry;
}

// src/messaging/deadline.ts
function startMessagingDeadline(timeoutMs, caller) {
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
        throw new MessagingError2(MESSAGING_ERROR_CODES2.timeout, "The send took too long", {
          details: { timeoutMs }
        });
      }
      if (controller.signal.aborted) {
        throw new MessagingError2(MESSAGING_ERROR_CODES2.aborted, "The send was cancelled");
      }
    },
    stop() {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onCaller);
    }
  };
}

class AttemptAborted extends Error {
  constructor() {
    super("The attempt was aborted");
    this.name = "AttemptAborted";
  }
}
function raceAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      promise.catch(() => {
        return;
      });
      reject(new AttemptAborted);
      return;
    }
    const onAbort = () => reject(new AttemptAborted);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => {
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    }, (error) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}
function isRetryableMessagingError(error) {
  return error instanceof MessagingError2 && error.code === MESSAGING_ERROR_CODES2.unavailable;
}
async function withMessagingRetry(attempt, options) {
  const sleep = options.sleep ?? systemSleep2;
  for (let n = 1;; n++) {
    options.deadline.check();
    try {
      return await attempt(n);
    } catch (error) {
      options.deadline.check();
      if (!isRetryableMessagingError(error) || n > options.policy.maxRetries) {
        throw error;
      }
      const delayMs = messagingRetryDelayMs2(n, options.policy, options.random);
      options.onRetry?.(n, delayMs);
      await sleep(delayMs, options.deadline.signal);
    }
  }
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
      const computed = calendarRetryDelayMs2(n, options.policy, options.random);
      const delayMs = options.adjustDelay?.(error, computed) ?? computed;
      options.onRetry?.(n, delayMs);
      await sleep(delayMs, options.deadline.signal);
    }
  }
}

// src/calendar/validate.ts
import { organizationIdSchema as organizationIdSchema2 } from "tula-closeline-contract";
import { z as z2 } from "zod";
function invalid(what) {
  throw new CalendarError2(CALENDAR_ERROR_CODES2.invalidRequest, `${what} is not acceptable`);
}
function integerIn(value, min, max) {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}
function checkOptions(options) {
  if (options !== undefined && (typeof options !== "object" || options === null)) {
    invalid("options");
  }
  const timeoutMs = options?.timeoutMs ?? DEFAULT_CALENDAR_TIMEOUT_MS2;
  if (!integerIn(timeoutMs, 1, MAX_CALENDAR_TIMEOUT_MS2)) {
    invalid("timeoutMs");
  }
  if (options?.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    invalid("signal");
  }
  const policy = options?.retry;
  const maxRetries = policy?.maxRetries ?? DEFAULT_CALENDAR_RETRY_POLICY2.maxRetries;
  const baseDelayMs = policy?.baseDelayMs ?? DEFAULT_CALENDAR_RETRY_POLICY2.baseDelayMs;
  const maxDelayMs = policy?.maxDelayMs ?? DEFAULT_CALENDAR_RETRY_POLICY2.maxDelayMs;
  if (!integerIn(maxRetries, 0, 5)) {
    invalid("retry.maxRetries");
  }
  if (!integerIn(baseDelayMs, 1, 60000)) {
    invalid("retry.baseDelayMs");
  }
  if (!integerIn(maxDelayMs, baseDelayMs, 60000)) {
    invalid("retry.maxDelayMs");
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
    return invalid(path ? `${what}.${path}` : what);
  }
  return parsed.data;
}
var instant = z2.iso.datetime({ offset: true });
var requestIdSchema = z2.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
var eventIdSchema = z2.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/);
var attendeeSchema = z2.strictObject({
  email: z2.email().max(254),
  name: z2.string().min(1).max(200).optional()
});
var titleSchema = z2.string().min(1).max(256);
var descriptionSchema = z2.string().max(8192);
var locationSchema = z2.string().max(512);
var attendeesSchema = z2.array(attendeeSchema).max(MAX_EVENT_ATTENDEES2);
var eventSchema = z2.strictObject({
  title: titleSchema,
  start: instant,
  end: instant,
  description: descriptionSchema.optional(),
  location: locationSchema.optional(),
  attendees: attendeesSchema.optional(),
  conferencing: z2.enum(["video", "none"]).optional()
});
var changesSchema = z2.strictObject({
  title: titleSchema.optional(),
  start: instant.optional(),
  end: instant.optional(),
  description: descriptionSchema.optional(),
  location: locationSchema.optional(),
  attendees: attendeesSchema.optional()
}).refine((c) => Object.values(c).some((v) => v !== undefined));
var grantSchema = z2.discriminatedUnion("kind", [
  z2.strictObject({
    kind: z2.literal("authorization_code"),
    code: z2.string().min(1).max(4096),
    redirectUri: z2.url().max(2048),
    codeVerifier: z2.string().min(1).max(256).optional()
  }),
  z2.strictObject({ kind: z2.literal("refresh_token"), refreshToken: z2.string().min(1).max(4096) })
]);
function checkOrganizationId(value) {
  return organizationIdSchema2.safeParse(value).success ? value : invalid("organizationId");
}
function checkBase(request) {
  if (typeof request !== "object" || request === null) {
    return invalid("request");
  }
  checkOrganizationId(request.organizationId);
  if (!(request.connection instanceof CalendarConnection2)) {
    return invalid("connection");
  }
  if (request.connection.organizationId !== request.organizationId) {
    return invalid("connection");
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
    invalid("range");
  }
  return { fromMs, toMs };
}
function checkEventTimes(startMs, endMs) {
  if (!(startMs < endMs) || endMs - startMs > MAX_EVENT_DURATION_MS2) {
    invalid("event.times");
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

// src/consent/port.ts
import {
  contactCheckRequestSchema
} from "tula-closeline-contract";
var CONTACT_UNAVAILABLE2 = Object.freeze({
  allowed: false,
  checkId: null,
  code: "consent.unavailable",
  suppressionReason: null
});
function isContactGuardRequest2(request, caller) {
  return contactCheckRequestSchema.safeParse(withCaller2(request, caller)).success;
}
function withCaller2(request, caller) {
  return typeof request === "object" && request !== null ? { ...request, caller } : request;
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
function dropHighSurrogate2(text) {
  const last = text.charCodeAt(text.length - 1);
  return last >= 55296 && last <= 56319 ? text.slice(0, -1) : text;
}
function cutText2(text, max) {
  if (text.length <= max) {
    return text;
  }
  let end = max;
  while (end > 0 && isWordCode(text.charCodeAt(end - 1))) {
    end--;
  }
  return `${dropHighSurrogate2(text.slice(0, end))}${TRUNCATED}`;
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
var MAX_ERRORS = 200;
var FIELD_NODE_ALLOWANCE = 50;
var FIELD_VALUE_ALLOWANCE = 200;
var FIELD_ERROR_ALLOWANCE = 2;
var MAX_ENTRY_CHARS = 1048576;
var MAX_STRING_CHARS = 16384;
var MAX_KEY_CHARS = 256;
var FIELD_CHAR_ALLOWANCE = 1024;
var RESERVED_KEYS = ["level", "time", "msg", "service"];
function startField(state) {
  state.nodeReserve = FIELD_NODE_ALLOWANCE;
  state.valueReserve = FIELD_VALUE_ALLOWANCE;
  state.charReserve = FIELD_CHAR_ALLOWANCE;
  state.errorReserve = FIELD_ERROR_ALLOWANCE;
}
function grant(state, wanted) {
  const shared = Math.min(wanted, Math.max(0, MAX_ENTRY_CHARS - state.chars));
  state.chars += shared;
  const extra = Math.min(wanted - shared, state.charReserve);
  state.charReserve -= extra;
  return shared + extra;
}
function available(state) {
  return Math.max(0, MAX_ENTRY_CHARS - state.chars) + state.charReserve;
}
function clip(state, text) {
  const want = Math.min(text.length, MAX_STRING_CHARS);
  if (want === 0) {
    return text;
  }
  const got = grant(state, want);
  if (got >= text.length) {
    return text;
  }
  return got <= TRUNCATED2.length ? TRUNCATED2 : cutText2(text, got - TRUNCATED2.length);
}
function clipKey(state, key) {
  const shown = key.length > MAX_KEY_CHARS ? `${dropHighSurrogate2(key.slice(0, MAX_KEY_CHARS - TRUNCATED2.length))}${TRUNCATED2}` : key;
  return grant(state, shown.length) < shown.length ? undefined : shown;
}
function spend(state, depth) {
  if (depth === 0) {
    return true;
  }
  state.values++;
  if (state.values <= MAX_VALUES) {
    return true;
  }
  if (state.valueReserve > 0) {
    state.valueReserve--;
    return true;
  }
  return false;
}
function visit(state) {
  state.nodes++;
  if (state.nodes <= MAX_NODES) {
    return true;
  }
  if (state.nodeReserve > 0) {
    state.nodeReserve--;
    return true;
  }
  return false;
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
function scrubbedErrorText(state, read) {
  const value = attempt(read);
  if (typeof value !== "string" || value === UNSERIALIZABLE) {
    return value;
  }
  const room = Math.min(MAX_STRING_CHARS, available(state));
  if (room <= TRUNCATED2.length) {
    return TRUNCATED2;
  }
  return clip(state, scrubText2(cutText2(value, room - TRUNCATED2.length)));
}
function redactError(error, state, ancestors, depth) {
  const out = {};
  const field = (name, read) => {
    put(out, name, spend(state, depth + 1) ? read() : TRUNCATED2);
  };
  field("name", () => {
    const name = attempt(() => error.name);
    return typeof name === "string" ? clip(state, name) : name;
  });
  field("message", () => scrubbedErrorText(state, () => error.message));
  field("stack", () => scrubbedErrorText(state, () => error.stack));
  const code = attempt(() => error.code);
  if (code !== undefined) {
    field("code", () => redactValue(code, state, ancestors, depth + 1));
  }
  const cause = attempt(() => error.cause);
  if (cause !== undefined) {
    field("cause", () => redactValue(cause, state, ancestors, depth + 1));
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
    const shown = clipKey(state, name);
    if (shown === undefined) {
      put(out, "[more]", `[+${map.size - index} more]`);
      return out;
    }
    const hidden = isSensitiveKey(name) && !(mayBeTokenCount(name) && typeof value === "number");
    put(out, shown, hidden ? REDACTED : redactValue(value, state, ancestors, depth + 1));
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
  let dropped = 0;
  for (const [position, key] of kept.entries()) {
    if (depth === 0) {
      startField(state);
    }
    if (!spend(state, depth)) {
      spent = true;
      break;
    }
    const sensitive = isSensitiveKey(key);
    const name = clipKey(state, key);
    if (name === undefined) {
      dropped = keys.length - position;
      break;
    }
    if (sensitive && !mayBeTokenCount(key)) {
      put(out, name, REDACTED);
      continue;
    }
    const value = attempt(() => record[key]);
    if (sensitive && typeof value !== "number") {
      put(out, name, REDACTED);
      continue;
    }
    if (typeof value === "object" && value !== null) {
      put(out, name, undefined);
      nested.push([name, value]);
    } else {
      put(out, name, typeof value === "string" ? clip(state, value) : value);
    }
  }
  for (const [key, value] of nested) {
    if (depth === 0) {
      startField(state);
    }
    put(out, key, redactValue(value, state, ancestors, depth + 1));
  }
  if (dropped > 0) {
    put(out, "[more]", `[+${dropped} more]`);
  } else if (spent) {
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
    if (state.errors >= MAX_ERRORS) {
      if (state.errorReserve <= 0) {
        return TRUNCATED2;
      }
      state.errorReserve--;
    }
    state.errors++;
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
  if (typeof value === "string") {
    return clip(state, value);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (ancestors.has(value)) {
    return CIRCULAR;
  }
  if (!visit(state) || depth >= MAX_DEPTH) {
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
    return redactRecord(fields, {
      nodes: 0,
      values: 0,
      nodeReserve: 0,
      valueReserve: 0,
      chars: 0,
      charReserve: 0,
      errors: 0,
      errorReserve: 0
    }, new Set([fields]), 0);
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

// src/twilio-signature.ts
import { createHmac, timingSafeEqual } from "node:crypto";
function signTwilioRequest2(authToken, url, params = {}) {
  const pairs = Array.isArray(params) ? [...params] : Object.entries(params);
  const text = pairs.sort(([a, av], [b, bv]) => a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0).reduce((acc, [name, value]) => acc + name + value, url);
  return createHmac("sha1", authToken).update(text, "utf8").digest("base64");
}
function twilioUrlVariants(url) {
  const variants = [url];
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      return variants;
    }
    const standard = parsed.protocol === "https:" ? "443" : parsed.protocol === "http:" ? "80" : "";
    if (standard === "" || parsed.port !== "" && parsed.port !== standard) {
      return variants;
    }
    const rest = `${parsed.pathname}${parsed.search}`;
    const bare = `${parsed.protocol}//${parsed.hostname}${rest}`;
    const withPort = `${parsed.protocol}//${parsed.hostname}:${standard}${rest}`;
    for (const variant of [bare, withPort]) {
      if (!variants.includes(variant)) {
        variants.push(variant);
      }
    }
  } catch {}
  return variants;
}
function sameText(a, b) {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
function verifyTwilioFormSignature(authToken, url, fields, signature) {
  let matched = false;
  for (const variant of twilioUrlVariants(url)) {
    matched = sameText(signTwilioRequest2(authToken, variant, fields), signature) || matched;
  }
  return matched;
}

// src/telephony/errors.ts
var TELEPHONY_ERROR_CODES2 = {
  invalidRequest: "telephony.invalid_request",
  notFound: "telephony.not_found",
  callEnded: "telephony.call_ended",
  disclosureRequired: "telephony.disclosure_required",
  recordingNotReady: "telephony.recording_not_ready",
  rejected: "telephony.rejected",
  unavailable: "telephony.unavailable",
  badResponse: "telephony.bad_response"
};
var STATUS = {
  "telephony.invalid_request": 400,
  "telephony.not_found": 404,
  "telephony.call_ended": 409,
  "telephony.disclosure_required": 409,
  "telephony.recording_not_ready": 409,
  "telephony.rejected": 502,
  "telephony.unavailable": 503,
  "telephony.bad_response": 502
};

class TelephonyError2 extends AppError2 {
  constructor(code, message, options = {}) {
    super({
      code,
      status: STATUS[code],
      message,
      ...options.cause === undefined ? {} : { cause: options.cause },
      ...options.details === undefined ? {} : { details: options.details }
    });
    this.name = "TelephonyError";
  }
}

// src/telephony/validate.ts
import {
  callIdSchema,
  e164PhoneSchema,
  membershipIdSchema,
  organizationIdSchema as organizationIdSchema3
} from "tula-closeline-contract";
var PROVIDER_ID = /^[A-Za-z0-9._:-]{1,128}$/;
var CONTROL = /[\u0000-\u001f\u007f]/;
function invalid2(what) {
  throw new TelephonyError2(TELEPHONY_ERROR_CODES2.invalidRequest, `${what} is not acceptable`);
}
function checkOrganizationId2(value) {
  return organizationIdSchema3.safeParse(value).success ? value : invalid2("organizationId");
}
function checkCallId(value) {
  return callIdSchema.safeParse(value).success ? value : invalid2("callId");
}
function checkIdentity(value) {
  return membershipIdSchema.safeParse(value).success ? value : invalid2("identity");
}
function checkNumber(value, what) {
  return e164PhoneSchema.safeParse(value).success ? value : invalid2(what);
}
function checkProviderId(value, what) {
  return typeof value === "string" && PROVIDER_ID.test(value) ? value : invalid2(what);
}
function checkDisclosure(version, text, aiAssisted) {
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    invalid2("wordingVersion");
  }
  if (typeof text !== "string" || text.trim().length === 0 || text.length > MAX_DISCLOSURE_TEXT_LENGTH2 || CONTROL.test(text)) {
    invalid2("text");
  }
  if (typeof aiAssisted !== "boolean") {
    invalid2("aiAssisted");
  }
}
function checkRingIdentities(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_RING_LEGS2) {
    invalid2("ringIdentities");
  }
  const identities = value.map(checkIdentity);
  return [...new Set(identities)];
}
function checkDestinationUrl(value, allowPlain) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    invalid2("destinationUrl");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return invalid2("destinationUrl");
  }
  const secure = url.protocol === "wss:";
  if (!(secure || allowPlain && url.protocol === "ws:") || url.username || url.password) {
    invalid2("destinationUrl");
  }
  return value;
}
function resolveTimeout(options, fallback) {
  const value = options?.timeoutMs ?? fallback;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TELEPHONY_TIMEOUT_MS2) {
    invalid2("timeoutMs");
  }
  return value;
}
function requireDisclosure(played, needsAi = false) {
  if (!played) {
    throw new TelephonyError2(TELEPHONY_ERROR_CODES2.disclosureRequired, "The Disclosure has not played on this call");
  }
  if (needsAi && !played.aiAssisted) {
    throw new TelephonyError2(TELEPHONY_ERROR_CODES2.disclosureRequired, "The Disclosure did not say an AI takes part");
  }
  return played;
}

// src/messaging/consent.ts
var DENIAL_CODES = [
  "consent.missing",
  "consent.withdrawn",
  "consent.suppressed",
  "consent.unavailable"
];
function denied(code) {
  return new MessagingError2(MESSAGING_ERROR_CODES2.consentDenied, "The Contact Check did not allow this message", {
    details: { code: DENIAL_CODES.includes(code) ? code : "consent.unavailable" }
  });
}
async function requireConsent(guard, request, deadline) {
  let result;
  try {
    result = await raceAbort(Promise.resolve().then(() => guard.check({
      organizationId: request.organizationId,
      prospectId: request.prospectId,
      phone: request.to,
      channel: request.channel,
      purpose: request.purpose
    })), deadline.signal);
  } catch (error) {
    if (error instanceof AttemptAborted) {
      deadline.check();
    }
    throw denied("consent.unavailable");
  }
  if (typeof result !== "object" || result === null || result.allowed !== true) {
    throw denied(typeof result === "object" && result !== null && "code" in result ? String(result.code) : "consent.unavailable");
  }
  if (typeof result.checkId !== "string") {
    throw denied("consent.unavailable");
  }
  return { consentCheckId: result.checkId };
}

// src/messaging/validate.ts
import { e164PhoneSchema as e164PhoneSchema2, organizationIdSchema as organizationIdSchema4, prospectIdSchema as prospectIdSchema2 } from "tula-closeline-contract";
var KEY = /^[A-Za-z0-9_.:-]{1,200}$/;
var TEMPLATE_ID = /^HX[0-9a-fA-F]{32}$/;
var VARIABLE_NAME = /^[A-Za-z0-9_]{1,64}$/;
var REQUEST_KEYS = new Set([
  "organizationId",
  "prospectId",
  "channel",
  "purpose",
  "to",
  "content",
  "idempotencyKey",
  "timeoutMs",
  "retry",
  "signal"
]);
function invalid3(what) {
  throw new MessagingError2(MESSAGING_ERROR_CODES2.invalidRequest, `${what} is not acceptable`, {
    details: { field: what }
  });
}
function integerIn2(value, min, max) {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function resolveMessagingRetryPolicy(policy) {
  if (policy !== undefined && !isRecord(policy)) {
    invalid3("retry");
  }
  const maxRetries = policy?.maxRetries ?? DEFAULT_MESSAGING_RETRY_POLICY2.maxRetries;
  const baseDelayMs = policy?.baseDelayMs ?? DEFAULT_MESSAGING_RETRY_POLICY2.baseDelayMs;
  const maxDelayMs = policy?.maxDelayMs ?? DEFAULT_MESSAGING_RETRY_POLICY2.maxDelayMs;
  if (!integerIn2(maxRetries, 0, 5)) {
    invalid3("retry.maxRetries");
  }
  if (!integerIn2(baseDelayMs, 1, 60000)) {
    invalid3("retry.baseDelayMs");
  }
  if (!integerIn2(maxDelayMs, baseDelayMs, 60000)) {
    invalid3("retry.maxDelayMs");
  }
  return { maxRetries, baseDelayMs, maxDelayMs };
}
function checkContent(value, channel) {
  if (!isRecord(value)) {
    return invalid3("content");
  }
  const extra = (allowed) => Object.keys(value).some((k) => !allowed.includes(k));
  if (value.kind === "text") {
    if (extra(["kind", "body"])) {
      invalid3("content");
    }
    const body = value.body;
    if (typeof body !== "string" || body.length < 1 || body.length > MAX_MESSAGE_BODY_CHARS2) {
      invalid3("content.body");
    }
    if (body.trim().length === 0) {
      invalid3("content.body");
    }
    return { kind: "text", body };
  }
  if (value.kind === "template") {
    if (extra(["kind", "templateId", "variables"])) {
      invalid3("content");
    }
    if (channel !== "whatsapp") {
      invalid3("content.kind");
    }
    const templateId = value.templateId;
    if (typeof templateId !== "string" || !TEMPLATE_ID.test(templateId)) {
      invalid3("content.templateId");
    }
    if (value.variables === undefined) {
      return { kind: "template", templateId };
    }
    if (!isRecord(value.variables)) {
      return invalid3("content.variables");
    }
    const entries = Object.entries(value.variables);
    if (entries.length > MAX_TEMPLATE_VARIABLES2) {
      invalid3("content.variables");
    }
    const variables = {};
    for (const [name, text] of entries) {
      if (!VARIABLE_NAME.test(name) || typeof text !== "string" || text.length > MAX_TEMPLATE_VARIABLE_CHARS2) {
        invalid3("content.variables");
      }
      variables[name] = text;
    }
    return { kind: "template", templateId, variables };
  }
  return invalid3("content.kind");
}
function checkSendRequest(request) {
  if (!isRecord(request)) {
    return invalid3("request");
  }
  for (const key of Object.keys(request)) {
    if (!REQUEST_KEYS.has(key)) {
      invalid3("request");
    }
  }
  const organization = organizationIdSchema4.safeParse(request.organizationId);
  if (!organization.success) {
    return invalid3("organizationId");
  }
  const prospect = prospectIdSchema2.safeParse(request.prospectId);
  if (!prospect.success) {
    return invalid3("prospectId");
  }
  const channel = MESSAGING_CHANNELS2.find((c) => c === request.channel);
  if (channel === undefined) {
    return invalid3("channel");
  }
  const purpose = MESSAGING_PURPOSES2.find((p) => p === request.purpose);
  if (purpose === undefined) {
    return invalid3("purpose");
  }
  if (!e164PhoneSchema2.safeParse(request.to).success || typeof request.to !== "string") {
    return invalid3("to");
  }
  if (typeof request.idempotencyKey !== "string" || !KEY.test(request.idempotencyKey)) {
    return invalid3("idempotencyKey");
  }
  const timeoutMs = request.timeoutMs ?? DEFAULT_MESSAGING_TIMEOUT_MS2;
  if (!integerIn2(timeoutMs, 1, MAX_MESSAGING_TIMEOUT_MS2)) {
    return invalid3("timeoutMs");
  }
  if (request.signal !== undefined && !(request.signal instanceof AbortSignal)) {
    return invalid3("signal");
  }
  return {
    organizationId: organization.data,
    prospectId: prospect.data,
    channel,
    purpose,
    to: request.to,
    content: checkContent(request.content, channel),
    idempotencyKey: request.idempotencyKey,
    timeoutMs,
    retry: resolveMessagingRetryPolicy(request.retry),
    signal: request.signal
  };
}

// src/messaging/webhook.ts
import { e164PhoneSchema as e164PhoneSchema3 } from "tula-closeline-contract";
var STOP = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
var START = new Set(["START", "UNSTOP", "YES"]);
var HELP = new Set(["HELP", "INFO"]);
var MESSAGE_SID = /^(SM|MM)[0-9a-fA-F]{32}$/;
var FORM = /^application\/x-www-form-urlencoded(\s*;.*)?$/i;
var MAX_INBOUND_BODY_CHARS = 4096;
var MAX_MEDIA = 10;
var STATUS2 = {
  queued: "queued",
  accepted: "queued",
  scheduled: "queued",
  sending: "queued",
  sent: "sent",
  delivered: "delivered",
  undelivered: "undelivered",
  failed: "failed",
  canceled: "failed",
  read: "read"
};
var NOT_LETTER = /[^\p{L}\p{N}]+/gu;
function classifyMessageIntent2(body) {
  const letters = body.replace(NOT_LETTER, "");
  const word = letters.toUpperCase();
  if (STOP.has(word)) {
    return "stop";
  }
  const ascii = /^[A-Za-z]+$/.test(letters);
  if (ascii && START.has(word)) {
    return "start";
  }
  if (ascii && HELP.has(word)) {
    return "help";
  }
  return "message";
}
function bad(reason) {
  throw new MessagingError2(MESSAGING_ERROR_CODES2.webhookInvalid, "The webhook is not valid", {
    details: { reason }
  });
}
function address(value) {
  if (value === undefined) {
    return bad("address");
  }
  const whatsapp = value.startsWith("whatsapp:");
  const number = whatsapp ? value.slice("whatsapp:".length) : value;
  if (!e164PhoneSchema3.safeParse(number).success) {
    return bad("address");
  }
  return { channel: whatsapp ? "whatsapp" : "sms", number };
}
function verifyAndParseWebhook(request, authToken, clock) {
  if (typeof request !== "object" || request === null) {
    return bad("request");
  }
  if (authToken === undefined || authToken === "") {
    return bad("unconfigured");
  }
  if (typeof request.body !== "string" || typeof request.url !== "string") {
    return bad("request");
  }
  if (Buffer.byteLength(request.body, "utf8") > MAX_MESSAGING_WEBHOOK_BYTES2) {
    return bad("body_too_large");
  }
  if (request.contentType !== undefined && request.contentType !== null && !FORM.test(request.contentType)) {
    return bad("content_type");
  }
  const signature = request.signature;
  if (typeof signature !== "string" || signature === "" || signature.length > 200) {
    return bad("signature");
  }
  const fields = [...new URLSearchParams(request.body)];
  if (!verifyTwilioFormSignature(authToken, request.url, fields, signature)) {
    return bad("signature");
  }
  const first = new Map;
  for (const [name, value] of fields) {
    if (!first.has(name)) {
      first.set(name, value);
    }
  }
  const sid = first.get("MessageSid") ?? first.get("SmsSid");
  if (sid === undefined || !MESSAGE_SID.test(sid)) {
    return bad("message_sid");
  }
  const body = first.get("Body");
  if (body !== undefined) {
    const from = address(first.get("From"));
    const to = address(first.get("To"));
    if (body.length > MAX_INBOUND_BODY_CHARS) {
      return bad("body");
    }
    const media = Number(first.get("NumMedia") ?? "0");
    if (!Number.isInteger(media) || media < 0 || media > MAX_MEDIA) {
      return bad("num_media");
    }
    return new InboundMessage2({
      channel: from.channel,
      from: from.number,
      to: to.number,
      providerMessageId: sid,
      body,
      receivedAt: clock.now().toISOString(),
      intent: classifyMessageIntent2(body),
      mediaCount: media
    });
  }
  const state = STATUS2[(first.get("MessageStatus") ?? first.get("SmsStatus") ?? "").toLowerCase()];
  if (state === undefined) {
    return bad("status");
  }
  const rawCode = first.get("ErrorCode");
  if (rawCode === undefined || rawCode === "") {
    return { kind: "status", providerMessageId: sid, status: state };
  }
  const errorCode = Number(rawCode);
  if (!Number.isInteger(errorCode) || errorCode < 0 || errorCode > 99999) {
    return bad("error_code");
  }
  return { kind: "status", providerMessageId: sid, status: state, errorCode };
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

// src/streaming-transcribe/errors.ts
var STREAMING_TRANSCRIBE_ERROR_CODES2 = {
  invalidRequest: "streaming_transcribe.invalid_request",
  conflict: "streaming_transcribe.conflict",
  closed: "streaming_transcribe.closed",
  rejected: "streaming_transcribe.rejected",
  unavailable: "streaming_transcribe.unavailable",
  badResponse: "streaming_transcribe.bad_response"
};
var STATUS3 = {
  "streaming_transcribe.invalid_request": 400,
  "streaming_transcribe.conflict": 409,
  "streaming_transcribe.closed": 409,
  "streaming_transcribe.rejected": 502,
  "streaming_transcribe.unavailable": 503,
  "streaming_transcribe.bad_response": 502
};

class StreamingTranscribeError2 extends AppError2 {
  constructor(code, message, options = {}) {
    super({
      code,
      status: STATUS3[code],
      message,
      ...options.cause === undefined ? {} : { cause: options.cause },
      ...options.details === undefined ? {} : { details: options.details }
    });
    this.name = "StreamingTranscribeError";
  }
}

// src/streaming-transcribe/port.ts
var DEFAULT_STREAMING_TRANSCRIBE_TIMEOUT_MS2 = 1e4;
var MAX_STREAMING_TRANSCRIBE_TIMEOUT_MS2 = 60000;
var MAX_AUDIO_CHUNK_BYTES2 = 65536;
var MAX_REPLAY_AUDIO_BYTES2 = 524288;
var MAX_WORDS_PER_TURN2 = 2000;
var DEFAULT_RECONNECT_POLICY2 = {
  maxAttempts: 5,
  baseDelayMs: 250,
  maxDelayMs: 5000
};
function reconnectDelayMs2(attempt, policy, random = Math.random) {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.max(1, Math.floor(exponential * (0.5 + random())));
}

// src/streaming-transcribe/validate.ts
import { callIdSchema as callIdSchema2, organizationIdSchema as organizationIdSchema5 } from "tula-closeline-contract";
var LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
var SAMPLE_RATES = [8000, 16000, 24000, 48000];
var ENCODINGS = ["pcm_s16le", "pcm_mulaw"];
var TRACKS = ["rep", "prospect"];
function invalid4(what) {
  throw new StreamingTranscribeError2(STREAMING_TRANSCRIBE_ERROR_CODES2.invalidRequest, `${what} is not acceptable`);
}
function integerIn3(value, min, max) {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}
function checkOpenRequest(request) {
  if (typeof request !== "object" || request === null) {
    return invalid4("request");
  }
  if (!organizationIdSchema5.safeParse(request.organizationId).success) {
    invalid4("organizationId");
  }
  if (!callIdSchema2.safeParse(request.callId).success) {
    invalid4("callId");
  }
  if (!TRACKS.includes(request.track)) {
    invalid4("track");
  }
  if (!ENCODINGS.includes(request.encoding)) {
    invalid4("encoding");
  }
  if (!SAMPLE_RATES.includes(request.sampleRate)) {
    invalid4("sampleRate");
  }
  if (request.language !== undefined && !(typeof request.language === "string" && LANGUAGE.test(request.language))) {
    invalid4("language");
  }
  if (typeof request.onEvent !== "function") {
    invalid4("onEvent");
  }
  return resolveReconnectPolicy(request.reconnect);
}
function resolveReconnectPolicy(policy) {
  const maxAttempts = policy?.maxAttempts ?? DEFAULT_RECONNECT_POLICY2.maxAttempts;
  const baseDelayMs = policy?.baseDelayMs ?? DEFAULT_RECONNECT_POLICY2.baseDelayMs;
  const maxDelayMs = policy?.maxDelayMs ?? DEFAULT_RECONNECT_POLICY2.maxDelayMs;
  if (!integerIn3(maxAttempts, 0, 10)) {
    invalid4("reconnect.maxAttempts");
  }
  if (!integerIn3(baseDelayMs, 1, 60000)) {
    invalid4("reconnect.baseDelayMs");
  }
  if (!integerIn3(maxDelayMs, baseDelayMs, 60000)) {
    invalid4("reconnect.maxDelayMs");
  }
  return { maxAttempts, baseDelayMs, maxDelayMs };
}
function resolveTimeout2(options) {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_STREAMING_TRANSCRIBE_TIMEOUT_MS2;
  return integerIn3(timeoutMs, 1, MAX_STREAMING_TRANSCRIBE_TIMEOUT_MS2) ? timeoutMs : invalid4("timeoutMs");
}
function checkChunk(chunk) {
  if (!(chunk instanceof Uint8Array) || chunk.length < 1 || chunk.length > MAX_AUDIO_CHUNK_BYTES2) {
    return invalid4("chunk");
  }
  return chunk;
}

// src/tts/audio.ts
var INSPECT = Symbol.for("nodejs.util.inspect.custom");

class TtsAudioChunk2 {
  sequence;
  byteLength;
  #audio;
  constructor(sequence, audio) {
    this.sequence = sequence;
    this.byteLength = audio.byteLength;
    this.#audio = audio;
  }
  get audio() {
    return this.#audio;
  }
  toJSON() {
    return { sequence: this.sequence, byteLength: this.byteLength };
  }
  toString() {
    return `TtsAudioChunk(#${this.sequence}, ${this.byteLength} bytes)`;
  }
  [INSPECT]() {
    return this.toString();
  }
}

// src/tts/port.ts
var DEFAULT_TTS_TIMEOUT_MS2 = 30000;
var MAX_TTS_TIMEOUT_MS2 = 120000;
var DEFAULT_TTS_FIRST_CHUNK_TIMEOUT_MS2 = 2000;
var MAX_TTS_FIRST_CHUNK_TIMEOUT_MS2 = 30000;
var DEFAULT_TTS_MAX_TEXT_CHARS2 = 5000;
var MAX_TTS_MAX_TEXT_CHARS2 = 20000;
var MAX_TTS_AUDIO_CHUNK_BYTES2 = 65536;
var DEFAULT_TTS_RETRY_POLICY2 = {
  maxRetries: 1,
  baseDelayMs: 50,
  maxDelayMs: 250
};
function ttsRetryDelayMs2(retry, policy, random = Math.random) {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (retry - 1));
  return Math.max(1, Math.floor(exponential * (0.5 + random())));
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
import { organizationIdSchema as organizationIdSchema6 } from "tula-closeline-contract";
var VOICE = /^[A-Za-z0-9_.:-]{1,128}$/;
var ENCODINGS2 = ["pcm_s16le", "pcm_mulaw"];
var SAMPLE_RATES2 = [8000, 16000, 24000, 48000];
function invalid5(what) {
  throw new TtsError2(TTS_ERROR_CODES2.invalidRequest, `${what} is not acceptable`);
}
function integerIn4(value, min, max) {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}
function resolveTtsRetryPolicy(policy) {
  if (policy !== undefined && (typeof policy !== "object" || policy === null)) {
    invalid5("retry");
  }
  const maxRetries = policy?.maxRetries ?? DEFAULT_TTS_RETRY_POLICY2.maxRetries;
  const baseDelayMs = policy?.baseDelayMs ?? DEFAULT_TTS_RETRY_POLICY2.baseDelayMs;
  const maxDelayMs = policy?.maxDelayMs ?? DEFAULT_TTS_RETRY_POLICY2.maxDelayMs;
  if (!integerIn4(maxRetries, 0, 5)) {
    invalid5("retry.maxRetries");
  }
  if (!integerIn4(baseDelayMs, 1, 60000)) {
    invalid5("retry.baseDelayMs");
  }
  if (!integerIn4(maxDelayMs, baseDelayMs, 60000)) {
    invalid5("retry.maxDelayMs");
  }
  return { maxRetries, baseDelayMs, maxDelayMs };
}
function checkOpenRequest2(request) {
  if (typeof request !== "object" || request === null) {
    return invalid5("request");
  }
  if (!organizationIdSchema6.safeParse(request.organizationId).success) {
    invalid5("organizationId");
  }
  if (typeof request.voice !== "string" || !VOICE.test(request.voice)) {
    invalid5("voice");
  }
  if (!ENCODINGS2.includes(request.encoding)) {
    invalid5("encoding");
  }
  if (!SAMPLE_RATES2.includes(request.sampleRate)) {
    invalid5("sampleRate");
  }
  const timeoutMs = request.timeoutMs ?? DEFAULT_TTS_TIMEOUT_MS2;
  if (!integerIn4(timeoutMs, 1, MAX_TTS_TIMEOUT_MS2)) {
    invalid5("timeoutMs");
  }
  const firstChunkTimeoutMs = request.firstChunkTimeoutMs ?? DEFAULT_TTS_FIRST_CHUNK_TIMEOUT_MS2;
  if (!integerIn4(firstChunkTimeoutMs, 1, MAX_TTS_FIRST_CHUNK_TIMEOUT_MS2)) {
    invalid5("firstChunkTimeoutMs");
  }
  const maxTextChars = request.maxTextChars ?? DEFAULT_TTS_MAX_TEXT_CHARS2;
  if (!integerIn4(maxTextChars, 1, MAX_TTS_MAX_TEXT_CHARS2)) {
    invalid5("maxTextChars");
  }
  if (request.signal !== undefined && !(request.signal instanceof AbortSignal)) {
    invalid5("signal");
  }
  return {
    timeoutMs,
    firstChunkTimeoutMs,
    maxTextChars,
    retry: resolveTtsRetryPolicy(request.retry)
  };
}

// src/vector/errors.ts
var VECTOR_ERROR_CODES2 = {
  invalidRequest: "vector.invalid_request",
  dimensionMismatch: "vector.dimension_mismatch",
  rejected: "vector.rejected",
  unavailable: "vector.unavailable",
  badResponse: "vector.bad_response"
};
var STATUS4 = {
  "vector.invalid_request": 400,
  "vector.dimension_mismatch": 422,
  "vector.rejected": 500,
  "vector.unavailable": 503,
  "vector.bad_response": 502
};

class VectorError2 extends AppError2 {
  constructor(code, message, options = {}) {
    super({
      code,
      status: STATUS4[code],
      message,
      ...options.cause === undefined ? {} : { cause: options.cause },
      ...options.details === undefined ? {} : { details: options.details }
    });
    this.name = "VectorError";
  }
}

// src/vector/port.ts
var MAX_UPSERT_BATCH2 = 500;
var MAX_DELETE_BATCH2 = 500;
var MAX_VECTOR_ID_LENGTH2 = 64;
var MAX_TOP_K2 = 100;
var MAX_DIMENSIONS2 = 4096;
var MAX_ATTRIBUTES2 = 16;
var MAX_ATTRIBUTE_STRING2 = 512;

export { AUDIT_LIMITS2, AUDIT_DENIED_METADATA_KEYS2, auditMetadataSchema2, auditActorSchema2, auditSubjectSchema2, auditEventPayloadSchema2, auditEntrySchema2, parseAuditEntry2, startMessagingDeadline, AttemptAborted, raceAbort, withMessagingRetry, startCalendarDeadline, withCalendarRetry, invalid, checkOptions, checkOrganizationId, checkBase, checkGrant, checkRequestId, checkEventId, checkRange, checkEventTimes, checkEvent, checkChanges, CONTACT_UNAVAILABLE2, isContactGuardRequest2, withCaller2, isSensitiveKey, dropHighSurrogate2, cutText2, scrubText2, redactFields, prepareFields, signTwilioRequest2, twilioUrlVariants, sameText, TELEPHONY_ERROR_CODES2, TelephonyError2, invalid2, checkOrganizationId2, checkCallId, checkIdentity, checkNumber, checkProviderId, checkDisclosure, checkRingIdentities, checkDestinationUrl, resolveTimeout, requireDisclosure, requireConsent, invalid3, checkSendRequest, classifyMessageIntent2, verifyAndParseWebhook, shouldReportError2, STREAMING_TRANSCRIBE_ERROR_CODES2, StreamingTranscribeError2, DEFAULT_STREAMING_TRANSCRIBE_TIMEOUT_MS2, MAX_STREAMING_TRANSCRIBE_TIMEOUT_MS2, MAX_AUDIO_CHUNK_BYTES2, MAX_REPLAY_AUDIO_BYTES2, MAX_WORDS_PER_TURN2, DEFAULT_RECONNECT_POLICY2, reconnectDelayMs2, invalid4, checkOpenRequest, resolveTimeout2, checkChunk, TtsAudioChunk2, DEFAULT_TTS_TIMEOUT_MS2, MAX_TTS_TIMEOUT_MS2, DEFAULT_TTS_FIRST_CHUNK_TIMEOUT_MS2, MAX_TTS_FIRST_CHUNK_TIMEOUT_MS2, DEFAULT_TTS_MAX_TEXT_CHARS2, MAX_TTS_MAX_TEXT_CHARS2, MAX_TTS_AUDIO_CHUNK_BYTES2, DEFAULT_TTS_RETRY_POLICY2, ttsRetryDelayMs2, startTtsDeadline, watchFirstChunk, withTtsRetry, invalid5, checkOpenRequest2, VECTOR_ERROR_CODES2, VectorError2, MAX_UPSERT_BATCH2, MAX_DELETE_BATCH2, MAX_VECTOR_ID_LENGTH2, MAX_TOP_K2, MAX_DIMENSIONS2, MAX_ATTRIBUTES2, MAX_ATTRIBUTE_STRING2 };
