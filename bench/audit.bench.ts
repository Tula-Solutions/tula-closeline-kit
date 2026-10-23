import { organizationIdSchema } from 'tula-closeline-contract'
import { createMemoryAuditRecorder } from '../src/audit/memory'
import { createQueueAuditRecorder } from '../src/audit/queue'

/**
 * Benchmark: `AuditRecorder.record`, called for every Agent action. It validates one small entry
 * strictly (a regex per id and label, a key check per metadata key), serialises it once to check
 * the 4 KiB cap, then does O(1) work: a map insert (memory) or one envelope build and one queue
 * publish (queue; a no-op publish here, a real queue adds its own call).
 *
 * Input: an entry with 6 metadata keys, a fresh event id each call.
 * Expected complexity O(entry size), at most 4 KiB; independent of how many events were recorded.
 *
 * Budgets, per call, about five times the fastest measured of several batches on one developer
 * machine (measured numbers beside each budget), with a mean floor of 0.02 ms. The median and the
 * best-of-five p95 are used as in `queue.bench.ts`, so one scheduler stall cannot fail the check.
 */
const ORG = organizationIdSchema.parse(`org_${'1'.repeat(32)}`)
const BATCHES = 5

interface Budget {
  meanMs: number
  medianMs: number
  tailMs: number
}
const BUDGETS = {
  // Measured: mean 0.0162, median 0.0061, best-of-5 p95 0.0083 ms (the mean carries GC pauses).
  memory: { meanMs: 0.08, medianMs: 0.03, tailMs: 0.04 },
  // Measured: mean 0.0221, median 0.0036, best-of-5 p95 0.0053 ms.
  queue: { meanMs: 0.11, medianMs: 0.02, tailMs: 0.03 },
} satisfies Record<string, Budget>

const memory = createMemoryAuditRecorder()
const queue = createQueueAuditRecorder({ queue: { publish: async () => undefined } })
let counter = 0

async function samples(
  recorder: { record: typeof memory.record },
  count: number
): Promise<number[]> {
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    counter += 1
    const entry = {
      id: `evt_${counter}`,
      organizationId: ORG,
      actor: { kind: 'agent', id: 'agent_inbound' },
      action: 'agent.sent_message',
      subject: { type: 'prospect', id: `prs_${'1'.repeat(32)}` },
      instructionVersion: 3,
      requestId: 'req_1',
      metadata: {
        channel: 'sms',
        attempt: 1,
        approved: true,
        tone: 'warm',
        len: 160,
        kind: 'text',
      },
    } as const
    const start = performance.now()
    await recorder.record(entry)
    out.push(performance.now() - start)
  }
  return out
}

/** The q-th quantile of the samples (0 to 1), by nearest rank. */
function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((x, y) => x - y)
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? Number.POSITIVE_INFINITY
  )
}

const failures: string[] = []
function report(name: string, values: number[], budget: Budget) {
  const mean = values.reduce((sum, ms) => sum + ms, 0) / values.length
  const batchSize = Math.floor(values.length / BATCHES)
  const batchP95s: number[] = []
  for (let b = 0; b < BATCHES; b++) {
    batchP95s.push(percentile(values.slice(b * batchSize, (b + 1) * batchSize), 0.95))
  }
  const median = percentile(values, 0.5)
  const tail = Math.min(...batchP95s)
  process.stdout.write(
    `${name} (${values.length} calls): mean ${mean.toFixed(5)} ms (budget ${budget.meanMs}), ` +
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

await samples(memory, 500)
report('memory', await samples(memory, 5_000), BUDGETS.memory)
await samples(queue, 500)
report('queue', await samples(queue, 5_000), BUDGETS.queue)

if (failures.length > 0) {
  process.stderr.write(`bench failed: ${failures.join('; ')}\n`)
  process.exit(1)
}
