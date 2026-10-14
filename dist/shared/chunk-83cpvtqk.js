// src/transcribe/wait.ts
function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function abortReason(signal) {
  return signal.reason ?? new DOMException("the wait was aborted", "AbortError");
}
async function waitForTranscription2(transcriber, organizationId, clientReference, options = {}) {
  const maxAttempts = options.maxAttempts ?? 60;
  const intervalMs = options.intervalMs ?? 5000;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 1000) {
    throw new TypeError("maxAttempts must be a whole number from 1 to 1000");
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 0 || intervalMs > 60000) {
    throw new TypeError("intervalMs must be a number from 0 to 60000");
  }
  const sleep = options.sleep ?? ((ms) => abortableSleep(ms, options.signal));
  const random = options.random ?? Math.random;
  let last;
  for (let attempt = 1;attempt <= maxAttempts; attempt++) {
    if (options.signal?.aborted) {
      throw abortReason(options.signal);
    }
    last = await transcriber.getResult(organizationId, clientReference, options.vendorId === undefined ? undefined : { vendorId: options.vendorId });
    if (last === undefined || last.status !== "pending") {
      return last;
    }
    if (attempt < maxAttempts) {
      await sleep(Math.round(intervalMs * (0.5 + random())));
    }
  }
  return last;
}

export { waitForTranscription2 };
