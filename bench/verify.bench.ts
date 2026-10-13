import { Hono } from 'hono'
import { createRemoteKeySet } from '../src/auth/keys'
import { type AuthEnv, createAuthMiddleware } from '../src/auth/middleware'
import { createTestJwks, createTestKeyPair, mintTestToken, testUserId } from '../src/auth/testing'
import { createTokenVerifier } from '../src/auth/verifier'
import { createFixedClock } from '../src/clock'

/**
 * Benchmark: the per-request token path with a warm key cache, in three legs.
 *
 * Input: 2,000 distinct valid tokens (a fixed key, a different user in each; Ed25519 signing is
 * deterministic, so the user is what makes the tokens differ, and this file checks it), run one
 * after another through each leg.
 * Expected complexity per call: O(token length), one Ed25519 verification and one Map lookup;
 * no I/O, no allocation proportional to anything but the token.
 *
 * Budgets, per call, and why each number (measured over many runs on one developer machine):
 * - mean: the regression gate across all 2,000 calls. Kept at the figures set earlier, 0.5 ms for
 *   a valid token and 0.3 ms for the other two legs; measured 0.055 to 0.065 ms.
 * - median: a second regression gate that one stall cannot move, because a stall changes a handful
 *   of samples and the median is the 1,000th. Budget 0.25 ms on every leg, about 5x the measured
 *   0.05 to 0.06 ms, so a 5x slowdown of the work itself fails here even where the mean budget
 *   leaves room (the valid-token mean budget is nearly 9x).
 * - tail: the best p95 of five batches of 400 calls. A p99 over one 2,000-call run is the 20th
 *   slowest sample, and a scheduler stall on a busy machine produced 0.67 ms and 2.2 ms there
 *   against steady means, failing a required check at random. A stall lands in one batch or two,
 *   and a batch's p95 is its 20th slowest of 400, so a tail fails only if every batch has more
 *   than 20 slow calls: a real slowdown of the slow path, or a machine too loaded to measure.
 *   Budget 0.4 ms on every leg, about 5x the 0.07 to 0.09 ms measured; the 2 ms the valid-token
 *   leg used before was 25x.
 * Each leg also asserts zero JWKS fetches after warm-up.
 */
const TOKENS = 2_000
const WARMUP = 200
const BATCHES = 5

interface Budget {
  meanMs: number
  medianMs: number
  tailMs: number
}
const VERIFY_BUDGET: Budget = { meanMs: 0.5, medianMs: 0.25, tailMs: 0.4 }
const BAD_SIGNATURE_BUDGET: Budget = { meanMs: 0.3, medianMs: 0.25, tailMs: 0.4 }
const MIDDLEWARE_BUDGET: Budget = { meanMs: 0.3, medianMs: 0.25, tailMs: 0.4 }

const clock = createFixedClock('2026-06-01T12:00:00.000Z')
const pair = await createTestKeyPair('bench-key')
let fetches = 0
const keys = createRemoteKeySet({
  url: 'https://auth.bench/.well-known/jwks.json',
  clock,
  fetch: (async () => {
    fetches++
    return Response.json(createTestJwks(pair))
  }) as unknown as typeof fetch,
})
await keys.warm()
const verifier = createTokenVerifier({
  issuer: 'https://auth.test',
  audience: 'closeline',
  keys,
  clock,
})
const app = new Hono<AuthEnv>()
app.use('*', createAuthMiddleware({ verifier }))
app.get('/me', (c) => c.body(null, 204))

const tokens: string[] = []
for (let i = 0; i < TOKENS + WARMUP; i++) {
  tokens.push(await mintTestToken({ keyPair: pair, clock, claims: { sub: testUserId(i + 1) } }))
}
if (new Set(tokens).size !== tokens.length) {
  process.stderr.write('bench failed: the minted tokens are not all distinct\n')
  process.exit(1)
}
// Same header and payload, wrong signature: every one reaches the signature check and fails there.
const forged = tokens.map((token) => {
  const dot = token.lastIndexOf('.')
  const flipped = token[dot + 1] === 'A' ? 'B' : 'A'
  return `${token.slice(0, dot + 1)}${flipped}${token.slice(dot + 2)}`
})

interface Leg {
  name: string
  budget: Budget
  inputs: string[]
  run: (token: string) => Promise<void>
}

const legs: Leg[] = [
  {
    name: 'verify, valid token',
    budget: VERIFY_BUDGET,
    inputs: tokens,
    run: async (token) => {
      await verifier.verify(token)
    },
  },
  {
    name: 'verify, bad signature',
    budget: BAD_SIGNATURE_BUDGET,
    inputs: forged,
    run: async (token) => {
      try {
        await verifier.verify(token)
        throw new Error('a forged token was accepted')
      } catch (error) {
        if (!(error instanceof Error) || error.name !== 'TokenVerificationError') {
          throw error
        }
      }
    },
  },
  {
    name: 'middleware, valid token',
    budget: MIDDLEWARE_BUDGET,
    inputs: tokens,
    run: async (token) => {
      const res = await app.request('/me', { headers: { authorization: `Bearer ${token}` } })
      if (res.status !== 204) {
        throw new Error(`middleware answered ${res.status}`)
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
const fetchesBefore = fetches
for (const leg of legs) {
  for (const token of leg.inputs.slice(0, WARMUP)) {
    await leg.run(token)
  }
  const samples: number[] = []
  for (const token of leg.inputs.slice(WARMUP)) {
    const start = performance.now()
    await leg.run(token)
    samples.push(performance.now() - start)
  }
  const mean = samples.reduce((sum, ms) => sum + ms, 0) / samples.length
  const batchSize = Math.floor(samples.length / BATCHES)
  const batchP99s: number[] = []
  for (let b = 0; b < BATCHES; b++) {
    batchP99s.push(percentile(samples.slice(b * batchSize, (b + 1) * batchSize), 0.95))
  }
  const median = percentile(samples, 0.5)
  const tail = Math.min(...batchP99s)
  process.stdout.write(
    `${leg.name} (warm cache, ${samples.length} tokens): mean ${mean.toFixed(3)} ms ` +
      `(budget ${leg.budget.meanMs}), median ${median.toFixed(3)} ms (budget ${leg.budget.medianMs}), ` +
      `best-of-${BATCHES} p95 ${tail.toFixed(3)} ms (budget ${leg.budget.tailMs})\n`
  )
  if (mean > leg.budget.meanMs) {
    failures.push(`${leg.name}: mean ${mean.toFixed(3)} ms > ${leg.budget.meanMs} ms`)
  }
  if (median > leg.budget.medianMs) {
    failures.push(`${leg.name}: median ${median.toFixed(3)} ms > ${leg.budget.medianMs} ms`)
  }
  if (tail > leg.budget.tailMs) {
    failures.push(
      `${leg.name}: best p95 of ${BATCHES} batches ${tail.toFixed(3)} ms > ${leg.budget.tailMs} ms`
    )
  }
}
process.stdout.write(`JWKS fetches after warm-up: ${fetches - fetchesBefore} (budget 0)\n`)
if (fetches !== fetchesBefore) {
  failures.push('a leg fetched the JWKS with a warm cache')
}
if (failures.length > 0) {
  process.stderr.write(`bench failed: ${failures.join('; ')}\n`)
  process.exit(1)
}
