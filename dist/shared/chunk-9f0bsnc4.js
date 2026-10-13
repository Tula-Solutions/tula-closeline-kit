import {
  QUEUE_ERROR_CODES2,
  QueueError2
} from "./chunk-vk3tcs4x.js";

// src/queue/port.ts
var MAX_BATCH_SIZE2 = 10;
var MAX_WAIT_SECONDS2 = 20;
var MAX_VISIBILITY_SECONDS2 = 43200;
function assertReceiveOptions2(options) {
  const { maxMessages, visibilityTimeoutSeconds, waitSeconds } = options;
  if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > MAX_BATCH_SIZE2) {
    throw new QueueError2(QUEUE_ERROR_CODES2.invalidRequest, "maxMessages must be 1 to 10");
  }
  assertVisibility2(visibilityTimeoutSeconds);
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > MAX_WAIT_SECONDS2) {
    throw new QueueError2(QUEUE_ERROR_CODES2.invalidRequest, "waitSeconds must be 0 to 20");
  }
}
function assertVisibility2(seconds) {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_VISIBILITY_SECONDS2) {
    throw new QueueError2(QUEUE_ERROR_CODES2.invalidRequest, "visibility timeout must be 0 to 43200 whole seconds");
  }
}
function assertBatchCount2(count) {
  if (count < 1 || count > MAX_BATCH_SIZE2) {
    throw new QueueError2(QUEUE_ERROR_CODES2.batchTooLarge, "a batch holds 1 to 10 messages", {
      details: { count }
    });
  }
}

// src/queue/sleep.ts
var systemSleep2 = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) {
    resolve();
    return;
  }
  const done = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", done, { once: true });
});

export { MAX_BATCH_SIZE2, MAX_WAIT_SECONDS2, MAX_VISIBILITY_SECONDS2, assertReceiveOptions2, assertVisibility2, assertBatchCount2, systemSleep2 };
