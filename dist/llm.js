import {
  reduceAwsCause,
  isTransientAwsFailure
} from "./shared/chunk-3xpsbhky.js";
import {
  startDeadline,
  withLlmRetry,
  invalid3,
  checkRequest,
  checkCompleteRequest,
  parseModelOutput
} from "./shared/chunk-rj1qezzq.js";
import {
  MODEL_TIERS2
} from "./shared/chunk-g61vs8b5.js";
import {
  systemSleep2
} from "./shared/chunk-hybwyj31.js";
import {
  LLM_ERROR_CODES2,
  LlmError2
} from "./shared/chunk-hk4f87am.js";

// src/llm/bedrock.ts
import {
  ConverseCommand,
  ConverseStreamCommand
} from "@aws-sdk/client-bedrock-runtime";

// src/llm/bedrock-client.ts
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
var REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;
var MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
var PROFILE_GEOGRAPHIES = new Set(["us", "eu", "apac", "global", "us-gov", "jp", "au", "ca"]);
var ENDPOINT_VARIABLES = ["AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_BEDROCK_RUNTIME"];
function geographyOf(region) {
  if (region.startsWith("us-gov-")) {
    return;
  }
  if (region.startsWith("us-")) {
    return "us";
  }
  if (region.startsWith("eu-")) {
    return "eu";
  }
  if (region.startsWith("ap-")) {
    return "apac";
  }
  return;
}
function assertRegion(region) {
  if (typeof region !== "string" || !REGION.test(region)) {
    throw new TypeError("region must be an AWS Region such as eu-west-1");
  }
}
function assertModelInRegion(tier, modelId, region) {
  if (typeof modelId !== "string" || !MODEL_ID.test(modelId)) {
    throw new TypeError(`models.${tier} is not a model id`);
  }
  const head = modelId.split(".")[0] ?? "";
  if (!modelId.includes(".") || !PROFILE_GEOGRAPHIES.has(head)) {
    return;
  }
  if (head !== geographyOf(region)) {
    throw new TypeError(`models.${tier} is an inference profile for "${head}", which does not match the Region ${region}`);
  }
}
function createBedrockClient(settings) {
  for (const name of ENDPOINT_VARIABLES) {
    if (process.env[name] !== undefined && process.env[name] !== "") {
      throw new TypeError(`${name} redirects the Bedrock client and is not accepted`);
    }
  }
  return new BedrockRuntimeClient({
    region: settings.region,
    maxAttempts: 1,
    retryMode: "standard",
    ignoreConfiguredEndpointUrls: true,
    requestHandler: {
      connectionTimeout: settings.connectTimeoutMs,
      requestTimeout: settings.connectTimeoutMs,
      throwOnRequestTimeout: true
    }
  });
}

