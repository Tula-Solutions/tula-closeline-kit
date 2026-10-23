import type { OrganizationId } from 'tula-closeline-contract'
import type { z } from 'zod'
import type { Logger } from '../logger'
import { type Sleep, systemSleep } from '../queue/sleep'
import type { ErrorReporter } from '../reporting/port'
import { startDeadline, withLlmRetry } from './deadline'
import { LLM_ERROR_CODES, LlmError } from './errors'
import {
  ESTIMATED_CHARS_PER_TOKEN,
  estimateTokens,
  type LlmCompleteRequest,
  type LlmCompletion,
  type LlmPort,
  type LlmStreamEvent,
  type LlmStreamRequest,
  type LlmUsage,
  type ModelTier,
} from './port'
import { checkCompleteRequest, checkRequest, invalid, parseModelOutput } from './validate'

/** What the scripted model answers to the next call. */
export interface ScriptedReply {
  /** The raw text the model writes: JSON text for `complete`, any text for `stream`. Tenant data: never logged. */
  text: string
  /** Tokens to report for the prompt; the estimate of the prompt when absent. */
  inputTokens?: number
  /** Tokens to report for the answer; the estimate of `text` when absent. */
  outputTokens?: number
  /** Time the vendor takes before it answers, in ms; default 0. */
  delayMs?: number
  /** Never answers; the request ends only when it is aborted. */
  hang?: boolean
  /** For `stream`: the pieces to deliver; `text` split into words when absent. They must join to `text`. */
  chunks?: readonly string[]
  /** For `stream`: fail with `llm.unavailable` (not retried) after this many pieces were delivered. */
  failAfterChunks?: number
}

/** The codes the vendor can be made to fail with. */
export type ScriptedFailure = 'llm.unavailable' | 'llm.rejected' | 'llm.bad_response'

/** What a test sees of one vendor request (never the prompt or the text). */
export interface MemoryLlmRequestView {
  /** Which method made it. */
  kind: 'complete' | 'stream'
  /** The Organization. */
  organizationId: OrganizationId
  /** The model class asked for. */
  tier: ModelTier
  /** True once the request's AbortSignal fired while it was still pending (a timeout, a cancel, a stopped reader). */
  aborted: boolean
  /** How it ended: still going, answered, failed or aborted. */
  outcome: 'pending' | 'ok' | 'failed' | 'aborted'
}

/** Options for {@link createMemoryLlm}. */
export interface MemoryLlmOptions {
  /** Receives the errors that mean the model or vendor failed; nothing if absent. */
  reporter?: ErrorReporter
  /** Where retries are noted (metadata only); nothing if absent. */
  logger?: Logger
  /** Pauses between retries and models a vendor's delay; real time by default. */
  sleep?: Sleep
  /** A number in `[0, 1)` for the jitter; `Math.random` by default. */
  random?: () => number
}

/** An {@link LlmPort} that plays scripted answers in the process, for tests. Not for production. */
export interface MemoryLlm extends LlmPort {
  /** Queues what the model answers to the next call that reaches it; later calls take later replies. */
  reply(reply: ScriptedReply | string): void
  /** Makes the next `times` (default 1) vendor requests fail with `code`, before any reply is used. */
  failNext(code: ScriptedFailure, times?: number): void
  /** Every vendor request so far, in order; a retry is a request of its own. */
  requests(): MemoryLlmRequestView[]
}

interface Mutable {
  view: MemoryLlmRequestView
}

/**
 * Builds an {@link LlmPort} for tests that plays scripted answers. It keeps the rules a real
 * adapter must: validation before any vendor call, the input and output token budgets, a hard
 * timeout that aborts the vendor request, schema-checked output, bounded jittered retries of
 * `llm.unavailable` only, and no prompt or completion in logs, reports or errors. Not for
 * production.
 */
