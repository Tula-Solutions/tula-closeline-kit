import { afterEach, describe, expect, test } from 'bun:test'
import { MAX_MESSAGE_BYTES } from './envelope'
import type { Delivery, Queue } from './port'
import type { createTestRegistry, TestEnvelope } from './testing'

/** What the behaviour suite needs from an adapter under test. */
export interface QueueSubject {
  /** The queue under test, empty, built over {@link createTestRegistry}. */
  queue: Queue<TestEnvelope>
  /** The registry the queue was built with. */
  registry: ReturnType<typeof createTestRegistry>
  /** The queue's visibility timeout for plain receives in the suite, in seconds (small). */
  visibilitySeconds: number
  /** Seconds a receive that expects nothing waits: 0 is enough for memory; SQS needs a long poll to be sure. */
  emptyWaitSeconds: number
  /** Deliveries before the dead-letter queue takes a message. */
  maxReceiveCount: number
  /** Lets `seconds` of the queue's time go by: advances a virtual clock, or really waits. */
  pass(seconds: number): Promise<void>
  /** Puts a raw body in the queue without validating it. */
  injectRaw(body: string): Promise<void>
  /** Envelope ids that reached the dead-letter queue; undefined when the subject cannot see it. */
  deadLetterIds(): Promise<string[] | undefined>
  /** Releases what the subject created. */
  close(): Promise<void>
}

/**
 * The behaviour every {@link Queue} must show. Run it with {@link queueBehaviour} against the
 * memory adapter and against the SQS adapter on ElasticMQ; a change that passes for one and fails
 * for the other is a bug in one of them.
 */
