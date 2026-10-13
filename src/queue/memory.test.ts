import { describe, expect, test } from 'bun:test'
import { createMemoryQueue } from './memory'
import { createTestRegistry, createVirtualTime } from './testing'

function setup(maxReceiveCount = 3) {
  const time = createVirtualTime()
  const registry = createTestRegistry({ clock: time.clock })
  const queue = createMemoryQueue({
    registry,
    clock: time.clock,
    sleep: time.sleep,
    maxReceiveCount,
  })
  const ping = (n: number, id?: string) =>
    registry.create({
      type: 'test.ping',
      payload: { n },
      organizationId: 'org_a',
      traceId: 't',
      ...(id === undefined ? {} : { id }),
    })
  return { time, registry, queue, ping }
}
const one = { maxMessages: 1, visibilityTimeoutSeconds: 5, waitSeconds: 0 }

describe('memory queue specifics', () => {
  test('an expired receipt cannot extend the visibility of a message that was redelivered', async () => {
    const { time, queue, ping } = setup()
    await queue.publish(ping(1))
    const [first] = await queue.receive(one)
    await time.advance(6000)
    const [second] = await queue.receive(one)
    expect(second?.receiveCount).toBe(2)
    await expect(queue.extendVisibility(first?.receipt ?? '', 5)).rejects.toMatchObject({
      code: 'queue.receipt_invalid',
    })
    await expect(queue.extendVisibility(second?.receipt ?? '', 5)).resolves.toBeUndefined()
  })

  test('a receipt whose timeout already passed is not in flight', async () => {
    const { time, queue, ping } = setup()
    await queue.publish(ping(1))
    const [got] = await queue.receive(one)
    await time.advance(5000)
    await expect(queue.extendVisibility(got?.receipt ?? '', 5)).rejects.toMatchObject({
      code: 'queue.receipt_invalid',
    })
  })

  test('a garbage receipt is not in flight, and acknowledging it is harmless', async () => {
    const { queue } = setup()
    await expect(queue.extendVisibility('nonsense', 5)).rejects.toMatchObject({
      code: 'queue.receipt_invalid',
    })
    await expect(queue.acknowledge('nonsense')).resolves.toBeUndefined()
  })

  test('a long poll returns as soon as a message is published, without time passing', async () => {
    const { time, queue, ping } = setup()
    const waiting = queue.receive({ ...one, waitSeconds: 20 })
    await time.settle()
    expect(time.pending()).toBe(1)
    await queue.publish(ping(1))
    expect(await waiting).toHaveLength(1)
    expect(time.pending()).toBe(0)
  })

  test('a long poll on an empty queue ends with an empty list when the wait passes', async () => {
    const { time, queue } = setup()
    const waiting = queue.receive({ ...one, waitSeconds: 20 })
    await time.advance(20_000)
    expect(await waiting).toEqual([])
  })

  test('aborting a long poll returns an empty list at once', async () => {
    const { time, queue } = setup()
    const stop = new AbortController()
    const waiting = queue.receive({ ...one, waitSeconds: 20, signal: stop.signal })
    await time.settle()
    stop.abort()
    expect(await waiting).toEqual([])
    expect(time.pending()).toBe(0)
  })

  test('depth and dead letters follow the clock', async () => {
    const { time, queue, ping } = setup(1)
    await queue.publish(ping(1, 'm1'))
    expect(queue.depth()).toEqual({ visible: 1, inFlight: 0 })
    await queue.receive(one)
    expect(queue.depth()).toEqual({ visible: 0, inFlight: 1 })
    await time.advance(5000)
    expect(await queue.receive(one)).toEqual([])
    expect(queue.deadLetters()).toEqual([{ messageId: 'm1', receiveCount: 1 }])
  })
})
