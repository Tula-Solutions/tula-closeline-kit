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

export { LLM_ERROR_CODES2, LlmError2 };
