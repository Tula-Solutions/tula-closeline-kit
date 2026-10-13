import { describe, expect, test } from 'bun:test'
import { createMemoryErrorReporter } from '../reporting/testing'
import { createMemoryLogger } from '../testing'
import { createConsumer, type Handlers } from './consumer'
import { QUEUE_ERROR_CODES, QueueError } from './errors'
import { createMemoryQueue } from './memory'
import type { Queue } from './port'
import { createMemoryProcessedStore, type ProcessedStore } from './store'
import { createTestRegistry, createVirtualTime, type TestEnvelope } from './testing'

function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open }
}

function setup(
  overrides: {
    maxReceiveCount?: number
    wrapQueue?: (queue: Queue<TestEnvelope>) => Queue<TestEnvelope>
    store?: (inner: ProcessedStore) => ProcessedStore
  } = {}
) {
  const time = createVirtualTime()
  const registry = createTestRegistry({ clock: time.clock })
  const memory = createMemoryQueue({
    registry,
    clock: time.clock,
    sleep: time.sleep,
    maxReceiveCount: overrides.maxReceiveCount ?? 3,
  })
  const queue = overrides.wrapQueue ? overrides.wrapQueue(memory) : memory
  const baseStore = createMemoryProcessedStore({ clock: time.clock })
  const store = overrides.store ? overrides.store(baseStore) : baseStore
  const logger = createMemoryLogger()
  const errorReporter = createMemoryErrorReporter()
  const ping = (n: number, org = 'org_a', id?: string) =>
    registry.create({
      type: 'test.ping',
      payload: { n },
      organizationId: org,
      traceId: `trace_${n}`,
      ...(id === undefined ? {} : { id }),
    })
  const make = (
    handlers: Handlers<TestEnvelope>,
    extra: Partial<Parameters<typeof createConsumer<TestEnvelope>>[0]> = {}
  ) =>
    createConsumer<TestEnvelope>({
      name: 'test.consumer',
      queue,
      store,
      handlers,
      logger,
      errorReporter,
      sleep: time.sleep,
      random: () => 0.5,
      visibilityTimeoutSeconds: 30,
      handlerTimeoutMs: 120_000,
      ...extra,
    })
  return { time, registry, memory, queue, store, logger, errorReporter, ping, make }
}

describe('messages this consumer cannot accept', () => {
  test('an invalid body does not reach a handler, is not acknowledged and does not stop the loop', async () => {
    const t = setup()
    const calls: number[] = []
    const consumer = t.make({ 'test.ping': async (m) => void calls.push(m.payload.n) })
    t.memory.publishRaw('{"secret":"BODY-TEXT"')
    await t.queue.publish(t.ping(1))
    expect(await consumer.pollOnce()).toBe(2)
    expect(calls).toEqual([1])
    expect(t.memory.depth()).toEqual({ visible: 0, inFlight: 1 })
    expect(t.errorReporter.captured).toHaveLength(1)
    const logged = JSON.stringify(t.logger.entries)
    expect(logged).toContain('malformed')
    expect(logged).not.toContain('BODY-TEXT')
  })

  test('an invalid message comes back after its delay and finally goes to the dead-letter list', async () => {
    const t = setup({ maxReceiveCount: 3 })
    const consumer = t.make({ 'test.ping': async () => undefined }, { invalidDelaySeconds: 60 })
    t.memory.publishRaw('not json')
    for (let round = 0; round < 3; round++) {
      expect(await consumer.pollOnce()).toBe(1)
      expect(await consumer.pollOnce()).toBe(0)
      await t.time.advance(61_000)
    }
    expect(await consumer.pollOnce()).toBe(0)
    expect(t.memory.deadLetters()).toHaveLength(1)
  })

  test('a valid message of a type with no handler is left in the queue, logged and reported', async () => {
    const t = setup()
    const consumer = t.make({ 'test.ping': async () => undefined })
    await t.queue.publish(
      t.registry.create({ type: 'test.note', payload: { text: 'x' }, traceId: 't' })
    )
    expect(await consumer.pollOnce()).toBe(1)
    expect(t.memory.depth().inFlight).toBe(1)
    expect(t.errorReporter.captured).toHaveLength(1)
  })
})

