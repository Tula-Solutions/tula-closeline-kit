import { prepareFields } from '../src/redact'

/**
 * Benchmark: preparing the fields of one log entry (`prepareFields`: key redaction, bounded copy),
 * which the logger runs on every line that carries fields, in two legs.
 *
 * Input: 2,000 distinct entries per leg built from a fixed sequence (no randomness), each timed on
 * its own.
 * - `typical entry` is what most lines carry: ten primitive fields, a tenant object, a request
 *   context object with a nested object, a short array of ids and a sensitive key. Expected
 *   complexity O(values in the entry), about 30 values and 5 objects.
 * - `oversized entry` is the worst shape for the budgets: a field of 100 arrays of 60 small
 *   objects (it spends the shared budget of 5,000 objects) followed by 40 small object fields,
 *   each of which gets its own allowance of 50 objects and 200 values. Expected complexity
 *   O(1) in the size of the input, bounded by 5,000 shared objects plus 50 per top-level field
 *   (at most 200 fields) and 20,000 shared values plus 200 per field.
 *
 * Budgets, per call: mean, median, and the best p95 of five batches (see `reporting.bench.ts` for
 * why). About 5x what each leg measures on one developer machine.
 */
const CALLS = 2_000
const WARMUP = 200
const BATCHES = 5

interface Budget {
  meanMs: number
  medianMs: number
  tailMs: number
}
const TYPICAL_BUDGET: Budget = { meanMs: 0.02, medianMs: 0.015, tailMs: 0.04 }
const OVERSIZED_BUDGET: Budget = { meanMs: 8, medianMs: 7, tailMs: 12 }

function typical(i: number): Record<string, unknown> {
  return {
    orgId: `org_${i % 50}`,
    requestId: `req_${i}`,
    method: 'POST',
    path: `/v1/teams/${i}`,
    status: 200,
    durationMs: i % 90,
    attempt: 1,
    region: 'us',
    userId: `usr_${i}`,
    password: 'hunter2',
    tenant: { organizationId: `org_${i % 50}`, plan: 'team' },
    ctx: { requestId: `req_${i}`, caller: { service: 'core', version: '1.2.3' } },
    ids: [`a_${i}`, `b_${i}`, `c_${i}`],
  }
}

function oversized(i: number): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    orgId: `org_${i % 50}`,
    big: Array.from({ length: 100 }, () =>
      Array.from({ length: 60 }, (_, index) => ({ index, label: 'x' }))
    ),
  }
  for (let k = 0; k < 40; k++) {
    entry[`ctx${k}`] = { id: `${i}_${k}`, nested: { a: 1, b: [1, 2, 3] } }
  }
  return entry
}

const legs = [
  { name: 'typical entry', budget: TYPICAL_BUDGET, make: typical },
  { name: 'oversized entry', budget: OVERSIZED_BUDGET, make: oversized },
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
  const inputs = Array.from({ length: CALLS + WARMUP }, (_, i) => leg.make(i))
  for (const input of inputs.slice(0, WARMUP)) {
    prepareFields(input)
  }
  const samples: number[] = []
  for (const input of inputs.slice(WARMUP)) {
    const start = performance.now()
    prepareFields(input)
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
    `redact, ${leg.name} (${samples.length} calls): mean ${mean.toFixed(4)} ms ` +
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
    failures.push(`${leg.name}: best p95 ${tail.toFixed(4)} ms > ${leg.budget.tailMs} ms`)
  }
}
if (failures.length > 0) {
  process.stderr.write(`bench failed: ${failures.join('; ')}\n`)
  process.exit(1)
}