// src/llm/bedrock.ts
var DEFAULT_BEDROCK_FAST_MODEL = "anthropic.claude-haiku-5-5";
var DEFAULT_BEDROCK_SMART_MODEL = "anthropic.claude-sonnet-5-5";
var DEFAULT_BEDROCK_CONNECT_TIMEOUT_MS = 5000;
var REQUEST_TIMEOUT_SLACK_MS = 500;
var UNAVAILABLE_NAMES = new Set([
  "ThrottlingException",
  "ServiceUnavailableException",
  "InternalServerException",
  "ModelTimeoutException",
  "ModelNotReadyException",
  "ModelStreamErrorException"
]);
function isWhole(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
function badResponse(what) {
  return new LlmError2(LLM_ERROR_CODES2.badResponse, `The model service sent ${what}`);
}
function usageOf(raw) {
  if (raw === undefined || !isWhole(raw.inputTokens) || !isWhole(raw.outputTokens)) {
    throw badResponse("no usable token counts");
  }
  return { inputTokens: raw.inputTokens, outputTokens: raw.outputTokens };
}
function truncated(maxOutputTokens) {
  return new LlmError2(LLM_ERROR_CODES2.invalidOutput, "The model answer was cut off by the output token budget", { details: { reason: "truncated", maxOutputTokens } });
}
function mapFailure(error, deadline) {
  if (error instanceof LlmError2) {
    return error;
  }
  if (deadline.signal.aborted) {
    try {
      deadline.check();
    } catch (checked) {
      return checked;
    }
  }
  const cause = reduceAwsCause(error);
  const unavailable = UNAVAILABLE_NAMES.has(cause.name) || isTransientAwsFailure(error);
  return unavailable ? new LlmError2(LLM_ERROR_CODES2.unavailable, "The model service is unavailable", { cause }) : new LlmError2(LLM_ERROR_CODES2.rejected, "The model service refused the call", { cause });
}
function toMessages(request) {
  const messages = request.messages.map((m) => ({
    role: m.role,
    content: [{ text: m.content }]
  }));
  return {
    messages,
    ...request.system === undefined ? {} : { system: [{ text: request.system }] }
  };
}
function createBedrockLlm(options) {
  assertRegion(options.region);
  const models = {
    fast: options.models?.fast ?? DEFAULT_BEDROCK_FAST_MODEL,
    smart: options.models?.smart ?? DEFAULT_BEDROCK_SMART_MODEL
  };
  for (const tier of MODEL_TIERS2) {
    assertModelInRegion(tier, models[tier], options.region);
  }
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_BEDROCK_CONNECT_TIMEOUT_MS;
  if (!Number.isInteger(connectTimeoutMs) || connectTimeoutMs < 1 || connectTimeoutMs > 60000) {
    throw new TypeError("connectTimeoutMs must be a whole number from 1 to 60000");
  }
  const client = options.client ?? createBedrockClient({ region: options.region, connectTimeoutMs });
  const sleep = options.sleep ?? systemSleep2;
  function report(error, organizationId, tier) {
    if (!(error instanceof LlmError2) || error.code !== LLM_ERROR_CODES2.unavailable && error.code !== LLM_ERROR_CODES2.rejected && error.code !== LLM_ERROR_CODES2.badResponse && error.code !== LLM_ERROR_CODES2.invalidOutput) {
      return;
    }
    try {
      options.reporter?.capture(error, { organizationId, tags: { feature: "llm", tier } });
    } catch {}
  }
  function retrying(tier, retry, deadline) {
    return {
      policy: retry,
      deadline,
      sleep,
      ...options.random === undefined ? {} : { random: options.random },
      onRetry: (n, delayMs) => options.logger?.warn("A model call is retrying", { tier, retry: n, delayMs })
    };
  }
  async function converse(input, timeoutMs, deadline) {
    try {
      return await client.send(new ConverseCommand(input), {
        abortSignal: deadline.signal,
        requestTimeout: timeoutMs + REQUEST_TIMEOUT_SLACK_MS
      });
    } catch (error) {
      throw mapFailure(error, deadline);
    }
  }
  async function nextEvent(iterator, deadline) {
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(new LlmError2(LLM_ERROR_CODES2.aborted, "The call was cancelled"));
      if (deadline.signal.aborted) {
        onAbort();
      } else {
        deadline.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    aborted.catch(() => {
      return;
    });
    try {
      return await Promise.race([iterator.next(), aborted]);
    } catch (error) {
      throw mapFailure(error, deadline);
    } finally {
      if (onAbort !== undefined) {
        deadline.signal.removeEventListener("abort", onAbort);
      }
    }
  }
  return {
    async complete(request) {
      const { checked, jsonSchema } = checkCompleteRequest(request);
      if (jsonSchema.type !== "object") {
        invalid3("schema");
      }
      const { $schema: _dropped, ...schemaBody } = jsonSchema;
      const input = {
        modelId: models[request.tier],
        ...toMessages(request),
        inferenceConfig: { maxTokens: checked.maxOutputTokens },
        toolConfig: {
          tools: [
            {
              toolSpec: {
                name: request.schemaName,
                description: "Return the answer.",
                inputSchema: { json: schemaBody }
              }
            }
          ],
          toolChoice: { tool: { name: request.schemaName } }
        }
      };
      const deadline = startDeadline(checked.timeoutMs, request.signal);
      try {
        const response = await withLlmRetry(() => converse(input, checked.timeoutMs, deadline), retrying(request.tier, checked.retry, deadline));
        const usage = usageOf(response.usage);
        if (response.stopReason === "max_tokens" || usage.outputTokens > checked.maxOutputTokens) {
          throw truncated(checked.maxOutputTokens);
        }
        if (response.stopReason === "content_filtered" || response.stopReason === "guardrail_intervened") {
          throw new LlmError2(LLM_ERROR_CODES2.rejected, "The model service withheld the answer", {
            details: { reason: response.stopReason }
          });
        }
        const block = response.output?.message?.content?.find((b) => b.toolUse !== undefined);
        if (block?.toolUse === undefined) {
          throw new LlmError2(LLM_ERROR_CODES2.invalidOutput, "The model did not answer in JSON", {
            details: { reason: "not_json" }
          });
        }
        const value = parseModelOutput(request.schema, JSON.stringify(block.toolUse.input ?? null));
        return { value, usage };
      } catch (error) {
        report(error, request.organizationId, request.tier);
        throw error;
      } finally {
        deadline.stop();
      }
    },
    stream(request) {
      const checked = checkRequest(request);
      const input = {
        modelId: models[request.tier],
        ...toMessages(request),
        inferenceConfig: { maxTokens: checked.maxOutputTokens }
      };
      async function* run() {
        const deadline = startDeadline(checked.timeoutMs, request.signal);
        try {
          const opened = await withLlmRetry(async () => {
            let response;
            try {
              response = await client.send(new ConverseStreamCommand(input), {
                abortSignal: deadline.signal,
                requestTimeout: checked.timeoutMs + REQUEST_TIMEOUT_SLACK_MS
              });
            } catch (error) {
              throw mapFailure(error, deadline);
            }
            if (response.stream === undefined) {
              throw badResponse("no stream");
            }
            const iterator = response.stream[Symbol.asyncIterator]();
            const buffered = [];
            for (;; ) {
              const next = await nextEvent(iterator, deadline);
              if (next.done) {
                return { iterator, buffered, ended: true };
              }
              buffered.push(next.value);
              if ((next.value.contentBlockDelta?.delta?.text ?? "").length > 0) {
                return { iterator, buffered, ended: false };
              }
            }
          }, retrying(request.tier, checked.retry, deadline));
          let stopReason;
          let usage;
          const handle = (event) => {
            if (event.messageStop?.stopReason !== undefined) {
              stopReason = event.messageStop.stopReason;
            }
            if (event.metadata?.usage !== undefined) {
              usage = usageOf(event.metadata.usage);
            }
            return event.contentBlockDelta?.delta?.text ?? "";
          };
          for (const event of opened.buffered) {
            const text = handle(event);
            if (text.length > 0) {
              yield { type: "text", text };
            }
          }
          let ended = opened.ended;
          while (!ended) {
            const next = await nextEvent(opened.iterator, deadline);
            deadline.check();
            if (next.done) {
              ended = true;
              break;
            }
            const text = handle(next.value);
            if (text.length > 0) {
              yield { type: "text", text };
            }
          }
          deadline.check();
          if (usage === undefined) {
            throw badResponse("no token counts");
          }
          if (stopReason === "content_filtered" || stopReason === "guardrail_intervened") {
            throw new LlmError2(LLM_ERROR_CODES2.rejected, "The model service withheld the answer", {
              details: { reason: stopReason }
            });
          }
          if (stopReason === "max_tokens") {
            yield { type: "done", stopReason: "max_tokens", usage };
          } else if (stopReason === "end_turn" || stopReason === "stop_sequence") {
            yield { type: "done", stopReason: "end", usage };
          } else {
            throw badResponse("an unexpected stop reason");
          }
        } catch (error) {
          const mapped = mapFailure(error, deadline);
          report(mapped, request.organizationId, request.tier);
          throw mapped;
        } finally {
          deadline.cancel();
          deadline.stop();
        }
      }
      return run();
    }
  };
}
export {
  DEFAULT_BEDROCK_CONNECT_TIMEOUT_MS,
  DEFAULT_BEDROCK_FAST_MODEL,
  DEFAULT_BEDROCK_SMART_MODEL,
  createBedrockLlm
};