describe('a handler that fails', () => {
  test('is retried after a delay and its effect happens once', async () => {
    const t = setup()
    let attempts = 0
    const effects: number[] = []
    const consumer = t.make({
      'test.ping': async (m) => {
        attempts += 1
        if (attempts === 1) {
          throw new Error('boom')
        }
        effects.push(m.payload.n)
      },
    })
    await t.queue.publish(t.ping(1))
    await consumer.pollOnce()
    expect(t.errorReporter.captured).toHaveLength(1)
    expect(await consumer.pollOnce()).toBe(0)
    await t.time.advance(6_000)
    await consumer.pollOnce()
    expect(effects).toEqual([1])
    expect(attempts).toBe(2)
    expect(t.memory.depth()).toEqual({ visible: 0, inFlight: 0 })
  })

  test('the retry delay grows with each delivery, up to a cap, and is jittered', async () => {
    const delays: number[] = []
    const t = setup({
      maxReceiveCount: 10,
      wrapQueue: (queue) => ({
        ...queue,
        extendVisibility: async (receipt, seconds) => {
          delays.push(seconds)
          await queue.extendVisibility(receipt, seconds)
        },
      }),
    })
    const consumer = t.make(
      {
        'test.ping': async () => {
          throw new Error('always')
        },
      },
      { retryBaseSeconds: 4, retryMaxSeconds: 20, random: () => 0 }
    )
    await t.queue.publish(t.ping(1))
    for (let i = 0; i < 5; i++) {
      await consumer.pollOnce()
      await t.time.advance(30_000)
    }
    // ceilings 4, 8, 16, 20, 20; with random 0 the delay is half of each
    expect(delays).toEqual([2, 4, 8, 10, 10])
  })

  test('a message that always fails reaches the dead-letter list after maxReceiveCount deliveries', async () => {
    const t = setup({ maxReceiveCount: 3 })
    let attempts = 0
    const consumer = t.make({
      'test.ping': async () => {
        attempts += 1
        throw new Error('poison')
      },
    })
    await t.queue.publish(t.ping(1, 'org_a', 'poison_1'))
    for (let i = 0; i < 6; i++) {
      await consumer.pollOnce()
      await t.time.advance(400_000)
    }
    expect(attempts).toBe(3)
    expect(t.memory.deadLetters().map((letter) => letter.messageId)).toEqual(['poison_1'])
  })

  test('a thrown value that is not an Error does not crash the loop', async () => {
    const t = setup()
    const consumer = t.make({
      'test.ping': async () => {
        throw 'just a string'
      },
    })
    await t.queue.publish(t.ping(1))
    await expect(consumer.pollOnce()).resolves.toBe(1)
  })
})

describe('idempotence', () => {
  test('a message published twice with the same id has its effect once and both copies are acknowledged', async () => {
    const t = setup()
    const effects: number[] = []
    const consumer = t.make(
      { 'test.ping': async (m) => void effects.push(m.payload.n) },
      { concurrency: 1 }
    )
    await t.queue.publish(t.ping(1, 'org_a', 'dup'))
    await t.queue.publish(t.ping(1, 'org_a', 'dup'))
    expect(await consumer.pollOnce()).toBe(1)
    expect(await consumer.pollOnce()).toBe(1)
    expect(effects).toEqual([1])
    expect(t.memory.depth()).toEqual({ visible: 0, inFlight: 0 })
  })

  test('two consumers that receive the same message run it once: the second backs off then acknowledges', async () => {
    const t = setup()
    const effects: string[] = []
    const hold = gate()
    const first = t.make({
      'test.ping': async () => {
        effects.push('first')
        await hold.opened
      },
    })
    const second = t.make({ 'test.ping': async () => void effects.push('second') })
    await t.queue.publish(t.ping(1, 'org_a', 'twin'))
    const running = first.pollOnce()
    await t.time.settle()
    // The same message arrives a second time (a duplicate in the queue) while the first runs.
    await t.queue.publish(t.ping(1, 'org_a', 'twin'))
    expect(await second.pollOnce()).toBe(1)
    expect(effects).toEqual(['first'])
    hold.open()
    await running
    // The duplicate was hidden until the holder's lease would have lapsed (a minute at most).
    await t.time.advance(61_000)
    expect(await second.pollOnce()).toBe(1)
    expect(effects).toEqual(['first'])
    expect(t.memory.depth()).toEqual({ visible: 0, inFlight: 0 })
  })

  test('a store that fails on claim leaves the message in the queue and does not crash', async () => {
    const t = setup({
      store: (inner) => ({
        ...inner,
        claim: async () => {
          throw new Error('db down')
        },
      }),
    })
    const calls: number[] = []
    const consumer = t.make({ 'test.ping': async (m) => void calls.push(m.payload.n) })
    await t.queue.publish(t.ping(1))
    await expect(consumer.pollOnce()).resolves.toBe(1)
    expect(calls).toEqual([])
    expect(t.memory.depth().inFlight).toBe(1)
    expect(t.errorReporter.captured).toHaveLength(1)
  })

  test('a store that fails on complete releases the claim so the retry can run', async () => {
    let failComplete = true
    const t = setup({
      store: (inner) => ({
        ...inner,
        complete: async (key, token) => {
          if (failComplete) {
            throw new Error('db down')
          }
          return inner.complete(key, token)
        },
      }),
    })
    const calls: number[] = []
    const consumer = t.make({ 'test.ping': async (m) => void calls.push(m.payload.n) })
    await t.queue.publish(t.ping(1))
    await consumer.pollOnce()
    expect(t.memory.depth().inFlight).toBe(1)
    failComplete = false
    await t.time.advance(10_000)
    await consumer.pollOnce()
    expect(calls).toEqual([1, 1])
    expect(t.memory.depth()).toEqual({ visible: 0, inFlight: 0 })
  })
})

