import type { Transcriber, TranscriptionResult, WaitOptions } from './port'

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Reads a send until it is `done` or `failed`, with a bound: at most `maxAttempts` reads (60 by
 * default) with a pause of `intervalMs` (5 s) varied by jitter between 50% and 150%, so many
 * waiters do not read in step. Returns the final result, `{ status: 'pending' }` when the attempts
 * ran out (the caller reschedules; it is not a failure), or `undefined` when the send does not
 * exist. A read that throws ends the wait with that error. Worst case: maxAttempts reads and
 * (maxAttempts - 1) pauses of at most 1.5 x intervalMs. For a queued job, one attempt per run is
 * usually better.
 */
export async function waitForTranscription(
  transcriber: Transcriber,
  organizationId: string,
  clientReference: string,
  options: WaitOptions = {}
): Promise<TranscriptionResult | undefined> {
  const maxAttempts = options.maxAttempts ?? 60
  const intervalMs = options.intervalMs ?? 5_000
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 1000) {
    throw new TypeError('maxAttempts must be a whole number from 1 to 1000')
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 0 || intervalMs > 60_000) {
    throw new TypeError('intervalMs must be a number from 0 to 60000')
  }
  const sleep = options.sleep ?? defaultSleep
  const random = options.random ?? Math.random
  let last: TranscriptionResult | undefined
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.signal?.aborted) {
      return last ?? { status: 'pending' }
    }
    last = await transcriber.getResult(organizationId, clientReference)
    if (last === undefined || last.status !== 'pending') {
      return last
    }
    if (attempt < maxAttempts) {
      await sleep(Math.round(intervalMs * (0.5 + random())))
    }
  }
  return last
}
