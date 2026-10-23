import {
  AppError2
} from "./chunk-tya44yhr.js";

// src/audit/errors.ts
var AUDIT_ERROR_CODES2 = {
  invalidEntry: "audit.invalid_entry",
  entryTooLarge: "audit.entry_too_large",
  unavailable: "audit.unavailable"
};
var STATUS = {
  "audit.invalid_entry": 422,
  "audit.entry_too_large": 413,
  "audit.unavailable": 503
};

class AuditError2 extends AppError2 {
  constructor(code, message, options = {}) {
    super({
      code,
      status: STATUS[code],
      message,
      ...options.cause === undefined ? {} : { cause: options.cause },
      ...options.details === undefined ? {} : { details: options.details }
    });
    this.name = "AuditError";
  }
}

// src/calendar/connection.ts
var INSPECT = Symbol.for("nodejs.util.inspect.custom");

class CalendarConnection2 {
  organizationId;
  provider;
  connectionId;
  #credential;
  constructor(init) {
    if (typeof init.provider !== "string" || init.provider.length < 1 || init.provider.length > 64 || typeof init.connectionId !== "string" || init.connectionId.length < 1 || init.connectionId.length > 256 || typeof init.credential !== "string" || init.credential.length < 1) {
      throw new TypeError("CalendarConnection needs a provider, a connection id and a credential");
    }
    this.organizationId = init.organizationId;
    this.provider = init.provider;
    this.connectionId = init.connectionId;
    this.#credential = init.credential;
  }
  unsafeCredential() {
    return this.#credential;
  }
  toJSON() {
    return {
      organizationId: this.organizationId,
      provider: this.provider,
      connectionId: this.connectionId
    };
  }
  toString() {
    return `CalendarConnection(${this.provider}:${this.connectionId})`;
  }
  [INSPECT]() {
    return this.toString();
  }
}

// src/calendar/errors.ts
var CALENDAR_ERROR_CODES2 = {
  invalidRequest: "calendar.invalid_request",
  revoked: "calendar.revoked",
  notFound: "calendar.not_found",
  rejected: "calendar.rejected",
  unavailable: "calendar.unavailable",
  timeout: "calendar.timeout",
  aborted: "calendar.aborted"
};
var STATUS2 = {
  "calendar.invalid_request": 400,
  "calendar.revoked": 403,
  "calendar.not_found": 404,
  "calendar.rejected": 502,
  "calendar.unavailable": 503,
  "calendar.timeout": 504,
  "calendar.aborted": 499
};

class CalendarError2 extends AppError2 {
  constructor(code, message, options = {}) {
    super({
      code,
      status: STATUS2[code],
      message,
      ...options.cause === undefined ? {} : { cause: options.cause },
      ...options.details === undefined ? {} : { details: options.details }
    });
    this.name = "CalendarError";
  }
}

// src/calendar/port.ts
var DEFAULT_CALENDAR_TIMEOUT_MS2 = 1e4;
var MAX_CALENDAR_TIMEOUT_MS2 = 60000;
var MAX_BUSY_RANGE_MS2 = 62 * 24 * 60 * 60 * 1000;
var MAX_BUSY_INTERVALS2 = 5000;
var MAX_EVENT_DURATION_MS2 = 7 * 24 * 60 * 60 * 1000;
var MAX_EVENT_ATTENDEES2 = 20;
var DEFAULT_CALENDAR_RETRY_POLICY2 = {
  maxRetries: 2,
  baseDelayMs: 200,
  maxDelayMs: 2000
};
function calendarRetryDelayMs2(retry, policy, random = Math.random) {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (retry - 1));
  return Math.max(1, Math.floor(exponential * (0.5 + random())));
}

// src/llm/errors.ts
var LLM_ERROR_CODES2 = {
  invalidRequest: "llm.invalid_request",
  inputTooLarge: "llm.input_too_large",
  invalidOutput: "llm.invalid_output",
  timeout: "llm.timeout",
  aborted: "llm.aborted",
  rejected: "llm.rejected",
  unavailable: "llm.unavailable",
  badResponse: "llm.bad_response"
};
var STATUS3 = {
  "llm.invalid_request": 400,
  "llm.input_too_large": 413,
  "llm.invalid_output": 502,
  "llm.timeout": 504,
  "llm.aborted": 499,
  "llm.rejected": 502,
  "llm.unavailable": 503,
  "llm.bad_response": 502
};

