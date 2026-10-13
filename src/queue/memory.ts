import type { Clock } from '../clock'
import {
  type AnyDefinition,
  type EnvelopeOf,
  MAX_MESSAGE_BYTES,
  type MessageRegistry,
} from './envelope'
import { QUEUE_ERROR_CODES, QueueError } from './errors'
import {
  assertBatchCount,
  assertReceiveOptions,
  assertVisibility,
  type BatchResult,
  type Delivery,
  type Queue,
  type Receipt,
  type ReceiveOptions,
} from './port'
import { type Sleep, systemSleep } from './sleep'

/** Options for {@link createMemoryQueue}. */
export interface MemoryQueueOptions<D extends AnyDefinition> {
  /** The message types the queue accepts and delivers. */
  registry: MessageRegistry<D>
  /** Time source for visibility timeouts; tests pass a FixedClock and advance it. */
  clock: Clock
  /** Waits for long polls; defaults to the real timer. Tests pass a virtual one. */
  sleep?: Sleep
  /** Deliveries before a message moves to the dead-letter list; defaults to 5 like the dev queue. */
  maxReceiveCount?: number
  /**
   * Random in [0, 1). When given, receive picks among the visible messages at random instead of in
   * publish order, which SQS does not promise either; tests use it to prove a consumer does not
   * depend on order.
   */
  random?: () => number
}

/** A message the memory queue moved aside after `maxReceiveCount` deliveries. */
export interface DeadLetter {
  /** The envelope id when the body had one. */
  messageId: string | undefined
  /** How many times it was delivered. */
  receiveCount: number
}

/** A {@link Queue} that keeps everything in the process, for tests. Not for production. */
export interface MemoryQueue<D extends AnyDefinition> extends Queue<EnvelopeOf<D>> {
  /** Messages moved aside after `maxReceiveCount` deliveries, oldest first. */
  deadLetters(): readonly DeadLetter[]
  /** Counts of messages waiting and hidden right now. */
  depth(): { visible: number; inFlight: number }
  /** Puts a raw body in the queue without validating it, to test how a consumer meets a bad one. */
  publishRaw(body: string): void
}

interface Entry {
  id: number
  body: string
  receiveCount: number
  /** Milliseconds since the epoch at which the message is visible again. */
  visibleAt: number
  inFlight: boolean
}

function bytesOf(body: string): number {
  return new TextEncoder().encode(body).length
}

/**
 * Creates the in-memory queue. It follows SQS where it matters to a consumer: a received message
 * is hidden until its visibility timeout passes on the injected clock, then comes back with a
 * higher receive count; after `maxReceiveCount` deliveries it goes to the dead-letter list; a
 * long poll returns when a message is published or the wait ends. By default it delivers in
 * publish order and a short poll always sees every visible message; SQS promises neither (order is
 * best effort and a short poll samples some servers), so do not write a test that depends on
 * either. Pass `random` to deliver in random order. Complexity: publish O(message size); receive O(messages stored),
 * because it scans for the visible ones (fine for tests).
 */
