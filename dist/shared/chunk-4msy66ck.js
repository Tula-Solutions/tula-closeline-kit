import {
  AppError2
} from "./chunk-tya44yhr.js";

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
var STATUS = {
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
      status: STATUS[code],
      message,
      ...options.cause === undefined ? {} : { cause: options.cause },
      ...options.details === undefined ? {} : { details: options.details }
    });
    this.name = "LlmError";
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
var STATUS2 = {
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
      status: STATUS2[code],
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

export { LLM_ERROR_CODES2, LlmError2, DEFAULT_TELEPHONY_TIMEOUT_MS2, MAX_TELEPHONY_TIMEOUT_MS2, MAX_DISCLOSURE_TEXT_LENGTH2, MAX_RING_LEGS2, MAX_WEBHOOK_BODY_BYTES2, TRANSCRIBER_ERROR_CODES2, TranscriberError2, MAX_CLIENT_REFERENCE_LENGTH2, MAX_AUDIO_URL_LENGTH2, MAX_SPEAKERS2, DEFAULT_TRANSCRIBER_LIST_LIMIT2, MAX_TRANSCRIBER_LIST_LIMIT2, MAX_TRANSCRIPT_TURNS2, MAX_TURN_TEXT2, MAX_VENDOR_ID_LENGTH2, MAX_TRANSCRIPT_RESPONSE_BYTES2, MAX_AUDIO_MS2, MAX_TRANSCRIPT_CHARS2, MAX_SPEAKER_LABEL2, MAX_CHANNELS2, TRANSCRIPTION_FAILURES2, checkTranscriptionResult2 };
