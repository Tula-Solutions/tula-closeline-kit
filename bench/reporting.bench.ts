import { AppError } from '../src/errors'
import { createLogger } from '../src/logger'
import { createErrorReporter } from '../src/reporting/create'
import type { ErrorContext } from '../src/reporting/port'
import { createSentryReporter } from '../src/reporting/sentry'
import { scrubText } from '../src/scrub'

/**
 * Benchmark: reporting an error with no DSN configured, reporting one through the Sentry adapter,
 * and scrubbing free text, in six legs.
 *
 * Input: 2,000 distinct inputs per leg (300 for the 32 KiB leg), built from a fixed sequence (no
 * randomness), run one after another, each timed on its own.
 * - `capture, no-op reporter` is what every error path pays in `local` and in tests: one call on
 *   the reporter `createErrorReporter` returns when there is no DSN. Expected complexity O(1): an
 *   empty function.
 * - `scrubText, ordinary message` is what the logger pays on every line: a 100 to 200 character
 *   message with nothing to mask. Expected complexity O(message length), a handful of linear
 *   passes with literal anchors.
 * - `scrubText, message with secrets` has a bearer token, a JWT-shaped string, a key=value pair
 *   and URL credentials in it, so the masking path is covered too.
 * - `capture, Sentry adapter` is the whole synchronous cost of reporting one unexpected error
 *   with a DSN set: the bounded copy of the error, the SDK building the event, `beforeSend`
 *   (confine, key redaction, `scrubText` on every string) and handing the envelope to a fake
 *   transport that answers at once (nothing goes over the network). Each error has a cause and a
 *   short stack. Expected complexity O(message length + frames), bounded by the caps in
 *   `sentry.ts` (8 KiB per message, six errors, 16 KiB of stack per error).
 * - `scrubText, 32 KiB input` is the worst input size `scrubText` accepts (it cuts anything longer),
 *   mixed prose with secrets, email addresses, telephone numbers and card numbers in it. Expected
 *   complexity O(input length): about 0.6 ms measured, so it bounds what one log line or one
 *   error message can cost.
 * - `scrubText, 32 KiB of @` is an input made only of `@`, the shape that made email masking
 *   quadratic (a backward search from each `@` over the whole text). Expected complexity
 *   O(input length). The mixed-prose leg above cannot catch that, so this one has its own budget.
 *
 * Budgets, per call, and why each number (measured over many runs on one developer machine):
 * - mean: the regression gate across all 2,000 calls. Measured 0.0001 ms for the no-op capture,
 *   0.002 ms for an ordinary message and 0.003 ms for one with secrets; the budgets are 10x, 4x
 *   and 5x those.
 * - median: a second regression gate that one stall cannot move, about 5x the measured median
 *   (and 10x for the no-op capture, whose median is below the timer's resolution).
 * - tail: the best p95 of five batches of 400 calls, so a scheduler stall that lands in one or two
 *   batches cannot fail the check, while a real slowdown of the slow path, or a machine too loaded
 *   to measure, fails every batch. About 10x the measured 0.0001 ms, 8x 0.002 ms and 8x 0.004 ms.
 * - The Sentry leg measured 0.08 ms for the mean, median and p95; the budgets are 5x, 4x and 7x.
 *   The 32 KiB leg measured 0.6 ms; the budgets are 5x, 4x and 6x. Both are wide on purpose: they
 *   catch an accidental quadratic or an uncapped input, not a few percent. The 32 KiB of `@` leg
 *   measured 0.65 ms; the budgets are the same as the other 32 KiB leg.
 * The no-op budgets sit near the timer's resolution on purpose: a timer read costs about as much
 * as the call, so what the leg proves is that capture stays in the sub-microsecond range, which
 * is "nothing measurable" next to any request.
 */
const CALLS = 2_000
const WARMUP = 200
const CALLS_32K = 300
const WARMUP_32K = 30
const BATCHES = 5

interface Budget {
  meanMs: number
  medianMs: number
  tailMs: number
}
const CAPTURE_BUDGET: Budget = { meanMs: 0.001, medianMs: 0.0005, tailMs: 0.002 }
const SCRUB_PLAIN_BUDGET: Budget = { meanMs: 0.008, medianMs: 0.006, tailMs: 0.015 }
const SCRUB_SECRETS_BUDGET: Budget = { meanMs: 0.015, medianMs: 0.012, tailMs: 0.03 }
const SENTRY_CAPTURE_BUDGET: Budget = { meanMs: 0.4, medianMs: 0.35, tailMs: 0.6 }
const SCRUB_32K_BUDGET: Budget = { meanMs: 3, medianMs: 2.5, tailMs: 4 }
const SCRUB_AT_BUDGET: Budget = { meanMs: 3, medianMs: 2.5, tailMs: 4 }

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

