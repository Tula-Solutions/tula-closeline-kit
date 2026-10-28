import { describe, expect, test } from 'bun:test'
import { callIdSchema, type OrganizationId } from 'tula-closeline-contract'
import { MAX_DETECTION_WINDOW_MS, type TelephonyEvent, type TelephonyPort } from './port'

/** What a Prospect at a dialed number does in the Agent-leg scenarios. */
export type AgentCallScenario =
  | 'human'
  | 'machine'
  | 'unknown'
  | 'busy'
  | 'no_answer'
  | 'carrier_failure'

/** What the Agent-leg suite needs from an adapter under test. */
export interface AgentCallSubject {
  /** The port under test. */
  telephony: TelephonyPort
  /** Two unrelated Organization ids the port accepts. */
  organizations: { a: OrganizationId; b: OrganizationId }
  /** Returns a number (E.164) that, when dialed, plays out as `scenario`. */
  numberFor(scenario: AgentCallScenario): string
  /** Lets a ringing call play out as its number says (a real provider does it by itself; waits for it). */
  settle(organizationId: string, providerCallId: string): void | Promise<void>
  /** Makes the next Agent-leg dial fail at the provider, as `telephony.unavailable`. */
  failNext(): void
  /** Makes the next Agent-leg dial never get an answer from the provider. */
  stallNext(): void
  /** Returns the events the provider has reported since the last call, in order. */
  takeEvents(): TelephonyEvent[] | Promise<TelephonyEvent[]>
}

/**
 * The behaviour every {@link TelephonyPort.placeAgentCall} must show: each detection result, busy,
 * no answer and a carrier failure are reported in order; a hang-up, also before the answer, is
 * silent and no detection follows it; the same key places one call; the request is validated and
 * scoped by Organization; a failing or stalled provider is `telephony.unavailable`.
 */
