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
 * Budgets, mean and p99 per call (measured over four runs on one machine), and why each number:
 * - verify, valid token: 0.5 ms and 2.0 ms. These are the figures in AGENTS.md, set generously
 *   before the other legs existed; measured about 0.057 ms mean and 0.09 to 0.11 ms p99.
 * - verify, bad signature: the check fails only after the work of a success, so it costs about
 *   the same (measured 0.055 ms mean, 0.08 to 0.11 ms p99). Budget 0.3 ms and 0.5 ms, about 5x.
 * - middleware: header parse, verify, context writes and a Hono route through `app.request`,
 *   which also builds a Request and Response (measured 0.06 ms mean, 0.09 to 0.19 ms p99). Budget
 *   0.3 ms and 0.9 ms, about 5x the mean and 5x the worst p99 seen.
 * Each leg also asserts zero JWKS fetches after warm-up.
 */
const TOKENS = 2_000
const WARMUP = 200

interface Budget {
  meanMs: number
  p99Ms: number
}
const VERIFY_BUDGET: Budget = { meanMs: 0.5, p99Ms: 2.0 }
const BAD_SIGNATURE_BUDGET: Budget = { meanMs: 0.3, p99Ms: 0.5 }
const MIDDLEWARE_BUDGET: Budget = { meanMs: 0.3, p99Ms: 0.9 }

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
  samples.sort((a, b) => a - b)
  const mean = samples.reduce((sum, ms) => sum + ms, 0) / samples.length
  const p99 = samples[Math.floor(samples.length * 0.99)] ?? Number.POSITIVE_INFINITY
  process.stdout.write(
    `${leg.name} (warm cache, ${samples.length} tokens): mean ${mean.toFixed(3)} ms ` +
      `(budget ${leg.budget.meanMs}), p99 ${p99.toFixed(3)} ms (budget ${leg.budget.p99Ms})\n`
  )
  if (mean > leg.budget.meanMs) {
    failures.push(`${leg.name}: mean ${mean.toFixed(3)} ms > ${leg.budget.meanMs} ms`)
  }
  if (p99 > leg.budget.p99Ms) {
    failures.push(`${leg.name}: p99 ${p99.toFixed(3)} ms > ${leg.budget.p99Ms} ms`)
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