describe('a handler that outlives the visibility timeout', () => {
  test('keeps the message hidden by extending it, and acknowledges when it finishes', async () => {
    const t = setup()
    const hold = gate()
    const consumer = t.make({ 'test.ping': async () => hold.opened })
    await t.queue.publish(t.ping(1))
    const running = consumer.pollOnce()
    await t.time.settle()
    await t.time.advance(100_000)
    expect(t.memory.depth()).toEqual({ visible: 0, inFlight: 1 })
    hold.open()
    await running
    expect(t.memory.depth()).toEqual({ visible: 0, inFlight: 0 })
  })

  test('past handlerTimeoutMs its signal aborts, the message is not acknowledged and is retried later', async () => {
    const t = setup()
    let signal: AbortSignal | undefined
    let runs = 0
    const hold = gate()
    const consumer = t.make(
      {
        'test.ping': async (_m, ctx) => {
          runs += 1
          if (runs === 1) {
            signal = ctx.signal
            await hold.opened
          }
        },
      },
      { handlerTimeoutMs: 60_000 }
    )
    await t.queue.publish(t.ping(1))
    const running = consumer.pollOnce()
    await t.time.settle()
    await t.time.advance(61_000)
    await running
    expect(signal?.aborted).toBe(true)
    expect(t.errorReporter.captured).toHaveLength(1)
    // The claim lapses after the handler timeout plus one visibility window.
    await t.time.advance(100_000)
    await consumer.pollOnce()
    expect(runs).toBe(2)
    expect(t.memory.depth()).toEqual({ visible: 0, inFlight: 0 })
    hold.open()
  })

  test('losing the message while the handler runs aborts it and does not acknowledge', async () => {
    const t = setup({
      wrapQueue: (queue) => ({
        ...queue,
        extendVisibility: async () => {
          throw new QueueError(QUEUE_ERROR_CODES.receiptInvalid, 'gone')
        },
      }),
    })
    const hold = gate()
    let signal: AbortSignal | undefined
    const consumer = t.make({
      'test.ping': async (_m, ctx) => {
        signal = ctx.signal
        await hold.opened
      },
    })
    await t.queue.publish(t.ping(1))
    const running = consumer.pollOnce()
    await t.time.settle()
    await t.time.advance(11_000)
    await running
    expect(signal?.aborted).toBe(true)
    expect(t.memory.depth().inFlight).toBe(1)
    hold.open()
  })
})