export function createMemoryLlm(options: MemoryLlmOptions = {}): MemoryLlm {
  const sleep = options.sleep ?? systemSleep
  const replies: ScriptedReply[] = []
  const failures: ScriptedFailure[] = []
  const requests: Mutable[] = []

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

  /** One vendor request: the scripted failure or reply, honouring the abort signal. */
  async function vendorRequest(
    kind: 'complete' | 'stream',
    base: { organizationId: OrganizationId; tier: ModelTier },
    signal: AbortSignal
  ): Promise<{ reply: ScriptedReply; entry: Mutable }> {
    const entry: Mutable = {
      view: { kind, ...base, aborted: false, outcome: 'pending' },
    }
    requests.push(entry)
    signal.addEventListener(
      'abort',
      () => {
        if (entry.view.outcome === 'pending') {
          entry.view.aborted = true
          entry.view.outcome = 'aborted'
        }
      },
      { once: true }
    )
    const abortedError = () => new LlmError(LLM_ERROR_CODES.aborted, 'The call was cancelled')
    if (signal.aborted) {
      throw abortedError()
    }
    const code = failures.shift()
    if (code !== undefined) {
      entry.view.outcome = 'failed'
      throw new LlmError(code, 'The vendor failed')
    }
    const next = replies.shift()
    if (next === undefined) {
      entry.view.outcome = 'failed'
      throw new LlmError(LLM_ERROR_CODES.badResponse, 'The vendor sent nothing usable')
    }
    if (next.hang) {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
    } else if ((next.delayMs ?? 0) > 0) {
      await sleep(next.delayMs ?? 0, signal)
    }
    if (signal.aborted) {
      throw abortedError()
    }
    // A stream stays pending until its last piece is delivered.
    if (kind === 'complete') {
      entry.view.outcome = 'ok'
    }
    return { reply: next, entry }
  }

  const port: MemoryLlm = {
    async complete<S extends z.ZodType>(
      request: LlmCompleteRequest<S>
    ): Promise<LlmCompletion<z.output<S>>> {
      const { checked } = checkCompleteRequest(request)
      const deadline = startDeadline(checked.timeoutMs, request.signal)
      try {
        const { reply } = await withLlmRetry(
          () => vendorRequest('complete', request, deadline.signal),
          {
            policy: checked.retry,
            deadline,
            sleep,
            ...(options.random === undefined ? {} : { random: options.random }),
            onRetry: (retry, delayMs) =>
              options.logger?.warn('A model call is retrying', {
                tier: request.tier,
                retry,
                delayMs,
              }),
          }
        )
        const outputTokens = reply.outputTokens ?? estimateTokens(reply.text)
        if (outputTokens > checked.maxOutputTokens) {
          throw new LlmError(
            LLM_ERROR_CODES.invalidOutput,
            'The model answer was cut off by the output token budget',
            { details: { reason: 'truncated', maxOutputTokens: checked.maxOutputTokens } }
          )
        }
        const value = parseModelOutput(request.schema, reply.text)
        return {
          value,
          usage: { inputTokens: reply.inputTokens ?? checked.inputTokens, outputTokens },
        }
      } catch (error) {
        report(error, request.organizationId, request.tier)
        throw error
      } finally {
        deadline.stop()
      }
    },

    stream(request: LlmStreamRequest): AsyncIterable<LlmStreamEvent> {
      const checked = checkRequest(request)
      async function* run(): AsyncGenerator<LlmStreamEvent> {
        const deadline = startDeadline(checked.timeoutMs, request.signal)
        let entry: Mutable | undefined
        try {
          const started = await withLlmRetry(
            () => vendorRequest('stream', request, deadline.signal),
            {
              policy: checked.retry,
              deadline,
              sleep,
              ...(options.random === undefined ? {} : { random: options.random }),
              onRetry: (retry, delayMs) =>
                options.logger?.warn('A model call is retrying', {
                  tier: request.tier,
                  retry,
                  delayMs,
                }),
            }
          )
          const reply = started.reply
          entry = started.entry
          const cap = checked.maxOutputTokens * ESTIMATED_CHARS_PER_TOKEN
          const truncated = reply.text.length > cap
          let remaining = cap
          const pieces = reply.chunks ?? reply.text.match(/\S+\s*/g) ?? []
          let delivered = 0
          let emittedChars = 0
          for (const piece of pieces) {
            if (remaining <= 0) {
              break
            }
            if (reply.failAfterChunks !== undefined && delivered >= reply.failAfterChunks) {
              throw new LlmError(LLM_ERROR_CODES.unavailable, 'The vendor stream broke')
            }
            deadline.check()
            const text = piece.slice(0, remaining)
            remaining -= text.length
            emittedChars += text.length
            delivered += 1
            if (text.length > 0) {
              yield { type: 'text', text }
            }
          }
          deadline.check()
          if (entry !== undefined) {
            entry.view.outcome = 'ok'
          }
          const usage: LlmUsage = {
            inputTokens: reply.inputTokens ?? checked.inputTokens,
            outputTokens: Math.min(
              reply.outputTokens ?? Math.ceil(emittedChars / ESTIMATED_CHARS_PER_TOKEN),
              checked.maxOutputTokens
            ),
          }
          yield { type: 'done', stopReason: truncated ? 'max_tokens' : 'end', usage }
        } catch (error) {
          if (entry?.view.outcome === 'pending') {
            entry.view.outcome = 'failed'
          }
          report(error, request.organizationId, request.tier)
          throw error
        } finally {
          // A reader that stopped early leaves the vendor request pending: abort it.
          deadline.cancel()
          deadline.stop()
        }
      }
      return run()
    },

    reply(reply) {
      const scripted = typeof reply === 'string' ? { text: reply } : reply
      if (typeof scripted.text !== 'string') {
        invalid('reply text')
      }
      if (scripted.chunks !== undefined && scripted.chunks.join('') !== scripted.text) {
        invalid('reply chunks')
      }
      replies.push({ ...scripted })
    },
    failNext(code, times = 1) {
      for (let i = 0; i < times; i++) {
        failures.push(code)
      }
    },
    requests() {
      return requests.map((entry) => ({ ...entry.view }))
    },
  }
  return port
}
