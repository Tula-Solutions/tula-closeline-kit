import { formatId, organizationIdSchema, type ProspectId } from 'tula-closeline-contract'
import { createMemoryContactGuard } from '../src/consent/memory'
import { createMemoryMessaging } from '../src/messaging/memory'
import { classifyMessageIntent } from '../src/messaging/webhook'

/**
 * Benchmark: the memory adapter of the messaging port, the overhead the port adds to each message
 * on a request path. A real adapter adds the vendor's network time on top; this measures only the
 * code every adapter shares (validation, the consent check, the dedupe, the webhook signature).
 *
 * Input: fixed scripted messages, a memory Contact Check that allows the Prospect, no delays.
 * - `send` times `send` of a 160-character SMS with a fresh idempotency key each time.
 *   Expected complexity O(body length + 1): strict validation of a small request, one consent
 *   call, one sha256 over the content and one map insert. Independent of how many messages were
 *   sent before it except for the dedupe map's O(1) lookup.
 * - `webhook` times `receive` of a typical signed inbound message: one HMAC-SHA1 over the URL and
 *   the form (about 200 bytes), one form parse and the field checks. Expected O(form size).
 * - `intent` times the STOP keyword classification of a 100-character reply. Expected O(length),
 *   one trim, one case fold and a set lookup.
 *
 * Budgets, per call, about five times the fastest measured of several batches on one developer
 * machine (measured numbers in the comment beside each budget), with a mean floor of 0.02 ms. The
 * median and the best-of-five p95 are used as in `queue.bench.ts`, so one scheduler stall cannot
 * fail the check. They catch an accidental quadratic or a copy per call, not a few percent.
 */
const ORG = organizationIdSchema.parse(`org_${'1'.repeat(32)}`)
const PROSPECT = formatId('prs', '1'.repeat(32)) as ProspectId
const BATCHES = 5

interface Budget {
  meanMs: number
  medianMs: number
  tailMs: number
}
const BUDGETS = {
  // Measured locally: mean 0.0069, median 0.0050, best-of-5 p95 0.0082 ms (two Contact Checks per
  // send). A shared CI runner is about four times slower: mean 0.0298, median 0.0246 and best-of-5
  // p95 0.04013 ms, which failed the earlier 0.04 ms tail budget. These are about five times the CI
  // numbers, so a noisy runner passes and an accidental quadratic or per-call copy still fails.
  send: { meanMs: 0.15, medianMs: 0.12, tailMs: 0.2 },
  // Measured locally: mean 0.0053, median 0.0041, best-of-5 p95 0.0061 ms. Like send, sized at about
  // five times a CI runner, which is about four times slower than local.
  webhook: { meanMs: 0.11, medianMs: 0.08, tailMs: 0.12 },
  // Measured: mean 0.00029, median 0.00025, best-of-5 p95 0.00029 ms; the budget is a 0.02 ms floor.
  intent: { meanMs: 0.02, medianMs: 0.02, tailMs: 0.02 },
} satisfies Record<string, Budget>

const guard = createMemoryContactGuard()
guard.allow({ organizationId: ORG, prospectId: PROSPECT, phone: '+14155550142' }, 'sms')
const messaging = createMemoryMessaging({ guard })
const inbound = messaging.inbound({
  from: '+14155550142',
  to: '+14155550199',
  body: 'Thanks, can you call me tomorrow at ten about the quote?',
})
const REPLY =
  'Please do not stop by on Tuesday, but call me about the quote after lunch on Wednesday.'
let counter = 0

async function sendSamples(count: number): Promise<number[]> {
  const samples: number[] = []
  for (let i = 0; i < count; i++) {
    counter += 1
    const request = {
      organizationId: ORG,
      prospectId: PROSPECT,
      channel: 'sms',
      purpose: 'agent_initiated',
      to: '+14155550142',
      content: { kind: 'text', body: 'x'.repeat(160) },
      idempotencyKey: `bench-${counter}`,
    } as const
    const start = performance.now()
    await messaging.send(request)
    samples.push(performance.now() - start)
  }
  return samples
}

async function webhookSamples(count: number): Promise<number[]> {
  const samples: number[] = []
  for (let i = 0; i < count; i++) {
    const start = performance.now()
    await messaging.receive(inbound)
    samples.push(performance.now() - start)
  }
  return samples
}

function intentSamples(count: number): number[] {
  const samples: number[] = []
  for (let i = 0; i < count; i++) {
    const start = performance.now()
    classifyMessageIntent(REPLY)
    samples.push(performance.now() - start)
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

await sendSamples(500)
report('send', await sendSamples(5_000), BUDGETS.send)
await webhookSamples(500)
report('webhook', await webhookSamples(5_000), BUDGETS.webhook)
intentSamples(2_000)
report('intent', intentSamples(20_000), BUDGETS.intent)

if (failures.length > 0) {
  process.stderr.write(`bench failed: ${failures.join('; ')}\n`)
  process.exit(1)
}