describe('shutdown', () => {
  test('stop lets work in flight finish within the deadline and receives nothing more', async () => {
    const t = setup()
    const hold = gate()
    const done: number[] = []
    const consumer = t.make(
      {
        'test.ping': async (m) => {
          await hold.opened
          done.push(m.payload.n)
        },
      },
      { concurrency: 2 }
    )
    consumer.start()
    await t.queue.publish(t.ping(1))
    await t.time.settle()
    const stopping = consumer.stop(10_000)
    await t.time.settle()
    hold.open()
    const result = await stopping
    expect(done).toEqual([1])
    expect(result).toEqual({ finished: 1, abandoned: 0 })
    await t.queue.publish(t.ping(2))
    await t.time.advance(60_000)
    expect(done).toEqual([1])
    expect(t.memory.depth().visible).toBe(1)
  })

  test('past the deadline stop aborts the handler, releases the claim and gives the message back', async () => {
    const t = setup()
    const hold = gate()
    let signal: AbortSignal | undefined
    let runs = 0
    const consumer = t.make({
      'test.ping': async (_m, ctx) => {
        runs += 1
        if (runs === 1) {
          signal = ctx.signal
          await hold.opened
        }
      },
    })
    consumer.start()
    await t.queue.publish(t.ping(1))
    await t.time.settle()
    const stopping = consumer.stop(5_000)
    await t.time.advance(5_000)
    const result = await stopping
    expect(result).toEqual({ finished: 0, abandoned: 1 })
    expect(signal?.aborted).toBe(true)
    expect(t.memory.depth()).toEqual({ visible: 1, inFlight: 0 })
    hold.open()
    await t.time.settle()
    // Late completion of the abandoned handler changes nothing; another instance takes the message.
    const other = t.make({ 'test.ping': async () => undefined })
    await other.pollOnce()
    expect(t.memory.depth()).toEqual({ visible: 0, inFlight: 0 })
  })

  test('stop with nothing in flight returns at once, and stop before start is harmless', async () => {
    const t = setup()
    const idle = t.make({})
    expect(await idle.stop(1000)).toEqual({ finished: 0, abandoned: 0 })
    const running = t.make({})
    running.start()
    running.start()
    await t.time.settle()
    expect(await running.stop(1000)).toEqual({ finished: 0, abandoned: 0 })
    expect(t.time.pending()).toBe(0)
  })

  test('a receive error is logged and retried with a back-off; the loop survives', async () => {
    let failures = 2
    const t = setup({
      wrapQueue: (queue) => ({
        ...queue,
        receive: async (options) => {
          if (failures > 0) {
            failures -= 1
            throw new QueueError(QUEUE_ERROR_CODES.unavailable, 'down')
          }
          return queue.receive(options)
        },
      }),
    })
    const calls: number[] = []
    const consumer = t.make({ 'test.ping': async (m) => void calls.push(m.payload.n) })
    await t.queue.publish(t.ping(1))
    consumer.start()
    await t.time.settle()
    expect(calls).toEqual([])
    await t.time.advance(2_000)
    await t.time.advance(2_000)
    expect(calls).toEqual([1])
    expect(t.errorReporter.captured).toHaveLength(2)
    await consumer.stop(1000)
  })
})

describe('concurrency', () => {
  test('never runs more handlers than the limit, and handles every message', async () => {
    const t = setup()
    let running = 0
    let peak = 0
    const done: number[] = []
    const holds = Array.from({ length: 5 }, () => gate())
    const consumer = t.make(
      {
        'test.ping': async (m) => {
          running += 1
          peak = Math.max(peak, running)
          await holds[m.payload.n]?.opened
          running -= 1
          done.push(m.payload.n)
        },
      },
      { concurrency: 2 }
    )
    for (let n = 0; n < 5; n++) {
      await t.queue.publish(t.ping(n, 'org_a', `m${n}`))
    }
    consumer.start()
    await t.time.settle()
    expect(running).toBe(2)
    for (const hold of holds) {
      hold.open()
      await t.time.settle()
    }
    expect([...done].sort()).toEqual([0, 1, 2, 3, 4])
    expect(peak).toBe(2)
    await consumer.stop(1000)
  })

  test.each([
    ['concurrency 0', { concurrency: 0 }],
    ['concurrency 1.5', { concurrency: 1.5 }],
    ['waitSeconds 21', { waitSeconds: 21 }],
    ['visibility 1', { visibilityTimeoutSeconds: 1 }],
    ['a blank name', { name: ' ' }],
    ['retryMax below base', { retryBaseSeconds: 10, retryMaxSeconds: 5 }],
  ])('refuses %s at construction', (_label, options) => {
    const t = setup()
    expect(() => t.make({}, options)).toThrow(TypeError)
  })
})

