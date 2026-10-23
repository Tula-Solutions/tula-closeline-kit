import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  ConverseCommand,
  type ConverseCommandOutput,
  ConverseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime'
import { organizationIdSchema } from 'tula-closeline-contract'
import { z } from 'zod'
import { createMemoryErrorReporter } from '../reporting/testing'
import { createBedrockLlm } from './bedrock'
import { createFakeBedrock, sdkError } from './bedrock.fake'
import { createBedrockClient } from './bedrock-client'
import { LLM_ERROR_CODES, LlmError } from './errors'
import type { LlmStreamEvent } from './port'

const org = organizationIdSchema.parse(`org_${'a'.repeat(32)}`)
const schema = z.object({ intent: z.enum(['buy', 'wait']) })
const retry = { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 2 }

function build(region = 'eu-west-1', models?: { fast?: string; smart?: string }) {
  const fake = createFakeBedrock()
  const port = createBedrockLlm({
    region,
    client: fake.sender,
    sleep: async () => undefined,
    ...(models === undefined ? {} : { models }),
  })
  return { fake, port }
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
    return undefined
  } catch (error) {
    return error instanceof LlmError ? error.code : `other: ${String(error)}`
  }
}

describe('Region and model guards', () => {
  test('a Region that is not shaped like one is refused', () => {
    for (const region of ['', 'europe', 'EU-WEST-1', 'eu-west', 'https://x.example/']) {
      expect(() => createBedrockLlm({ region, client: createFakeBedrock().sender })).toThrow(
        TypeError
      )
    }
  })

  test('an inference profile whose prefix does not match the Region is refused at construction', () => {
    const refused: [string, string][] = [
      ['eu-west-1', 'us.anthropic.claude-haiku-5-5'],
      ['eu-central-1', 'apac.anthropic.claude-haiku-5-5'],
      ['us-east-1', 'eu.anthropic.claude-haiku-5-5'],
      ['ap-southeast-2', 'us.anthropic.claude-haiku-5-5'],
      ['eu-west-1', 'global.anthropic.claude-haiku-5-5'],
      ['us-east-1', 'global.anthropic.claude-haiku-5-5'],
      ['ca-central-1', 'us.anthropic.claude-haiku-5-5'],
      ['eu-west-1', 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.x'],
    ]
    for (const [region, id] of refused) {
      for (const tier of ['fast', 'smart'] as const) {
        expect(() =>
          createBedrockLlm({ region, client: createFakeBedrock().sender, models: { [tier]: id } })
        ).toThrow(TypeError)
      }
    }
  })

  test('a matching profile and a bare model id are accepted', () => {
    const accepted: [string, string][] = [
      ['eu-west-1', 'eu.anthropic.claude-haiku-5-5'],
      ['us-east-1', 'us.anthropic.claude-haiku-5-5'],
      ['ap-southeast-2', 'apac.anthropic.claude-haiku-5-5'],
      ['eu-west-1', 'anthropic.claude-haiku-5-5'],
      ['ca-central-1', 'anthropic.claude-haiku-5-5'],
    ]
    for (const [region, id] of accepted) {
      expect(() =>
        createBedrockLlm({ region, client: createFakeBedrock().sender, models: { fast: id } })
      ).not.toThrow()
    }
  })

  test('the default model ids pass the guard in every Region', () => {
    for (const region of ['eu-west-1', 'us-east-1', 'ap-southeast-2', 'ca-central-1']) {
      expect(() => build(region)).not.toThrow()
    }
  })

  test('the tiers use the configured model ids', async () => {
    const { fake, port } = build('eu-west-1', {
      fast: 'eu.anthropic.fast-model',
      smart: 'anthropic.smart-model',
    })
    fake.reply('hi')
    fake.reply('hi')
    for await (const _ of port.stream({
      organizationId: org,
      tier: 'fast',
      messages: [{ role: 'user', content: 'a' }],
    })) {
    }
    for await (const _ of port.stream({
      organizationId: org,
      tier: 'smart',
      messages: [{ role: 'user', content: 'a' }],
    })) {
    }
    expect(fake.requests.map((r) => r.input.modelId)).toEqual([
      'eu.anthropic.fast-model',
      'anthropic.smart-model',
    ])
  })
})

describe('the SDK client never leaves the Region', () => {
  let savedId: string | undefined
  let savedSecret: string | undefined
  beforeAll(() => {
    savedId = process.env.AWS_ACCESS_KEY_ID
    savedSecret = process.env.AWS_SECRET_ACCESS_KEY
    process.env.AWS_ACCESS_KEY_ID = 'test'
    process.env.AWS_SECRET_ACCESS_KEY = 'test'
  })
  afterAll(() => {
    for (const [name, value] of [
      ['AWS_ACCESS_KEY_ID', savedId],
      ['AWS_SECRET_ACCESS_KEY', savedSecret],
    ] as const) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
  })

  async function hostOf(region: string): Promise<{ host?: string; region: string }> {
    const client = createBedrockClient({ region, connectTimeoutMs: 1000 })
    let host: string | undefined
    client.middlewareStack.add(
      () => async (args) => {
        host = (args.request as { hostname?: string }).hostname
        throw new Error('stop before sending')
      },
      { step: 'build', name: 'captureHost' }
    )
    await client
      .send(
        new ConverseCommand({
          modelId: 'm',
          messages: [{ role: 'user', content: [{ text: 'x' }] }],
        })
      )
      .catch(() => undefined)
    return { ...(host === undefined ? {} : { host }), region: await client.config.region() }
  }

  test('an eu Region resolves to an eu endpoint and never a us one', async () => {
    for (const region of ['eu-west-1', 'eu-central-1', 'eu-north-1']) {
      const seen = await hostOf(region)
      expect(seen.region).toBe(region)
      expect(seen.host).toBe(`bedrock-runtime.${region}.amazonaws.com`)
      expect(seen.host).not.toMatch(/\.us-|^bedrock-runtime\.us-/)
    }
  })

  test('the endpoint environment variables are refused', () => {
    for (const name of ['AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_BEDROCK_RUNTIME']) {
      process.env[name] = 'https://bedrock-runtime.us-east-1.amazonaws.com'
      try {
        expect(() => createBedrockLlm({ region: 'eu-west-1' })).toThrow(TypeError)
      } finally {
        delete process.env[name]
      }
    }
  })
})

describe('request mapping', () => {
  test('complete sends the prompt as Converse messages with a forced tool of the schema', async () => {
    const { fake, port } = build()
    fake.reply('{"intent":"buy"}', { inputTokens: 12, outputTokens: 4 })
    const result = await port.complete({
      organizationId: org,
      tier: 'fast',
      system: 'be brief',
      messages: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'two' },
        { role: 'user', content: 'three' },
      ],
      schema,
      schemaName: 'answer',
      maxOutputTokens: 200,
    })
    expect(result).toEqual({
      value: { intent: 'buy' },
      usage: { inputTokens: 12, outputTokens: 4 },
    })
    const input = fake.requests[0]?.input
    expect(input?.modelId).toBe('anthropic.claude-haiku-5-5')
    expect(input?.system).toEqual([{ text: 'be brief' }])
    expect(input?.messages).toEqual([
      { role: 'user', content: [{ text: 'one' }] },
      { role: 'assistant', content: [{ text: 'two' }] },
      { role: 'user', content: [{ text: 'three' }] },
    ])
    expect(input?.inferenceConfig?.maxTokens).toBe(200)
    expect(input?.toolConfig?.toolChoice).toEqual({ tool: { name: 'answer' } })
    const spec = input?.toolConfig?.tools?.[0]?.toolSpec
    expect(spec?.name).toBe('answer')
    const json = spec?.inputSchema?.json as Record<string, unknown>
    expect(json.type).toBe('object')
    expect(json.$schema).toBeUndefined()
  })

  test('a schema whose root is not an object is refused before any vendor call', async () => {
    const { fake, port } = build()
    fake.reply('"x"')
    const code = await codeOf(
      port.complete({
        organizationId: org,
        tier: 'fast',
        messages: [{ role: 'user', content: 'x' }],
        schema: z.string(),
        schemaName: 'answer',
      })
    )
    expect(code).toBe(LLM_ERROR_CODES.invalidRequest)
    expect(fake.requests).toHaveLength(0)
  })

  test('stream uses ConverseStream, skips empty deltas and maps the stop reason', async () => {
    const { fake, port } = build()
    fake.reply('alpha beta', { inputTokens: 3, outputTokens: 2 })
    const events: LlmStreamEvent[] = []
    for await (const event of port.stream({
      organizationId: org,
      tier: 'smart',
      messages: [{ role: 'user', content: 'x' }],
    })) {
      events.push(event)
    }
    expect(events).toEqual([
      { type: 'text', text: 'alpha ' },
      { type: 'text', text: 'beta' },
      { type: 'done', stopReason: 'end', usage: { inputTokens: 3, outputTokens: 2 } },
    ])
    expect(fake.requests[0]?.input.modelId).toBe('anthropic.claude-sonnet-5-5')
    expect(fake.requests[0]?.input.toolConfig).toBeUndefined()
  })

  test('a stream that fails after its first text is not retried', async () => {
    const { fake, port } = build()
    fake.reply('one two three')
    fake.failMidStream(1)
    const seen: string[] = []
    const code = await codeOf(
      (async () => {
        for await (const event of port.stream({
          organizationId: org,
          tier: 'fast',
          messages: [{ role: 'user', content: 'x' }],
          retry,
        })) {
          seen.push(event.type)
        }
      })()
    )
    expect(code).toBe(LLM_ERROR_CODES.unavailable)
    expect(seen).toEqual(['text'])
    expect(fake.requests).toHaveLength(1)
  })
})

