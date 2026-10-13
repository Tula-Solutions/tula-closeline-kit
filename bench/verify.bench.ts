import { createRemoteKeySet } from '../src/auth/keys'
import { createTestJwks, createTestKeyPair, mintTestToken } from '../src/auth/testing'
import { createTokenVerifier } from '../src/auth/verifier'
import { createFixedClock } from '../src/clock'

/**
 * Benchmark: TokenVerifier.verify with a warm key cache (the per-request hot path).
 *
 * Input: 2,000 distinct valid tokens (a fixed key, varied users), verified one after another.
 * Expected complexity per call: O(token length), one Ed25519 verification and one Map lookup;
 * no I/O, no allocation proportional to anything but the token.
 * Budget: mean under 0.5 ms per verify, p99 under 2.0 ms (measured ~0.04 / ~0.05 ms), and zero JWKS fetches after warm-up.
 */
const TOKENS = 2_000
const WARMUP = 200
const BUDGET_MEAN_MS = 0.5
const BUDGET_P99_MS = 2.0

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

const tokens: string[] = []
for (let i = 0; i < TOKENS + WARMUP; i++) {
  tokens.push(await mintTestToken({ keyPair: pair, clock }))
}
for (const token of tokens.slice(0, WARMUP)) {
  await verifier.verify(token)
}

const fetchesBefore = fetches
const samples: number[] = []
for (const token of tokens.slice(WARMUP)) {
  const start = performance.now()
  await verifier.verify(token)
  samples.push(performance.now() - start)
}
samples.sort((a, b) => a - b)
const mean = samples.reduce((sum, ms) => sum + ms, 0) / samples.length
const p99 = samples[Math.floor(samples.length * 0.99)] ?? Number.POSITIVE_INFINITY

process.stdout.write(
  `verify (warm cache, ${TOKENS} tokens): mean ${mean.toFixed(3)} ms (budget ${BUDGET_MEAN_MS}), ` +
    `p99 ${p99.toFixed(3)} ms (budget ${BUDGET_P99_MS}), fetches ${fetches - fetchesBefore} (budget 0)\n`
)

const failures: string[] = []
if (mean > BUDGET_MEAN_MS) {
  failures.push(`mean ${mean.toFixed(3)} ms > ${BUDGET_MEAN_MS} ms`)
}
if (p99 > BUDGET_P99_MS) {
  failures.push(`p99 ${p99.toFixed(3)} ms > ${BUDGET_P99_MS} ms`)
}
if (fetches !== fetchesBefore) {
  failures.push('verify fetched the JWKS with a warm cache')
}
if (failures.length > 0) {
  process.stderr.write(`bench failed: ${failures.join('; ')}\n`)
  process.exit(1)
}
