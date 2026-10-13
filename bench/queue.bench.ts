import { createFixedClock } from '../src/clock'
import { createMemoryQueue } from '../src/queue/memory'
import { createTestRegistry } from '../src/queue/testing'

/**
 * Benchmark: the queue's envelope validation and the memory adapter's publish, receive and
 * acknowledge, in three legs. The SQS adapter's cost is one HTTP round trip and is not measured
 * here; what it adds on top is the same `encode` and `decode`.
 *
 * Input: 2,000 distinct messages per leg from a fixed sequence (no randomness), each timed alone.
 * - `encode + decode, ordinary message` is what every publish and every delivery pays: a message
 *   of about 200 bytes validated against its schema and serialised or parsed. Expected complexity
 *   O(message size), at most 256 KiB because a longer body is refused before parsing.
 * - `decode, 200 KiB message` is the worst accepted size: one JSON parse and one Zod pass over a
 *   large text field. Expected complexity O(message size); it bounds what one delivery can cost.
 * - `memory publish + receive + acknowledge` is one message through the queue with the queue
 *   otherwise empty. Expected complexity O(1) for publish and acknowledge and O(messages stored)
 *   for receive, which is a scan, so the leg keeps the queue empty.
 *
 * Budgets, per call. Measured on one developer machine: 0.002 ms, 0.034 ms and 0.004 ms mean for
 * the three legs; each budget is 8x to 10x that, wide on purpose to catch an accidental
 * quadratic or an uncapped input, not a few percent.
 * The median and best-of-five-batches p95 are used as in `reporting.bench.ts`, so a single
 * scheduler stall cannot fail the check.
 */
const CALLS = 2_000
const WARMUP = 200
const BIG_CALLS = 200
const BIG_WARMUP = 20
const BATCHES = 5

interface Budget {
  meanMs: number
  medianMs: number
  tailMs: number
}
const SMALL_BUDGET: Budget = { meanMs: 0.02, medianMs: 0.015, tailMs: 0.03 }
const BIG_BUDGET: Budget = { meanMs: 0.3, medianMs: 0.25, tailMs: 0.4 }
const CYCLE_BUDGET: Budget = { meanMs: 0.03, medianMs: 0.025, tailMs: 0.05 }

const clock = createFixedClock('2026-01-01T00:00:00.000Z')
const registry = createTestRegistry({ clock })
const queue = createMemoryQueue({ registry, clock })

const small = Array.from({ length: CALLS + WARMUP }, (_, i) =>
  registry.create({
    type: 'test.ping',
    payload: { n: i },
    organizationId: `org_${i % 50}`,
    traceId: `req_${i}`,
    id: `msg_${i}`,
  })
)
const bigBodies = Array.from({ length: BIG_CALLS + BIG_WARMUP }, (_, i) =>
  registry.encode(
    registry.create({
      type: 'test.note',
      payload: { text: `${i} `.padEnd(200 * 1024, 'x') },
      traceId: `req_${i}`,
      id: `big_${i}`,
    })
  )
)
if (!registry.decode(bigBodies[0] as string).ok) {
  process.stderr.write('bench failed: the large message does not decode\n')
  process.exit(1)
}

interface Leg<T> {
  name: string
  budget: Budget
  inputs: T[]
  warmup: number
  run: (input: T) => void | Promise<void>
}

const legs: Array<Leg<unknown>> = [
  {
    name: 'encode + decode, ordinary message',
    budget: SMALL_BUDGET,
    inputs: small,
    warmup: WARMUP,
    run: (input) => {
      const result = registry.decode(registry.encode(input as (typeof small)[number]))
      if (!result.ok) {
        throw new Error('decode failed')
      }
    },
  },
  {
    name: 'decode, 200 KiB message',
    budget: BIG_BUDGET,
    inputs: bigBodies,
    warmup: BIG_WARMUP,
    run: (input) => {
      if (!registry.decode(input as string).ok) {
        throw new Error('decode failed')
      }
    },
  },
  {
    name: 'memory publish + receive + acknowledge',
    budget: CYCLE_BUDGET,
    inputs: small,
    warmup: WARMUP,
    run: async (input) => {
      await queue.publish(input as (typeof small)[number])
      const [got] = await queue.receive({
        maxMessages: 1,
        visibilityTimeoutSeconds: 30,
        waitSeconds: 0,
      })
      if (got === undefined) {
        throw new Error('nothing received')
      }
      await queue.acknowledge(got.receipt)
    },
  },
]

/** The q-th quantile of the samples (0 to 1), by nearest rank. */
function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((x, y) => x - y)
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? Number.POSITIVE_INFINITY
  )
}

const failures: string[] = []
for (const leg of legs) {
  for (const input of leg.inputs.slice(0, leg.warmup)) {
    await leg.run(input)
  }
  const samples: number[] = []
  for (const input of leg.inputs.slice(leg.warmup)) {
    const start = performance.now()
    await leg.run(input)
    samples.push(performance.now() - start)
  }
  const mean = samples.reduce((sum, ms) => sum + ms, 0) / samples.length
  const batchSize = Math.floor(samples.length / BATCHES)
  const batchP95s: number[] = []
  for (let b = 0; b < BATCHES; b++) {
    batchP95s.push(percentile(samples.slice(b * batchSize, (b + 1) * batchSize), 0.95))
  }
  const median = percentile(samples, 0.5)
  const tail = Math.min(...batchP95s)
  process.stdout.write(
    `${leg.name} (${samples.length} calls): mean ${mean.toFixed(4)} ms ` +
      `(budget ${leg.budget.meanMs}), median ${median.toFixed(4)} ms (budget ${leg.budget.medianMs}), ` +
      `best-of-${BATCHES} p95 ${tail.toFixed(4)} ms (budget ${leg.budget.tailMs})\n`
  )
  if (mean > leg.budget.meanMs) {
    failures.push(`${leg.name}: mean ${mean.toFixed(4)} ms > ${leg.budget.meanMs} ms`)
  }
  if (median > leg.budget.medianMs) {
    failures.push(`${leg.name}: median ${median.toFixed(4)} ms > ${leg.budget.medianMs} ms`)
  }
  if (tail > leg.budget.tailMs) {
    failures.push(
      `${leg.name}: best p95 of ${BATCHES} batches ${tail.toFixed(4)} ms > ${leg.budget.tailMs} ms`
    )
  }
}
if (failures.length > 0) {
  process.stderr.write(`bench failed: ${failures.join('; ')}\n`)
  process.exit(1)
}