describe('response and error mapping', () => {
  function stubbed(output: Partial<ConverseCommandOutput> | Error) {
    const sent: unknown[] = []
    const reporter = createMemoryErrorReporter()
    const port = createBedrockLlm({
      region: 'eu-west-1',
      reporter,
      sleep: async () => undefined,
      client: {
        send: async (command: unknown) => {
          sent.push(command)
          if (output instanceof Error) {
            throw output
          }
          return output
        },
      } as never,
    })
    return { port, sent, reporter }
  }
  const ask = {
    organizationId: org,
    tier: 'fast' as const,
    messages: [{ role: 'user' as const, content: 'x' }],
    schema,
    schemaName: 'answer',
    retry,
  }
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
  const toolUse = (input: unknown) => ({
    output: {
      message: {
        role: 'assistant' as const,
        content: [{ toolUse: { toolUseId: 't', name: 'answer', input: input as never } }],
      },
    },
    stopReason: 'tool_use' as const,
    usage,
  })

  test('a tool input that fits the schema is the value', async () => {
    const { port } = stubbed(toolUse({ intent: 'wait' }))
    expect((await port.complete(ask)).value).toEqual({ intent: 'wait' })
  })

  test('a tool input that does not fit is llm.invalid_output', async () => {
    const { port } = stubbed(toolUse({ intent: 'steal' }))
    expect(await codeOf(port.complete(ask))).toBe(LLM_ERROR_CODES.invalidOutput)
  })

  test('no tool call is llm.invalid_output', async () => {
    const { port } = stubbed({
      output: { message: { role: 'assistant', content: [{ text: 'hello' }] } },
      stopReason: 'end_turn',
      usage,
    })
    expect(await codeOf(port.complete(ask))).toBe(LLM_ERROR_CODES.invalidOutput)
  })

  test('max_tokens is llm.invalid_output with reason truncated', async () => {
    const { port } = stubbed({ ...toolUse({ intent: 'buy' }), stopReason: 'max_tokens' })
    const error = await port.complete(ask).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).details).toMatchObject({ reason: 'truncated' })
  })

  test('a content filter is llm.rejected', async () => {
    const { port } = stubbed({
      output: { message: { role: 'assistant', content: [] } },
      stopReason: 'content_filtered',
      usage,
    })
    expect(await codeOf(port.complete(ask))).toBe(LLM_ERROR_CODES.rejected)
  })

  test('usage that is not whole numbers is llm.bad_response', async () => {
    const { port } = stubbed({
      ...toolUse({ intent: 'buy' }),
      usage: { inputTokens: 1.5, outputTokens: 1, totalTokens: 2 },
    })
    expect(await codeOf(port.complete(ask))).toBe(LLM_ERROR_CODES.badResponse)
    const missing = stubbed({ ...toolUse({ intent: 'buy' }), usage: undefined })
    expect(await codeOf(missing.port.complete(ask))).toBe(LLM_ERROR_CODES.badResponse)
  })

  test.each([
    ['ThrottlingException', 429, 'client', LLM_ERROR_CODES.unavailable],
    ['ServiceUnavailableException', 503, 'server', LLM_ERROR_CODES.unavailable],
    ['InternalServerException', 500, 'server', LLM_ERROR_CODES.unavailable],
    ['ModelTimeoutException', 408, 'client', LLM_ERROR_CODES.unavailable],
    ['ModelNotReadyException', 429, 'client', LLM_ERROR_CODES.unavailable],
    ['ModelStreamErrorException', 424, 'client', LLM_ERROR_CODES.unavailable],
    ['AccessDeniedException', 403, 'client', LLM_ERROR_CODES.rejected],
    ['ValidationException', 400, 'client', LLM_ERROR_CODES.rejected],
    ['ResourceNotFoundException', 404, 'client', LLM_ERROR_CODES.rejected],
    ['ServiceQuotaExceededException', 400, 'client', LLM_ERROR_CODES.rejected],
  ] as const)('%s is %s', async (name, status, fault, code) => {
    const { port } = stubbed(sdkError(name, status, fault))
    expect(await codeOf(port.complete({ ...ask, retry: { ...retry, maxRetries: 0 } }))).toBe(code)
  })

  test('missing credentials are llm.rejected, a connection reset is llm.unavailable', async () => {
    const noCredentials = new Error('Could not load credentials from any providers')
    noCredentials.name = 'CredentialsProviderError'
    expect(await codeOf(stubbed(noCredentials).port.complete(ask))).toBe(LLM_ERROR_CODES.rejected)
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    expect(
      await codeOf(stubbed(reset).port.complete({ ...ask, retry: { ...retry, maxRetries: 0 } }))
    ).toBe(LLM_ERROR_CODES.unavailable)
  })

  test('the cause carries no message and no prompt', async () => {
    const { port } = stubbed(sdkError('AccessDeniedException', 403, 'client', 'secret-prompt'))
    const error = (await port.complete(ask).catch((e: unknown) => e)) as LlmError
    expect(error.cause).toMatchObject({ name: 'AccessDeniedException', httpStatus: 403 })
    expect(JSON.stringify({ ...error, message: error.message, cause: error.cause })).not.toContain(
      'secret-prompt'
    )
  })

  test('commands are Converse commands', async () => {
    const { port, sent } = stubbed(toolUse({ intent: 'buy' }))
    await port.complete(ask)
    expect(sent[0]).toBeInstanceOf(ConverseCommand)
    expect(sent[0]).not.toBeInstanceOf(ConverseStreamCommand)
  })

  test('a send that outlives the time limit is cut by the call deadline, not retried', async () => {
    const { fake, port } = build()
    fake.hang()
    const code = await codeOf(
      port.complete({
        ...ask,
        timeoutMs: 20,
        retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 2 },
      })
    )
    expect(code).toBe(LLM_ERROR_CODES.timeout)
    expect(fake.requests).toHaveLength(1)
  })
})
