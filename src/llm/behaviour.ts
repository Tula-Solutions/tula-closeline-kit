import { afterEach, describe, expect, test } from 'bun:test'
import type { OrganizationId } from 'tula-closeline-contract'
import { z } from 'zod'
import type { MemoryErrorReporter } from '../reporting/testing'
import { LLM_ERROR_CODES, LlmError } from './errors'
import type { LlmPort, LlmStreamEvent, LlmUsage } from './port'

/** What the behaviour suite needs from an adapter under test. */
export interface LlmSubject {
  /** The port under test. */
  port: LlmPort
  /** Two unrelated Organization ids the port accepts. */
  organizations: { a: OrganizationId; b: OrganizationId }
  /** The reporter the port was built with: the suite reads what it was given. */
  reporter: MemoryErrorReporter
  /** Everything the port logged, one JSON or text line per entry. */
  logs(): string[]
  /** Arranges that the next call that reaches the model is answered with `text`. */
  reply(text: string, usage?: Partial<LlmUsage>): void
  /** Arranges that the next call that reaches the model never answers, until it is aborted. */
  hang(): void
  /** Arranges that the next `times` vendor requests fail: `retryable` as throttling or a 5xx, `fatal` as refused credentials. */
  failNext(kind: 'retryable' | 'fatal', times: number): void
  /** How many requests have reached the vendor, a retry counting as its own. */
  vendorRequests(): number
  /** How many vendor requests were aborted while they were still pending. */
  abortedRequests(): number
  /** Removes what the subject created. */
  close(): Promise<void>
}

const SECRET_PROMPT = 'zebra confidential pricing'
const SECRET_SYSTEM = 'SYSTEM-MARKER-INSTRUCTIONS'
const SECRET_ANSWER = 'ANSWER-MARKER-PAYLOAD'

const answerSchema = z.object({ intent: z.enum(['buy', 'wait']), confidence: z.number() })

/**
 * The behaviour every {@link LlmPort} must show: a structured answer comes back typed with its
 * usage; output that is not JSON, does not fit the schema or was cut off is `llm.invalid_output`
 * and never a partial value; the timeout and the caller's signal abort the vendor request; a
 * prompt over the input budget never reaches the vendor; a stream delivers text then one `done`
 * and a reader that stops early aborts the request; only retryable vendor errors are retried and
 * only a bounded number of times; a bad request is refused before any vendor call; and neither a
 * prompt nor a completion reaches a log, the error reporter or an error. Run it against the
 * memory adapter and any real adapter (which needs a subject that drives the vendor's test mode).
 */
