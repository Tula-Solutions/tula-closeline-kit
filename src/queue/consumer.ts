import type { Logger } from '../logger'
import type { ErrorReporter } from '../reporting/port'
import type { AnyEnvelope } from './envelope'
import { QUEUE_ERROR_CODES, QueueError } from './errors'
import {
  type Delivery,
  MAX_BATCH_SIZE,
  MAX_VISIBILITY_SECONDS,
  MAX_WAIT_SECONDS,
  type Queue,
} from './port'
import { type Sleep, systemSleep } from './sleep'
import type { ConsumedKey, ProcessedStore } from './store'

/** What a handler is told about the delivery it is processing. */
export interface HandlerContext {
  /**
   * The Organization the message belongs to, taken from the validated envelope; undefined for a
   * global message. Scope every read and write to it. The same value is part of the idempotency
   * key, so another Organization's message with the same id is a different message.
   */
  readonly organizationId: string | undefined
  /** The request or trace id that caused the message. */
  readonly traceId: string
  /** How many times the queue has delivered this message, this delivery included. */
  readonly receiveCount: number
  /**
   * Aborts when the handler has run past `handlerTimeoutMs`, when the consumer lost the message
   * (its visibility ran out and it was handed to someone else) or when shutdown gave up waiting.
   * A handler checks it between steps and stops; one that ignores it may run alongside a retry.
   */
  readonly signal: AbortSignal
}

/** One handler per message type of the queue; the type of `message` follows the key. */
export type Handlers<E extends AnyEnvelope> = {
  [T in E['type']]?: (message: Extract<E, { type: T }>, context: HandlerContext) => Promise<void>
}

/** Options for {@link createConsumer}. */
export interface ConsumerOptions<E extends AnyEnvelope> {
  /** Names this consumer in the store and in logs, such as `playbook.ingestion`. */
  name: string
  /** The queue to read. */
  queue: Queue<E>
  /** Where finished messages are recorded; Postgres in production (see the README). */
  store: ProcessedStore
  /** The handlers. A message whose type has none is treated like an invalid one. */
  handlers: Handlers<E>
  /** Where problems are logged: ids, types and counts only, never a body or a payload. */
  logger: Logger
  /** Where unexpected failures are reported; optional. */
  errorReporter?: ErrorReporter
  /** Waits for the extend timer, the retry back-off and the shutdown deadline; defaults to real timers. */
  sleep?: Sleep
  /** Random in [0, 1) for jitter; defaults to `Math.random`. */
  random?: () => number
  /** Messages handled at once, 1 to 100; default 4. */
  concurrency?: number
  /** Long-poll wait in seconds, 0 to 20; default 20. */
  waitSeconds?: number
  /** Visibility timeout in seconds, 2 or more; default 30. The consumer extends it while a handler runs. */
  visibilityTimeoutSeconds?: number
  /** How long one handler may run before its signal aborts, in ms; default 300000 (5 minutes). */
  handlerTimeoutMs?: number
  /** First delay before a failed message is retried, in seconds; doubles per delivery; default 5. */
  retryBaseSeconds?: number
  /** Longest retry delay in seconds; default 300. */
  retryMaxSeconds?: number
  /** How long an invalid or unhandled message stays hidden before the next look, in seconds; default 60. */
  invalidDelaySeconds?: number
}

/** What {@link Consumer.stop} did with the messages in flight. */
export interface StopResult {
  /** Messages whose handling ended before the deadline, over the consumer's life. */
  finished: number
  /** Messages given back to the queue because the deadline passed. */
  abandoned: number
}

/** A running (or runnable) message loop. */
export interface Consumer {
  /** Starts receiving in the background. Calling it twice does nothing. */
  start(): void
  /**
   * Stops receiving, waits up to `deadlineMs` for handlers in flight, then aborts their signals and
   * hands what is left back to the queue (claims released, visibility 0). Resolves when that is done.
   */
  stop(deadlineMs: number): Promise<StopResult>
  /** Receives one batch with no wait and handles it to the end; returns how many arrived. For tests and one-shot jobs. */
  pollOnce(): Promise<number>
}

