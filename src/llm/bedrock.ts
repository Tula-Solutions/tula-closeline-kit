import {
  type BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandOutput,
  ConverseStreamCommand,
  type ConverseStreamCommandOutput,
  type ConverseStreamOutput,
  type Message,
  type StopReason,
} from '@aws-sdk/client-bedrock-runtime'
import type { OrganizationId } from 'tula-closeline-contract'
import type { z } from 'zod'
import { isTransientAwsFailure, reduceAwsCause } from '../aws-failure'
import type { Logger } from '../logger'
import { type Sleep, systemSleep } from '../queue/sleep'
import type { ErrorReporter } from '../reporting/port'
import {
  assertModelInRegion,
  assertRegion,
  callableModelId,
  createBedrockClient,
} from './bedrock-client'
import { type Deadline, startDeadline, withLlmRetry } from './deadline'
import { LLM_ERROR_CODES, LlmError } from './errors'
import {
  type LlmCompleteRequest,
  type LlmCompletion,
  type LlmPort,
  type LlmStreamEvent,
  type LlmStreamRequest,
  type LlmUsage,
  MODEL_TIERS,
  type ModelTier,
} from './port'
import { checkCompleteRequest, checkRequest, invalid, parseModelOutput } from './validate'

/** The Bedrock model id of the fast tier unless `models.fast` says otherwise: Claude Haiku 5.5. */
export const DEFAULT_BEDROCK_FAST_MODEL = 'anthropic.claude-haiku-5-5'

/** The Bedrock model id of the smart tier unless `models.smart` says otherwise: Claude Sonnet 5.5. */
export const DEFAULT_BEDROCK_SMART_MODEL = 'anthropic.claude-sonnet-5-5'

/** The time the SDK waits to connect, unless `connectTimeoutMs` says otherwise. */
export const DEFAULT_BEDROCK_CONNECT_TIMEOUT_MS = 5000

/** Slack added to the SDK's request timeout so the call's own deadline always fires first. */
const REQUEST_TIMEOUT_SLACK_MS = 500

/** The part of the SDK client the adapter uses; tests pass a scripted one. */
export interface BedrockSender {
  /** Sends one Converse or ConverseStream command, aborting it when `abortSignal` fires. */
  send(
    command: ConverseCommand,
    options?: { abortSignal?: AbortSignal; requestTimeout?: number }
  ): Promise<ConverseCommandOutput>
  send(
    command: ConverseStreamCommand,
    options?: { abortSignal?: AbortSignal; requestTimeout?: number }
  ): Promise<ConverseStreamCommandOutput>
}

/** Options for {@link createBedrockLlm}. */
export interface BedrockLlmOptions {
  /** The AWS Region the calls are made in, such as `eu-west-1`; every call stays in it. */
  region: string
  /** The model id of each tier; the Haiku 5.5 and Sonnet 5.5 ids by default. A bare `anthropic.*` id is called through the `region` geography's inference profile; a profile id must carry the prefix of `region`'s geography. */
  models?: Partial<Record<ModelTier, string>>
  /** Time the SDK waits to connect, in ms; 5000 by default. */
  connectTimeoutMs?: number
  /** Receives the errors that mean the model or vendor failed; nothing if absent. */
  reporter?: ErrorReporter
  /** Where retries are noted (metadata only); nothing if absent. */
  logger?: Logger
  /** Pauses between retries; real time by default. */
  sleep?: Sleep
  /** A number in `[0, 1)` for the jitter; `Math.random` by default. */
  random?: () => number
  /** A client to use instead of building one; for tests. Production code leaves it out. */
  client?: BedrockSender
}

const UNAVAILABLE_NAMES = new Set([
  'ThrottlingException',
  'ServiceUnavailableException',
  'InternalServerException',
  'ModelTimeoutException',
  'ModelNotReadyException',
  'ModelStreamErrorException',
])

