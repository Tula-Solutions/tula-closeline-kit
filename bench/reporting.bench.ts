import { AppError } from '../src/errors'
import { createLogger } from '../src/logger'
import { createErrorReporter } from '../src/reporting/create'
import type { ErrorContext } from '../src/reporting/port'
import { scrubText } from '../src/scrub'

/**
 * Benchmark: reporting an error with no DSN configured, and scrubbing free text, in three legs.
 *
 * Input: 2,000 distinct inputs per leg, built from a fixed sequence (no randomness), run one after
 * another, each timed on its own.
 * - `capture, no-op reporter` is what every error path pays in `local` and in tests: one call on
 *   the reporter `createErrorReporter` returns when there is no DSN. Expected complexity O(1): an
 *   empty function.
 * - `scrubText, ordinary message` is what the logger pays on every line: a 100 to 200 character
 *   message with nothing to mask. Expected complexity O(message length), a handful of linear
 *   passes with literal anchors.
 * - `scrubText, message with secrets` has a bearer token, a JWT-shaped string, a key=value pair
 *   and URL credentials in it, so the masking path is covered too.
 *
 * Budgets, per call, and why each number (measured over many runs on one developer machine):
 * - mean: the regression gate across all 2,000 calls. Measured 0.0001 ms for the no-op capture,
 *   0.0009 ms for an ordinary message and 0.003 ms for one with secrets; the budgets are 10x, 5x
 *   and 5x those.
 * - median: a second regression gate that one stall cannot move, about 5x the measured median
 *   (and 10x for the no-op capture, whose median is below the timer's resolution).
 * - tail: the best p95 of five batches of 400 calls, so a scheduler stall that lands in one or two
 *   batches cannot fail the check, while a real slowdown of the slow path, or a machine too loaded
 *   to measure, fails every batch. About 10x the measured 0.0001, 0.001 and 0.0044 ms.
 * The no-op budgets sit near the timer's resolution on purpose: a timer read costs about as much
 * as the call, so what the leg proves is that capture stays in the sub-microsecond range, which
 * is "nothing measurable" next to any request.
 */
const CALLS = 2_000
const WARMUP = 200
const BATCHES = 5

interface Budget {
  meanMs: number
  medianMs: number
  tailMs: number
}
const CAPTURE_BUDGET: Budget = { meanMs: 0.001, medianMs: 0.0005, tailMs: 0.002 }
const SCRUB_PLAIN_BUDGET: Budget = { meanMs: 0.005, medianMs: 0.004, tailMs: 0.01 }
const SCRUB_SECRETS_BUDGET: Budget = { meanMs: 0.015, medianMs: 0.012, tailMs: 0.03 }

const reporter = createErrorReporter({
  service: 'bench',
  environment: 'local',
  region: 'us',
  logger: createLogger({ service: 'bench', level: 'silent' }),
})

interface CaptureInput {
  error: unknown
  context: ErrorContext
}
const captureInputs: CaptureInput[] = []
for (let i = 0; i < CALLS + WARMUP; i++) {
  captureInputs.push({
    error:
      i % 3 === 0
        ? new AppError({ code: 'core.not_found', status: 404, message: `team ${i} not found` })
        : new Error(`failed ${i}`),
    context: {
      requestId: `req_${i}`,
      organizationId: `org_${i % 50}`,
      method: 'POST',
      path: `/v1/teams/${i}`,
      status: i % 3 === 0 ? 404 : 500,
    },
  })
}

const plainMessages: string[] = []
const secretMessages: string[] = []
for (let i = 0; i < CALLS + WARMUP; i++) {
  plainMessages.push(
    `request ${i} to GET /v1/teams/team_${i} failed with status 502 after 3 retries in ${i % 97} ms (upstream timed out)`
  )
  secretMessages.push(
    `upstream ${i} rejected Bearer ${(123456789 + i).toString(36)}abcdef0123456789 ` +
      `(jwt eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1c3JfMSJ9.c2lnbmF0dXJl${i}) password=hunter${i} ` +
      `at https://app:pw${i}@api.example.com/v1/teams`
  )
}
if (!scrubText(secretMessages[0] as string).includes('[redacted]')) {
  process.stderr.write('bench failed: the secret messages are not being masked\n')
  process.exit(1)
}

interface Leg<T> {
  name: string
  budget: Budget
  inputs: T[]
  run: (input: T) => void
}

const legs: Array<Leg<CaptureInput> | Leg<string>> = [
  {
    name: 'capture, no-op reporter',
    budget: CAPTURE_BUDGET,
    inputs: captureInputs,
    run: (input: CaptureInput) => reporter.capture(input.error, input.context),
  } satisfies Leg<CaptureInput>,
  {
    name: 'scrubText, ordinary message',
    budget: SCRUB_PLAIN_BUDGET,
    inputs: plainMessages,
    run: (message: string) => {
      scrubText(message)
    },
  } satisfies Leg<string>,
  {
    name: 'scrubText, message with secrets',
    budget: SCRUB_SECRETS_BUDGET,
    inputs: secretMessages,
    run: (message: string) => {
      scrubText(message)
    },
  } satisfies Leg<string>,
]

/** The q-th quantile of the samples (0 to 1), by nearest rank. */
function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((x, y) => x - y)
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? Number.POSITIVE_INFINITY
  )
}

const failures: string[] = []
for (const leg of legs as Array<Leg<unknown>>) {
  for (const input of leg.inputs.slice(0, WARMUP)) {
    leg.run(input)
  }
  const samples: number[] = []
  for (const input of leg.inputs.slice(WARMUP)) {
    const start = performance.now()
    leg.run(input)
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
