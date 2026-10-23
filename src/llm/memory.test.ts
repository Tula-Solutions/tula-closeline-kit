import { describe, expect, test } from 'bun:test'
import { organizationIdSchema } from 'tula-closeline-contract'
import { z } from 'zod'
import { startDeadline, withLlmRetry } from './deadline'
import { LLM_ERROR_CODES, LlmError } from './errors'
import { createMemoryLlm } from './memory'
import {
  DEFAULT_LLM_RETRY_POLICY,
  estimateTokens,
  type LlmStreamEvent,
  llmRetryDelayMs,
} from './port'
import { parseModelOutput, resolveRetryPolicy } from './validate'

const org = organizationIdSchema.parse(`org_${'a'.repeat(32)}`)
const request = {
  organizationId: org,
  tier: 'smart',
  messages: [{ role: 'user', content: 'hello' }],
} as const
const schema = z.object({ n: z.number().int() })

describe('llmRetryDelayMs', () => {
  const policy = { maxRetries: 5, baseDelayMs: 100, maxDelayMs: 500 }
  test('doubles up to the maximum', () => {
    expect([1, 2, 3, 4, 5].map((n) => llmRetryDelayMs(n, policy, () => 0.5))).toEqual([
      100, 200, 400, 500, 500,
    ])
  })
  test('jitters between half and one and a half times', () => {
    expect(llmRetryDelayMs(2, policy, () => 0)).toBe(100)
    expect(llmRetryDelayMs(2, policy, () => 0.999)).toBe(299)
  })
  test('the default policy is bounded', () => {
    expect(resolveRetryPolicy(undefined)).toEqual(DEFAULT_LLM_RETRY_POLICY)
  })
})

describe('estimateTokens', () => {
  test('rounds up and runs high', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(2)
  })
})

describe('parseModelOutput', () => {
  test('a valid answer is parsed, transforms included', () => {
    const withTransform = z.object({ n: z.number() }).transform((v) => v.n * 2)
    expect(parseModelOutput(withTransform, '{"n":4}')).toBe(8)
  })
  test('an invalid one carries a reason and a count, not the output', () => {
    try {
      parseModelOutput(schema, '{"n":"SECRET"}')
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(LlmError)
      expect(JSON.stringify((error as LlmError).details)).not.toContain('SECRET')
      expect((error as LlmError).message).not.toContain('SECRET')
      expect((error as LlmError).details).toEqual({ reason: 'schema', issues: 1 })
    }
  })
})

describe('withLlmRetry', () => {
  test('does not retry past the deadline', async () => {
    const deadline = startDeadline(5)
    let attempts = 0
    const result = withLlmRetry(
      async () => {
        attempts += 1
        throw new LlmError(LLM_ERROR_CODES.unavailable, 'down')
      },
      {
        policy: { maxRetries: 5, baseDelayMs: 50, maxDelayMs: 50 },
        deadline,
        sleep: (ms, signal) =>
          new Promise((resolve) => {
            const timer = setTimeout(resolve, ms)
            signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer)
                resolve()
              },
              { once: true }
            )
          }),
      }
    )
    await expect(result).rejects.toMatchObject({ code: LLM_ERROR_CODES.timeout })
    deadline.stop()
    expect(attempts).toBe(1)
  })
})

describe('createMemoryLlm', () => {
  test('replies are used in order, one per call that reaches the model', async () => {
    const memory = createMemoryLlm()
    memory.reply('{"n":1}')
    memory.reply('{"n":2}')
    const a = await memory.complete({ ...request, schema, schemaName: 'n' })
    const b = await memory.complete({ ...request, schema, schemaName: 'n' })
    expect([a.value.n, b.value.n]).toEqual([1, 2])
  })

  test('nothing scripted is llm.bad_response', async () => {
    const memory = createMemoryLlm()
    await expect(memory.complete({ ...request, schema, schemaName: 'n' })).rejects.toMatchObject({
      code: LLM_ERROR_CODES.badResponse,
    })
  })

  test('a stream that breaks mid-way throws llm.unavailable and is not retried', async () => {
    const memory = createMemoryLlm()
    memory.reply({ text: 'one two three four', failAfterChunks: 2 })
    const seen: LlmStreamEvent[] = []
    await expect(
      (async () => {
        for await (const event of memory.stream(request)) {
          seen.push(event)
        }
      })()
    ).rejects.toMatchObject({ code: LLM_ERROR_CODES.unavailable })
    expect(seen).toHaveLength(2)
    expect(memory.requests()).toHaveLength(1)
    expect(memory.requests()[0]?.outcome).toBe('failed')
  })

  test('scripted chunks must join to the text', () => {
    const memory = createMemoryLlm()
    expect(() => memory.reply({ text: 'ab', chunks: ['a', 'c'] })).toThrow(LlmError)
  })

  test('a vendor delay shorter than the limit still answers', async () => {
    const memory = createMemoryLlm()
    memory.reply({ text: '{"n":3}', delayMs: 5 })
    const result = await memory.complete({ ...request, schema, schemaName: 'n', timeoutMs: 1000 })
    expect(result.value.n).toBe(3)
    expect(memory.requests()[0]).toMatchObject({ outcome: 'ok', aborted: false, tier: 'smart' })
  })
})

describe('the testing entry', () => {
  test('exports createMemoryLlm for consumers', async () => {
    const testing = await import('../testing')
    const memory = testing.createMemoryLlm()
    memory.reply('{"n":5}')
    const result = await memory.complete({ ...request, schema, schemaName: 'n' })
    expect(result.value.n).toBe(5)
  })
})