type ToolSchema = NonNullable<
  NonNullable<NonNullable<ConverseCommand['input']['toolConfig']>['tools']>[number]['toolSpec']
>['inputSchema']

function isWhole(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function badResponse(what: string): LlmError {
  return new LlmError(LLM_ERROR_CODES.badResponse, `The model service sent ${what}`)
}

function usageOf(raw: { inputTokens?: unknown; outputTokens?: unknown } | undefined): LlmUsage {
  if (raw === undefined || !isWhole(raw.inputTokens) || !isWhole(raw.outputTokens)) {
    throw badResponse('no usable token counts')
  }
  return { inputTokens: raw.inputTokens, outputTokens: raw.outputTokens }
}

function truncated(maxOutputTokens: number): LlmError {
  return new LlmError(
    LLM_ERROR_CODES.invalidOutput,
    'The model answer was cut off by the output token budget',
    { details: { reason: 'truncated', maxOutputTokens } }
  )
}

/** Turns what the SDK threw into an `LlmError`; the SDK's message can repeat the request, so it is dropped. */
function mapFailure(error: unknown, deadline: Deadline): LlmError {
  if (error instanceof LlmError) {
    return error
  }
  if (deadline.signal.aborted) {
    try {
      deadline.check()
    } catch (checked) {
      return checked as LlmError
    }
  }
  const cause = reduceAwsCause(error)
  const unavailable = UNAVAILABLE_NAMES.has(cause.name) || isTransientAwsFailure(error)
  return unavailable
    ? new LlmError(LLM_ERROR_CODES.unavailable, 'The model service is unavailable', { cause })
    : new LlmError(LLM_ERROR_CODES.rejected, 'The model service refused the call', { cause })
}

function toMessages(request: {
  system?: string | undefined
  messages: readonly { role: 'user' | 'assistant'; content: string }[]
}): Pick<ConverseCommand['input'], 'system' | 'messages'> {
  const messages: Message[] = request.messages.map((m) => ({
    role: m.role,
    content: [{ text: m.content }],
  }))
  return {
    messages,
    ...(request.system === undefined ? {} : { system: [{ text: request.system }] }),
  }
}

/**
 * Builds an {@link LlmPort} on Amazon Bedrock (Converse and ConverseStream) with Claude models,
 * in one Region. `complete` forces a tool whose input schema is the caller's, so the answer
 * arrives as JSON and is checked with Zod. Every call has the request's time limit and a bounded,
 * jittered retry of `llm.unavailable` (the SDK's own retry is off). Nothing leaves `region`: the
 * endpoint cannot be overridden and an inference profile for another geography is refused.
 * Prompts, completions and credentials are never logged, reported or put in an error.
 */
export function createBedrockLlm(options: BedrockLlmOptions): LlmPort {
  assertRegion(options.region)
  const models: Record<ModelTier, string> = {
    fast: options.models?.fast ?? DEFAULT_BEDROCK_FAST_MODEL,
    smart: options.models?.smart ?? DEFAULT_BEDROCK_SMART_MODEL,
  }
  for (const tier of MODEL_TIERS) {
    assertModelInRegion(tier, models[tier], options.region)
  }
  // Metering stays keyed on the tier; only the id sent to Bedrock carries the profile prefix.
  const callable = {
    fast: callableModelId(models.fast, options.region),
    smart: callableModelId(models.smart, options.region),
  }
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_BEDROCK_CONNECT_TIMEOUT_MS
  if (!Number.isInteger(connectTimeoutMs) || connectTimeoutMs < 1 || connectTimeoutMs > 60_000) {
    throw new TypeError('connectTimeoutMs must be a whole number from 1 to 60000')
  }
  const client: BedrockSender =
    options.client ??
    (createBedrockClient({ region: options.region, connectTimeoutMs }) as BedrockRuntimeClient &
      BedrockSender)
  const sleep = options.sleep ?? systemSleep

  function report(error: unknown, organizationId: OrganizationId, tier: ModelTier) {
    if (
      !(error instanceof LlmError) ||
      (error.code !== LLM_ERROR_CODES.unavailable &&
        error.code !== LLM_ERROR_CODES.rejected &&
        error.code !== LLM_ERROR_CODES.badResponse &&
        error.code !== LLM_ERROR_CODES.invalidOutput)
    ) {
      return
    }
    try {
      options.reporter?.capture(error, { organizationId, tags: { feature: 'llm', tier } })
    } catch {
      // Reporting must never turn an error into a different one.
    }
  }

  function retrying(
    tier: ModelTier,
    retry: Parameters<typeof withLlmRetry>[1]['policy'],
    deadline: Deadline
  ) {
    return {
      policy: retry,
      deadline,
      sleep,
      ...(options.random === undefined ? {} : { random: options.random }),
      onRetry: (n: number, delayMs: number) =>
        options.logger?.warn('A model call is retrying', { tier, retry: n, delayMs }),
    }
  }

  async function converse(
    input: ConverseCommand['input'],
    timeoutMs: number,
    deadline: Deadline
  ): Promise<ConverseCommandOutput> {
    try {
      return await client.send(new ConverseCommand(input), {
        abortSignal: deadline.signal,
        requestTimeout: timeoutMs + REQUEST_TIMEOUT_SLACK_MS,
      })
    } catch (error) {
      throw mapFailure(error, deadline)
    }
  }

  /** Waits for the next stream event, giving up when the deadline fires. */
  async function nextEvent(
    iterator: AsyncIterator<ConverseStreamOutput>,
    deadline: Deadline
  ): Promise<IteratorResult<ConverseStreamOutput>> {
    let onAbort: (() => void) | undefined
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new LlmError(LLM_ERROR_CODES.aborted, 'The call was cancelled'))
      if (deadline.signal.aborted) {
        onAbort()
      } else {
        deadline.signal.addEventListener('abort', onAbort, { once: true })
      }
    })
    aborted.catch(() => undefined)
    try {
      return await Promise.race([iterator.next(), aborted])
    } catch (error) {
      throw mapFailure(error, deadline)
    } finally {
      if (onAbort !== undefined) {
        deadline.signal.removeEventListener('abort', onAbort)
      }
    }
  }

  return {
    async complete<S extends z.ZodType>(
      request: LlmCompleteRequest<S>
    ): Promise<LlmCompletion<z.output<S>>> {
      const { checked, jsonSchema } = checkCompleteRequest(request)
      if (jsonSchema.type !== 'object') {
        invalid('schema')
      }
      const { $schema: _dropped, ...schemaBody } = jsonSchema
      const input: ConverseCommand['input'] = {
        modelId: callable[request.tier],
        ...toMessages(request),
        inferenceConfig: { maxTokens: checked.maxOutputTokens },
        toolConfig: {
          tools: [
            {
              toolSpec: {
                name: request.schemaName,
                description: 'Return the answer.',
                inputSchema: { json: schemaBody } as ToolSchema,
              },
            },
          ],
          toolChoice: { tool: { name: request.schemaName } },
        },
      }
      const deadline = startDeadline(checked.timeoutMs, request.signal)
      try {
        const response = await withLlmRetry(
          () => converse(input, checked.timeoutMs, deadline),
          retrying(request.tier, checked.retry, deadline)
        )
        const usage = usageOf(response.usage)
        if (response.stopReason === 'max_tokens' || usage.outputTokens > checked.maxOutputTokens) {
          throw truncated(checked.maxOutputTokens)
        }
        if (
          response.stopReason === 'content_filtered' ||
          response.stopReason === 'guardrail_intervened'
        ) {
          throw new LlmError(LLM_ERROR_CODES.rejected, 'The model service withheld the answer', {
            details: { reason: response.stopReason },
          })
        }
        const block = response.output?.message?.content?.find((b) => b.toolUse !== undefined)
        if (block?.toolUse === undefined) {
          throw new LlmError(LLM_ERROR_CODES.invalidOutput, 'The model did not answer in JSON', {
            details: { reason: 'not_json' },
          })
        }
        const value = parseModelOutput(request.schema, JSON.stringify(block.toolUse.input ?? null))
        return { value, usage }
      } catch (error) {
        report(error, request.organizationId, request.tier)
        throw error
      } finally {
        deadline.stop()
      }
    },

    stream(request: LlmStreamRequest): AsyncIterable<LlmStreamEvent> {
      const checked = checkRequest(request)
      const input: ConverseCommand['input'] = {
        modelId: callable[request.tier],
        ...toMessages(request),
        inferenceConfig: { maxTokens: checked.maxOutputTokens },
      }
      async function* run(): AsyncGenerator<LlmStreamEvent> {
        const deadline = startDeadline(checked.timeoutMs, request.signal)
        try {
          // Retry only until the first text is in hand: after that the reader has seen output.
          const opened = await withLlmRetry(
            async () => {
              let response: ConverseStreamCommandOutput
              try {
                response = await client.send(new ConverseStreamCommand(input), {
                  abortSignal: deadline.signal,
                  requestTimeout: checked.timeoutMs + REQUEST_TIMEOUT_SLACK_MS,
                })
              } catch (error) {
                throw mapFailure(error, deadline)
              }
              if (response.stream === undefined) {
                throw badResponse('no stream')
              }
              const iterator = response.stream[Symbol.asyncIterator]()
              const buffered: ConverseStreamOutput[] = []
              for (;;) {
                const next = await nextEvent(iterator, deadline)
                if (next.done) {
                  return { iterator, buffered, ended: true }
                }
                buffered.push(next.value)
                if ((next.value.contentBlockDelta?.delta?.text ?? '').length > 0) {
                  return { iterator, buffered, ended: false }
                }
              }
            },
            retrying(request.tier, checked.retry, deadline)
          )

          let stopReason: StopReason | undefined
          let usage: LlmUsage | undefined
          const handle = (event: ConverseStreamOutput): string => {
            if (event.messageStop?.stopReason !== undefined) {
              stopReason = event.messageStop.stopReason
            }
            if (event.metadata?.usage !== undefined) {
              usage = usageOf(event.metadata.usage)
            }
            return event.contentBlockDelta?.delta?.text ?? ''
          }
          for (const event of opened.buffered) {
            const text = handle(event)
            if (text.length > 0) {
              yield { type: 'text', text }
            }
          }
          let ended = opened.ended
          while (!ended) {
            const next = await nextEvent(opened.iterator, deadline)
            deadline.check()
            if (next.done) {
              ended = true
              break
            }
            const text = handle(next.value)
            if (text.length > 0) {
              yield { type: 'text', text }
            }
          }
          deadline.check()
          if (usage === undefined) {
            throw badResponse('no token counts')
          }
          if (stopReason === 'content_filtered' || stopReason === 'guardrail_intervened') {
            throw new LlmError(LLM_ERROR_CODES.rejected, 'The model service withheld the answer', {
              details: { reason: stopReason },
            })
          }
          if (stopReason === 'max_tokens') {
            yield { type: 'done', stopReason: 'max_tokens', usage }
          } else if (stopReason === 'end_turn' || stopReason === 'stop_sequence') {
            yield { type: 'done', stopReason: 'end', usage }
          } else {
            throw badResponse('an unexpected stop reason')
          }
        } catch (error) {
          const mapped = mapFailure(error, deadline)
          report(mapped, request.organizationId, request.tier)
          throw mapped
        } finally {
          // A reader that stopped early leaves the vendor request pending: abort it.
          deadline.cancel()
          deadline.stop()
        }
      }
      return run()
    },
  }
}
