import {
  DEFAULT_LLM_TIMEOUT_MS2,
  MAX_LLM_TIMEOUT_MS2,
  DEFAULT_LLM_MAX_INPUT_TOKENS2,
  MAX_LLM_MAX_INPUT_TOKENS2,
  DEFAULT_LLM_MAX_OUTPUT_TOKENS2,
  MAX_LLM_MAX_OUTPUT_TOKENS2,
  MAX_LLM_MESSAGES2,
  MODEL_TIERS2,
  estimateTokens2,
  DEFAULT_LLM_RETRY_POLICY2,
  llmRetryDelayMs2
} from "./chunk-g61vs8b5.js";
import {
  systemSleep2
} from "./chunk-hybwyj31.js";
import {
  LLM_ERROR_CODES2,
  LlmError2
} from "./chunk-hk4f87am.js";

// src/llm/deadline.ts
function startDeadline(timeoutMs, caller) {
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
        throw new LlmError2(LLM_ERROR_CODES2.timeout, "The call took too long", {
          details: { timeoutMs }
        });
      }
      if (controller.signal.aborted) {
        throw new LlmError2(LLM_ERROR_CODES2.aborted, "The call was cancelled");
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
function isRetryableLlmError(error) {
  return error instanceof LlmError2 && error.code === LLM_ERROR_CODES2.unavailable;
}
async function withLlmRetry(attempt, options) {
  const sleep = options.sleep ?? systemSleep2;
  for (let n = 1;; n++) {
    options.deadline.check();
    try {
      return await attempt(n);
    } catch (error) {
      options.deadline.check();
      if (!isRetryableLlmError(error) || n > options.policy.maxRetries) {
        throw error;
      }
      const delayMs = llmRetryDelayMs2(n, options.policy, options.random);
      options.onRetry?.(n, delayMs);
      await sleep(delayMs, options.deadline.signal);
    }
  }
}

// src/llm/validate.ts
import { organizationIdSchema } from "tula-closeline-contract";
import { z } from "zod";
var SCHEMA_NAME = /^[A-Za-z0-9_-]{1,64}$/;
function invalid4(what) {
  throw new LlmError2(LLM_ERROR_CODES2.invalidRequest, `${what} is not acceptable`);
}
function integerIn(value, min, max) {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}
function resolveRetryPolicy(policy) {
  const maxRetries = policy?.maxRetries ?? DEFAULT_LLM_RETRY_POLICY2.maxRetries;
  const baseDelayMs = policy?.baseDelayMs ?? DEFAULT_LLM_RETRY_POLICY2.baseDelayMs;
  const maxDelayMs = policy?.maxDelayMs ?? DEFAULT_LLM_RETRY_POLICY2.maxDelayMs;
  if (!integerIn(maxRetries, 0, 5)) {
    invalid4("retry.maxRetries");
  }
  if (!integerIn(baseDelayMs, 1, 60000)) {
    invalid4("retry.baseDelayMs");
  }
  if (!integerIn(maxDelayMs, baseDelayMs, 60000)) {
    invalid4("retry.maxDelayMs");
  }
  return { maxRetries, baseDelayMs, maxDelayMs };
}
function checkRequest(request) {
  if (typeof request !== "object" || request === null) {
    return invalid4("request");
  }
  if (!organizationIdSchema.safeParse(request.organizationId).success) {
    invalid4("organizationId");
  }
  if (!MODEL_TIERS2.includes(request.tier)) {
    invalid4("tier");
  }
  if (request.system !== undefined && typeof request.system !== "string") {
    invalid4("system");
  }
  const messages = request.messages;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_LLM_MESSAGES2) {
    invalid4("messages");
  }
  for (const message of messages) {
    const m = message;
    if (typeof m !== "object" || m === null || m.role !== "user" && m.role !== "assistant" || typeof m.content !== "string" || m.content.length < 1) {
      invalid4("messages");
    }
  }
  if (messages.at(-1)?.role !== "user") {
    invalid4("messages");
  }
  const timeoutMs = request.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS2;
  if (!integerIn(timeoutMs, 1, MAX_LLM_TIMEOUT_MS2)) {
    invalid4("timeoutMs");
  }
  const maxInputTokens = request.maxInputTokens ?? DEFAULT_LLM_MAX_INPUT_TOKENS2;
  if (!integerIn(maxInputTokens, 1, MAX_LLM_MAX_INPUT_TOKENS2)) {
    invalid4("maxInputTokens");
  }
  const maxOutputTokens = request.maxOutputTokens ?? DEFAULT_LLM_MAX_OUTPUT_TOKENS2;
  if (!integerIn(maxOutputTokens, 1, MAX_LLM_MAX_OUTPUT_TOKENS2)) {
    invalid4("maxOutputTokens");
  }
  if (request.signal !== undefined && !(request.signal instanceof AbortSignal)) {
    invalid4("signal");
  }
  const retry = resolveRetryPolicy(request.retry);
  const inputTokens = estimateTokens2(request.system ?? "") + messages.reduce((sum, m) => sum + estimateTokens2(m.content), 0);
  if (inputTokens > maxInputTokens) {
    throw new LlmError2(LLM_ERROR_CODES2.inputTooLarge, "The prompt is over the input token budget", {
      details: { maxInputTokens }
    });
  }
  return { timeoutMs, maxInputTokens, maxOutputTokens, retry, inputTokens };
}
function checkCompleteRequest(request) {
  const checked = checkRequest(request);
  if (!(request.schema instanceof z.ZodType)) {
    invalid4("schema");
  }
  if (typeof request.schemaName !== "string" || !SCHEMA_NAME.test(request.schemaName)) {
    invalid4("schemaName");
  }
  let jsonSchema;
  try {
    jsonSchema = z.toJSONSchema(request.schema, { io: "input" });
  } catch {
    return invalid4("schema");
  }
  return { checked, jsonSchema };
}
function parseModelOutput(schema, text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new LlmError2(LLM_ERROR_CODES2.invalidOutput, "The model did not answer in JSON", {
      details: { reason: "not_json" }
    });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new LlmError2(LLM_ERROR_CODES2.invalidOutput, "The model answer does not fit the schema", {
      details: { reason: "schema", issues: parsed.error.issues.length }
    });
  }
  return parsed.data;
}

export { startDeadline, withLlmRetry, invalid4, checkRequest, checkCompleteRequest, parseModelOutput };
