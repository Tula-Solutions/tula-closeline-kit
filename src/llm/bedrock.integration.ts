import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { organizationIdSchema } from 'tula-closeline-contract'
import { z } from 'zod'
import { createBedrockLlm } from './bedrock'
import { LLM_ERROR_CODES, LlmError } from './errors'
import type { LlmStreamEvent } from './port'

/**
 * Calls Amazon Bedrock for real, in the Region named by `BEDROCK_TEST_REGION`, with the AWS
 * credentials of the default chain. It spends a few tokens of the fast model (or `BEDROCK_TEST_MODEL`).
 * The shared `LlmPort` behaviour suite needs scripted replies, hangs and failures, so it runs
 * against a scripted client in `bedrock.behaviour.test.ts`; this file checks the same port against
 * the real service: a structured answer, a stream, a tiny time limit and a cancel.
 *
 * Without `BEDROCK_TEST_REGION` it is skipped and says so on stderr. It never fails CI for want of
 * credentials: a model account is not part of the local stack.
 */
const region = process.env.BEDROCK_TEST_REGION
const organizationId = organizationIdSchema.parse(`org_${'a'.repeat(32)}`)

if (region === undefined || region === '') {
  process.stderr.write(
    'SKIPPED: the Bedrock adapter was not run against Bedrock. Set BEDROCK_TEST_REGION (and AWS credentials) and run `bun run test:integration`.\n'
  )
  describe.skip('LLM integration: Bedrock adapter (BEDROCK_TEST_REGION not set)', () => {
    test('skipped', () => undefined)
  })
} else {
  setDefaultTimeout(60_000)
  const model = process.env.BEDROCK_TEST_MODEL
  const port = createBedrockLlm({
    region,
    ...(model === undefined || model === '' ? {} : { models: { fast: model } }),
  })
  const base = {
    organizationId,
    tier: 'fast' as const,
    messages: [{ role: 'user' as const, content: 'Is the sky blue? Answer yes or no.' }],
    maxOutputTokens: 200,
  }

  describe(`LLM integration: Bedrock adapter in ${region}`, () => {
    test('a structured answer comes back typed, with its usage', async () => {
      const result = await port.complete({
        ...base,
        schema: z.object({ answer: z.enum(['yes', 'no']) }),
        schemaName: 'answer',
      })
      expect(['yes', 'no']).toContain(result.value.answer)
      expect(result.usage.inputTokens).toBeGreaterThan(0)
      expect(result.usage.outputTokens).toBeGreaterThan(0)
    })

    test('a stream delivers text then one done', async () => {
      const events: LlmStreamEvent[] = []
      for await (const event of port.stream(base)) {
        events.push(event)
      }
      expect(events.filter((e) => e.type === 'done')).toHaveLength(1)
      expect(events.at(-1)?.type).toBe('done')
      expect(events.some((e) => e.type === 'text')).toBe(true)
    })

    test('a time limit of 1 ms fails with llm.timeout', async () => {
      const error = await port
        .complete({
          ...base,
          schema: z.object({ answer: z.string() }),
          schemaName: 'answer',
          timeoutMs: 1,
          retry: { maxRetries: 0 },
        })
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(LlmError)
      expect((error as LlmError).code).toBe(LLM_ERROR_CODES.timeout)
    })

    test('a cancel fails with llm.aborted', async () => {
      const controller = new AbortController()
      const pending = port
        .complete({
          ...base,
          schema: z.object({ answer: z.string() }),
          schemaName: 'answer',
          signal: controller.signal,
        })
        .catch((e: unknown) => e)
      controller.abort()
      const error = await pending
      expect(error).toBeInstanceOf(LlmError)
      expect((error as LlmError).code).toBe(LLM_ERROR_CODES.aborted)
    })
  })
}