export function llmBehaviour(name: string, make: () => Promise<LlmSubject>, skip = false): void {
  const run = skip ? describe.skip : describe
  run(`LLM behaviour: ${name}`, () => {
    const made: LlmSubject[] = []
    afterEach(async () => {
      await Promise.all(made.splice(0).map((subject) => subject.close()))
    })
    async function subject(): Promise<LlmSubject> {
      const next = await make()
      made.push(next)
      return next
    }

    const retry = { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 4 }
    const good = JSON.stringify({ intent: 'buy', confidence: 0.9 })

    function base(s: LlmSubject, content = 'what does the prospect want?') {
      return {
        organizationId: s.organizations.a,
        tier: 'fast' as const,
        messages: [{ role: 'user' as const, content }],
        retry,
      }
    }

    function complete(s: LlmSubject, overrides: Record<string, unknown> = {}) {
      return s.port.complete({
        ...base(s),
        schema: answerSchema,
        schemaName: 'answer',
        ...overrides,
      })
    }

    async function collect(iterable: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
      const out: LlmStreamEvent[] = []
      for await (const event of iterable) {
        out.push(event)
      }
      return out
    }

    async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
      try {
        await promise
        return undefined
      } catch (error) {
        return error instanceof LlmError ? error.code : `not an LlmError: ${String(error)}`
      }
    }

    test('a structured answer comes back typed, with its usage', async () => {
      const s = await subject()
      s.reply(good, { inputTokens: 11, outputTokens: 7 })
      const result = await complete(s)
      expect(result.value).toEqual({ intent: 'buy', confidence: 0.9 })
      expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7 })
      expect(s.vendorRequests()).toBe(1)
    })

    test('usage is always a pair of non-negative whole numbers', async () => {
      const s = await subject()
      s.reply(good)
      const { usage } = await complete(s)
      expect(Number.isInteger(usage.inputTokens) && usage.inputTokens > 0).toBe(true)
      expect(Number.isInteger(usage.outputTokens) && usage.outputTokens > 0).toBe(true)
    })

    test('output that is not JSON is llm.invalid_output', async () => {
      const s = await subject()
      s.reply('I think they want to buy.')
      expect(await codeOf(complete(s))).toBe(LLM_ERROR_CODES.invalidOutput)
    })

    test('output that does not fit the schema is llm.invalid_output, never a partial value', async () => {
      const s = await subject()
      s.reply(JSON.stringify({ intent: 'buy' }))
      expect(await codeOf(complete(s))).toBe(LLM_ERROR_CODES.invalidOutput)
      s.reply(JSON.stringify({ intent: 'steal', confidence: 1 }))
      expect(await codeOf(complete(s))).toBe(LLM_ERROR_CODES.invalidOutput)
    })

    test('output cut off by the output budget is llm.invalid_output', async () => {
      const s = await subject()
      s.reply(JSON.stringify({ intent: 'buy', confidence: 0.9, note: 'x'.repeat(300) }))
      expect(await codeOf(complete(s, { maxOutputTokens: 10 }))).toBe(LLM_ERROR_CODES.invalidOutput)
    })

    test('invalid output is not retried', async () => {
      const s = await subject()
      s.reply('nonsense')
      await codeOf(complete(s))
      expect(s.vendorRequests()).toBe(1)
    })

    test('the timeout aborts the vendor request and fails with llm.timeout', async () => {
      const s = await subject()
      s.hang()
      const started = Date.now()
      expect(await codeOf(complete(s, { timeoutMs: 30 }))).toBe(LLM_ERROR_CODES.timeout)
      expect(Date.now() - started).toBeLessThan(2000)
      expect(s.vendorRequests()).toBe(1)
      expect(s.abortedRequests()).toBe(1)
    })

    test('the caller signal aborts the vendor request and fails with llm.aborted', async () => {
      const s = await subject()
      s.hang()
      const controller = new AbortController()
      const pending = codeOf(complete(s, { signal: controller.signal }))
      setTimeout(() => controller.abort(), 10)
      expect(await pending).toBe(LLM_ERROR_CODES.aborted)
      expect(s.abortedRequests()).toBe(1)
    })

    test('a signal that is already aborted never reaches the vendor', async () => {
      const s = await subject()
      s.reply(good)
      expect(await codeOf(complete(s, { signal: AbortSignal.abort() }))).toBe(
        LLM_ERROR_CODES.aborted
      )
      expect(s.vendorRequests()).toBeLessThanOrEqual(1)
      expect(s.abortedRequests()).toBe(s.vendorRequests())
    })

    test('a prompt over the input budget is llm.input_too_large and never reaches the vendor', async () => {
      const s = await subject()
      s.reply(good)
      const big = { ...base(s, 'word '.repeat(2000)), maxInputTokens: 100 }
      expect(await codeOf(complete(s, big))).toBe(LLM_ERROR_CODES.inputTooLarge)
      expect(() => s.port.stream(big)).toThrow(LlmError)
      expect(s.vendorRequests()).toBe(0)
    })

    test('a request that is not acceptable is refused before any vendor call', async () => {
      const s = await subject()
      s.reply(good)
      const bad: Record<string, unknown>[] = [
        { organizationId: 'org_nope' },
        { tier: 'gpt-9' },
        { messages: [] },
        { messages: [{ role: 'user', content: '' }] },
        { messages: [{ role: 'assistant', content: 'hi' }] },
        { messages: [{ role: 'system', content: 'hi' }] },
        { timeoutMs: 0 },
        { timeoutMs: 10_000_000 },
        { maxInputTokens: -1 },
        { maxOutputTokens: 1_000_000 },
        { retry: { maxRetries: 99 } },
        { retry: { baseDelayMs: 100, maxDelayMs: 10 } },
        { schema: { not: 'a schema' } },
        { schemaName: 'has spaces' },
        { schema: z.object({ at: z.date() }) },
      ]
      for (const overrides of bad) {
        expect(await codeOf(complete(s, overrides))).toBe(LLM_ERROR_CODES.invalidRequest)
      }
      expect(s.vendorRequests()).toBe(0)
    })

    test('a stream delivers its text in order and ends with one done event', async () => {
      const s = await subject()
      s.reply('we can offer a discount today', { inputTokens: 9, outputTokens: 6 })
      const events = await collect(s.port.stream(base(s)))
      const done = events.at(-1)
      expect(events.filter((e) => e.type === 'done')).toHaveLength(1)
      expect(done).toEqual({
        type: 'done',
        stopReason: 'end',
        usage: { inputTokens: 9, outputTokens: 6 },
      })
      const text = events.flatMap((e) => (e.type === 'text' ? [e.text] : []))
      expect(text.every((piece) => piece.length > 0)).toBe(true)
      expect(text.join('')).toBe('we can offer a discount today')
    })

    test('a stream that hits the output budget stops with max_tokens, within the budget', async () => {
      const s = await subject()
      s.reply('lorem ipsum '.repeat(100))
      const events = await collect(s.port.stream({ ...base(s), maxOutputTokens: 5 }))
      const done = events.at(-1)
      expect(done?.type === 'done' && done.stopReason).toBe('max_tokens')
      expect(done?.type === 'done' && done.usage.outputTokens).toBeLessThanOrEqual(5)
      const text = events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('')
      expect(text.length).toBeLessThan(100)
    })

    test('a reader that stops early aborts the vendor request', async () => {
      const s = await subject()
      s.reply('one two three four five six seven eight')
      for await (const event of s.port.stream(base(s))) {
        if (event.type === 'text') {
          break
        }
      }
      expect(s.abortedRequests()).toBe(1)
    })

    test('the timeout covers a stream and aborts its vendor request', async () => {
      const s = await subject()
      s.hang()
      const code = await codeOf(collect(s.port.stream({ ...base(s), timeoutMs: 30 })))
      expect(code).toBe(LLM_ERROR_CODES.timeout)
      expect(s.abortedRequests()).toBe(1)
    })

    test('a retryable vendor error is retried and the call then succeeds', async () => {
      const s = await subject()
      s.failNext('retryable', 2)
      s.reply(good)
      const result = await complete(s)
      expect(result.value.intent).toBe('buy')
      expect(s.vendorRequests()).toBe(3)
    })

    test('retries are bounded and the last error is llm.unavailable', async () => {
      const s = await subject()
      s.failNext('retryable', 10)
      s.reply(good)
      expect(await codeOf(complete(s))).toBe(LLM_ERROR_CODES.unavailable)
      expect(s.vendorRequests()).toBe(3)
      s.failNext('retryable', 10)
      expect(
        await codeOf(complete(s, { retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 } }))
      ).toBe(LLM_ERROR_CODES.unavailable)
      expect(s.vendorRequests()).toBe(4)
    })

    test('a vendor error that a retry cannot fix is llm.rejected and is not retried', async () => {
      const s = await subject()
      s.failNext('fatal', 1)
      s.reply(good)
      expect(await codeOf(complete(s))).toBe(LLM_ERROR_CODES.rejected)
      expect(s.vendorRequests()).toBe(1)
    })

    test('a stream retries before its first text', async () => {
      const s = await subject()
      s.failNext('retryable', 1)
      s.reply('hello there')
      const events = await collect(s.port.stream(base(s)))
      expect(events.at(-1)?.type).toBe('done')
      expect(s.vendorRequests()).toBe(2)
    })

    test('a failure is reported with the Organization and no text', async () => {
      const s = await subject()
      s.failNext('retryable', 10)
      await codeOf(complete(s))
      expect(s.reporter.captured).toHaveLength(1)
      expect(s.reporter.captured[0]?.error).toMatchObject({ code: LLM_ERROR_CODES.unavailable })
      expect(s.reporter.captured[0]?.context.organizationId).toBe(s.organizations.a)
      const tags = s.reporter.captured[0]?.context.tags ?? {}
      expect(Object.keys(tags).sort()).toEqual(['feature', 'tier'])
    })

    test('a timeout and a caller cancel are not reported', async () => {
      const s = await subject()
      s.hang()
      await codeOf(complete(s, { timeoutMs: 20 }))
      s.hang()
      const controller = new AbortController()
      const pending = codeOf(complete(s, { signal: controller.signal }))
      setTimeout(() => controller.abort(), 10)
      expect(await pending).toBe(LLM_ERROR_CODES.aborted)
      expect(s.reporter.captured).toHaveLength(0)
    })

    test('no prompt and no completion reaches a log, the error reporter or an error', async () => {
      const s = await subject()
      const seenErrors: unknown[] = []
      const system = SECRET_SYSTEM
      const ask = { ...base(s, SECRET_PROMPT), system }

      s.reply(JSON.stringify({ intent: 'buy', confidence: 0.9, note: SECRET_ANSWER }))
      await s.port.complete({ ...ask, schema: answerSchema, schemaName: 'answer' })

      s.reply(JSON.stringify({ intent: SECRET_ANSWER }))
      await s.port
        .complete({ ...ask, schema: answerSchema, schemaName: 'answer' })
        .catch((error) => seenErrors.push(error))

      s.reply(SECRET_ANSWER)
      await s.port
        .complete({ ...ask, schema: answerSchema, schemaName: 'answer' })
        .catch((error) => seenErrors.push(error))

      s.failNext('retryable', 3)
      await s.port
        .complete({ ...ask, schema: answerSchema, schemaName: 'answer' })
        .catch((error) => seenErrors.push(error))

      s.reply(`stream ${SECRET_ANSWER}`)
      await collect(s.port.stream(ask))

      s.failNext('fatal', 1)
      await collect(s.port.stream(ask)).catch((error) => seenErrors.push(error))

      expect(seenErrors.length).toBeGreaterThan(0)
      const asText = (value: unknown) =>
        JSON.stringify(value, (_key, v) =>
          v instanceof Error
            ? { ...v, name: v.name, message: v.message, stack: v.stack, cause: v.cause }
            : v
        )
      const seen = [...s.logs(), asText(s.reporter.captured), asText(seenErrors)].join('\n')
      for (const secret of [SECRET_PROMPT, 'confidential', 'zebra', SECRET_SYSTEM, SECRET_ANSWER]) {
        expect(seen).not.toContain(secret)
      }
    })
  })
}