describe('tenant scoping', () => {
  test('a handler sees the organization id of the message it was given, and nothing else', async () => {
    const t = setup()
    const seen: Array<{ org: string | undefined; ctxOrg: string | undefined; n: number }> = []
    const consumer = t.make({
      'test.ping': async (m, ctx) => {
        seen.push({ org: m.organizationId, ctxOrg: ctx.organizationId, n: m.payload.n })
      },
    })
    await t.queue.publish(t.ping(1, 'org_a'))
    await t.queue.publish(t.ping(2, 'org_b'))
    await consumer.pollOnce()
    expect(seen.sort((x, y) => x.n - y.n)).toEqual([
      { org: 'org_a', ctxOrg: 'org_a', n: 1 },
      { org: 'org_b', ctxOrg: 'org_b', n: 2 },
    ])
  })

  test('the same message id in a second organization is a different message, not a duplicate', async () => {
    const t = setup()
    const seen: string[] = []
    const consumer = t.make({
      'test.ping': async (_m, ctx) => void seen.push(String(ctx.organizationId)),
    })
    await t.queue.publish(t.ping(1, 'org_a', 'shared_id'))
    await consumer.pollOnce()
    await t.queue.publish(t.ping(1, 'org_b', 'shared_id'))
    await consumer.pollOnce()
    // And a real duplicate in org_a is still dropped.
    await t.queue.publish(t.ping(1, 'org_a', 'shared_id'))
    await consumer.pollOnce()
    expect(seen).toEqual(['org_a', 'org_b'])
  })

  test("the store key carries the organization, so one organization's completion is not another's", async () => {
    const keys: Array<string | null> = []
    const t = setup({
      store: (inner) => ({
        ...inner,
        claim: async (key, lease) => {
          keys.push(key.organizationId)
          return inner.claim(key, lease)
        },
      }),
    })
    const consumer = t.make({ 'test.ping': async () => undefined })
    await t.queue.publish(t.ping(1, 'org_a', 'x'))
    await t.queue.publish(t.ping(1, 'org_b', 'x'))
    await consumer.pollOnce()
    expect([...keys].sort()).toEqual(['org_a', 'org_b'])
  })

  test('a handler cannot change the context or the envelope it was given', async () => {
    const t = setup()
    const outcomes: string[] = []
    const consumer = t.make({
      'test.ping': async (m, ctx) => {
        for (const change of [
          () => {
            ;(ctx as { organizationId?: string }).organizationId = 'org_evil'
          },
          () => {
            ;(m as { organizationId?: string }).organizationId = 'org_evil'
          },
        ]) {
          try {
            change()
            outcomes.push('changed')
          } catch {
            outcomes.push('refused')
          }
        }
        outcomes.push(String(ctx.organizationId))
      },
    })
    await t.queue.publish(t.ping(1, 'org_a'))
    await consumer.pollOnce()
    expect(outcomes).toEqual(['refused', 'refused', 'org_a'])
  })

  test('an organization message that carries no organization id never reaches a handler', async () => {
    const t = setup()
    const calls: number[] = []
    const consumer = t.make({ 'test.ping': async (m) => void calls.push(m.payload.n) })
    const good = t.ping(1)
    t.memory.publishRaw(JSON.stringify({ ...good, organizationId: undefined }))
    await consumer.pollOnce()
    expect(calls).toEqual([])
  })
})

