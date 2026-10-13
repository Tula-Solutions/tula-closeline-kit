import {
  QUEUE_ERROR_CODES2,
  QueueError2,
  MAX_MESSAGE_BYTES2
} from "./shared/chunk-pzmynk9n.js";
import {
  MAX_BATCH_SIZE2,
  MAX_WAIT_SECONDS2,
  MAX_VISIBILITY_SECONDS2,
  assertReceiveOptions2,
  assertVisibility2,
  assertBatchCount2,
  systemSleep2
} from "./shared/chunk-pkdp60t0.js";

// src/queue/aws.ts
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  SQSClient
} from "@aws-sdk/client-sqs";
var SQS_DEFAULT_TIMEOUT_MS = 5000;
var SQS_DEFAULT_MAX_ATTEMPTS = 3;
function bytesOf(body) {
  return new TextEncoder().encode(body).length;
}
function mapFailure(operation, error) {
  const fault = error;
  if (fault?.$fault === "client" && fault.$retryable === undefined) {
    return new QueueError2(QUEUE_ERROR_CODES2.rejected, `the queue refused ${operation}`, {
      cause: error
    });
  }
  return new QueueError2(QUEUE_ERROR_CODES2.unavailable, `the queue did not complete ${operation}`, {
    cause: error
  });
}
var STALE_RECEIPT_NAMES = new Set(["ReceiptHandleIsInvalid", "MessageNotInflight"]);
function isStaleReceipt(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  return STALE_RECEIPT_NAMES.has(error.name) || error.name === "InvalidParameterValue" && /receipt ?handle/i.test(error.message);
}
var ENDPOINT_VARIABLES = ["AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_SQS"];
function createSqsQueue(options) {
  if (options.endpoint !== undefined && options.environment !== "local") {
    throw new TypeError(`an SQS endpoint override is only for ENVIRONMENT=local, not ${options.environment}`);
  }
  if (options.environment !== "local") {
    for (const name of ENDPOINT_VARIABLES) {
      if ((process.env[name] ?? "") !== "") {
        throw new TypeError(`${name} is set; an SQS endpoint override is only for ENVIRONMENT=local`);
      }
    }
  }
  const timeoutMs = options.timeoutMs ?? SQS_DEFAULT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? SQS_DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) {
    throw new TypeError("timeoutMs must be a whole number from 100 to 60000");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new TypeError("maxAttempts must be a whole number from 1 to 10");
  }
  const { registry, queueUrl } = options;
  const client = options.client ?? new SQSClient({
    region: options.region,
    ...options.endpoint === undefined ? {} : { endpoint: options.endpoint },
    maxAttempts,
    retryMode: "standard",
    requestHandler: {
      connectionTimeout: timeoutMs,
      requestTimeout: timeoutMs,
      throwOnRequestTimeout: true
    }
  });
  function encodeChecked(envelope) {
    const body = registry.encode(envelope);
    if (bytesOf(body) > MAX_MESSAGE_BYTES2) {
      throw new QueueError2(QUEUE_ERROR_CODES2.messageTooLarge, "the message is over 256 KiB", {
        details: { limitBytes: MAX_MESSAGE_BYTES2 }
      });
    }
    return body;
  }
  async function changeVisibility(receipt, seconds) {
    assertVisibility2(seconds);
    try {
      await client.send(new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receipt,
        VisibilityTimeout: seconds
      }));
    } catch (error) {
      if (isStaleReceipt(error)) {
        throw new QueueError2(QUEUE_ERROR_CODES2.receiptInvalid, "the message is not in flight", {
          cause: error
        });
      }
      throw mapFailure("a visibility change", error);
    }
  }
  return {
    async publish(envelope) {
      const body = encodeChecked(envelope);
      try {
        await client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }));
      } catch (error) {
        throw mapFailure("a publish", error);
      }
    },
    async publishBatch(envelopes) {
      assertBatchCount2(envelopes.length);
      const bodies = envelopes.map(encodeChecked);
      const total = bodies.reduce((sum, body) => sum + bytesOf(body), 0);
      if (total > MAX_MESSAGE_BYTES2) {
        throw new QueueError2(QUEUE_ERROR_CODES2.batchTooLarge, "a batch is at most 256 KiB in total", {
          details: { limitBytes: MAX_MESSAGE_BYTES2, totalBytes: total }
        });
      }
      let output;
      try {
        output = await client.send(new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: bodies.map((body, index) => ({ Id: String(index), MessageBody: body }))
        }));
      } catch (error) {
        throw mapFailure("a batch publish", error);
      }
      const accepted = new Set((output.Successful ?? []).map((entry) => entry.Id));
      const refused = new Map((output.Failed ?? []).map((entry) => [entry.Id, entry]));
      const result = { sent: [], failed: [] };
      envelopes.forEach((envelope, index) => {
        const entryId = String(index);
        const failure = refused.get(entryId);
        if (failure !== undefined) {
          const item = {
            id: envelope.id,
            code: failure.Code ?? "Unknown",
            senderFault: failure.SenderFault === true
          };
          result.failed.push(item);
        } else if (accepted.has(entryId)) {
          result.sent.push(envelope.id);
        } else {
          result.failed.push({ id: envelope.id, code: "MissingFromResponse", senderFault: false });
        }
      });
      return result;
    },
    async receive(receiveOptions) {
      assertReceiveOptions2(receiveOptions);
      const { maxMessages, visibilityTimeoutSeconds, waitSeconds, signal } = receiveOptions;
      if (signal?.aborted) {
        return [];
      }
      let output;
      try {
        output = await client.send(new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: maxMessages,
          VisibilityTimeout: visibilityTimeoutSeconds,
          WaitTimeSeconds: waitSeconds,
          MessageSystemAttributeNames: ["ApproximateReceiveCount"]
        }), {
          requestTimeout: waitSeconds * 1000 + timeoutMs,
          ...signal === undefined ? {} : { abortSignal: signal }
        });
      } catch (error) {
        if (signal?.aborted) {
          return [];
        }
        throw mapFailure("a receive", error);
      }
      const deliveries = [];
      for (const message of output.Messages ?? []) {
        if (message.ReceiptHandle === undefined || message.Body === undefined) {
          throw new QueueError2(QUEUE_ERROR_CODES2.badResponse, "the queue returned a message without a body or receipt");
        }
        const receiveCount = Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? "1", 10);
        const count = Number.isInteger(receiveCount) && receiveCount > 0 ? receiveCount : 1;
        const decoded = registry.decode(message.Body);
        deliveries.push(decoded.ok ? {
          kind: "message",
          envelope: decoded.envelope,
          receipt: message.ReceiptHandle,
          receiveCount: count
        } : {
          kind: "invalid",
          reason: decoded.reason,
          issues: decoded.issues,
          ...decoded.messageId === undefined ? {} : { messageId: decoded.messageId },
          receipt: message.ReceiptHandle,
          receiveCount: count
        });
      }
      return deliveries;
    },
    async acknowledge(receipt) {
      try {
        await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receipt }));
      } catch (error) {
        if (!isStaleReceipt(error)) {
          throw mapFailure("an acknowledge", error);
        }
      }
    },
    extendVisibility: changeVisibility,
    release: (receipt) => changeVisibility(receipt, 0)
  };
}
// src/queue/consumer.ts
var LEASE_MARGIN_SECONDS = 5;
function integerIn(name, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be a whole number from ${min} to ${max}, got ${value}`);
  }
  return value;
}
function nameOf(error) {
  return error instanceof Error ? error.name : "non-error";
}
function createConsumer(options) {
  const { queue, store, logger } = options;
  const sleep = options.sleep ?? systemSleep2;
  const random = options.random ?? Math.random;
  const concurrency = integerIn("concurrency", options.concurrency ?? 4, 1, 100);
  const waitSeconds = integerIn("waitSeconds", options.waitSeconds ?? MAX_WAIT_SECONDS2, 0, MAX_WAIT_SECONDS2);
  const visibility = integerIn("visibilityTimeoutSeconds", options.visibilityTimeoutSeconds ?? 30, 2, MAX_VISIBILITY_SECONDS2);
  const handlerTimeoutMs = integerIn("handlerTimeoutMs", options.handlerTimeoutMs ?? 300000, 1, 43200000);
  const retryBase = integerIn("retryBaseSeconds", options.retryBaseSeconds ?? 5, 1, 3600);
  const retryMax = integerIn("retryMaxSeconds", options.retryMaxSeconds ?? 300, retryBase, MAX_VISIBILITY_SECONDS2);
  const invalidDelay = integerIn("invalidDelaySeconds", options.invalidDelaySeconds ?? 60, 1, MAX_VISIBILITY_SECONDS2);
  if (options.name.trim() === "") {
    throw new TypeError("a consumer needs a name");
  }
  const log = logger.child({ consumer: options.name });
  const extendEveryMs = Math.max(500, Math.floor(visibility * 1000 / 3));
  const unsupportedMax = integerIn("unsupportedVersionMaxSeconds", options.unsupportedVersionMaxSeconds ?? 3600, invalidDelay, MAX_VISIBILITY_SECONDS2);
  const storeTimeoutMs = integerIn("storeTimeoutMs", options.storeTimeoutMs ?? 1e4, 1, 600000);
  const leaseSeconds = Math.max(visibility * 2, Math.ceil(storeTimeoutMs / 1000) + 2 * Math.ceil(extendEveryMs / 1000) + LEASE_MARGIN_SECONDS);
  const flights = new Set;
  const stopControl = new AbortController;
  let loop;
  let abandonedCount = 0;
  let finishedCount = 0;
  let stopped;
  async function bounded(call, what) {
    const stop = new AbortController;
    const timer = new Promise((_, reject) => {
      sleep(storeTimeoutMs, stop.signal).then(() => {
        if (!stop.signal.aborted) {
          reject(new Error(`the processed store timed out on ${what}`));
        }
      });
    });
    try {
      return await Promise.race([call, timer]);
    } finally {
      stop.abort();
    }
  }
  function report(error) {
    try {
      options.errorReporter?.capture(error, { tags: { consumer: options.name } });
    } catch {}
  }
  function retryDelay(receiveCount) {
    const ceiling = Math.min(retryMax, retryBase * 2 ** Math.min(receiveCount - 1, 20));
    return Math.max(1, Math.floor(ceiling / 2 + random() * (ceiling / 2)));
  }
  async function delay(receipt, seconds, why) {
    try {
      await queue.extendVisibility(receipt, seconds);
    } catch (error) {
      log.warn("could not delay a message", { why, errorName: nameOf(error) });
    }
  }
  async function handle(delivery, flight) {
    if (delivery.kind === "invalid") {
      log.error("received a message this consumer does not accept", {
        reason: delivery.reason,
        issues: delivery.issues,
        messageId: delivery.messageId,
        receiveCount: delivery.receiveCount
      });
      report(new Error(`invalid queue message: ${delivery.reason}`));
      let seconds = invalidDelay;
      if (delivery.reason === "unsupported_version") {
        const ceiling = Math.min(unsupportedMax, invalidDelay * 2 ** Math.min(delivery.receiveCount - 1, 20));
        seconds = Math.max(1, Math.floor(ceiling / 2 + random() * (ceiling / 2)));
      }
      await delay(delivery.receipt, seconds, "invalid");
      return;
    }
    const { envelope, receipt, receiveCount } = delivery;
    const fields = {
      messageId: envelope.id,
      type: envelope.type,
      organizationId: envelope.organizationId,
      traceId: envelope.traceId,
      receiveCount
    };
    const handler = options.handlers[envelope.type];
    if (handler === undefined) {
      log.error("no handler for a message type", fields);
      report(new Error(`no handler for queue message type ${envelope.type}`));
      await delay(receipt, invalidDelay, "no_handler");
      return;
    }
    const key = {
      consumer: options.name,
      organizationId: envelope.organizationId ?? null,
      messageId: envelope.id
    };
    let claim;
    try {
      claim = await bounded(store.claim(key, leaseSeconds), "claim");
    } catch (error) {
      log.error("the processed store failed on claim", { ...fields, errorName: nameOf(error) });
      report(error);
      await delay(receipt, retryDelay(receiveCount), "claim_failed");
      return;
    }
    if (claim.status === "done") {
      log.debug("message already processed; acknowledging", fields);
      await queue.acknowledge(receipt).catch((error) => {
        log.warn("acknowledge failed", { ...fields, errorName: nameOf(error) });
      });
      return;
    }
    if (claim.status === "busy") {
      log.debug("message is being processed elsewhere; backing off", fields);
      await delay(receipt, Math.min(claim.retryAfterSeconds, MAX_VISIBILITY_SECONDS2), "busy");
      return;
    }
    const token = claim.token;
    flight.key = key;
    flight.token = token;
    if (flight.abandoned || flight.control.signal.aborted) {
      await bounded(store.release(key, token), "release").catch(() => {
        return;
      });
      return;
    }
    const context = Object.freeze({
      organizationId: envelope.organizationId,
      traceId: envelope.traceId,
      receiveCount,
      signal: flight.control.signal
    });
    const aborted = new Promise((resolve) => {
      flight.control.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
    });
    const running = Promise.resolve().then(() => handler(Object.freeze({ ...envelope }), context)).then(() => ({ ok: true }), (error) => ({ ok: false, error }));
    const stopKeepAlive = new AbortController;
    let timedOut = false;
    const deadline = sleep(handlerTimeoutMs, stopKeepAlive.signal).then(() => {
      if (!stopKeepAlive.signal.aborted) {
        timedOut = true;
        flight.control.abort();
      }
    });
    let renewalPending = false;
    const keepAlive = (async () => {
      while (!stopKeepAlive.signal.aborted) {
        await sleep(extendEveryMs, stopKeepAlive.signal);
        if (stopKeepAlive.signal.aborted) {
          return;
        }
        try {
          await queue.extendVisibility(receipt, visibility);
        } catch (error) {
          if (error instanceof QueueError2 && error.code === QUEUE_ERROR_CODES2.receiptInvalid) {
            log.warn("lost the message while its handler was running", fields);
            flight.control.abort();
            return;
          }
          log.warn("could not extend visibility", { ...fields, errorName: nameOf(error) });
        }
        if (renewalPending) {
          continue;
        }
        renewalPending = true;
        (async () => {
          try {
            if (!await bounded(store.renew(key, token, leaseSeconds), "renew")) {
              log.warn("lost the claim while its handler was running", fields);
              flight.control.abort();
            }
          } catch (error) {
            log.warn("could not renew the claim", { ...fields, errorName: nameOf(error) });
          } finally {
            renewalPending = false;
          }
        })();
      }
    })();
    const outcome = await Promise.race([running, aborted]);
    stopKeepAlive.abort();
    await Promise.all([keepAlive, deadline]);
    if (flight.abandoned) {
      return;
    }
    if (outcome === "aborted") {
      log.error(timedOut ? "a handler timed out" : "a message was lost mid-handler", fields);
      report(new Error(timedOut ? "queue handler timed out" : "queue message lost mid-handler"));
      return;
    }
    if (!outcome.ok) {
      log.error("a handler failed; the message will be retried", {
        ...fields,
        errorName: nameOf(outcome.error)
      });
      report(outcome.error);
      await bounded(store.release(key, token), "release").catch(() => {
        return;
      });
      await delay(receipt, retryDelay(receiveCount), "handler_failed");
      return;
    }
    try {
      if (!await bounded(store.complete(key, token), "complete")) {
        log.warn("the claim was lost before completion; acknowledging anyway", fields);
      }
    } catch (error) {
      log.error("the processed store failed on complete", { ...fields, errorName: nameOf(error) });
      report(error);
      await bounded(store.release(key, token), "release").catch(() => {
        return;
      });
      await delay(receipt, retryDelay(receiveCount), "complete_failed");
      return;
    }
    await queue.acknowledge(receipt).catch((error) => {
      log.warn("acknowledge failed", { ...fields, errorName: nameOf(error) });
    });
  }
  function dispatch(delivery) {
    const flight = {
      receipt: delivery.receipt,
      key: null,
      token: null,
      control: new AbortController,
      abandoned: false,
      done: Promise.resolve()
    };
    flight.done = handle(delivery, flight).catch((error) => {
      log.error("unexpected consumer failure", { errorName: nameOf(error) });
      report(error);
    }).finally(() => {
      flights.delete(flight);
      if (!flight.abandoned) {
        finishedCount += 1;
      }
    });
    flights.add(flight);
    return flight;
  }
  async function giveBack(delivery) {
    await queue.release(delivery.receipt).catch(() => {
      return;
    });
  }
  async function run() {
    let failures = 0;
    while (!stopControl.signal.aborted) {
      if (flights.size >= concurrency) {
        await Promise.race([...flights].map((flight) => flight.done));
        continue;
      }
      let batch;
      try {
        batch = await queue.receive({
          maxMessages: Math.min(concurrency - flights.size, MAX_BATCH_SIZE2),
          visibilityTimeoutSeconds: visibility,
          waitSeconds,
          signal: stopControl.signal
        });
        failures = 0;
      } catch (error) {
        if (stopControl.signal.aborted) {
          return;
        }
        failures += 1;
        log.error("receive failed", { errorName: nameOf(error), failures });
        report(error);
        const ceiling = Math.min(30000, 500 * 2 ** Math.min(failures, 10));
        await sleep(Math.floor(ceiling / 2 + random() * (ceiling / 2)), stopControl.signal);
        continue;
      }
      if (stopControl.signal.aborted) {
        await Promise.all(batch.map(giveBack));
        return;
      }
      for (const delivery of batch) {
        dispatch(delivery);
      }
      if (batch.length === 0 && waitSeconds === 0) {
        await sleep(1000, stopControl.signal);
      }
    }
  }
  return {
    start() {
      loop ??= run().catch((error) => {
        log.error("the receive loop ended unexpectedly", { errorName: nameOf(error) });
        report(error);
      });
    },
    stop(deadlineMs) {
      stopped ??= stopNow(deadlineMs);
      return stopped;
    },
    async pollOnce() {
      const batch = await queue.receive({
        maxMessages: Math.min(concurrency, MAX_BATCH_SIZE2),
        visibilityTimeoutSeconds: visibility,
        waitSeconds: 0
      });
      await Promise.all(batch.map((delivery) => dispatch(delivery).done));
      return batch.length;
    }
  };
  async function stopNow(deadlineMs) {
    stopControl.abort();
    const cancel = new AbortController;
    const drained = (async () => {
      await loop;
      while (flights.size > 0) {
        await Promise.all([...flights].map((flight) => flight.done));
      }
    })();
    await Promise.race([drained, sleep(deadlineMs, cancel.signal)]);
    cancel.abort();
    if (flights.size > 0) {
      const left = [...flights];
      abandonedCount += left.length;
      for (const flight of left) {
        flight.abandoned = true;
        flight.control.abort();
      }
      await Promise.all(left.map(async (flight) => {
        if (flight.key !== null && flight.token !== null) {
          await bounded(store.release(flight.key, flight.token), "release").catch(() => {
            return;
          });
        }
        await queue.release(flight.receipt).catch(() => {
          return;
        });
      }));
      log.warn("shutdown gave up waiting; returned messages to the queue", { count: left.length });
    }
    return { finished: finishedCount, abandoned: abandonedCount };
  }
}
export {
  SQS_DEFAULT_MAX_ATTEMPTS,
  SQS_DEFAULT_TIMEOUT_MS,
  createConsumer,
  createSqsQueue
};