const sentryReporter = createSentryReporter({
  dsn: 'https://abc123publickey@o123.ingest.sentry.io/456',
  service: 'bench',
  environment: 'staging',
  region: 'us',
  release: 'abc1234',
  logger: createLogger({ service: 'bench', level: 'silent' }),
  transport: () => ({
    send: async () => ({}),
    flush: async () => true,
  }),
})
const sentryInputs: CaptureInput[] = []
for (let i = 0; i < CALLS + WARMUP; i++) {
  sentryInputs.push({
    error: new Error(`failed ${i} calling upstream`, {
      cause: new Error(`connect ECONNRESET 10.0.${i % 255}.5:5432 password=hunter${i}`),
    }),
    context: {
      requestId: `req_${i}`,
      organizationId: `org_${i % 50}`,
      method: 'POST',
      path: `/v1/teams/${i}`,
      status: 500,
    },
  })
}

const BIG_UNIT = [
  'The customer asked about pricing and said call me on +1 (415) 555-0199 or 415-555-0188. ',
  'Email jane.doe@acme.com, card 4111 1111 1111 1111, request 7f3a9c20 took 345 ms. ',
  'upstream rejected Bearer abcdef0123456789abcd password=hunter2\n',
  'GET /v1/teams/team_01/members?limit=20&sig=abc123def failed with status 502, ',
  'connect postgres://app:pw@db.internal:5432/closeline Key (email)=(x@y.io) already exists.\n',
]
const bigMessages: string[] = []
for (let i = 0; i < CALLS_32K + WARMUP_32K; i++) {
  let text = `run ${i}: `
  for (let j = i; text.length < 32_768; j++) {
    text += BIG_UNIT[j % BIG_UNIT.length] as string
  }
  bigMessages.push(text.slice(0, 32_768))
}
if (scrubText(bigMessages[0] as string).includes('hunter2')) {
  process.stderr.write('bench failed: the 32 KiB messages are not being masked\n')
  process.exit(1)
}

// Only `@`, with a counter in front so the inputs differ: linear email masking is a few hundred
// microseconds on it; the quadratic search it replaced took 16 to 23 ms.
const atMessages: string[] = []
for (let i = 0; i < CALLS_32K + WARMUP_32K; i++) {
  const prefix = `run ${i}: `
  atMessages.push(prefix + '@'.repeat(32_768 - prefix.length))
}

interface Leg<T> {
  name: string
  budget: Budget
  /** Inputs for the warm-up calls first, then the timed ones. */
  inputs: T[]
  warmup: number
  run: (input: T) => void
}

const legs: Array<Leg<CaptureInput> | Leg<string>> = [
  {
    name: 'capture, no-op reporter',
    budget: CAPTURE_BUDGET,
    inputs: captureInputs,
    warmup: WARMUP,
    run: (input: CaptureInput) => reporter.capture(input.error, input.context),
  } satisfies Leg<CaptureInput>,
  {
    name: 'scrubText, ordinary message',
    budget: SCRUB_PLAIN_BUDGET,
    inputs: plainMessages,
    warmup: WARMUP,
    run: (message: string) => {
      scrubText(message)
    },
  } satisfies Leg<string>,
  {
    name: 'scrubText, message with secrets',
    budget: SCRUB_SECRETS_BUDGET,
    inputs: secretMessages,
    warmup: WARMUP,
    run: (message: string) => {
      scrubText(message)
    },
  } satisfies Leg<string>,
  {
    name: 'capture, Sentry adapter',
    budget: SENTRY_CAPTURE_BUDGET,
    inputs: sentryInputs,
    warmup: WARMUP,
    run: (input: CaptureInput) => sentryReporter.capture(input.error, input.context),
  } satisfies Leg<CaptureInput>,
  {
    name: 'scrubText, 32 KiB input',
    budget: SCRUB_32K_BUDGET,
    inputs: bigMessages,
    warmup: WARMUP_32K,
    run: (message: string) => {
      scrubText(message)
    },
  } satisfies Leg<string>,
  {
    name: 'scrubText, 32 KiB of @',
    budget: SCRUB_AT_BUDGET,
    inputs: atMessages,
    warmup: WARMUP_32K,
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
  for (const input of leg.inputs.slice(0, leg.warmup)) {
    leg.run(input)
  }
  const samples: number[] = []
  for (const input of leg.inputs.slice(leg.warmup)) {
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
// Let the fake transport finish, then release the SDK's listeners; neither is part of a leg.
await sentryReporter.close(2_000)
if (failures.length > 0) {
  process.stderr.write(`bench failed: ${failures.join('; ')}\n`)
  process.exit(1)
}