class LlmError2 extends AppError2 {
  constructor(code, message, options = {}) {
    super({
      code,
      status: STATUS3[code],
      message,
      ...options.cause === undefined ? {} : { cause: options.cause },
      ...options.details === undefined ? {} : { details: options.details }
    });
    this.name = "LlmError";
  }
}

// src/messaging/errors.ts
var MESSAGING_ERROR_CODES2 = {
  invalidRequest: "messaging.invalid_request",
  consentDenied: "messaging.consent_denied",
  recipientOptedOut: "messaging.recipient_opted_out",
  templateRequired: "messaging.template_required",
  timeout: "messaging.timeout",
  aborted: "messaging.aborted",
  rejected: "messaging.rejected",
  unavailable: "messaging.unavailable",
  badResponse: "messaging.bad_response",
  webhookInvalid: "messaging.webhook_invalid"
};
var STATUS4 = {
  "messaging.invalid_request": 400,
  "messaging.consent_denied": 403,
  "messaging.recipient_opted_out": 409,
  "messaging.template_required": 409,
  "messaging.timeout": 504,
  "messaging.aborted": 499,
  "messaging.rejected": 502,
  "messaging.unavailable": 503,
  "messaging.bad_response": 502,
  "messaging.webhook_invalid": 401
};

class MessagingError2 extends AppError2 {
  constructor(code, message, options = {}) {
    super({
      code,
      status: STATUS4[code],
      message,
      ...options.cause === undefined ? {} : { cause: options.cause },
      ...options.details === undefined ? {} : { details: options.details }
    });
    this.name = "MessagingError";
  }
}
function isReportableMessagingError2(error) {
  return error instanceof MessagingError2 && (error.code === MESSAGING_ERROR_CODES2.unavailable || error.code === MESSAGING_ERROR_CODES2.rejected || error.code === MESSAGING_ERROR_CODES2.badResponse);
}

// src/messaging/port.ts
var DEFAULT_MESSAGING_TIMEOUT_MS2 = 1e4;
var MAX_MESSAGING_TIMEOUT_MS2 = 60000;
var MAX_MESSAGE_BODY_CHARS2 = 1600;
var MAX_TEMPLATE_VARIABLES2 = 20;
var MAX_TEMPLATE_VARIABLE_CHARS2 = 1024;
var MAX_MESSAGING_WEBHOOK_BYTES2 = 262144;
var MESSAGING_CHANNELS2 = ["sms", "whatsapp"];
var MESSAGING_PURPOSES2 = ["agent_initiated", "reply"];
var DEFAULT_MESSAGING_RETRY_POLICY2 = {
  maxRetries: 2,
  baseDelayMs: 200,
  maxDelayMs: 2000
};
function messagingRetryDelayMs2(retry, policy, random = Math.random) {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (retry - 1));
  return Math.max(1, Math.floor(exponential * (0.5 + random())));
}
var INSPECT2 = Symbol.for("nodejs.util.inspect.custom");

class InboundMessage2 {
  kind = "message";
  channel;
  providerMessageId;
  receivedAt;
  intent;
  mediaCount;
  #from;
  #to;
  #body;
  constructor(fields) {
    this.channel = fields.channel;
    this.providerMessageId = fields.providerMessageId;
    this.receivedAt = fields.receivedAt;
    this.intent = fields.intent;
    this.mediaCount = fields.mediaCount;
    this.#from = fields.from;
    this.#to = fields.to;
    this.#body = fields.body;
  }
  get from() {
    return this.#from;
  }
  get to() {
    return this.#to;
  }
  get body() {
    return this.#body;
  }
  toJSON() {
    return {
      kind: this.kind,
      channel: this.channel,
      providerMessageId: this.providerMessageId,
      receivedAt: this.receivedAt,
      intent: this.intent,
      mediaCount: this.mediaCount,
      bodyChars: this.#body.length
    };
  }
  toString() {
    return `InboundMessage(${this.channel}, ${this.intent}, ${this.#body.length} chars)`;
  }
  [INSPECT2]() {
    return this.toString();
  }
}

// src/telephony/port.ts
var DEFAULT_TELEPHONY_TIMEOUT_MS2 = 1e4;
var MAX_TELEPHONY_TIMEOUT_MS2 = 60000;
var MAX_DISCLOSURE_TEXT_LENGTH2 = 1000;
var MAX_RING_LEGS2 = 50;
var MAX_WEBHOOK_BODY_BYTES2 = 262144;

