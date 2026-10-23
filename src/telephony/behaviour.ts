import { afterEach, describe, expect, test } from 'bun:test'
import {
  callIdSchema,
  membershipIdSchema,
  type OrganizationId,
  softphoneTokenSchema,
} from 'tula-closeline-contract'
import type { SignedWebhook, TelephonyOperation } from './memory'
import { MAX_WEBHOOK_BODY_BYTES, type TelephonyEvent, type TelephonyPort } from './port'

/** What a Prospect at a dialed number does, in the scenarios the suite needs. */
export type ProspectScenario =
  | 'answers'
  | 'no_answer'
  | 'busy'
  | 'hangs_up_during_disclosure'
  | 'carrier_failure'

/** What the behaviour suite needs from an adapter under test. */
export interface TelephonySubject {
  /** The port under test, with no calls for the Organizations below. */
  telephony: TelephonyPort
  /** Two unrelated Organization ids the port accepts. */
  organizations: { a: OrganizationId; b: OrganizationId }
  /** Returns a number (E.164) that, when dialed, plays out as `scenario`. */
  numberFor(scenario: ProspectScenario): string
  /** Makes a provider call arrive on a Line, as an inbound webhook would; returns its provider id. */
  receiveInbound(organizationId: string): string | Promise<string>
  /** Has the Prospect on a call hang up now. */
  prospectHangsUp(organizationId: string, providerCallId: string): void | Promise<void>
  /** Makes the next call of `operation` never get an answer from the provider. */
  stallNext(operation: TelephonyOperation): void
  /** Makes the next call of `operation` fail at the provider, as `telephony.unavailable`. */
  failNext(operation: TelephonyOperation): void
  /** Returns the events the provider has reported since the last call, in order. */
  takeEvents(): TelephonyEvent[] | Promise<TelephonyEvent[]>
  /** The signed webhook the provider would send for `event`. */
  signedWebhook(event: TelephonyEvent): SignedWebhook
  /** Removes what the subject created, including every provider call and Recording. */
  close(): Promise<void>
}

/**
 * The behaviour every {@link TelephonyPort} must show: calls are scoped to their Organization;
 * placing is idempotent; the Disclosure must play before a Rep is bridged, a Recording starts or
 * tracks are forked, and no request can skip it; the Recording has two channels and can be
 * fetched after the call and deleted; webhooks verify in constant time and refuse a wrong, short,
 * long or missing signature; the browser token is short-lived; and every operation gives up after
 * its timeout and reports a failing provider as `telephony.unavailable`. Run it against the memory
 * adapter and any real adapter (which needs a subject that drives the provider's test mode).
 */