describe('the claim lease is a heartbeat', () => {
  const key = { consumer: 'test.consumer', organizationId: 'org_a' }

  test('a crashed holder does not burn the message towards the dead-letter queue', async () => {
    const t = setup({ maxReceiveCount: 5 })
    const runs: number[] = []
    const consumer = t.make({ 'test.ping': async (m) => void runs.push(m.payload.n) })
    await t.queue.publish(t.ping(1, 'org_a', 'crash'))
    // A holder claimed the message (lease: two visibility windows) and received it, then died.
    await t.store.claim({ ...key, messageId: 'crash' }, 60)
    await t.queue.receive({ maxMessages: 1, visibilityTimeoutSeconds: 30, waitSeconds: 0 })
    for (let i = 0; i < 8; i++) {
      await t.time.advance(31_000)
      await consumer.pollOnce()
    }
    expect(runs).toEqual([1])
    expect(t.memory.deadLetters()).toEqual([])
    expect(t.memory.depth()).toEqual({ visible: 0, inFlight: 0 })
  })

  test('a store that fails to release a claim after a failed handler does not burn it either', async () => {
    const t = setup({
      maxReceiveCount: 5,
      store: (inner) => ({
        ...inner,
        release: async () => {
          throw new Error('db down')
        },
      }),
    })
    let attempts = 0
    let lastCount = 0
    const consumer = t.make({
      'test.ping': async (_m, ctx) => {
        attempts += 1
        lastCount = ctx.receiveCount
        if (attempts === 1) {
          throw new Error('boom')
        }
      },
    })
    await t.queue.publish(t.ping(1))
    for (let i = 0; i < 10; i++) {
      await consumer.pollOnce()
      await t.time.advance(31_000)
    }
    expect(attempts).toBe(2)
    expect(lastCount).toBeLessThanOrEqual(3)
    expect(t.memory.deadLetters()).toEqual([])
  })

  test('while a handler runs, each visibility extension renews the lease with the same token', async () => {
    const renewals: Array<{ token: string; seconds: number }> = []
    const t = setup({
      store: (inner) => ({
        ...inner,
        renew: async (k, token, seconds) => {
          renewals.push({ token, seconds })
          return inner.renew(k, token, seconds)
        },
      }),
    })
    const hold = gate()
    const consumer = t.make({ 'test.ping': async () => hold.opened })
    await t.queue.publish(t.ping(1, 'org_a', 'long'))
    const running = consumer.pollOnce()
    await t.time.settle()
    await t.time.advance(100_000)
    // A second consumer meeting the same message finds a live claim, a minute at most from lapsing.
    expect(await t.store.claim({ ...key, messageId: 'long' }, 60)).toMatchObject({ status: 'busy' })
    hold.open()
    await running
    expect(renewals.length).toBeGreaterThanOrEqual(8)
    expect(new Set(renewals.map((r) => r.token)).size).toBe(1)
    expect(renewals.every((r) => r.seconds === 60)).toBe(true)
  })

  test('a lease that cannot be renewed means the claim was lost: the handler is aborted and nothing is acknowledged', async () => {
    const t = setup({ store: (inner) => ({ ...inner, renew: async () => false }) })
    const hold = gate()
    let signal: AbortSignal | undefined
    const consumer = t.make({
      'test.ping': async (_m, ctx) => {
        signal = ctx.signal
        await hold.opened
      },
    })
    await t.queue.publish(t.ping(1))
    const running = consumer.pollOnce()
    await t.time.settle()
    await t.time.advance(11_000)
    await running
    expect(signal?.aborted).toBe(true)
    expect(t.memory.depth().inFlight).toBe(1)
    hold.open()
  })

  test('a renew that throws is tolerated: the next tick tries again', async () => {
    let calls = 0
    const t = setup({
      store: (inner) => ({
        ...inner,
        renew: async (k, token, seconds) => {
          calls += 1
          if (calls === 1) {
            throw new Error('blip')
          }
          return inner.renew(k, token, seconds)
        },
      }),
    })
    const hold = gate()
    let signal: AbortSignal | undefined
    const consumer = t.make({
      'test.ping': async (_m, ctx) => {
        signal = ctx.signal
        await hold.opened
      },
    })
    await t.queue.publish(t.ping(1))
    const running = consumer.pollOnce()
    await t.time.settle()
    await t.time.advance(35_000)
    expect(signal?.aborted).toBe(false)
    hold.open()
    await running
    expect(t.memory.depth()).toEqual({ visible: 0, inFlight: 0 })
  })
})

describe('time limits', () => {
  test('a handler timeout shorter than one extension tick is honoured', async () => {
    const t = setup()
    const hold = gate()
    let signal: AbortSignal | undefined
    const consumer = t.make(
      {
        'test.ping': async (_m, ctx) => {
          signal = ctx.signal
          await hold.opened
        },
      },
      { handlerTimeoutMs: 400 }
    )
    await t.queue.publish(t.ping(1))
    const running = consumer.pollOnce()
    await t.time.settle()
    await t.time.advance(400)
    await running
    expect(signal?.aborted).toBe(true)
    hold.open()
  })

  test('a store that never answers cannot wedge a slot: the call times out and the message is left for a retry', async () => {
    const t = setup({ store: (inner) => ({ ...inner, claim: () => new Promise(() => undefined) }) })
    const consumer = t.make({ 'test.ping': async () => undefined })
    await t.queue.publish(t.ping(1))
    const running = consumer.pollOnce()
    await t.time.settle()
    await t.time.advance(10_000)
    await expect(running).resolves.toBe(1)
    expect(t.memory.depth().inFlight).toBe(1)
    expect(t.errorReporter.captured).toHaveLength(1)
  })

  test('a store that never answers on complete is also cut off, and the claim is released', async () => {
    let hang = true
    const t = setup({
      store: (inner) => ({
        ...inner,
        complete: (k, token) => (hang ? new Promise(() => undefined) : inner.complete(k, token)),
      }),
    })
    const calls: number[] = []
    const consumer = t.make({ 'test.ping': async (m) => void calls.push(m.payload.n) })
    await t.queue.publish(t.ping(1))
    const running = consumer.pollOnce()
    await t.time.settle()
    await t.time.advance(10_000)
    await running
    hang = false
    await t.time.advance(10_000)
    await consumer.pollOnce()
    expect(calls).toEqual([1, 1])
  })
})