interface Flight {
  receipt: string
  key: ConsumedKey | null
  token: string | null
  control: AbortController
  abandoned: boolean
  done: Promise<void>
}

function integerIn(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be a whole number from ${min} to ${max}, got ${value}`)
  }
  return value
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : 'non-error'
}

/**
 * Wraps handlers so that each message has its effect once, on top of at-least-once delivery.
 *
 * Guarantees: a message completed before is acknowledged and not handled again; two consumers that
 * receive the same message do not both run it (the second finds the claim and backs off); a
 * handler that throws or times out leaves the message in the queue for a delayed retry, and the
 * queue's `maxReceiveCount` sends it to the dead-letter queue; an invalid message or one without
 * a handler is never acknowledged, never crashes the loop, and ends in the dead-letter queue; at
 * most `concurrency` handlers run at once; the Organization id is the envelope's own and is part
 * of the idempotency key.
 *
 * Not guaranteed: a crash between the handler's effect and `store.complete` runs the effect again
 * after the lease. Keep the effect and the store record in one database transaction where you can,
 * or make the effect itself idempotent.
 */
export function createConsumer<E extends AnyEnvelope>(options: ConsumerOptions<E>): Consumer {
  const { queue, store, logger } = options
  const sleep = options.sleep ?? systemSleep
  const random = options.random ?? Math.random
  const concurrency = integerIn('concurrency', options.concurrency ?? 4, 1, 100)
  const waitSeconds = integerIn(
    'waitSeconds',
    options.waitSeconds ?? MAX_WAIT_SECONDS,
    0,
    MAX_WAIT_SECONDS
  )
  const visibility = integerIn(
    'visibilityTimeoutSeconds',
    options.visibilityTimeoutSeconds ?? 30,
    2,
    MAX_VISIBILITY_SECONDS
  )
  const handlerTimeoutMs = integerIn(
    'handlerTimeoutMs',
    options.handlerTimeoutMs ?? 300_000,
    1,
    43_200_000
  )
  const retryBase = integerIn('retryBaseSeconds', options.retryBaseSeconds ?? 5, 1, 3600)
  const retryMax = integerIn(
    'retryMaxSeconds',
    options.retryMaxSeconds ?? 300,
    retryBase,
    MAX_VISIBILITY_SECONDS
  )
  const invalidDelay = integerIn(
    'invalidDelaySeconds',
    options.invalidDelaySeconds ?? 60,
    1,
    MAX_VISIBILITY_SECONDS
  )
  if (options.name.trim() === '') {
    throw new TypeError('a consumer needs a name')
  }
  const log = logger.child({ consumer: options.name })
  // The lease outlives the longest handler plus one visibility window, so a claim only lapses when
  // its holder is gone.
  const leaseSeconds = Math.ceil(handlerTimeoutMs / 1000) + visibility
  const extendEveryMs = Math.max(500, Math.floor((visibility * 1000) / 3))

  const flights = new Set<Flight>()
  const stopControl = new AbortController()
  let loop: Promise<void> | undefined
  let abandonedCount = 0
  let finishedCount = 0

  function report(error: unknown): void {
    try {
      options.errorReporter?.capture(error, { tags: { consumer: options.name } })
    } catch {
      // a reporter must not break the loop
    }
  }

  function retryDelay(receiveCount: number): number {
    const ceiling = Math.min(retryMax, retryBase * 2 ** Math.min(receiveCount - 1, 20))
    return Math.max(1, Math.floor(ceiling / 2 + random() * (ceiling / 2)))
  }

  async function delay(receipt: string, seconds: number, why: string): Promise<void> {
    try {
      await queue.extendVisibility(receipt, seconds)
    } catch (error) {
      // Not in flight any more: someone else has it, which is what we wanted anyway.
      log.warn('could not delay a message', { why, errorName: nameOf(error) })
    }
  }

  async function handle(delivery: Delivery<E>, flight: Flight): Promise<void> {
    if (delivery.kind === 'invalid') {
      log.error('received a message this consumer does not accept', {
        reason: delivery.reason,
        issues: delivery.issues,
        messageId: delivery.messageId,
        receiveCount: delivery.receiveCount,
      })
      report(new Error(`invalid queue message: ${delivery.reason}`))
      await delay(delivery.receipt, invalidDelay, 'invalid')
      return
    }
    const { envelope, receipt, receiveCount } = delivery
    const fields = {
      messageId: envelope.id,
      type: envelope.type,
      organizationId: envelope.organizationId,
      traceId: envelope.traceId,
      receiveCount,
    }
    const handler = options.handlers[envelope.type as E['type']] as
      | ((message: E, context: HandlerContext) => Promise<void>)
      | undefined
    if (handler === undefined) {
      log.error('no handler for a message type', fields)
      report(new Error(`no handler for queue message type ${envelope.type}`))
      await delay(receipt, invalidDelay, 'no_handler')
      return
    }
    const key: ConsumedKey = {
      consumer: options.name,
      organizationId: envelope.organizationId ?? null,
      messageId: envelope.id,
    }
    let claim: Awaited<ReturnType<ProcessedStore['claim']>>
    try {
      claim = await store.claim(key, leaseSeconds)
    } catch (error) {
      log.error('the processed store failed on claim', { ...fields, errorName: nameOf(error) })
      report(error)
      await delay(receipt, retryDelay(receiveCount), 'claim_failed')
      return
    }
    if (claim.status === 'done') {
      log.debug('message already processed; acknowledging', fields)
      await queue.acknowledge(receipt).catch((error: unknown) => {
        log.warn('acknowledge failed', { ...fields, errorName: nameOf(error) })
      })
      return
    }
    if (claim.status === 'busy') {
      log.debug('message is being processed elsewhere; backing off', fields)
      await delay(receipt, visibility, 'busy')
      return
    }
    const token = claim.token
    flight.key = key
    flight.token = token
    const context: HandlerContext = Object.freeze({
      organizationId: envelope.organizationId,
      traceId: envelope.traceId,
      receiveCount,
      signal: flight.control.signal,
    })
    const aborted = new Promise<'aborted'>((resolve) => {
      flight.control.signal.addEventListener('abort', () => resolve('aborted'), { once: true })
    })
    const running = Promise.resolve()
      .then(() => handler(Object.freeze({ ...envelope }), context))
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error })
      )
    // Keeps the visibility timeout alive while the handler runs, and times it out.
    const stopKeepAlive = new AbortController()
    let timedOut = false
    const keepAlive = (async () => {
      let elapsed = 0
      while (!stopKeepAlive.signal.aborted) {
        await sleep(extendEveryMs, stopKeepAlive.signal)
        if (stopKeepAlive.signal.aborted) {
          return
        }
        elapsed += extendEveryMs
        if (elapsed >= handlerTimeoutMs) {
          timedOut = true
          flight.control.abort()
          return
        }
        try {
          await queue.extendVisibility(receipt, visibility)
        } catch (error) {
          if (error instanceof QueueError && error.code === QUEUE_ERROR_CODES.receiptInvalid) {
            log.warn('lost the message while its handler was running', fields)
            flight.control.abort()
            return
          }
          log.warn('could not extend visibility', { ...fields, errorName: nameOf(error) })
        }
      }
    })()
    const outcome = await Promise.race([running, aborted])
    stopKeepAlive.abort()
    await keepAlive
    if (flight.abandoned) {
      return
    }
    if (outcome === 'aborted') {
      // Timed out or lost. The claim is left to lapse (the handler may still be running) and the
      // message is not acknowledged: the queue hands it out again.
      log.error(timedOut ? 'a handler timed out' : 'a message was lost mid-handler', fields)
      report(new Error(timedOut ? 'queue handler timed out' : 'queue message lost mid-handler'))
      return
    }
    if (!outcome.ok) {
      log.error('a handler failed; the message will be retried', {
        ...fields,
        errorName: nameOf(outcome.error),
      })
      report(outcome.error)
      await store.release(key, token).catch(() => undefined)
      await delay(receipt, retryDelay(receiveCount), 'handler_failed')
      return
    }
    try {
      if (!(await store.complete(key, token))) {
        log.warn('the claim was lost before completion; acknowledging anyway', fields)
      }
    } catch (error) {
      log.error('the processed store failed on complete', { ...fields, errorName: nameOf(error) })
      report(error)
      await store.release(key, token).catch(() => undefined)
      await delay(receipt, retryDelay(receiveCount), 'complete_failed')
      return
    }
    await queue.acknowledge(receipt).catch((error: unknown) => {
      // The store says done, so the redelivery is acknowledged without running again.
      log.warn('acknowledge failed', { ...fields, errorName: nameOf(error) })
    })
  }

  function dispatch(delivery: Delivery<E>): Flight {
    const flight: Flight = {
      receipt: delivery.receipt,
      key: null,
      token: null,
      control: new AbortController(),
      abandoned: false,
      done: Promise.resolve(),
    }
    flight.done = handle(delivery, flight)
      .catch((error: unknown) => {
        // A bug in this helper must not stop the loop; the message simply stays in the queue.
        log.error('unexpected consumer failure', { errorName: nameOf(error) })
        report(error)
      })
      .finally(() => {
        flights.delete(flight)
        if (!flight.abandoned) {
          finishedCount += 1
        }
      })
    flights.add(flight)
    return flight
  }

  async function giveBack(delivery: Delivery<E>): Promise<void> {
    await queue.release(delivery.receipt).catch(() => undefined)
  }

  async function run(): Promise<void> {
    let failures = 0
    while (!stopControl.signal.aborted) {
      if (flights.size >= concurrency) {
        await Promise.race([...flights].map((flight) => flight.done))
        continue
      }
      let batch: Delivery<E>[]
      try {
        batch = await queue.receive({
          maxMessages: Math.min(concurrency - flights.size, MAX_BATCH_SIZE),
          visibilityTimeoutSeconds: visibility,
          waitSeconds,
          signal: stopControl.signal,
        })
        failures = 0
      } catch (error) {
        if (stopControl.signal.aborted) {
          return
        }
        failures += 1
        log.error('receive failed', { errorName: nameOf(error), failures })
        report(error)
        const ceiling = Math.min(30_000, 500 * 2 ** Math.min(failures, 10))
        await sleep(Math.floor(ceiling / 2 + random() * (ceiling / 2)), stopControl.signal)
        continue
      }
      if (stopControl.signal.aborted) {
        await Promise.all(batch.map(giveBack))
        return
      }
      for (const delivery of batch) {
        dispatch(delivery)
      }
      if (batch.length === 0 && waitSeconds === 0) {
        await sleep(1000, stopControl.signal)
      }
    }
  }

  return {
    start() {
      loop ??= run().catch((error: unknown) => {
        log.error('the receive loop ended unexpectedly', { errorName: nameOf(error) })
        report(error)
      })
    },
    async stop(deadlineMs) {
      stopControl.abort()
      const cancel = new AbortController()
      const drained = (async () => {
        await loop
        while (flights.size > 0) {
          await Promise.all([...flights].map((flight) => flight.done))
        }
      })()
      await Promise.race([drained, sleep(deadlineMs, cancel.signal)])
      cancel.abort()
      if (flights.size > 0) {
        const left = [...flights]
        abandonedCount += left.length
        for (const flight of left) {
          flight.abandoned = true
          flight.control.abort()
        }
        await Promise.all(
          left.map(async (flight) => {
            if (flight.key !== null && flight.token !== null) {
              await store.release(flight.key, flight.token).catch(() => undefined)
            }
            await queue.release(flight.receipt).catch(() => undefined)
          })
        )
        log.warn('shutdown gave up waiting; returned messages to the queue', { count: left.length })
      }
      return { finished: finishedCount, abandoned: abandonedCount }
    },
    async pollOnce() {
      const batch = await queue.receive({
        maxMessages: Math.min(concurrency, MAX_BATCH_SIZE),
        visibilityTimeoutSeconds: visibility,
        waitSeconds: 0,
      })
      await Promise.all(batch.map((delivery) => dispatch(delivery).done))
      return batch.length
    },
  }
}
