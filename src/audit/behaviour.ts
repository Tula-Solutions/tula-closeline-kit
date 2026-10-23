import { afterEach, describe, expect, test } from 'bun:test'
import { type OrganizationId, organizationIdSchema } from 'tula-closeline-contract'
import { AuditError, type AuditErrorCode } from './errors'
import type { AuditEntryInput, AuditRecorder } from './port'

/** What the behaviour suite needs from an adapter under test. */
export interface AuditSubject {
  /** The recorder under test, empty. */
  recorder: AuditRecorder
  /**
   * Every event the recorder has handed on, as `{ id, organizationId, action }`, in order. The
   * memory adapter keeps one per event id; the queue adapter may hold duplicates with the same id
   * (the queue delivers at least once and the consumer drops the second).
   */
  delivered(): Promise<{ id: string; organizationId: string; action: string }[]>
  /** Everything the recorder logged, one JSON or text line per entry. */
  logs(): string[]
  /** Releases what the subject created. */
  close(): Promise<void>
}

const ORG_A = organizationIdSchema.parse(`org_${'a'.repeat(32)}`) as OrganizationId
const ORG_B = organizationIdSchema.parse(`org_${'b'.repeat(32)}`) as OrganizationId

/** A valid entry for the suite; `id` is the event id. */
export function sampleAuditEntry(id: string, overrides: Partial<AuditEntryInput> = {}) {
  return {
    id,
    organizationId: ORG_A,
    actor: { kind: 'agent', id: 'agent_inbound' },
    action: 'agent.sent_message',
    subject: { type: 'prospect', id: `prs_${'1'.repeat(32)}` },
    instructionVersion: 3,
    requestId: 'req_1',
    metadata: { channel: 'sms', attempt: 1, approved: true },
    ...overrides,
  } satisfies AuditEntryInput
}

/**
 * The behaviour every {@link AuditRecorder} must show. Run it with {@link auditBehaviour} against
 * the memory adapter and the queue adapter; a change that passes for one and fails for the other
 * is a bug in one of them.
 */
export function auditBehaviour(
  name: string,
  make: () => Promise<AuditSubject>,
  skip = false
): void {
  const run = skip ? describe.skip : describe
  run(`AuditRecorder behaviour: ${name}`, () => {
    const open: AuditSubject[] = []
    afterEach(async () => {
      await Promise.all(open.splice(0).map((subject) => subject.close()))
    })
    async function subject(): Promise<AuditSubject> {
      const made = await make()
      open.push(made)
      return made
    }
    async function refused(s: AuditSubject, entry: unknown, code: AuditErrorCode) {
      const error = await s.recorder.record(entry as AuditEntryInput).then(
        () => undefined,
        (e: unknown) => e
      )
      expect(error).toBeInstanceOf(AuditError)
      expect((error as AuditError).code).toBe(code)
      expect(await s.delivered()).toEqual([])
    }

    test('records an entry under its event id and Organization', async () => {
      const s = await subject()
      await s.recorder.record(sampleAuditEntry('evt_1'))
      expect(await s.delivered()).toEqual([
        { id: 'evt_1', organizationId: ORG_A, action: 'agent.sent_message' },
      ])
    })

    test('recording the same event id again adds no second event', async () => {
      const s = await subject()
      await s.recorder.record(sampleAuditEntry('evt_1'))
      await s.recorder.record(sampleAuditEntry('evt_1'))
      await s.recorder.record(sampleAuditEntry('evt_1'))
      const ids = (await s.delivered()).map((event) => event.id)
      expect(ids.length).toBeGreaterThan(0)
      expect(new Set(ids)).toEqual(new Set(['evt_1']))
    })

    test('different event ids are different events, one per Organization', async () => {
      const s = await subject()
      await s.recorder.record(sampleAuditEntry('evt_1'))
      await s.recorder.record(sampleAuditEntry('evt_2', { organizationId: ORG_B }))
      const events = await s.delivered()
      expect(events.map((e) => [e.id, e.organizationId])).toEqual([
        ['evt_1', ORG_A],
        ['evt_2', ORG_B],
      ])
    })

    test('refuses an unknown field, an unknown actor kind and a bad action code', async () => {
      const s = await subject()
      await refused(s, { ...sampleAuditEntry('evt_1'), message: 'hello' }, 'audit.invalid_entry')
      await refused(
        s,
        sampleAuditEntry('evt_1', { actor: { kind: 'robot', id: 'x' } as never }),
        'audit.invalid_entry'
      )
      await refused(
        s,
        sampleAuditEntry('evt_1', { action: 'Sent A Message' }),
        'audit.invalid_entry'
      )
      await refused(
        s,
        sampleAuditEntry('evt_1', { organizationId: 'org_x' as OrganizationId }),
        'audit.invalid_entry'
      )
    })

    test('refuses metadata with a long string, a denied key, a nested value or too many keys', async () => {
      const s = await subject()
      const bad: Record<string, unknown>[] = [
        { note: 'x'.repeat(201) },
        { body: 'hi' },
        { Transcript: 'hi' },
        { E_MAIL: 'a@b.c' },
        { nested: { a: 1 } },
        { list: [1] },
        { n: Number.NaN },
        { n: Number.POSITIVE_INFINITY },
        { empty: null },
        Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i])),
      ]
      for (const metadata of bad) {
        await refused(
          s,
          sampleAuditEntry('evt_1', { metadata: metadata as never }),
          'audit.invalid_entry'
        )
      }
    })

    test('accepts metadata at the limits', async () => {
      const s = await subject()
      await s.recorder.record(
        sampleAuditEntry('evt_1', {
          metadata: {
            note: 'x'.repeat(200),
            ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, i])),
          },
        })
      )
      expect((await s.delivered()).length).toBeGreaterThan(0)
    })

    test('refuses an entry whose serialised size is over the cap', async () => {
      const s = await subject()
      const metadata = Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [`key_${String(i).padStart(2, '0')}`, 'y'.repeat(200)])
      )
      await refused(s, sampleAuditEntry('evt_1', { metadata }), 'audit.entry_too_large')
    })

    test('never logs a metadata value, recorded or refused', async () => {
      const s = await subject()
      const secret = 'sentinel-value-7f3a9c'
      await s.recorder.record(sampleAuditEntry('evt_1', { metadata: { note: secret } }))
      await s.recorder.record(sampleAuditEntry('evt_1', { metadata: { note: secret } }))
      await s.recorder
        .record(sampleAuditEntry('evt_2', { metadata: { body: secret } }))
        .catch(() => undefined)
      await s.recorder
        .record(sampleAuditEntry('evt_3', { metadata: { note: secret.repeat(40) } }))
        .catch(() => undefined)
      expect(s.logs().join('\n')).not.toContain(secret)
    })
  })
}
