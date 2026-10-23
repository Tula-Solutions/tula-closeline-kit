import { describe, expect, test } from 'bun:test'
import { prospectIdSchema } from 'tula-closeline-contract'
import { createFixedClock } from '../clock'
import { createMessageRegistry } from '../queue/envelope'
import { sampleAuditEntry } from './behaviour'
import { auditRecordedMessage } from './message'

const registry = createMessageRegistry([auditRecordedMessage], {
  clock: createFixedClock('2026-01-01T00:00:00.000Z'),
})
const PROSPECT = prospectIdSchema.parse(`prs_${'a'.repeat(32)}`)

function envelope(extra: Record<string, unknown>): unknown {
  const { id, organizationId, ...payload } = sampleAuditEntry('evt_1')
  return {
    id,
    type: auditRecordedMessage.type,
    version: auditRecordedMessage.version,
    occurredAt: '2026-01-01T00:00:00.000Z',
    organizationId,
    traceId: id,
    payload: { ...payload, ...extra },
  }
}

function roundTrip(extra: Record<string, unknown>) {
  const wire = JSON.stringify(envelope(extra))
  return registry.decode(wire)
}

describe('audit.recorded prospectId', () => {
  test('a message with a prospectId round-trips', () => {
    const result = roundTrip({ prospectId: PROSPECT })
    expect(result.ok && result.envelope.payload.prospectId).toBe(PROSPECT)
  })

  test('a null prospectId round-trips', () => {
    const result = roundTrip({ prospectId: null })
    expect(result.ok && result.envelope.payload.prospectId).toBeNull()
  })

  test('a message without a prospectId still parses', () => {
    const result = roundTrip({})
    expect(result.ok).toBe(true)
    expect(result.ok && result.envelope.payload.prospectId).toBeUndefined()
  })

  test('a malformed prospectId is rejected', () => {
    expect(roundTrip({ prospectId: 'not-an-id' }).ok).toBe(false)
  })
})