describe('shutdown interleavings', () => {
  test('stop passing its deadline while a flight is still claiming: no handler runs and the claim is released', async () => {
    const claimGate = gate()
    const t = setup({
      store: (inner) => ({
        ...inner,
        claim: async (k, lease) => {
          await claimGate.opened
          return inner.claim(k, lease)
        },
      }),
    })
    let ran = false
    const consumer = t.make({
      'test.ping': async () => {
        ran = true
      },
    })
    consumer.start()
    await t.queue.publish(t.ping(1, 'org_a', 'late'))
    await t.time.settle()
    const stopping = consumer.stop(5_000)
    await t.time.advance(5_000)
    expect(await stopping).toEqual({ finished: 0, abandoned: 1 })
    claimGate.open()
    await t.time.settle()
    expect(ran).toBe(false)
    expect(
      await t.store.claim(
        { consumer: 'test.consumer', organizationId: 'org_a', messageId: 'late' },
        60
      )
    ).toMatchObject({ status: 'claimed' })
  })

  test('stop twice reports the same result and counts nothing twice', async () => {
    const t = setup()
    const hold = gate()
    const consumer = t.make({ 'test.ping': async () => hold.opened })
    consumer.start()
    await t.queue.publish(t.ping(1))
    await t.time.settle()
    const first = consumer.stop(1_000)
    const second = consumer.stop(1_000)
    await t.time.advance(1_000)
    expect(await first).toEqual({ finished: 0, abandoned: 1 })
    expect(await second).toEqual({ finished: 0, abandoned: 1 })
    expect(await consumer.stop(1_000)).toEqual({ finished: 0, abandoned: 1 })
    hold.open()
  })
})

describe('other interleavings', () => {
  test('a claim lost before complete is logged and the message is still acknowledged', async () => {
    const t = setup({ store: (inner) => ({ ...inner, complete: async () => false }) })
    const consumer = t.make({ 'test.ping': async () => undefined })
    await t.queue.publish(t.ping(1))
    await consumer.pollOnce()
    expect(t.memory.depth()).toEqual({ visible: 0, inFlight: 0 })
    expect(t.logger.entries.some((e) => e.message.includes('claim was lost'))).toBe(true)
  })

  test('an acknowledge that fails after complete is logged, and the redelivery is acknowledged without running again', async () => {
    let failAck = true
    const t = setup({
      wrapQueue: (queue) => ({
        ...queue,
        acknowledge: async (receipt) => {
          if (failAck) {
            throw new QueueError(QUEUE_ERROR_CODES.unavailable, 'down')
          }
          return queue.acknowledge(receipt)
        },
      }),
    })
    const calls: number[] = []
    const consumer = t.make({ 'test.ping': async (m) => void calls.push(m.payload.n) })
    await t.queue.publish(t.ping(1))
    await consumer.pollOnce()
    expect(t.logger.entries.some((e) => e.message.includes('acknowledge failed'))).toBe(true)
    failAck = false
    await t.time.advance(31_000)
    await consumer.pollOnce()
    expect(calls).toEqual([1])
    expect(t.memory.depth()).toEqual({ visible: 0, inFlight: 0 })
  })

  test('an unexpected failure inside the helper is logged and reported and does not stop the batch', async () => {
    let first = true
    const t = setup({
      store: (inner) => ({
        ...inner,
        claim: async (k, lease) => {
          if (first) {
            first = false
            return undefined as never
          }
          return inner.claim(k, lease)
        },
      }),
    })
    const calls: number[] = []
    const consumer = t.make({ 'test.ping': async (m) => void calls.push(m.payload.n) })
    await t.queue.publish(t.ping(1))
    await t.queue.publish(t.ping(2))
    await expect(consumer.pollOnce()).resolves.toBe(2)
    expect(calls).toHaveLength(1)
    expect(t.logger.entries.some((e) => e.message.includes('unexpected consumer failure'))).toBe(
      true
    )
    expect(t.errorReporter.captured).toHaveLength(1)
  })
})