export function createMemoryQueue<const D extends AnyDefinition>(
  options: MemoryQueueOptions<D>
): MemoryQueue<D> {
  const { registry, clock } = options
  const sleep = options.sleep ?? systemSleep
  const maxReceiveCount = options.maxReceiveCount ?? 5
  const entries = new Map<number, Entry>()
  const dead: DeadLetter[] = []
  let nextId = 1
  const waiters = new Set<() => void>()

  function add(body: string): void {
    const id = nextId++
    entries.set(id, { id, body, receiveCount: 0, visibleAt: 0, inFlight: false })
    for (const wake of [...waiters]) {
      wake()
    }
  }

  function findByReceipt(receipt: Receipt): Entry | undefined {
    const id = Number(receipt.split('.')[0]?.slice(1))
    return receipt.startsWith('m') && Number.isInteger(id) ? entries.get(id) : undefined
  }

  /** The entry a receipt names, only while that very delivery is still the one in flight. */
  function inFlight(receipt: Receipt): Entry {
    const entry = findByReceipt(receipt)
    const count = Number(receipt.split('.')[1])
    if (
      entry === undefined ||
      !entry.inFlight ||
      entry.receiveCount !== count ||
      entry.visibleAt <= clock.now().getTime()
    ) {
      throw new QueueError(QUEUE_ERROR_CODES.receiptInvalid, 'the message is not in flight')
    }
    return entry
  }

  function take(max: number, visibilityTimeoutSeconds: number): Delivery<EnvelopeOf<D>>[] {
    const now = clock.now().getTime()
    const out: Delivery<EnvelopeOf<D>>[] = []
    const candidates = [...entries.values()]
    if (options.random !== undefined) {
      for (let i = candidates.length - 1; i > 0; i--) {
        const j = Math.floor(options.random() * (i + 1))
        const swap = candidates[i] as Entry
        candidates[i] = candidates[j] as Entry
        candidates[j] = swap
      }
    }
    for (const entry of candidates) {
      if (out.length >= max) {
        break
      }
      if (entry.visibleAt > now) {
        continue
      }
      if (entry.receiveCount >= maxReceiveCount) {
        entries.delete(entry.id)
        const decoded = registry.decode(entry.body)
        dead.push({
          messageId: decoded.ok ? decoded.envelope.id : decoded.messageId,
          receiveCount: entry.receiveCount,
        })
        continue
      }
      entry.receiveCount += 1
      entry.inFlight = true
      entry.visibleAt = now + visibilityTimeoutSeconds * 1000
      const receipt = `m${entry.id}.${entry.receiveCount}`
      const decoded = registry.decode(entry.body)
      out.push(
        decoded.ok
          ? {
              kind: 'message',
              envelope: decoded.envelope,
              receipt,
              receiveCount: entry.receiveCount,
            }
          : {
              kind: 'invalid',
              reason: decoded.reason,
              issues: decoded.issues,
              ...(decoded.messageId === undefined ? {} : { messageId: decoded.messageId }),
              receipt,
              receiveCount: entry.receiveCount,
            }
      )
    }
    return out
  }

  function encodeChecked(envelope: EnvelopeOf<D>): string {
    const body = registry.encode(envelope)
    if (bytesOf(body) > MAX_MESSAGE_BYTES) {
      throw new QueueError(QUEUE_ERROR_CODES.messageTooLarge, 'the message is over 256 KiB')
    }
    return body
  }

  function setVisibility(receipt: Receipt, seconds: number): void {
    assertVisibility(seconds)
    const entry = inFlight(receipt)
    entry.visibleAt = clock.now().getTime() + seconds * 1000
    if (seconds === 0) {
      entry.inFlight = false
      for (const wake of [...waiters]) {
        wake()
      }
    }
  }

  return {
    async publish(envelope) {
      add(encodeChecked(envelope))
    },
    async publishBatch(envelopes) {
      assertBatchCount(envelopes.length)
      const bodies = envelopes.map(encodeChecked)
      if (bodies.reduce((sum, body) => sum + bytesOf(body), 0) > MAX_MESSAGE_BYTES) {
        throw new QueueError(QUEUE_ERROR_CODES.batchTooLarge, 'a batch is at most 256 KiB in total')
      }
      for (const body of bodies) {
        add(body)
      }
      const result: BatchResult = { sent: envelopes.map((envelope) => envelope.id), failed: [] }
      return result
    },
    async receive(receiveOptions: ReceiveOptions) {
      assertReceiveOptions(receiveOptions)
      const { maxMessages, visibilityTimeoutSeconds, waitSeconds, signal } = receiveOptions
      let found = take(maxMessages, visibilityTimeoutSeconds)
      if (found.length > 0 || waitSeconds === 0 || signal?.aborted) {
        return found
      }
      const wake = new AbortController()
      const published = new Promise<void>((resolve) => {
        const listener = () => {
          waiters.delete(listener)
          resolve()
        }
        waiters.add(listener)
        wake.signal.addEventListener('abort', () => waiters.delete(listener), { once: true })
      })
      const stop = new AbortController()
      signal?.addEventListener('abort', () => stop.abort(), { once: true })
      try {
        await Promise.race([published, sleep(waitSeconds * 1000, stop.signal)])
      } finally {
        wake.abort()
        stop.abort()
      }
      found = signal?.aborted ? [] : take(maxMessages, visibilityTimeoutSeconds)
      return found
    },
    async acknowledge(receipt) {
      // Only the most recent delivery's receipt deletes: after a redelivery the older receipt is
      // stale, and (as in SQS) acknowledging with it must not remove the message.
      const entry = findByReceipt(receipt)
      if (entry !== undefined && entry.receiveCount === Number(receipt.split('.')[1])) {
        entries.delete(entry.id)
      }
    },
    async extendVisibility(receipt, seconds) {
      setVisibility(receipt, seconds)
    },
    async release(receipt) {
      setVisibility(receipt, 0)
    },
    deadLetters: () => [...dead],
    depth() {
      const now = clock.now().getTime()
      let visible = 0
      let hidden = 0
      for (const entry of entries.values()) {
        if (entry.visibleAt > now) {
          hidden += 1
        } else {
          visible += 1
        }
      }
      return { visible, inFlight: hidden }
    },
    publishRaw: add,
  }
}