export function queueBehaviour(
  name: string,
  make: () => Promise<QueueSubject>,
  skip = false
): void {
  const run = skip ? describe.skip : describe
  run(`Queue behaviour: ${name}`, () => {
    const open: QueueSubject[] = []
    afterEach(async () => {
      await Promise.all(open.splice(0).map((subject) => subject.close()))
    })
    async function subject(): Promise<QueueSubject> {
      const made = await make()
      open.push(made)
      return made
    }
    const ping = (s: QueueSubject, n = 1, org = 'org_a', id?: string) =>
      s.registry.create({
        type: 'test.ping',
        payload: { n },
        organizationId: org,
        traceId: 'trace_1',
        ...(id === undefined ? {} : { id }),
      })

    /** Receives until `count` deliveries arrived or the attempts ran out. */
    async function take(
      s: QueueSubject,
      count: number,
      wait = 1
    ): Promise<Delivery<TestEnvelope>[]> {
      const got: Delivery<TestEnvelope>[] = []
      for (let attempt = 0; attempt < 5 && got.length < count; attempt++) {
        got.push(
          ...(await s.queue.receive({
            maxMessages: Math.min(10, count - got.length),
            visibilityTimeoutSeconds: s.visibilitySeconds,
            waitSeconds: wait,
          }))
        )
      }
      return got
    }
    const none = async (s: QueueSubject) =>
      await s.queue.receive({
        maxMessages: 10,
        visibilityTimeoutSeconds: s.visibilitySeconds,
        waitSeconds: s.emptyWaitSeconds,
      })

    test('publishing an envelope of an unknown type is refused and nothing is sent', async () => {
      const s = await subject()
      const bad = { ...ping(s), type: 'test.nope' } as unknown as TestEnvelope
      await expect(s.queue.publish(bad)).rejects.toMatchObject({ code: 'queue.invalid_message' })
      expect(await none(s)).toEqual([])
    })

    test('publishing a payload that fails its schema is refused', async () => {
      const s = await subject()
      const bad = { ...ping(s), payload: { n: 'x' } } as unknown as TestEnvelope
      await expect(s.queue.publish(bad)).rejects.toMatchObject({ code: 'queue.invalid_message' })
    })

    test('an organization message without an organization id is refused, and a global one with it', async () => {
      const s = await subject()
      const noOrg = { ...ping(s), organizationId: undefined } as unknown as TestEnvelope
      await expect(s.queue.publish(noOrg)).rejects.toMatchObject({ code: 'queue.invalid_message' })
      const note = s.registry.create({ type: 'test.note', payload: { text: 'hi' }, traceId: 't' })
      const withOrg = { ...note, organizationId: 'org_a' } as unknown as TestEnvelope
      await expect(s.queue.publish(withOrg)).rejects.toMatchObject({
        code: 'queue.invalid_message',
      })
    })

    test('a message over 256 KiB is refused with a clear error', async () => {
      const s = await subject()
      const big = s.registry.create({
        type: 'test.note',
        payload: { text: 'x'.repeat(MAX_MESSAGE_BYTES) },
        traceId: 't',
      })
      await expect(s.queue.publish(big)).rejects.toMatchObject({ code: 'queue.message_too_large' })
      expect(await none(s)).toEqual([])
    })

    test('a batch of 11, an empty batch, or over 256 KiB in total is refused before anything is sent', async () => {
      const s = await subject()
      const eleven = Array.from({ length: 11 }, (_, i) => ping(s, i))
      await expect(s.queue.publishBatch(eleven)).rejects.toMatchObject({
        code: 'queue.batch_too_large',
      })
      await expect(s.queue.publishBatch([])).rejects.toMatchObject({
        code: 'queue.batch_too_large',
      })
      const half = (text: string) =>
        s.registry.create({ type: 'test.note', payload: { text }, traceId: 't' })
      const heavy = [half('a'.repeat(150_000)), half('b'.repeat(150_000))]
      await expect(s.queue.publishBatch(heavy)).rejects.toMatchObject({
        code: 'queue.batch_too_large',
      })
      expect(await none(s)).toEqual([])
    })

    test.each([
      [{ maxMessages: 0, visibilityTimeoutSeconds: 5, waitSeconds: 0 }],
      [{ maxMessages: 11, visibilityTimeoutSeconds: 5, waitSeconds: 0 }],
      [{ maxMessages: 1, visibilityTimeoutSeconds: -1, waitSeconds: 0 }],
      [{ maxMessages: 1, visibilityTimeoutSeconds: 5, waitSeconds: 21 }],
      [{ maxMessages: 1, visibilityTimeoutSeconds: 1.5, waitSeconds: 0 }],
    ])('receive with out-of-range arguments %j is refused', async (args) => {
      const s = await subject()
      await expect(s.queue.receive(args)).rejects.toMatchObject({ code: 'queue.invalid_request' })
    })

    test('a body that is not a valid message comes back as invalid, with no body in it', async () => {
      const s = await subject()
      const secret = 'SECRET-PAYLOAD-VALUE'
      const good = ping(s, 1, 'org_a', 'msg_x')
      const cases: Array<[string, string, string]> = [
        ['malformed', `not json ${secret}`, 'malformed'],
        ['unknown_type', JSON.stringify({ ...good, type: 'test.other' }), 'unknown_type'],
        ['unsupported_version', JSON.stringify({ ...good, version: 2 }), 'unsupported_version'],
        ['invalid_payload', JSON.stringify({ ...good, payload: { n: secret } }), 'invalid_payload'],
        ['invalid_scope', JSON.stringify({ ...good, organizationId: undefined }), 'invalid_scope'],
      ]
      for (const [, body] of cases) {
        await s.injectRaw(body)
      }
      const got = await take(s, cases.length)
      expect(got).toHaveLength(cases.length)
      expect(got.every((delivery) => delivery.kind === 'invalid')).toBe(true)
      const reasons: string[] = got.map((delivery) =>
        delivery.kind === 'invalid' ? delivery.reason : ''
      )
      expect([...reasons].sort()).toEqual(cases.map(([, , reason]) => reason).sort())
      expect(JSON.stringify(got)).not.toContain(secret)
    })

    test('an invalid message that is never acknowledged is delivered maxReceiveCount times and then taken out of circulation', async () => {
      const s = await subject()
      await s.injectRaw('{"broken":')
      for (let round = 0; round < s.maxReceiveCount; round++) {
        const got = await take(s, 1)
        expect(got).toHaveLength(1)
        expect(got[0]?.receiveCount).toBe(round + 1)
        await s.queue.release((got[0] as Delivery<TestEnvelope>).receipt)
      }
      expect(await none(s)).toEqual([])
    })

    test('extending visibility of an acknowledged message is refused with queue.receipt_invalid', async () => {
      const s = await subject()
      await s.queue.publish(ping(s))
      const [got] = await take(s, 1)
      const receipt = (got as Delivery<TestEnvelope>).receipt
      await s.queue.acknowledge(receipt)
      await expect(s.queue.extendVisibility(receipt, 10)).rejects.toMatchObject({
        code: 'queue.receipt_invalid',
      })
    })

    test('acknowledging twice resolves both times', async () => {
      const s = await subject()
      await s.queue.publish(ping(s))
      const [got] = await take(s, 1)
      const receipt = (got as Delivery<TestEnvelope>).receipt
      await s.queue.acknowledge(receipt)
      await expect(s.queue.acknowledge(receipt)).resolves.toBeUndefined()
    })

    test('a published message arrives with every envelope field intact', async () => {
      const s = await subject()
      const sent = ping(s, 7, 'org_a', 'msg_1')
      await s.queue.publish(sent)
      const [got] = await take(s, 1)
      expect(got?.kind).toBe('message')
      if (got?.kind === 'message') {
        expect(got.envelope).toEqual(sent)
        expect(got.receiveCount).toBe(1)
      }
    })

    test('an empty queue gives an empty list', async () => {
      const s = await subject()
      expect(await none(s)).toEqual([])
    })

    test('a batch publish reports every id as sent and delivers them all', async () => {
      const s = await subject()
      const batch = [ping(s, 1), ping(s, 2), ping(s, 3)]
      const result = await s.queue.publishBatch(batch)
      expect(result.failed).toEqual([])
      expect(result.sent).toEqual(batch.map((envelope) => envelope.id))
      const got = await take(s, 3)
      expect(got).toHaveLength(3)
    })

    test('receive returns at most maxMessages', async () => {
      const s = await subject()
      await s.queue.publishBatch([ping(s, 1), ping(s, 2), ping(s, 3)])
      const first = await s.queue.receive({
        maxMessages: 2,
        visibilityTimeoutSeconds: s.visibilitySeconds,
        waitSeconds: 1,
      })
      expect(first.length).toBeLessThanOrEqual(2)
      expect(first.length).toBeGreaterThan(0)
    })

    test('the subject leaves room for an empty long poll inside the visibility timeout', () => {
      // The hidden check below long-polls for `emptyWaitSeconds`; if the timeout is not clearly
      // longer, the message comes back during the poll and the check fails on a slow runner.
      return subject().then((s) => {
        expect(s.visibilitySeconds).toBeGreaterThanOrEqual(s.emptyWaitSeconds + 3)
      })
    })

    test('a received message stays hidden until its visibility timeout, then returns with a higher count', async () => {
      const s = await subject()
      await s.queue.publish(ping(s, 1, 'org_a', 'msg_v'))
      expect(await take(s, 1)).toHaveLength(1)
      expect(await none(s)).toEqual([])
      // Wait on the condition, not on a fixed time: let a second go by, then look, until the
      // message returns or a deadline of the timeout plus 20 seconds passes.
      let again: Delivery<TestEnvelope> | undefined
      for (let waited = 0; waited <= s.visibilitySeconds + 20 && again === undefined; waited++) {
        await s.pass(1)
        ;[again] = await s.queue.receive({
          maxMessages: 1,
          visibilityTimeoutSeconds: s.visibilitySeconds,
          waitSeconds: s.emptyWaitSeconds,
        })
      }
      expect(again?.kind === 'message' && again.envelope.id).toBe('msg_v')
      expect(again?.receiveCount).toBe(2)
    })

    test('extending visibility keeps a message hidden past the original timeout', async () => {
      const s = await subject()
      await s.queue.publish(ping(s))
      const [got] = await take(s, 1)
      await s.queue.extendVisibility(
        (got as Delivery<TestEnvelope>).receipt,
        s.visibilitySeconds * 4
      )
      await s.pass(s.visibilitySeconds + 1)
      expect(await none(s)).toEqual([])
    })

    test('releasing a message makes it receivable at once', async () => {
      const s = await subject()
      await s.queue.publish(ping(s))
      const [got] = await take(s, 1)
      await s.queue.release((got as Delivery<TestEnvelope>).receipt)
      const [again] = await take(s, 1)
      expect(again?.receiveCount).toBe(2)
    })

    test('acknowledging with the receipt of an earlier delivery does not delete the redelivered message', async () => {
      const s = await subject()
      await s.queue.publish(ping(s, 1, 'org_a', 'msg_stale'))
      const [first] = await take(s, 1)
      await s.pass(s.visibilitySeconds + 1)
      const [second] = await take(s, 1)
      expect(second?.receiveCount).toBe(2)
      await s.queue.acknowledge((first as Delivery<TestEnvelope>).receipt)
      await s.queue.release((second as Delivery<TestEnvelope>).receipt)
      const [third] = await take(s, 1)
      expect(third?.kind === 'message' && third.envelope.id).toBe('msg_stale')
      expect(third?.receiveCount).toBe(3)
    })

    test('an acknowledged message is not delivered again', async () => {
      const s = await subject()
      await s.queue.publish(ping(s))
      const [got] = await take(s, 1)
      await s.queue.acknowledge((got as Delivery<TestEnvelope>).receipt)
      await s.pass(s.visibilitySeconds + 1)
      expect(await none(s)).toEqual([])
    })

    test('a message released maxReceiveCount times moves to the dead-letter queue instead of being delivered again', async () => {
      const s = await subject()
      await s.queue.publish(ping(s, 1, 'org_a', 'msg_dead'))
      for (let round = 1; round <= s.maxReceiveCount; round++) {
        const [got] = await take(s, 1)
        expect(got?.receiveCount).toBe(round)
        await s.queue.release((got as Delivery<TestEnvelope>).receipt)
      }
      expect(await none(s)).toEqual([])
      const dead = await s.deadLetterIds()
      if (dead !== undefined) {
        expect(dead).toEqual(['msg_dead'])
      }
    })

    test("two organizations' messages stay separate: each envelope keeps its own organization id", async () => {
      const s = await subject()
      await s.queue.publishBatch([ping(s, 1, 'org_a', 'same_id'), ping(s, 2, 'org_b', 'same_id')])
      const got = await take(s, 2)
      const orgs = got.map((delivery) =>
        delivery.kind === 'message' ? delivery.envelope.organizationId : ''
      )
      expect(orgs.sort()).toEqual(['org_a', 'org_b'])
    })
  })
}