// src/transcribe/errors.ts
var TRANSCRIBER_ERROR_CODES2 = {
  invalidRequest: "transcriber.invalid_request",
  conflict: "transcriber.conflict",
  rejected: "transcriber.rejected",
  unavailable: "transcriber.unavailable",
  badResponse: "transcriber.bad_response"
};
var STATUS5 = {
  "transcriber.invalid_request": 400,
  "transcriber.conflict": 409,
  "transcriber.rejected": 500,
  "transcriber.unavailable": 503,
  "transcriber.bad_response": 502
};

class TranscriberError2 extends AppError2 {
  constructor(code, message, options = {}) {
    super({
      code,
      status: STATUS5[code],
      message,
      ...options.cause === undefined ? {} : { cause: options.cause },
      ...options.details === undefined ? {} : { details: options.details }
    });
    this.name = "TranscriberError";
  }
}

// src/transcribe/port.ts
var MAX_CLIENT_REFERENCE_LENGTH2 = 128;
var MAX_AUDIO_URL_LENGTH2 = 4096;
var MAX_SPEAKERS2 = 10;
var DEFAULT_TRANSCRIBER_LIST_LIMIT2 = 100;
var MAX_TRANSCRIBER_LIST_LIMIT2 = 1000;
var MAX_TRANSCRIPT_TURNS2 = 50000;
var MAX_TURN_TEXT2 = 20000;
var MAX_VENDOR_ID_LENGTH2 = 128;

// src/transcribe/result.ts
var MAX_TRANSCRIPT_RESPONSE_BYTES2 = 8 * 1024 * 1024;
var MAX_AUDIO_MS2 = 12 * 60 * 60 * 1000;
var MAX_TRANSCRIPT_CHARS2 = 4000000;
var MAX_SPEAKER_LABEL2 = 64;
var MAX_CHANNELS2 = 8;
var TRANSCRIPTION_FAILURES2 = [
  "audio_unreachable",
  "audio_invalid",
  "no_speech",
  "too_long",
  "vendor_failed",
  "timed_out"
];
var bad = (message) => new TranscriberError2(TRANSCRIBER_ERROR_CODES2.badResponse, message);
var isMs = (value) => typeof value === "number" && Number.isInteger(value) && value >= 0;
function checkTranscriptionResult2(result, context) {
  if (typeof result !== "object" || result === null) {
    throw bad("a result must be an object");
  }
  const raw = result;
  if (raw.status === "pending") {
    return { status: "pending" };
  }
  if (raw.status === "failed") {
    if (!TRANSCRIPTION_FAILURES2.includes(raw.reason)) {
      throw bad("a failed result must give a listed reason");
    }
    return { status: "failed", reason: raw.reason };
  }
  if (raw.status !== "done") {
    throw bad("a result is pending, done or failed");
  }
  if (!isMs(raw.durationMs) || raw.durationMs > MAX_AUDIO_MS2) {
    throw bad("the duration must be whole milliseconds, at most 12 hours");
  }
  if (!Array.isArray(raw.turns) || raw.turns.length > MAX_TRANSCRIPT_TURNS2) {
    throw bad("the turns must be a list of at most 50000");
  }
  const cap = Math.min(context?.maxSpeakers ?? MAX_SPEAKERS2, MAX_SPEAKERS2);
  const speakers = new Set;
  let previousStart = 0;
  let characters = 0;
  const turns = raw.turns.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw bad("a turn must be an object");
    }
    const turn = item;
    if (typeof turn.speaker !== "string" || turn.speaker.length < 1 || turn.speaker.length > MAX_SPEAKER_LABEL2) {
      throw bad("a speaker label is 1 to 64 characters");
    }
    if (!isMs(turn.startMs) || !isMs(turn.endMs) || turn.endMs < turn.startMs) {
      throw bad("a turn needs whole-millisecond times with the end not before the start");
    }
    if (turn.endMs > raw.durationMs) {
      throw bad("a turn ends after the audio");
    }
    if (turn.startMs < previousStart) {
      throw bad("turns must be in time order");
    }
    previousStart = turn.startMs;
    if (typeof turn.text !== "string" || turn.text.length > MAX_TURN_TEXT2) {
      throw bad("the text of a turn is at most 20000 characters");
    }
    characters += turn.text.length;
    if (characters > MAX_TRANSCRIPT_CHARS2) {
      throw bad("the transcript is too long");
    }
    speakers.add(turn.speaker);
    if (speakers.size > cap) {
      throw bad("more speakers than allowed");
    }
    let channel;
    if (turn.channel !== undefined) {
      if (typeof turn.channel !== "number" || !Number.isInteger(turn.channel) || turn.channel < 0 || turn.channel >= MAX_CHANNELS2) {
        throw bad("a channel is a whole number from 0 to 7");
      }
      channel = turn.channel;
    }
    if (context?.speakers === "diarize" && channel !== undefined) {
      throw bad("a diarized result has no channels");
    }
    if (context?.speakers === "split_channels" && channel === undefined) {
      throw bad("a split-channels result names the channel of every turn");
    }
    return {
      speaker: turn.speaker,
      ...channel === undefined ? {} : { channel },
      startMs: turn.startMs,
      endMs: turn.endMs,
      text: turn.text
    };
  });
  return { status: "done", durationMs: raw.durationMs, turns };
}

