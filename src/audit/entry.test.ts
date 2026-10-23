import { describe, expect, test } from 'bun:test'
import { organizationIdSchema } from 'tula-closeline-contract'
import { createFixedClock } from '../clock'
import { sampleAuditEntry } from './behaviour'
import { AUDIT_LIMITS, parseAuditEntry } from './entry'
import { AuditError } from './errors'
import { createMemoryAuditRecorder } from './memory'

/** A small seeded generator, so a failure repeats. */
function prng(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) % 4_294_967_296
    return s / 4_294_967_296
  }
}

const DENIED = [
  'body',
  'content',
  'text',
  'message',
  'transcript',
  'token',
  'secret',
  'password',
  'email',
]
const ORG = organizationIdSchema.parse(`org_${'c'.repeat(32)}`)

function randomMetadata(rand: () => number): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  const count = Math.floor(rand() * 8)
  for (let i = 0; i < count; i++) {
    const kind = Math.floor(rand() * 3)
    out[`key_${i}`] =
      kind === 0
        ? 'v'.repeat(Math.floor(rand() * 201))
        : kind === 1
          ? Math.floor(rand() * 1e6)
          : rand() < 0.5
  }
  return out
}

function recase(word: string, rand: () => number): string {
  return [...word].map((c) => (rand() < 0.5 ? c.toUpperCase() : c)).join('')
}

describe('audit metadata (generated cases)', () => {
  test('metadata within the limits is accepted', () => {
    const rand = prng(1)
    for (let i = 0; i < 300; i++) {
      const entry = sampleAuditEntry(`evt_${i}`, {
        organizationId: ORG,
        metadata: randomMetadata(rand),
      })
      expect(() => parseAuditEntry(entry)).not.toThrow()
    }
  })

  test('a string over 200 characters in any value is refused', () => {
    const rand = prng(2)
    for (let i = 0; i < 300; i++) {
      const metadata = randomMetadata(rand)
      metadata[`long_${i}`] = 'z'.repeat(AUDIT_LIMITS.maxStringChars + 1 + Math.floor(rand() * 300))
      const entry = sampleAuditEntry(`evt_${i}`, { organizationId: ORG, metadata })
      expect(() => parseAuditEntry(entry)).toThrow(AuditError)
    }
  })

  test('a key named body, or another denied name in any case, is refused', () => {
    const rand = prng(3)
    for (let i = 0; i < 300; i++) {
      const metadata = randomMetadata(rand)
      metadata[recase(DENIED[i % DENIED.length] ?? 'body', rand)] = 'x'
      const entry = sampleAuditEntry(`evt_${i}`, { organizationId: ORG, metadata })
      expect(() => parseAuditEntry(entry)).toThrow(AuditError)
    }
    for (const name of ['body', 'Body', 'BODY']) {
      expect(() => parseAuditEntry(sampleAuditEntry('evt_1', { metadata: { [name]: 1 } }))).toThrow(
        AuditError
      )
    }
  })

  test('a refused entry names fields and codes, never a value', () => {
    const secret = 'sentinel-value-1b2c3d'
    try {
      parseAuditEntry(sampleAuditEntry('evt_1', { metadata: { body: secret } }))
      expect.unreachable()
    } catch (error) {
      expect(JSON.stringify((error as AuditError).details)).not.toContain(secret)
      expect((error as AuditError).message).not.toContain(secret)
    }
  })
})

describe('memory recorder', () => {
  test('keeps one stored entry per event id, the first, with the clock time', async () => {
    const clock = createFixedClock('2026-01-01T00:00:00.000Z')
    const recorder = createMemoryAuditRecorder({ clock })
    await recorder.record(sampleAuditEntry('evt_1', { metadata: { a: 1 } }))
    clock.advance('1h')
    await recorder.record(sampleAuditEntry('evt_1', { metadata: { a: 2 } }))
    expect(recorder.entries()).toHaveLength(1)
    expect(recorder.entries()[0]?.metadata).toEqual({ a: 1 })
    expect(recorder.entries()[0]?.occurredAt).toBe('2026-01-01T00:00:00.000Z')
  })

  test('is not changed by editing what the caller passed in or what entries() returned', async () => {
    const recorder = createMemoryAuditRecorder()
    const entry = sampleAuditEntry('evt_1', { metadata: { a: 1 } })
    await recorder.record(entry)
    entry.metadata.a = 99
    const stored = recorder.entries()[0]
    if (stored?.metadata) {
      stored.metadata.a = 7
    }
    expect(recorder.entries()[0]?.metadata).toEqual({ a: 1 })
  })
})

describe('review findings', () => {
  test('a key that holds a denied word as a part is refused', () => {
    for (const key of [
      'messageBody',
      'emailAddress',
      'authToken',
      'transcript_text',
      'user-password',
    ]) {
      expect(() =>
        parseAuditEntry(sampleAuditEntry('evt_1', { metadata: { [key]: 'x' } }))
      ).toThrow(AuditError)
    }
    for (const key of ['context', 'attempt', 'channel']) {
      expect(() =>
        parseAuditEntry(sampleAuditEntry('evt_1', { metadata: { [key]: 'x' } }))
      ).not.toThrow()
    }
  })

  test('the size cap counts the timestamp the recorder adds', () => {
    const size = (e: unknown) => new TextEncoder().encode(JSON.stringify(e)).length
    const clock = createFixedClock('2026-01-01T00:00:00.000Z')
    const metadata: Record<string, string> = {}
    for (let i = 0; i < 17; i++) {
      metadata[`key_${i}`] = 'a'.repeat(200)
    }
    metadata.extra = 'e'.repeat(100)
    // one more key, padded so the entry without a timestamp is 10 bytes under the cap
    const without = size(sampleAuditEntry('evt_1', { metadata: { ...metadata, last: '' } }))
    metadata.last = 'z'.repeat(AUDIT_LIMITS.maxEntryBytes - 10 - without)
    const entry = sampleAuditEntry('evt_1', { metadata })
    expect(metadata.last.length).toBeLessThanOrEqual(200)
    expect(size(entry)).toBe(AUDIT_LIMITS.maxEntryBytes - 10)
    expect(() => parseAuditEntry(entry, clock)).toThrow(AuditError)
    expect(() => parseAuditEntry({ ...entry, occurredAt: '2026-01-01T00:00:00.000Z' })).toThrow(
      AuditError
    )
  })
})
