import { prepareFields } from '../src/redact'

/**
 * Benchmark: preparing the fields of one log entry (`prepareFields`: key redaction, bounded copy),
 * which the logger runs on every line that carries fields, in four legs.
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
 * - `worst case entry` is the shape that spends every budget: 200 top-level fields, each an array
 *   of 100 objects with 200 short keys (the objects and values budgets) and two 20 KB strings (the
 *   text budget), so every field hits its allowance and the shared pool is spent early. Expected
 *   complexity O(1) in the input: bounded by the counts above and 1 MiB of text plus 1 KiB per
 *   field; a serialised entry is about 2 MB.
 *
 * - `many errors entry` is 200 top-level fields of 100 Errors each, with 30,000 character messages
 *   and stacks: the shape where scrubbing every Error cost about 1 s. Only the first 200 Errors are
 *   copied (each scrubbed up to 16 KiB); the rest are `[truncated]` and their text is never read.
 *   Expected complexity O(1) in the input.
 *
 * Budgets, per call: mean, median, and the best p95 of five batches (see `reporting.bench.ts` for
 * why), each about five times what the leg measures on one developer machine (typical 0.012 ms,
 * oversized 4.1 ms, worst case about 55 ms, many errors about 8 ms), so a loaded CI runner does not fail a healthy build.
 */
const CALLS = 2_000
const WARMUP = 200
const BATCHES = 5

interface Budget {
  meanMs: number
  medianMs: number
  tailMs: number
}
const TYPICAL_BUDGET: Budget = { meanMs: 0.06, medianMs: 0.05, tailMs: 0.08 }
const OVERSIZED_BUDGET: Budget = { meanMs: 20, medianMs: 20, tailMs: 25 }
const WORST_BUDGET: Budget = { meanMs: 300, medianMs: 280, tailMs: 300 }
const ERRORS_BUDGET: Budget = { meanMs: 40, medianMs: 40, tailMs: 40 }

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

function worst(i: number): Record<string, unknown> {
  const text = `${'lorem ipsum '.repeat(1_700)}`.slice(0, 20_000)
  const entry: Record<string, unknown> = { orgId: `org_${i % 50}` }
  for (let k = 0; k < 200; k++) {
    entry[`field${k}`] = Array.from({ length: 100 }, () => ({
      ...Object.fromEntries(Array.from({ length: 200 }, (_, key) => [`k${key}`, key])),
      note: text,
      detail: text,
    }))
  }
  return entry
}

function manyErrors(i: number): Record<string, unknown> {
  const text = `${'lorem ipsum '.repeat(2_500)}${i}`
  const entry: Record<string, unknown> = { orgId: `org_${i % 50}` }
  for (let k = 0; k < 200; k++) {
    entry[`field${k}`] = Array.from({ length: 100 }, () => {
      const error = new Error(text)
      error.stack = text
      return error
    })
  }
  return entry
}

const legs = [
  { name: 'typical entry', budget: TYPICAL_BUDGET, make: typical, calls: CALLS, warmup: WARMUP },
  {
    name: 'oversized entry',
    budget: OVERSIZED_BUDGET,
    make: oversized,
    calls: CALLS,
    warmup: WARMUP,
  },
  { name: 'worst case entry', budget: WORST_BUDGET, make: worst, calls: 50, warmup: 5 },
  { name: 'many errors entry', budget: ERRORS_BUDGET, make: manyErrors, calls: 50, warmup: 5 },
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
  const inputs = Array.from({ length: leg.calls + leg.warmup }, (_, i) => leg.make(i))
  for (const input of inputs.slice(0, leg.warmup)) {
    prepareFields(input)
  }
  const samples: number[] = []
  for (const input of inputs.slice(leg.warmup)) {
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
