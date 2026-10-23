import { describe, expect, test } from 'bun:test'
import {
  callIdSchema,
  membershipIdSchema,
  organizationIdSchema,
  softphoneTokenSchema,
} from 'tula-closeline-contract'
import { createFixedClock } from '../clock'
import { createMemoryTelephony } from './memory'

const org = organizationIdSchema.parse(`org_${'a'.repeat(32)}`)
const callId = callIdSchema.parse(`call_${'c'.repeat(32)}`)
const rep = membershipIdSchema.parse(`mem_${'1'.repeat(32)}`)
const line = '+14155550100'
const prospect = '+14155550123'
const wording = { wordingVersion: 2, text: 'This call is recorded.', aiAssisted: true }

async function place(t: ReturnType<typeof createMemoryTelephony>, to = prospect) {
  const placed = await t.placeCall({
    organizationId: org,
    callId,
    idempotencyKey: `k-${Math.random()}`,
    from: line,
    to,
  })
  return { organizationId: org, providerCallId: placed.providerCallId }
}

describe('memory telephony', () => {
  test('the Disclosure is recorded before the bridge, the recording and the fork', async () => {
    const t = createMemoryTelephony()
    const ref = await place(t)
    await t.playDisclosure({ ...ref, ...wording })
    await t.bridge({ ...ref, repIdentity: rep })
    await t.startRecording(ref)
    await t.forkTracks({ ...ref, destinationUrl: 'wss://copilot.example.test/s' })
    const order = t.operations.map((o) => o.operation)
    expect(order).toEqual(['placeCall', 'playDisclosure', 'bridge', 'startRecording', 'forkTracks'])
  })

  test('refused and failed operations are not in the operations log', async () => {
    const t = createMemoryTelephony()
    const ref = await place(t)
    await expect(t.bridge({ ...ref, repIdentity: rep })).rejects.toMatchObject({
      code: 'telephony.disclosure_required',
    })
    expect(t.operations.map((o) => o.operation)).toEqual(['placeCall'])
  })

  test('failNext with a chosen code and a count', async () => {
    const t = createMemoryTelephony()
    t.failNext('mintBrowserToken', 'telephony.rejected', 2)
    const request = { organizationId: org, identity: rep }
    await expect(t.mintBrowserToken(request)).rejects.toMatchObject({ code: 'telephony.rejected' })
    await expect(t.mintBrowserToken(request)).rejects.toMatchObject({ code: 'telephony.rejected' })
    expect((await t.mintBrowserToken(request)).identity).toBe(rep)
  })

  test('a carrier failure after the bridge ends the call with a contract reason', async () => {
    const t = createMemoryTelephony()
    t.script(prospect, {
      kind: 'carrier_failure',
      reason: 'carrier_rejected',
      when: 'after_bridge',
    })
    const ref = await place(t)
    await t.playDisclosure({ ...ref, ...wording })
    await t.bridge({ ...ref, repIdentity: rep })
    expect(t.takeEvents().at(-1)).toMatchObject({
      type: 'failed',
      failureReason: 'carrier_rejected',
    })
    expect(t.calls(org)[0]?.state).toBe('ended')
  })

  test('a Prospect who hangs up after the bridge ends the call', async () => {
    const t = createMemoryTelephony()
    t.script(prospect, { kind: 'hangs_up', when: 'after_bridge' })
    const ref = await place(t)
    await t.playDisclosure({ ...ref, ...wording })
    await t.bridge({ ...ref, repIdentity: rep })
    expect(t.takeEvents().at(-1)).toMatchObject({ type: 'completed', endedBy: 'prospect' })
  })

  test('takeEvents forgets what it returned, events keeps everything', async () => {
    const t = createMemoryTelephony()
    await place(t)
    expect(t.takeEvents().length).toBeGreaterThan(0)
    expect(t.takeEvents()).toEqual([])
    expect(t.events.length).toBeGreaterThan(0)
  })

  test('webhookFor signs a body that verifyWebhook accepts, and a different secret does not', async () => {
    const t = createMemoryTelephony({ webhookSecret: 'secret-number-one-xx' })
    const other = createMemoryTelephony({ webhookSecret: 'secret-number-two-xx' })
    await place(t)
    const event = t.events[0]
    if (!event) {
      throw new Error('no event')
    }
    const hook = t.webhookFor(event)
    expect(t.verifyWebhook(hook)).toBe(true)
    expect(other.verifyWebhook(hook)).toBe(false)
  })

  test('a webhook secret under 16 characters is refused at construction', () => {
    expect(() => createMemoryTelephony({ webhookSecret: 'short' })).toThrow(TypeError)
  })

  test.each([[0], [Number.NaN], [60_001]])(
    'a defaultTimeoutMs of %p is refused at construction',
    (ms) => {
      expect(() => createMemoryTelephony({ defaultTimeoutMs: ms })).toThrow(TypeError)
    }
  )

  test('a ws: destination is accepted only in local', async () => {
    const local = createMemoryTelephony({ environment: 'local' })
    const prod = createMemoryTelephony({ environment: 'prod' })
    for (const [t, ok] of [
      [local, true],
      [prod, false],
    ] as const) {
      const ref = await place(t)
      await t.playDisclosure({ ...ref, ...wording })
      const result = t.forkTracks({ ...ref, destinationUrl: 'ws://127.0.0.1:9000/s' })
      if (ok) {
        await expect(result).resolves.toBeDefined()
      } else {
        await expect(result).rejects.toMatchObject({ code: 'telephony.invalid_request' })
      }
    }
  })

  test('an inbound call is incoming until answered', async () => {
    const t = createMemoryTelephony()
    const id = t.receiveInbound(org, '+14155550177', line)
    expect(t.calls(org)[0]?.state).toBe('incoming')
    await t.answerCall({ organizationId: org, providerCallId: id, callId, ringIdentities: [rep] })
    expect(t.calls(org)[0]).toMatchObject({ state: 'connected', direction: 'inbound' })
  })

  test('call views hold no number or Disclosure text', async () => {
    const t = createMemoryTelephony()
    const ref = await place(t)
    await t.playDisclosure({ ...ref, ...wording })
    const text = JSON.stringify([t.calls(), t.events, t.operations])
    expect(text).not.toContain(prospect)
    expect(text).not.toContain(wording.text)
  })

  test('the token parses as a SoftphoneToken and expires from the clock', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    const t = createMemoryTelephony({ clock: createFixedClock(now) })
    const token = await t.mintBrowserToken({ organizationId: org, identity: rep, ttlSeconds: 300 })
    expect(softphoneTokenSchema.parse(token)).toEqual(token)
    expect(token.expiresAt).toBe('2026-01-01T00:05:00.000Z')
  })

  test('recordingCount follows deletes', async () => {
    const t = createMemoryTelephony()
    const ref = await place(t)
    await t.playDisclosure({ ...ref, ...wording })
    const started = await t.startRecording(ref)
    expect(t.recordingCount()).toBe(1)
    await t.deleteRecording({ organizationId: org, recordingId: started.recordingId })
    expect(t.recordingCount()).toBe(0)
  })
})
