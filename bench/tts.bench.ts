import { organizationIdSchema } from 'tula-closeline-contract'
import { createMemoryTts } from '../src/tts/memory'

/**
 * Benchmark: the memory adapter of the text-to-speech port, the overhead the port adds to each
 * audio chunk of a live call. A real adapter adds the vendor's network time on top; this measures
 * only the code every adapter shares (the pull, the order, the deadline checks, the wrapper).
 *
 * Input: fixed scripted audio of 160-byte chunks (20 ms of 8 kHz mu-law), no delays, no randomness.
 * - `chunk pull` times one `next()` of a stream already delivering, over 500-chunk streams.
 *   Expected complexity O(1) per chunk: one generator step, one chunk object and two signal checks;
 *   independent of how many chunks the stream holds, and memory O(1) because the consumer pulls.
 * - `open to first chunk` times `open`, one `write` and the first `next()` of a new stream.
 *   Expected complexity O(text length + 1): validation, one timer and one watch timer.
 *
 * Budgets, per call, about five times the fastest measured of several batches on one developer
 * machine (measured numbers in the comment beside each budget). The median and the best-of-five
 * p95 are used as in `queue.bench.ts`, so one scheduler stall cannot fail the check. They catch an
 * accidental quadratic or a copy of the audio per chunk, not a few percent.
 */
const ORG = organizationIdSchema.parse(`org_${'1'.repeat(32)}`)
const CHUNK = new Uint8Array(160).fill(0x7f)
const STREAM_CHUNKS = 500
const STREAMS = 20
const WARMUP_STREAMS = 4
const BATCHES = 5

interface Budget {
  meanMs: number
  medianMs: number
  tailMs: number
}
const BUDGETS = {
  // Measured: mean 0.00028, median 0.00012, best-of-5 p95 0.00013 ms.
  pull: { meanMs: 0.0015, medianMs: 0.0006, tailMs: 0.0007 },
  // Measured: mean 0.0024, median 0.0016, best-of-5 p95 0.0020 ms.
  first: { meanMs: 0.012, medianMs: 0.008, tailMs: 0.01 },
} satisfies Record<string, Budget>

const tts = createMemoryTts()
const chunks = Array.from({ length: STREAM_CHUNKS }, () => CHUNK)
const request = {
  organizationId: ORG,
  voice: 'stock-friendly',
  encoding: 'pcm_mulaw',
  sampleRate: 8000,
} as const

/** Times each pull of a stream that delivers `STREAM_CHUNKS` chunks; the first chunk is left out. */
async function pullSamples(streams: number): Promise<number[]> {
  const samples: number[] = []
  for (let s = 0; s < streams; s++) {
    tts.speak(chunks)
    const stream = tts.open(request)
    stream.write('A short reply for the prospect.')
    stream.finish()
    const iterator = stream[Symbol.asyncIterator]()
    await iterator.next()
    for (let i = 1; i < STREAM_CHUNKS; i++) {
      const start = performance.now()
      const result = await iterator.next()
      samples.push(performance.now() - start)
      if (result.done) {
        throw new Error('stream ended early')
      }
    }
    await iterator.next()
    await stream.close()
  }
  return samples
}

async function firstSamples(count: number): Promise<number[]> {
  const samples: number[] = []
  for (let i = 0; i < count; i++) {
    tts.speak([CHUNK])
    const start = performance.now()
    const stream = tts.open(request)
    stream.write('A short reply for the prospect.')
    const result = await stream[Symbol.asyncIterator]().next()
    samples.push(performance.now() - start)
    if (result.done) {
      throw new Error('no first chunk')
    }
    await stream.close()
  }
  return samples
}

/** The q-th quantile of the samples (0 to 1), by nearest rank. */
function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((x, y) => x - y)
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? Number.POSITIVE_INFINITY
  )
}

const failures: string[] = []
function report(name: string, samples: number[], budget: Budget) {
  const mean = samples.reduce((sum, ms) => sum + ms, 0) / samples.length
  const batchSize = Math.floor(samples.length / BATCHES)
  const batchP95s: number[] = []
  for (let b = 0; b < BATCHES; b++) {
    batchP95s.push(percentile(samples.slice(b * batchSize, (b + 1) * batchSize), 0.95))
  }
  const median = percentile(samples, 0.5)
  const tail = Math.min(...batchP95s)
  process.stdout.write(
    `${name} (${samples.length} calls): mean ${mean.toFixed(5)} ms (budget ${budget.meanMs}), ` +
      `median ${median.toFixed(5)} ms (budget ${budget.medianMs}), ` +
      `best-of-${BATCHES} p95 ${tail.toFixed(5)} ms (budget ${budget.tailMs})\n`
  )
  if (mean > budget.meanMs) {
    failures.push(`${name}: mean ${mean.toFixed(5)} ms > ${budget.meanMs} ms`)
  }
  if (median > budget.medianMs) {
    failures.push(`${name}: median ${median.toFixed(5)} ms > ${budget.medianMs} ms`)
  }
  if (tail > budget.tailMs) {
    failures.push(
      `${name}: best p95 of ${BATCHES} batches ${tail.toFixed(5)} ms > ${budget.tailMs} ms`
    )
  }
}

await pullSamples(WARMUP_STREAMS)
report('chunk pull', await pullSamples(STREAMS), BUDGETS.pull)
await firstSamples(200)
report('open to first chunk', await firstSamples(2_000), BUDGETS.first)

if (failures.length > 0) {
  process.stderr.write(`bench failed: ${failures.join('; ')}\n`)
  process.exit(1)
}