// src/tts/errors.ts
var TTS_ERROR_CODES2 = {
  invalidRequest: "tts.invalid_request",
  textTooLarge: "tts.text_too_large",
  closed: "tts.closed",
  timeout: "tts.timeout",
  aborted: "tts.aborted",
  rejected: "tts.rejected",
  unavailable: "tts.unavailable",
  badResponse: "tts.bad_response"
};
var STATUS6 = {
  "tts.invalid_request": 400,
  "tts.text_too_large": 413,
  "tts.closed": 409,
  "tts.timeout": 504,
  "tts.aborted": 499,
  "tts.rejected": 502,
  "tts.unavailable": 503,
  "tts.bad_response": 502
};

class TtsError2 extends AppError2 {
  constructor(code, message, options = {}) {
    super({
      code,
      status: STATUS6[code],
      message,
      ...options.cause === undefined ? {} : { cause: options.cause },
      ...options.details === undefined ? {} : { details: options.details }
    });
    this.name = "TtsError";
  }
}

export { AUDIT_ERROR_CODES2, AuditError2, CalendarConnection2, CALENDAR_ERROR_CODES2, CalendarError2, DEFAULT_CALENDAR_TIMEOUT_MS2, MAX_CALENDAR_TIMEOUT_MS2, MAX_BUSY_RANGE_MS2, MAX_BUSY_INTERVALS2, MAX_EVENT_DURATION_MS2, MAX_EVENT_ATTENDEES2, DEFAULT_CALENDAR_RETRY_POLICY2, calendarRetryDelayMs2, LLM_ERROR_CODES2, LlmError2, MESSAGING_ERROR_CODES2, MessagingError2, isReportableMessagingError2, DEFAULT_MESSAGING_TIMEOUT_MS2, MAX_MESSAGING_TIMEOUT_MS2, MAX_MESSAGE_BODY_CHARS2, MAX_TEMPLATE_VARIABLES2, MAX_TEMPLATE_VARIABLE_CHARS2, MAX_MESSAGING_WEBHOOK_BYTES2, MESSAGING_CHANNELS2, MESSAGING_PURPOSES2, DEFAULT_MESSAGING_RETRY_POLICY2, messagingRetryDelayMs2, InboundMessage2, DEFAULT_TELEPHONY_TIMEOUT_MS2, MAX_TELEPHONY_TIMEOUT_MS2, MAX_DISCLOSURE_TEXT_LENGTH2, MAX_RING_LEGS2, MAX_WEBHOOK_BODY_BYTES2, TRANSCRIBER_ERROR_CODES2, TranscriberError2, MAX_CLIENT_REFERENCE_LENGTH2, MAX_AUDIO_URL_LENGTH2, MAX_SPEAKERS2, DEFAULT_TRANSCRIBER_LIST_LIMIT2, MAX_TRANSCRIBER_LIST_LIMIT2, MAX_TRANSCRIPT_TURNS2, MAX_TURN_TEXT2, MAX_VENDOR_ID_LENGTH2, MAX_TRANSCRIPT_RESPONSE_BYTES2, MAX_AUDIO_MS2, MAX_TRANSCRIPT_CHARS2, MAX_SPEAKER_LABEL2, MAX_CHANNELS2, TRANSCRIPTION_FAILURES2, checkTranscriptionResult2, TTS_ERROR_CODES2, TtsError2 };