export function telephonyBehaviour(
  name: string,
  make: () => Promise<TelephonySubject>,
  skip = false
): void {
  const run = skip ? describe.skip : describe
  run(`Telephony behaviour: ${name}`, () => {
    const open: TelephonySubject[] = []
    afterEach(async () => {
      await Promise.all(open.splice(0).map((subject) => subject.close()))
    })
    async function subject(): Promise<TelephonySubject> {
      const made = await make()
      open.push(made)
      return made
    }

    const callId = callIdSchema.parse(`call_${'c'.repeat(32)}`)
    const rep = membershipIdSchema.parse(`mem_${'1'.repeat(32)}`)
    const otherRep = membershipIdSchema.parse(`mem_${'2'.repeat(32)}`)
    const line = '+14155550100'
    const wording = { wordingVersion: 1, text: 'This call is recorded.', aiAssisted: false }
    let keyCounter = 0
    const key = () => `key-${++keyCounter}-${Math.random().toString(36).slice(2)}`

    async function place(s: TelephonySubject, scenario: ProspectScenario = 'answers') {
      const placed = await s.telephony.placeCall({
        organizationId: s.organizations.a,
        callId,
        idempotencyKey: key(),
        from: line,
        to: s.numberFor(scenario),
      })
      return {
        ...placed,
        ref: { organizationId: s.organizations.a, providerCallId: placed.providerCallId },
      }
    }
    async function disclosed(s: TelephonySubject, aiAssisted = false) {
      const placed = await place(s)
      await s.telephony.playDisclosure({ ...placed.ref, ...wording, aiAssisted })
      return placed
    }
    const code = (value: string) => ({ code: value })

    describe('placing a call', () => {
      test('a Prospect who answers: the call rings, then is answered', async () => {
        const s = await subject()
        const placed = await place(s)
        expect(placed.created).toBe(true)
        expect(placed.providerCallId.length).toBeGreaterThan(0)
        expect((await s.takeEvents()).map((e) => e.type)).toEqual(['ringing', 'answered'])
      })

      test('the same idempotency key places exactly one call', async () => {
        const s = await subject()
        const request = {
          organizationId: s.organizations.a,
          callId,
          idempotencyKey: key(),
          from: line,
          to: s.numberFor('answers'),
        }
        const first = await s.telephony.placeCall(request)
        const second = await s.telephony.placeCall(request)
        expect(second).toEqual({ providerCallId: first.providerCallId, created: false })
        expect((await s.takeEvents()).filter((e) => e.type === 'ringing')).toHaveLength(1)
      })

      test('the same key for another number is refused', async () => {
        const s = await subject()
        const idempotencyKey = key()
        const base = { organizationId: s.organizations.a, callId, idempotencyKey, from: line }
        await s.telephony.placeCall({ ...base, to: s.numberFor('answers') })
        await expect(
          s.telephony.placeCall({ ...base, to: s.numberFor('busy') })
        ).rejects.toMatchObject(code('telephony.invalid_request'))
      })

      test('the same key in another Organization is a different call', async () => {
        const s = await subject()
        const base = { callId, idempotencyKey: key(), from: line, to: s.numberFor('answers') }
        const a = await s.telephony.placeCall({ ...base, organizationId: s.organizations.a })
        const b = await s.telephony.placeCall({ ...base, organizationId: s.organizations.b })
        expect(b.created).toBe(true)
        expect(b.providerCallId).not.toBe(a.providerCallId)
      })

      test.each([
        ['to', { to: '4155550100' }],
        ['to', { to: '+0123' }],
        ['from', { from: 'not a number' }],
        ['idempotencyKey', { idempotencyKey: '' }],
        ['idempotencyKey', { idempotencyKey: 'has space' }],
        ['callId', { callId: 'call_1' }],
        ['organizationId', { organizationId: 'org_1' }],
      ])('a bad %s is refused before the provider is asked', async (_field, bad) => {
        const s = await subject()
        const request = {
          organizationId: s.organizations.a,
          callId,
          idempotencyKey: key(),
          from: line,
          to: s.numberFor('answers'),
          ...bad,
        }
        await expect(s.telephony.placeCall(request as never)).rejects.toMatchObject(
          code('telephony.invalid_request')
        )
        expect(await s.takeEvents()).toHaveLength(0)
      })

      test('a Prospect who does not answer: no_answer', async () => {
        const s = await subject()
        await place(s, 'no_answer')
        const events = await s.takeEvents()
        expect(events.map((e) => e.type)).toEqual(['ringing', 'no_answer'])
        expect(events[1]).toMatchObject({ failureReason: 'no_answer' })
      })

      test('a busy Prospect: busy', async () => {
        const s = await subject()
        await place(s, 'busy')
        expect((await s.takeEvents()).at(-1)).toMatchObject({ type: 'busy', failureReason: 'busy' })
      })

      test('a carrier failure: failed with a contract reason, and the call is over', async () => {
        const s = await subject()
        const placed = await place(s, 'carrier_failure')
        const last = (await s.takeEvents()).at(-1)
        expect(last?.type).toBe('failed')
        expect(['carrier_dropped', 'carrier_rejected', 'provider_error']).toContain(
          last?.failureReason as string
        )
        await expect(
          s.telephony.playDisclosure({ ...placed.ref, ...wording })
        ).rejects.toMatchObject(code('telephony.call_ended'))
      })

      test('events carry no number and no text', async () => {
        const s = await subject()
        const to = s.numberFor('answers')
        await s.telephony.placeCall({
          organizationId: s.organizations.a,
          callId,
          idempotencyKey: key(),
          from: line,
          to,
        })
        const text = JSON.stringify(await s.takeEvents())
        expect(text).not.toContain(to)
        expect(text).not.toContain(line)
      })
    })

    describe('answering an inbound call', () => {
      test('answers it and rings the browser legs', async () => {
        const s = await subject()
        const providerCallId = await s.receiveInbound(s.organizations.a)
        const answered = await s.telephony.answerCall({
          organizationId: s.organizations.a,
          providerCallId,
          callId,
          ringIdentities: [rep, otherRep],
        })
        expect(answered).toEqual({ ringing: 2 })
        expect((await s.takeEvents()).map((e) => e.type)).toContain('answered')
      })

      test('answering again changes nothing', async () => {
        const s = await subject()
        const providerCallId = await s.receiveInbound(s.organizations.a)
        const request = {
          organizationId: s.organizations.a,
          providerCallId,
          callId,
          ringIdentities: [rep],
        }
        await s.telephony.answerCall(request)
        await s.takeEvents()
        expect(await s.telephony.answerCall(request)).toEqual({ ringing: 1 })
        expect(await s.takeEvents()).toHaveLength(0)
      })

      test('another Organization cannot answer it', async () => {
        const s = await subject()
        const providerCallId = await s.receiveInbound(s.organizations.a)
        await expect(
          s.telephony.answerCall({
            organizationId: s.organizations.b,
            providerCallId,
            callId,
            ringIdentities: [rep],
          })
        ).rejects.toMatchObject(code('telephony.not_found'))
      })

      test.each([
        ['no legs', []],
        ['a bad identity', ['mem_1']],
      ])('%s is refused', async (_label, ringIdentities) => {
        const s = await subject()
        const providerCallId = await s.receiveInbound(s.organizations.a)
        await expect(
          s.telephony.answerCall({
            organizationId: s.organizations.a,
            providerCallId,
            callId,
            ringIdentities: ringIdentities as never,
          })
        ).rejects.toMatchObject(code('telephony.invalid_request'))
      })

      test('a call nobody answered cannot play the Disclosure yet', async () => {
        const s = await subject()
        const providerCallId = await s.receiveInbound(s.organizations.a)
        await expect(
          s.telephony.playDisclosure({
            organizationId: s.organizations.a,
            providerCallId,
            ...wording,
          })
        ).rejects.toMatchObject(code('telephony.invalid_request'))
      })
    })

    describe('the Disclosure', () => {
      test('plays, and reports its wording version, whether it names an AI, and when', async () => {
        const s = await subject()
        const placed = await place(s)
        const played = await s.telephony.playDisclosure({
          ...placed.ref,
          ...wording,
          aiAssisted: true,
        })
        expect(played).toMatchObject({ wordingVersion: 1, aiAssisted: true })
        expect(Number.isNaN(Date.parse(played.playedAt))).toBe(false)
      })

      test('playing the same version again reports it and does not replay it', async () => {
        const s = await subject()
        const placed = await place(s)
        const first = await s.telephony.playDisclosure({ ...placed.ref, ...wording })
        const again = await s.telephony.playDisclosure({ ...placed.ref, ...wording })
        expect(again).toEqual(first)
      })

      test.each([
        ['an empty text', { text: '   ' }],
        ['a control character', { text: 'bad\u0000text' }],
        ['a text over 1000 characters', { text: 'x'.repeat(1001) }],
        ['version 0', { wordingVersion: 0 }],
        ['a fractional version', { wordingVersion: 1.5 }],
        ['no aiAssisted flag', { aiAssisted: undefined }],
      ])('%s is refused', async (_label, bad) => {
        const s = await subject()
        const placed = await place(s)
        await expect(
          s.telephony.playDisclosure({ ...placed.ref, ...wording, ...bad } as never)
        ).rejects.toMatchObject(code('telephony.invalid_request'))
      })

      test('a Prospect who hangs up during it: call_ended, nothing is bridged', async () => {
        const s = await subject()
        const placed = await place(s, 'hangs_up_during_disclosure')
        await expect(
          s.telephony.playDisclosure({ ...placed.ref, ...wording })
        ).rejects.toMatchObject(code('telephony.call_ended'))
        expect((await s.takeEvents()).at(-1)).toMatchObject({
          type: 'completed',
          endedBy: 'prospect',
        })
        await expect(s.telephony.bridge({ ...placed.ref, repIdentity: rep })).rejects.toMatchObject(
          code('telephony.call_ended')
        )
      })

      test('a later wording version replaces the earlier one, including whether it names an AI', async () => {
        const s = await subject()
        const placed = await place(s)
        await s.telephony.playDisclosure({ ...placed.ref, ...wording, aiAssisted: true })
        const second = await s.telephony.playDisclosure({
          ...placed.ref,
          ...wording,
          wordingVersion: 2,
          aiAssisted: false,
        })
        expect(second).toMatchObject({ wordingVersion: 2, aiAssisted: false })
        await expect(
          s.telephony.forkTracks({ ...placed.ref, destinationUrl: 'wss://copilot.example.test/s' })
        ).rejects.toMatchObject(code('telephony.disclosure_required'))
      })

      test('another Organization cannot play it on this call', async () => {
        const s = await subject()
        const placed = await place(s)
        await expect(
          s.telephony.playDisclosure({
            organizationId: s.organizations.b,
            providerCallId: placed.providerCallId,
            ...wording,
          })
        ).rejects.toMatchObject(code('telephony.not_found'))
      })
    })

    describe('nothing happens before the Disclosure', () => {
      test('bridging a Rep is refused', async () => {
        const s = await subject()
        const placed = await place(s)
        await expect(s.telephony.bridge({ ...placed.ref, repIdentity: rep })).rejects.toMatchObject(
          code('telephony.disclosure_required')
        )
      })

      test('recording is refused', async () => {
        const s = await subject()
        const placed = await place(s)
        await expect(s.telephony.startRecording(placed.ref)).rejects.toMatchObject(
          code('telephony.disclosure_required')
        )
      })

      test('forking the tracks is refused', async () => {
        const s = await subject()
        const placed = await place(s)
        await expect(
          s.telephony.forkTracks({ ...placed.ref, destinationUrl: 'wss://copilot.example.test/s' })
        ).rejects.toMatchObject(code('telephony.disclosure_required'))
      })

      test('forking the tracks needs a Disclosure that named an AI', async () => {
        const s = await subject()
        const placed = await disclosed(s, false)
        await expect(
          s.telephony.forkTracks({ ...placed.ref, destinationUrl: 'wss://copilot.example.test/s' })
        ).rejects.toMatchObject(code('telephony.disclosure_required'))
      })

      test('a failed Disclosure leaves the call unbridged and unrecorded', async () => {
        const s = await subject()
        const placed = await place(s)
        s.failNext('playDisclosure')
        await expect(
          s.telephony.playDisclosure({ ...placed.ref, ...wording })
        ).rejects.toMatchObject(code('telephony.unavailable'))
        await expect(s.telephony.bridge({ ...placed.ref, repIdentity: rep })).rejects.toMatchObject(
          code('telephony.disclosure_required')
        )
        await expect(s.telephony.startRecording(placed.ref)).rejects.toMatchObject(
          code('telephony.disclosure_required')
        )
      })
    })

    describe('bridging', () => {
      test('joins a Rep after the Disclosure, and again is a no-op', async () => {
        const s = await subject()
        const placed = await disclosed(s)
        await s.telephony.bridge({ ...placed.ref, repIdentity: rep })
        await s.telephony.bridge({ ...placed.ref, repIdentity: rep })
      })

      test('moves the call to another Rep', async () => {
        const s = await subject()
        const placed = await disclosed(s)
        await s.telephony.bridge({ ...placed.ref, repIdentity: rep })
        await s.telephony.bridge({ ...placed.ref, repIdentity: otherRep })
      })

      test('a bad identity is refused', async () => {
        const s = await subject()
        const placed = await disclosed(s)
        await expect(
          s.telephony.bridge({ ...placed.ref, repIdentity: 'mem_1' as never })
        ).rejects.toMatchObject(code('telephony.invalid_request'))
      })

      test('a Prospect who hangs up after the Rep is bridged ends the call', async () => {
        const s = await subject()
        const placed = await disclosed(s)
        await s.telephony.bridge({ ...placed.ref, repIdentity: rep })
        await s.takeEvents()
        await s.prospectHangsUp(placed.ref.organizationId, placed.providerCallId)
        expect((await s.takeEvents()).find((e) => e.type === 'completed')).toMatchObject({
          endedBy: 'prospect',
        })
        await expect(
          s.telephony.bridge({ ...placed.ref, repIdentity: otherRep })
        ).rejects.toMatchObject(code('telephony.call_ended'))
      })
    })

    describe('recording', () => {
      test('is dual-channel and starting it again returns the first Recording', async () => {
        const s = await subject()
        const placed = await disclosed(s)
        const first = await s.telephony.startRecording(placed.ref)
        expect(first.channels).toBe(2)
        expect(await s.telephony.startRecording(placed.ref)).toEqual(first)
      })

      test('cannot be fetched while the call is up', async () => {
        const s = await subject()
        const placed = await disclosed(s)
        const started = await s.telephony.startRecording(placed.ref)
        await expect(
          s.telephony.fetchRecording({
            organizationId: placed.ref.organizationId,
            recordingId: started.recordingId,
          })
        ).rejects.toMatchObject(code('telephony.recording_not_ready'))
      })

      test('can be fetched after the call: two channels, a type and bytes', async () => {
        const s = await subject()
        const placed = await disclosed(s)
        const started = await s.telephony.startRecording(placed.ref)
        await s.telephony.hangUp({ ...placed.ref, by: 'rep' })
        expect((await s.takeEvents()).at(-1)).toMatchObject({
          type: 'recording_ready',
          recordingId: started.recordingId,
        })
        const fetched = await s.telephony.fetchRecording({
          organizationId: placed.ref.organizationId,
          recordingId: started.recordingId,
        })
        expect(fetched.channels).toBe(2)
        expect(fetched.contentType).toMatch(/^audio\//)
        let bytes = 0
        for await (const chunk of fetched.body) {
          bytes += chunk.length
        }
        expect(bytes).toBeGreaterThan(0)
        if (fetched.sizeBytes !== null) {
          expect(fetched.sizeBytes).toBe(bytes)
        }
      })

      test('a recording started before the call ended can be fetched when the Prospect hangs up', async () => {
        const s = await subject()
        const placed = await disclosed(s)
        const started = await s.telephony.startRecording(placed.ref)
        await s.prospectHangsUp(placed.ref.organizationId, placed.providerCallId)
        const fetched = await s.telephony.fetchRecording({
          organizationId: placed.ref.organizationId,
          recordingId: started.recordingId,
        })
        await fetched.body[Symbol.asyncIterator]?.().return?.()
        expect(fetched.channels).toBe(2)
      })

      test('deleting removes the provider copy; deleting again and an unknown id say it did not exist', async () => {
        const s = await subject()
        const placed = await disclosed(s)
        const started = await s.telephony.startRecording(placed.ref)
        await s.telephony.hangUp(placed.ref)
        const ref = { organizationId: placed.ref.organizationId, recordingId: started.recordingId }
        expect(await s.telephony.deleteRecording(ref)).toEqual({ existed: true })
        expect(await s.telephony.deleteRecording(ref)).toEqual({ existed: false })
        expect(await s.telephony.deleteRecording({ ...ref, recordingId: 'never-issued' })).toEqual({
          existed: false,
        })
        await expect(s.telephony.fetchRecording(ref)).rejects.toMatchObject(
          code('telephony.not_found')
        )
      })

      test('another Organization can neither fetch nor delete it', async () => {
        const s = await subject()
        const placed = await disclosed(s)
        const started = await s.telephony.startRecording(placed.ref)
        await s.telephony.hangUp(placed.ref)
        const theirs = { organizationId: s.organizations.b, recordingId: started.recordingId }
        await expect(s.telephony.fetchRecording(theirs)).rejects.toMatchObject(
          code('telephony.not_found')
        )
        expect(await s.telephony.deleteRecording(theirs)).toEqual({ existed: false })
        const mine = { organizationId: s.organizations.a, recordingId: started.recordingId }
        const fetched = await s.telephony.fetchRecording(mine)
        expect(fetched.channels).toBe(2)
      })

      test('a bad recording id is refused', async () => {
        const s = await subject()
        await expect(
          s.telephony.fetchRecording({ organizationId: s.organizations.a, recordingId: '../x' })
        ).rejects.toMatchObject(code('telephony.invalid_request'))
      })
    })

    describe('forking the tracks', () => {
      test('sends the Rep and the Prospect apart once an AI-naming Disclosure played; again returns the first', async () => {
        const s = await subject()
        const placed = await disclosed(s, true)
        const request = { ...placed.ref, destinationUrl: 'wss://copilot.example.test/s' }
        const first = await s.telephony.forkTracks(request)
        expect(first.tracks).toEqual(['rep', 'prospect'])
        expect(await s.telephony.forkTracks(request)).toEqual(first)
      })

      test.each([
        ['a plain http URL', 'http://copilot.example.test/s'],
        ['a URL with credentials', 'wss://user:pw@copilot.example.test/s'],
        ['not a URL', 'copilot'],
        ['an empty string', ''],
      ])('%s is refused', async (_label, destinationUrl) => {
        const s = await subject()
        const placed = await disclosed(s, true)
        await expect(
          s.telephony.forkTracks({ ...placed.ref, destinationUrl })
        ).rejects.toMatchObject(code('telephony.invalid_request'))
      })
    })

    describe('hanging up', () => {
      test('ends the call with who ended it, and again is a no-op', async () => {
        const s = await subject()
        const placed = await place(s)
        await s.takeEvents()
        await s.telephony.hangUp({ ...placed.ref, by: 'rep' })
        expect(await s.takeEvents()).toMatchObject([{ type: 'completed', endedBy: 'rep' }])
        await s.telephony.hangUp(placed.ref)
        expect(await s.takeEvents()).toHaveLength(0)
      })

      test('another Organization cannot hang it up', async () => {
        const s = await subject()
        const placed = await place(s)
        await expect(
          s.telephony.hangUp({
            organizationId: s.organizations.b,
            providerCallId: placed.providerCallId,
          })
        ).rejects.toMatchObject(code('telephony.not_found'))
      })

      test('an unknown call is not found', async () => {
        const s = await subject()
        await expect(
          s.telephony.hangUp({ organizationId: s.organizations.a, providerCallId: 'unknown' })
        ).rejects.toMatchObject(code('telephony.not_found'))
      })

      test('nothing can be played, bridged, recorded or forked on an ended call', async () => {
        const s = await subject()
        const placed = await place(s)
        await s.telephony.hangUp(placed.ref)
        await expect(
          s.telephony.playDisclosure({ ...placed.ref, ...wording })
        ).rejects.toMatchObject(code('telephony.call_ended'))
        await expect(s.telephony.bridge({ ...placed.ref, repIdentity: rep })).rejects.toMatchObject(
          code('telephony.call_ended')
        )
        await expect(s.telephony.startRecording(placed.ref)).rejects.toMatchObject(
          code('telephony.call_ended')
        )
      })
    })

    describe('verifying a webhook', () => {
      async function webhook() {
        const s = await subject()
        const placed = await place(s)
        const event = (await s.takeEvents())[0] as TelephonyEvent
        return { s, placed, event, hook: s.signedWebhook(event) }
      }

      test('a genuine webhook verifies', async () => {
        const { s, hook } = await webhook()
        expect(s.telephony.verifyWebhook(hook)).toBe(true)
      })

      test('a wrong signature of the right length is refused', async () => {
        const { s, hook } = await webhook()
        const flipped = (hook.signature[0] === 'A' ? 'B' : 'A') + hook.signature.slice(1)
        expect(flipped).toHaveLength(hook.signature.length)
        expect(s.telephony.verifyWebhook({ ...hook, signature: flipped })).toBe(false)
      })

      test('a signature of the wrong length is refused', async () => {
        const { s, hook } = await webhook()
        expect(s.telephony.verifyWebhook({ ...hook, signature: hook.signature.slice(0, -1) })).toBe(
          false
        )
        expect(s.telephony.verifyWebhook({ ...hook, signature: `${hook.signature}A` })).toBe(false)
        expect(s.telephony.verifyWebhook({ ...hook, signature: 'x' })).toBe(false)
      })

      test.each([
        ['undefined', undefined],
        ['null', null],
        ['empty', ''],
      ])('a %s signature is refused', async (_label, signature) => {
        const { s, hook } = await webhook()
        expect(s.telephony.verifyWebhook({ ...hook, signature })).toBe(false)
      })

      test('a signature that fits another body or another URL is refused', async () => {
        const { s, hook } = await webhook()
        expect(s.telephony.verifyWebhook({ ...hook, body: `${hook.body} ` })).toBe(false)
        expect(s.telephony.verifyWebhook({ ...hook, url: `${hook.url}?x=1` })).toBe(false)
      })

      test('a body over the limit is refused without throwing', async () => {
        const { s, hook } = await webhook()
        const body = 'x'.repeat(MAX_WEBHOOK_BODY_BYTES + 1)
        expect(s.telephony.verifyWebhook({ ...hook, body })).toBe(false)
      })

      test('garbage in any field is refused, never thrown', async () => {
        const { s } = await webhook()
        for (const bad of [null, undefined, 1, 'x', {}, { url: 1, body: 2, signature: 3 }]) {
          expect(s.telephony.verifyWebhook(bad as never)).toBe(false)
        }
      })
    })

    describe('the browser token', () => {
      test('is a SoftphoneToken for the Rep that expires within the hour', async () => {
        const s = await subject()
        const before = Date.now()
        const token = await s.telephony.mintBrowserToken({
          organizationId: s.organizations.a,
          identity: rep,
          ttlSeconds: 120,
        })
        expect(softphoneTokenSchema.safeParse(token).success).toBe(true)
        expect(token).toMatchObject({ identity: rep, ttlSeconds: 120 })
        expect(Date.parse(token.expiresAt)).toBeGreaterThan(before)
        expect(Date.parse(token.expiresAt)).toBeLessThanOrEqual(Date.now() + 120_000 + 1000)
      })

      test('defaults to a short life and each token is different', async () => {
        const s = await subject()
        const request = { organizationId: s.organizations.a, identity: rep }
        const one = await s.telephony.mintBrowserToken(request)
        const two = await s.telephony.mintBrowserToken(request)
        expect(one.ttlSeconds).toBeGreaterThanOrEqual(60)
        expect(one.ttlSeconds).toBeLessThanOrEqual(3600)
        expect(one.token).not.toBe(two.token)
      })

      test.each([[59], [3601], [1.5], [Number.NaN]])(
        'a life of %p seconds is refused',
        async (ttl) => {
          const s = await subject()
          await expect(
            s.telephony.mintBrowserToken({
              organizationId: s.organizations.a,
              identity: rep,
              ttlSeconds: ttl,
            })
          ).rejects.toMatchObject(code('telephony.invalid_request'))
        }
      )

      test('the token does not hold the Organization id or the Rep id in clear', async () => {
        const s = await subject()
        const token = await s.telephony.mintBrowserToken({
          organizationId: s.organizations.a,
          identity: rep,
        })
        expect(token.token).not.toContain(s.organizations.a)
        expect(token.token).not.toContain(rep)
      })
    })

    describe('timeouts and a failing provider', () => {
      const TIMEOUT = 30
      type Step = (s: TelephonySubject) => Promise<unknown>
      const steps: Record<
        TelephonyOperation,
        { ready: Step; call: (s: TelephonySubject, ctx: Ctx) => Promise<unknown> }
      > = {
        placeCall: {
          ready: async () => ({}),
          call: (s, _c) =>
            s.telephony.placeCall(
              {
                organizationId: s.organizations.a,
                callId,
                idempotencyKey: key(),
                from: line,
                to: s.numberFor('answers'),
              },
              { timeoutMs: TIMEOUT }
            ),
        },
        answerCall: {
          ready: async (s) => ({ providerCallId: await s.receiveInbound(s.organizations.a) }),
          call: (s, c) =>
            s.telephony.answerCall(
              {
                organizationId: s.organizations.a,
                providerCallId: c.providerCallId as string,
                callId,
                ringIdentities: [rep],
              },
              { timeoutMs: TIMEOUT }
            ),
        },
        playDisclosure: {
          ready: async (s) => ({ providerCallId: (await place(s)).providerCallId }),
          call: (s, c) =>
            s.telephony.playDisclosure(
              {
                organizationId: s.organizations.a,
                providerCallId: c.providerCallId as string,
                ...wording,
              },
              { timeoutMs: TIMEOUT }
            ),
        },
        bridge: {
          ready: async (s) => ({ providerCallId: (await disclosed(s)).providerCallId }),
          call: (s, c) =>
            s.telephony.bridge(
              {
                organizationId: s.organizations.a,
                providerCallId: c.providerCallId as string,
                repIdentity: rep,
              },
              { timeoutMs: TIMEOUT }
            ),
        },
        startRecording: {
          ready: async (s) => ({ providerCallId: (await disclosed(s)).providerCallId }),
          call: (s, c) =>
            s.telephony.startRecording(
              { organizationId: s.organizations.a, providerCallId: c.providerCallId as string },
              { timeoutMs: TIMEOUT }
            ),
        },
        forkTracks: {
          ready: async (s) => ({ providerCallId: (await disclosed(s, true)).providerCallId }),
          call: (s, c) =>
            s.telephony.forkTracks(
              {
                organizationId: s.organizations.a,
                providerCallId: c.providerCallId as string,
                destinationUrl: 'wss://copilot.example.test/s',
              },
              { timeoutMs: TIMEOUT }
            ),
        },
        hangUp: {
          ready: async (s) => ({ providerCallId: (await place(s)).providerCallId }),
          call: (s, c) =>
            s.telephony.hangUp(
              { organizationId: s.organizations.a, providerCallId: c.providerCallId as string },
              { timeoutMs: TIMEOUT }
            ),
        },
        fetchRecording: {
          ready: async (s) => {
            const placed = await disclosed(s)
            const started = await s.telephony.startRecording(placed.ref)
            await s.telephony.hangUp(placed.ref)
            return { recordingId: started.recordingId }
          },
          call: (s, c) =>
            s.telephony.fetchRecording(
              { organizationId: s.organizations.a, recordingId: c.recordingId as string },
              { timeoutMs: TIMEOUT }
            ),
        },
        deleteRecording: {
          ready: async (s) => {
            const placed = await disclosed(s)
            const started = await s.telephony.startRecording(placed.ref)
            await s.telephony.hangUp(placed.ref)
            return { recordingId: started.recordingId }
          },
          call: (s, c) =>
            s.telephony.deleteRecording(
              { organizationId: s.organizations.a, recordingId: c.recordingId as string },
              { timeoutMs: TIMEOUT }
            ),
        },
        mintBrowserToken: {
          ready: async () => ({}),
          call: (s) =>
            s.telephony.mintBrowserToken(
              { organizationId: s.organizations.a, identity: rep },
              { timeoutMs: TIMEOUT }
            ),
        },
      }
      type Ctx = Record<string, unknown>
      const operations = Object.keys(steps) as TelephonyOperation[]

      test.each(operations)(
        '%s gives up when the provider does not answer in time',
        async (operation) => {
          const s = await subject()
          const ctx = (await steps[operation].ready(s)) as Ctx
          s.stallNext(operation)
          const started = Date.now()
          await expect(steps[operation].call(s, ctx)).rejects.toMatchObject(
            code('telephony.unavailable')
          )
          const elapsed = Date.now() - started
          expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT - 10)
          expect(elapsed).toBeLessThan(5000)
        }
      )

      test.each(operations)('%s reports a failing provider as unavailable', async (operation) => {
        const s = await subject()
        const ctx = (await steps[operation].ready(s)) as Ctx
        s.failNext(operation)
        await expect(steps[operation].call(s, ctx)).rejects.toMatchObject(
          code('telephony.unavailable')
        )
      })

      test.each(operations)('%s works again once the provider recovers', async (operation) => {
        const s = await subject()
        const ctx = (await steps[operation].ready(s)) as Ctx
        s.failNext(operation)
        await expect(steps[operation].call(s, ctx)).rejects.toBeDefined()
        await steps[operation].call(s, ctx)
      })

      test('a placeCall that timed out placed nothing: the same key places the call', async () => {
        const s = await subject()
        const request = {
          organizationId: s.organizations.a,
          callId,
          idempotencyKey: key(),
          from: line,
          to: s.numberFor('answers'),
        }
        s.stallNext('placeCall')
        await expect(s.telephony.placeCall(request, { timeoutMs: TIMEOUT })).rejects.toMatchObject(
          code('telephony.unavailable')
        )
        expect(await s.takeEvents()).toHaveLength(0)
        expect((await s.telephony.placeCall(request)).created).toBe(true)
      })

      test('a hangUp that timed out left the call up', async () => {
        const s = await subject()
        const placed = await disclosed(s)
        s.stallNext('hangUp')
        await expect(s.telephony.hangUp(placed.ref, { timeoutMs: TIMEOUT })).rejects.toBeDefined()
        await s.telephony.bridge({ ...placed.ref, repIdentity: rep })
      })

      test.each([[0], [-1], [1.5], [60_001], [Number.NaN]])(
        'a timeout of %p ms is refused',
        async (timeoutMs) => {
          const s = await subject()
          await expect(
            s.telephony.mintBrowserToken(
              { organizationId: s.organizations.a, identity: rep },
              { timeoutMs }
            )
          ).rejects.toMatchObject(code('telephony.invalid_request'))
        }
      )
    })
  })
}