export function agentCallBehaviour(name: string, make: () => Promise<AgentCallSubject>): void {
  describe(`Agent-leg call behaviour: ${name}`, () => {
    const callId = callIdSchema.parse(`call_${'c'.repeat(32)}`)
    const line = '+14155550100'
    const streamUrl = 'wss://voice.example.test/media'
    let counter = 0
    const key = () => `agent-key-${++counter}-${Math.random().toString(36).slice(2)}`
    const types = (events: TelephonyEvent[]) => events.map((e) => e.type)

    async function dial(s: AgentCallSubject, scenario: AgentCallScenario) {
      const placed = await s.telephony.placeAgentCall({
        organizationId: s.organizations.a,
        callId,
        idempotencyKey: key(),
        from: line,
        to: s.numberFor(scenario),
        streamUrl,
      })
      return { ...placed, org: s.organizations.a as string }
    }

    test.each([
      ['human', 'human'],
      ['machine', 'machine'],
      ['unknown', 'unknown'],
    ] as const)('a %s answering is reported once, after the answer', async (scenario, expected) => {
      const s = await make()
      const placed = await dial(s, scenario)
      expect(placed.created).toBe(true)
      await s.settle(placed.org, placed.providerCallId)
      const events = await s.takeEvents()
      expect(types(events)).toEqual(['ringing', 'answered', 'detection'])
      expect(events[2]?.answeredBy).toBe(expected)
    })

    test.each([
      ['busy', 'busy'],
      ['no_answer', 'no_answer'],
    ] as const)('%s ends the call with no detection', async (scenario, type) => {
      const s = await make()
      const placed = await dial(s, scenario)
      await s.settle(placed.org, placed.providerCallId)
      expect(types(await s.takeEvents())).toEqual(['ringing', type])
    })

    test('a carrier failure is reported as failed with no detection', async () => {
      const s = await make()
      const placed = await dial(s, 'carrier_failure')
      await s.settle(placed.org, placed.providerCallId)
      const events = await s.takeEvents()
      expect(types(events)).toEqual(['ringing', 'failed'])
      expect(events[1]?.failureReason).toBeDefined()
    })

    test('a machine is hung up on silently: completed by the system, nothing after', async () => {
      const s = await make()
      const placed = await dial(s, 'machine')
      await s.settle(placed.org, placed.providerCallId)
      await s.telephony.hangUp({ organizationId: s.organizations.a, ...placed })
      await s.settle(placed.org, placed.providerCallId)
      const events = await s.takeEvents()
      expect(types(events)).toEqual(['ringing', 'answered', 'detection', 'completed'])
      expect(events[3]?.endedBy).toBe('system')
    })

    test('cancelling before the answer ends the call and no detection ever follows', async () => {
      const s = await make()
      const placed = await dial(s, 'human')
      await s.telephony.hangUp({ organizationId: s.organizations.a, ...placed })
      await s.settle(placed.org, placed.providerCallId)
      expect(types(await s.takeEvents())).toEqual(['ringing', 'completed'])
    })

    test('the same key places one call', async () => {
      const s = await make()
      const request = {
        organizationId: s.organizations.a,
        callId,
        idempotencyKey: key(),
        from: line,
        to: s.numberFor('human'),
        streamUrl,
      }
      const first = await s.telephony.placeAgentCall(request)
      const second = await s.telephony.placeAgentCall(request)
      expect(second).toEqual({ providerCallId: first.providerCallId, created: false })
      expect((await s.takeEvents()).filter((e) => e.type === 'ringing')).toHaveLength(1)
    })

    test('a key used by placeCall cannot place an Agent-leg call', async () => {
      const s = await make()
      const base = {
        organizationId: s.organizations.a,
        callId,
        idempotencyKey: key(),
        from: line,
        to: s.numberFor('human'),
      }
      await s.telephony.placeCall(base)
      await expect(s.telephony.placeAgentCall({ ...base, streamUrl })).rejects.toMatchObject({
        code: 'telephony.invalid_request',
      })
    })

    test("another Organization's call is not found", async () => {
      const s = await make()
      const placed = await dial(s, 'human')
      await expect(
        s.telephony.hangUp({
          organizationId: s.organizations.b,
          providerCallId: placed.providerCallId,
        })
      ).rejects.toMatchObject({ code: 'telephony.not_found' })
    })

    test.each([
      ['a plain-text stream', { streamUrl: 'http://example.test/media' }],
      ['a stream with credentials', { streamUrl: 'wss://u:p@example.test/media' }],
      ['a zero window', { detectionWindowMs: 0 }],
      ['a window above the maximum', { detectionWindowMs: MAX_DETECTION_WINDOW_MS + 1 }],
      ['a fractional window', { detectionWindowMs: 1.5 }],
      ['a bad number', { to: 'not-a-number' }],
    ] as const)('%s is refused before anything is dialed', async (_label, patch) => {
      const s = await make()
      await expect(
        s.telephony.placeAgentCall({
          organizationId: s.organizations.a,
          callId,
          idempotencyKey: key(),
          from: line,
          to: s.numberFor('human'),
          streamUrl,
          ...patch,
        })
      ).rejects.toMatchObject({ code: 'telephony.invalid_request' })
      expect(await s.takeEvents()).toEqual([])
    })

    test('a failing provider is telephony.unavailable and places nothing', async () => {
      const s = await make()
      s.failNext()
      await expect(dial(s, 'human')).rejects.toMatchObject({ code: 'telephony.unavailable' })
      expect(await s.takeEvents()).toEqual([])
    })

    test('a provider that never answers is telephony.unavailable after the timeout', async () => {
      const s = await make()
      s.stallNext()
      await expect(
        s.telephony.placeAgentCall(
          {
            organizationId: s.organizations.a,
            callId,
            idempotencyKey: key(),
            from: line,
            to: s.numberFor('human'),
            streamUrl,
          },
          { timeoutMs: 30 }
        )
      ).rejects.toMatchObject({ code: 'telephony.unavailable' })
    })

    test('no event carries a number or the stream URL', async () => {
      const s = await make()
      const placed = await dial(s, 'machine')
      await s.settle(placed.org, placed.providerCallId)
      const text = JSON.stringify(await s.takeEvents())
      expect(text).not.toContain(s.numberFor('machine'))
      expect(text).not.toContain(line)
      expect(text).not.toContain('voice.example.test')
    })
  })
}
