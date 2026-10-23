import {
  type ConverseCommand,
  type ConverseCommandOutput,
  ConverseStreamCommand,
  type ConverseStreamCommandOutput,
  type ConverseStreamOutput,
} from '@aws-sdk/client-bedrock-runtime'
import type { BedrockSender } from './bedrock'
import { ESTIMATED_CHARS_PER_TOKEN, estimateTokens } from './port'

// Test-only: a scripted stand-in for the Bedrock Runtime client. Not exported from any entry.

interface Reply {
  text: string
  inputTokens?: number
  outputTokens?: number
  hang?: boolean
}

/** What a test sees of one request. */
export interface FakeRequest {
  kind: 'complete' | 'stream'
  aborted: boolean
  outcome: 'pending' | 'ok' | 'failed' | 'aborted'
  input: ConverseCommand['input']
}

/** The scripted client and the handles a test drives it with. */
export interface FakeBedrock {
  sender: BedrockSender
  reply(text: string, usage?: { inputTokens?: number; outputTokens?: number }): void
  hang(): void
  failNext(kind: 'retryable' | 'fatal' | 'unknown', times: number): void
  failMidStream(afterTexts: number): void
  requests: FakeRequest[]
}

/** An error shaped like the SDK's, with a message that would leak the prompt if copied. */
export function sdkError(name: string, status: number, fault: 'client' | 'server', prompt = '') {
  const error = new Error(`${name}: request failed for ${prompt}`)
  error.name = name
  return Object.assign(error, {
    $fault: fault,
    $metadata: { httpStatusCode: status, requestId: 'req-123' },
    ...(status === 429 || fault === 'server' ? { $retryable: {} } : {}),
  })
}

function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

/** Builds the scripted client. */
export function createFakeBedrock(): FakeBedrock {
  const replies: Reply[] = []
  const failures: ('retryable' | 'fatal' | 'unknown')[] = []
  const requests: FakeRequest[] = []
  let midStream: number | undefined

  async function begin(
    kind: 'complete' | 'stream',
    input: ConverseCommand['input'],
    signal: AbortSignal | undefined
  ): Promise<{ reply: Reply; entry: FakeRequest }> {
    const entry: FakeRequest = { kind, aborted: false, outcome: 'pending', input }
    requests.push(entry)
    signal?.addEventListener(
      'abort',
      () => {
        if (entry.outcome === 'pending') {
          entry.aborted = true
          entry.outcome = 'aborted'
        }
      },
      { once: true }
    )
    const prompt = input.messages?.[0]?.content?.[0]?.text ?? ''
    if (signal?.aborted) {
      throw abortError()
    }
    const failure = failures.shift()
    if (failure !== undefined) {
      entry.outcome = 'failed'
      if (failure === 'retryable') {
        throw sdkError('ThrottlingException', 429, 'client', prompt)
      }
      if (failure === 'unknown') {
        throw sdkError('InternalServerException', 500, 'server', prompt)
      }
      throw sdkError('AccessDeniedException', 403, 'client', prompt)
    }
    const reply = replies.shift()
    if (reply === undefined) {
      entry.outcome = 'failed'
      throw sdkError('ValidationException', 400, 'client', prompt)
    }
    if (reply.hang) {
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()))
      throw abortError()
    }
    return { reply, entry }
  }

  const sender: BedrockSender = {
    async send(command: ConverseCommand | ConverseStreamCommand, options) {
      const signal = options?.abortSignal
      if (command instanceof ConverseStreamCommand) {
        const { reply, entry } = await begin('stream', command.input, signal)
        const maxTokens = command.input.inferenceConfig?.maxTokens ?? 1
        const cap = maxTokens * ESTIMATED_CHARS_PER_TOKEN
        const failAfter = midStream
        midStream = undefined
        async function* events(): AsyncGenerator<ConverseStreamOutput> {
          let remaining = cap
          let emitted = 0
          let texts = 0
          for (const piece of reply.text.match(/\S+\s*/g) ?? []) {
            if (remaining <= 0) {
              break
            }
            if (failAfter !== undefined && texts >= failAfter) {
              entry.outcome = 'failed'
              throw sdkError('ModelStreamErrorException', 424, 'client')
            }
            const text = piece.slice(0, remaining)
            remaining -= text.length
            emitted += text.length
            texts += 1
            yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text } } }
          }
          yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: '' } } }
          yield {
            messageStop: { stopReason: reply.text.length > cap ? 'max_tokens' : 'end_turn' },
          }
          entry.outcome = 'ok'
          yield {
            metadata: {
              usage: {
                inputTokens: reply.inputTokens ?? 5,
                outputTokens: Math.min(
                  reply.outputTokens ?? Math.ceil(emitted / ESTIMATED_CHARS_PER_TOKEN),
                  maxTokens
                ),
                totalTokens: 0,
              },
              metrics: { latencyMs: 1 },
            },
          }
        }
        return { stream: events(), $metadata: {} } as ConverseStreamCommandOutput
      }
      const { reply, entry } = await begin('complete', command.input, signal)
      entry.outcome = 'ok'
      const estimated = reply.outputTokens ?? estimateTokens(reply.text)
      const maxTokens = command.input.inferenceConfig?.maxTokens ?? 1
      const usage = {
        inputTokens: reply.inputTokens ?? 5,
        outputTokens: Math.min(estimated, maxTokens),
        totalTokens: 0,
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(reply.text)
      } catch {
        parsed = undefined
      }
      const isObject = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      const name = command.input.toolConfig?.tools?.[0]?.toolSpec?.name ?? 'tool'
      const output =
        estimated > maxTokens
          ? { stopReason: 'max_tokens', content: [{ text: reply.text.slice(0, 5) }] }
          : isObject
            ? {
                stopReason: 'tool_use',
                content: [{ toolUse: { toolUseId: 't1', name, input: parsed } }],
              }
            : { stopReason: 'end_turn', content: [{ text: reply.text }] }
      return {
        $metadata: {},
        metrics: { latencyMs: 1 },
        output: { message: { role: 'assistant', content: output.content } },
        stopReason: output.stopReason,
        usage,
      } as ConverseCommandOutput
    },
  } as BedrockSender

  return {
    sender,
    reply: (text, usage) => replies.push({ text, ...usage }),
    hang: () => replies.push({ text: '', hang: true }),
    failNext: (kind, times) => {
      for (let i = 0; i < times; i++) {
        failures.push(kind)
      }
    },
    failMidStream: (afterTexts) => {
      midStream = afterTexts
    },
    requests,
  }
}