describe('messages for a version this consumer does not know', () => {
  test('are delayed for longer each time', async () => {
    const delays: number[] = []
    const t = setup({
      maxReceiveCount: 10,
      wrapQueue: (queue) => ({
        ...queue,
        extendVisibility: async (receipt, seconds) => {
          delays.push(seconds)
          await queue.extendVisibility(receipt, seconds)
        },
      }),
    })
    const consumer = t.make({ 'test.ping': async () => undefined }, { invalidDelaySeconds: 60 })
    t.memory.publishRaw(JSON.stringify({ ...t.ping(1), version: 9 }))
    for (let i = 0; i < 4; i++) {
      await consumer.pollOnce()
      await t.time.advance(4_000_000)
    }
    expect(delays).toEqual([45, 90, 180, 360])
  })

  test('a plain invalid message keeps the flat delay', async () => {
    const delays: number[] = []
    const t = setup({
      maxReceiveCount: 10,
      wrapQueue: (queue) => ({
        ...queue,
        extendVisibility: async (receipt, seconds) => {
          delays.push(seconds)
          await queue.extendVisibility(receipt, seconds)
        },
      }),
    })
    const consumer = t.make({ 'test.ping': async () => undefined }, { invalidDelaySeconds: 60 })
    t.memory.publishRaw('not json')
    for (let i = 0; i < 3; i++) {
      await consumer.pollOnce()
      await t.time.advance(100_000)
    }
    expect(delays).toEqual([60, 60, 60])
  })
})

describe('what an invalid message leaves in logs and reports', () => {
  test('an unknown type and an email-keyed payload appear in no entry', async () => {
    const t = setup()
    const consumer = t.make({ 'test.ping': async () => undefined })
    t.memory.publishRaw(JSON.stringify({ ...t.ping(1), type: 'SECRET-xyz' }))
    t.memory.publishRaw(JSON.stringify({ ...t.ping(2), payload: { 'jane@acme.com': 1 } }))
    await consumer.pollOnce()
    const everything = JSON.stringify([t.logger.entries, t.errorReporter.captured.map(String)])
    expect(everything).not.toContain('SECRET')
    expect(everything).not.toContain('jane')
    expect(t.logger.entries.length).toBeGreaterThan(0)
  })
})

describe('the lease covers a slow store', () => {
  test('with a 2 s visibility timeout a renew that takes 3 s does not abort a healthy handler', async () => {
    const t = setup({
      store: (inner) => ({
        ...inner,
        renew: async (k, token, seconds) => {
          await t.time.sleep(3_000)
          return inner.renew(k, token, seconds)
        },
      }),
    })
    const hold = gate()
    const calls: number[] = []
    let signal: AbortSignal | undefined
    const consumer = t.make(
      {
        'test.ping': async (m, ctx) => {
          signal = ctx.signal
          await hold.opened
          calls.push(m.payload.n)
        },
      },
      { visibilityTimeoutSeconds: 2 }
    )
    await t.queue.publish(t.ping(1))
    const running = consumer.pollOnce()
    await t.time.settle()
    await t.time.advance(14_000)
    expect(signal?.aborted).toBe(false)
    hold.open()
    await running
    expect(calls).toEqual([1])
    expect(t.memory.depth()).toEqual({ visible: 0, inFlight: 0 })
  })

  test('the lease is at least the store timeout plus two ticks plus a margin, and a busy claim reports no more than the lease', async () => {
    const leases: number[] = []
    const t = setup({
      store: (inner) => ({
        ...inner,
        claim: async (k, lease) => {
          leases.push(lease)
          return inner.claim(k, lease)
        },
      }),
    })
    await t.queue.publish(t.ping(1))
    await t.make({ 'test.ping': async () => undefined }, { visibilityTimeoutSeconds: 2 }).pollOnce()
    // storeTimeoutMs 10 s -> 10 + 2 ticks of 1 s + 5 s margin
    expect(leases).toEqual([17])
    leases.length = 0
    await t.queue.publish(t.ping(2))
    await t.make({ 'test.ping': async () => undefined }).pollOnce()
    expect(leases).toEqual([60])
  })
})
