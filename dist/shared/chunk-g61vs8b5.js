// src/llm/port.ts
var DEFAULT_LLM_TIMEOUT_MS2 = 15000;
var MAX_LLM_TIMEOUT_MS2 = 120000;
var DEFAULT_LLM_MAX_INPUT_TOKENS2 = 16000;
var MAX_LLM_MAX_INPUT_TOKENS2 = 200000;
var DEFAULT_LLM_MAX_OUTPUT_TOKENS2 = 1024;
var MAX_LLM_MAX_OUTPUT_TOKENS2 = 8192;
var MAX_LLM_MESSAGES2 = 100;
var MODEL_TIERS2 = ["fast", "smart"];
var ESTIMATED_CHARS_PER_TOKEN2 = 3;
function estimateTokens2(text) {
  return Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN2);
}
var DEFAULT_LLM_RETRY_POLICY2 = {
  maxRetries: 2,
  baseDelayMs: 200,
  maxDelayMs: 2000
};
function llmRetryDelayMs2(retry, policy, random = Math.random) {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (retry - 1));
  return Math.max(1, Math.floor(exponential * (0.5 + random())));
}

export { DEFAULT_LLM_TIMEOUT_MS2, MAX_LLM_TIMEOUT_MS2, DEFAULT_LLM_MAX_INPUT_TOKENS2, MAX_LLM_MAX_INPUT_TOKENS2, DEFAULT_LLM_MAX_OUTPUT_TOKENS2, MAX_LLM_MAX_OUTPUT_TOKENS2, MAX_LLM_MESSAGES2, MODEL_TIERS2, ESTIMATED_CHARS_PER_TOKEN2, estimateTokens2, DEFAULT_LLM_RETRY_POLICY2, llmRetryDelayMs2 };
