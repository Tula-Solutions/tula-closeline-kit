import { createFixedClock } from '../src/clock'
import { createMemoryObjectStore } from '../src/storage/memory'
import { createMemoryVectorStore } from '../src/vector/memory'

/**
 * Benchmark: the memory adapters of the object store and the vector store, one leg per hot
 * operation. The S3 adapter's cost is one HTTP round trip plus the same validation, which the
 * first leg measures; a real vector adapter's cost is a round trip to its vendor.
 *
 * Input: each leg runs 2,000 calls (after a warm-up) over fixed data, no randomness, each timed
 * alone.
 * - `object put + get, 4 KiB` writes then reads one 4 KiB object. Expected complexity O(object
 *   size) for the validation, the copy in and the copy out.
 * - `object list, page of 100 from 1,000 objects` is one `list` of a 1,000-object Organization.
 *   Expected complexity O(n log n) in the Organization's n objects (the memory adapter scans and
 *   sorts; S3 does it server side); it is for tests only.
 * - `vector upsert, 10 vectors of 384 dimensions` validates, normalises and stores a batch.
 *   Expected complexity O(batch x dimensions).
 * - `vector search, 1,000 vectors of 384 dimensions, topK 10` is an exact scan. Expected
 *   complexity O(n x dimensions + n log n); it is for tests only, never a request path.
 *
 * Budgets, per call, about five times the mean measured on one developer machine. The median and
 * the best-of-five-batches p95 are used as in `queue.bench.ts`, so a single scheduler stall cannot
 * fail the check. They catch an accidental quadratic or an uncapped input, not a few percent.
 */
const CALLS = 2_000
const WARMUP = 200
const BATCHES = 5
const ORG = `org_${'1'.repeat(32)}`
const DIMENSIONS = 384

interface Budget {
  meanMs: number
  medianMs: number
  tailMs: number
}
const BUDGETS = {
  put: { meanMs: 0.012, medianMs: 0.01, tailMs: 0.016 },
  list: { meanMs: 0.16, medianMs: 0.15, tailMs: 0.17 },
  upsert: { meanMs: 0.33, medianMs: 0.32, tailMs: 0.34 },
  search: { meanMs: 2.7, medianMs: 2.7, tailMs: 2.75 },
} satisfies Record<string, Budget>

// A fixed pseudo-random sequence so every run sees the same numbers.
let seed = 12_345
const next = () => {
  seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0
  return seed / 4_294_967_296 - 0.5
}
const randomVector = () => Array.from({ length: DIMENSIONS }, next)

const objects = createMemoryObjectStore({ clock: createFixedClock('2026-01-01T00:00:00.000Z') })
const listed = createMemoryObjectStore({ clock: createFixedClock('2026-01-01T00:00:00.000Z') })
const vectors = createMemoryVectorStore({ dimensions: DIMENSIONS })
const searched = createMemoryVectorStore({ dimensions: DIMENSIONS })

const body = new Uint8Array(4096).fill(7)
for (let i = 0; i < 1_000; i++) {
  await listed.put(ORG, `docs/${String(i).padStart(4, '0')}`, body)
}
for (let i = 0; i < 1_000; i += 100) {
  await searched.upsert(
    ORG,
    Array.from({ length: 100 }, (_, j) => ({
      id: `v${i + j}`,
      vector: randomVector(),
      attributes: { document_id: `doc_${(i + j) % 20}` },
    }))
  )
}
const queries = Array.from({ length: CALLS + WARMUP }, randomVector)
const batches = Array.from({ length: CALLS + WARMUP }, (_, i) =>
  Array.from({ length: 10 }, (_, j) => ({ id: `b${i % 50}_${j}`, vector: randomVector() }))
)

interface Leg {
  name: string
  budget: Budget
  run: (index: number) => Promise<void>
}
const legs: Leg[] = [
  {
    name: 'object put + get, 4 KiB',
    budget: BUDGETS.put,
    run: async (i) => {
      const key = `docs/${i % 100}`
      await objects.put(ORG, key, body, { contentType: 'application/pdf' })
      if ((await objects.get(ORG, key))?.size !== body.byteLength) {
        throw new Error('object not read back')
      }
    },
  },
  {
    name: 'object list, page of 100 from 1,000 objects',
    budget: BUDGETS.list,
    run: async () => {
      const page = await listed.list(ORG, { limit: 100 })
      if (page.items.length !== 100 || page.nextCursor === undefined) {
        throw new Error('unexpected page')
      }
    },
  },
  {
    name: 'vector upsert, 10 vectors of 384 dimensions',
    budget: BUDGETS.upsert,
    run: (i) => vectors.upsert(ORG, batches[i] as (typeof batches)[number]),
  },
  {
    name: 'vector search, 1,000 vectors of 384 dimensions, topK 10',
    budget: BUDGETS.search,
    run: async (i) => {
      const hits = await searched.search(ORG, { vector: queries[i] as number[], topK: 10 })
      if (hits.length !== 10) {
        throw new Error('unexpected hits')
      }
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
  for (let i = 0; i < WARMUP; i++) {
    await leg.run(i)
  }
  const samples: number[] = []
  for (let i = WARMUP; i < WARMUP + CALLS; i++) {
    const start = performance.now()
    await leg.run(i)
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
