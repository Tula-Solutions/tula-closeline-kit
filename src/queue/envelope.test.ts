import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { createFixedClock } from '../clock'
import { createMessageRegistry, defineMessage } from './envelope'
import { createTestRegistry, testNote, testPing } from './testing'

const registry = createTestRegistry({
  clock: createFixedClock('2026-02-03T04:05:06.000Z'),
  newId: () => 'msg_fixed',
})

describe('decode never throws and never echoes a value', () => {
  const good = registry.create({
    type: 'test.ping',
    payload: { n: 1 },
    organizationId: 'org_a',
    traceId: 'trace_1',
  })

  test.each([
    ['not JSON', '{nope', 'malformed'],
    ['JSON that is not an object', '42', 'malformed'],
    ['null', 'null', 'malformed'],
    ['an empty id', JSON.stringify({ ...good, id: '' }), 'malformed'],
    ['a date that is not ISO', JSON.stringify({ ...good, occurredAt: 'yesterday' }), 'malformed'],
    ['an unknown type', JSON.stringify({ ...good, type: 'test.other' }), 'unknown_type'],
    ['another version', JSON.stringify({ ...good, version: 2 }), 'unsupported_version'],
    [
      'a missing organization id',
      JSON.stringify({ ...good, organizationId: undefined }),
      'invalid_scope',
    ],
    [
      'an organization id on a global type',
      JSON.stringify({ ...good, type: 'test.note', payload: { text: 'a' } }),
      'invalid_scope',
    ],
    [
      'a payload of the wrong shape',
      JSON.stringify({ ...good, payload: { n: 'SECRET' } }),
      'invalid_payload',
    ],
  ])('%s is %s', (_label, body, reason) => {
    const result = registry.decode(body)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason as string).toBe(reason)
      expect(JSON.stringify(result.issues)).not.toContain('SECRET')
    }
  })

  test('a body over 256 KiB is malformed without being parsed', () => {
    const result = registry.decode(' '.repeat(262_145))
    expect(result).toMatchObject({ ok: false, reason: 'malformed' })
  })

  test('the id of a rejected message is returned when it can be read', () => {
    const result = registry.decode(JSON.stringify({ ...good, payload: { n: 'x' } }))
    expect(result).toMatchObject({ ok: false, messageId: good.id })
  })
})

describe('create and encode', () => {
  test('create fills id, time and version, and validates the payload', () => {
    const envelope = registry.create({
      type: 'test.ping',
      payload: { n: 5 },
      organizationId: 'org_a',
      traceId: 'trace_1',
    })
    expect(envelope).toEqual({
      id: 'msg_fixed',
      type: 'test.ping',
      version: 1,
      occurredAt: '2026-02-03T04:05:06.000Z',
      organizationId: 'org_a',
      traceId: 'trace_1',
      payload: { n: 5 },
    })
  })

  test('create refuses a payload that does not fit and an unknown type', () => {
    expect(() =>
      registry.create({
        type: 'test.ping',
        payload: { n: 'x' } as never,
        organizationId: 'o',
        traceId: 't',
      })
    ).toThrow()
    expect(() =>
      registry.create({ type: 'test.nope', payload: {}, traceId: 't' } as never)
    ).toThrow(expect.objectContaining({ code: 'queue.invalid_message' }))
  })

  test('encode then decode gives the same envelope', () => {
    const envelope = registry.create({ type: 'test.note', payload: { text: 'hi' }, traceId: 't' })
    const decoded = registry.decode(registry.encode(envelope))
    expect(decoded).toEqual({ ok: true, envelope })
  })

  test('a registry with a duplicated type is a mistake', () => {
    expect(() => createMessageRegistry([testPing, testPing])).toThrow(/defined twice/)
  })

  test.each([
    ['no area', 'ping'],
    ['upper case', 'Test.Ping'],
    ['empty', ''],
  ])('defineMessage refuses a type with %s', (_label, type) => {
    expect(() =>
      defineMessage({ type, version: 1, scope: 'global', payload: z.object({}) })
    ).toThrow(TypeError)
  })

  test('defineMessage refuses a version that is not a positive integer', () => {
    for (const version of [0, 1.5, -1]) {
      expect(() =>
        defineMessage({ type: 'a.b', version, scope: 'global', payload: z.object({}) })
      ).toThrow(TypeError)
    }
  })

  test('the test definitions are what the suite thinks they are', () => {
    expect(testNote.scope).toBe('global')
    expect(testPing.scope).toBe('organization')
  })
})

describe('what a rejected message may reveal (a body is untrusted and can hold personal data)', () => {
  const people = defineMessage({
    type: 'test.people',
    version: 1,
    scope: 'global',
    payload: z.object({ byEmail: z.record(z.string(), z.number()) }),
  })
  const strict = createMessageRegistry([people])
  const base = {
    id: 'msg_1',
    type: 'test.people',
    version: 1,
    occurredAt: '2026-01-01T00:00:00.000Z',
    traceId: 't',
  }

  test('a payload path made of a record key that is an email is not echoed', () => {
    const result = strict.decode(
      JSON.stringify({ ...base, payload: { byEmail: { 'jane.doe@acme.com': 'x' } } })
    )
    expect(result).toMatchObject({ ok: false, reason: 'invalid_payload' })
    expect(JSON.stringify(result)).not.toContain('jane.doe')
    expect(JSON.stringify(result)).not.toContain('acme')
  })

  test('array indices and odd keys become *, ordinary field names stay', () => {
    const list = defineMessage({
      type: 'test.list',
      version: 1,
      scope: 'global',
      payload: z.object({ items: z.array(z.number()) }),
    })
    const result = createMessageRegistry([list]).decode(
      JSON.stringify({ ...base, type: 'test.list', payload: { items: [1, 'x'] } })
    )
    expect(result).toMatchObject({ ok: false, issues: ['items.*: invalid_type'] })
  })

  test('an unknown type is never echoed, only its length', () => {
    const result = strict.decode(JSON.stringify({ ...base, type: 'SECRET-xyz', payload: {} }))
    expect(result).toMatchObject({ ok: false, reason: 'unknown_type' })
    expect(JSON.stringify(result)).not.toContain('SECRET')
    expect(JSON.stringify(result)).toContain('10')
  })

  test.each(['jane@acme.com', 'has space', 'x'.repeat(129), 'ünï'])(
    'a message id that fails the id pattern (%s) is not returned',
    (id) => {
      const result = strict.decode(JSON.stringify({ ...base, id, payload: { byEmail: {} } }))
      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).not.toContain('acme')
      expect(JSON.stringify(result)).not.toContain('messageId')
    }
  )

  test('a trace id that is not a plain identifier is malformed', () => {
    const result = strict.decode(
      JSON.stringify({ ...base, traceId: 'jane@acme.com', payload: { byEmail: {} } })
    )
    expect(result).toMatchObject({ ok: false, reason: 'malformed' })
  })
})

describe('the Organization id is the system id shape', () => {
  const scoped = defineMessage({
    type: 'test.scoped',
    version: 1,
    scope: 'organization',
    payload: z.object({}),
  })
  const strict = createMessageRegistry([scoped])
  const good = `org_${'0123456789abcdef'.repeat(2)}`
  const body = (organizationId: string) =>
    JSON.stringify({
      id: 'm1',
      type: 'test.scoped',
      version: 1,
      occurredAt: '2026-01-01T00:00:00.000Z',
      organizationId,
      traceId: 't',
      payload: {},
    })

  test('the contract shape is accepted', () => {
    expect(strict.decode(body(good)).ok).toBe(true)
  })

  test.each([
    'org_a',
    'org_',
    `org_${'A'.repeat(32)}`,
    `usr_${'a'.repeat(32)}`,
    `org_${'a'.repeat(33)}`,
    "org_'; drop table",
  ])('%s is invalid_scope and never reaches a handler', (id) => {
    expect(strict.decode(body(id))).toMatchObject({ ok: false, reason: 'invalid_scope' })
    expect(JSON.stringify(strict.decode(body(id)))).not.toContain('drop')
  })

  test('create and encode refuse a bad id too', () => {
    expect(() =>
      strict.create({ type: 'test.scoped', payload: {}, organizationId: 'org_a', traceId: 't' })
    ).toThrow(expect.objectContaining({ code: 'queue.invalid_message' }))
  })

  test('the schema can be replaced', () => {
    const lenient = createMessageRegistry([scoped], { organizationIdSchema: z.string().min(1) })
    expect(lenient.decode(body('org_a')).ok).toBe(true)
  })
})

describe('versions during a rolling deploy', () => {
  const v1 = z.object({ name: z.string() })
  const v2 = z.object({ firstName: z.string(), lastName: z.string() })
  const renamed = defineMessage({
    type: 'test.renamed',
    version: 2,
    scope: 'global',
    payload: v2,
    previous: [
      {
        version: 1,
        payload: v1,
        upcast: (old) => {
          const [firstName = '', lastName = ''] = (old as { name: string }).name.split(' ')
          return { firstName, lastName }
        },
      },
    ],
  })
  const registry = createMessageRegistry([renamed])
  const wire = (version: number, payload: unknown) =>
    JSON.stringify({
      id: 'm1',
      type: 'test.renamed',
      version,
      occurredAt: '2026-01-01T00:00:00.000Z',
      traceId: 't',
      payload,
    })

  test('an older accepted version is upcast to the current shape', () => {
    const result = registry.decode(wire(1, { name: 'Ada Lovelace' }))
    expect(result).toMatchObject({
      ok: true,
      envelope: { version: 2, payload: { firstName: 'Ada', lastName: 'Lovelace' } },
    })
  })

  test('an older version whose payload fails its own schema is invalid_payload', () => {
    expect(registry.decode(wire(1, { firstName: 'x' }))).toMatchObject({
      ok: false,
      reason: 'invalid_payload',
    })
  })

  test('a version nobody listed is unsupported', () => {
    expect(registry.decode(wire(3, {}))).toMatchObject({ ok: false, reason: 'unsupported_version' })
    expect(registry.decode(wire(0 + 4, {}))).toMatchObject({
      ok: false,
      reason: 'unsupported_version',
    })
  })

  test('a previous entry that repeats the current version is a mistake', () => {
    expect(() =>
      defineMessage({
        type: 'test.bad',
        version: 1,
        scope: 'global',
        payload: v1,
        previous: [{ version: 1, payload: v1, upcast: (old) => old }],
      })
    ).toThrow(TypeError)
  })
})

describe('a path keeps only field names the schema declares (a record key is body content)', () => {
  const tagged = defineMessage({
    type: 'test.tagged',
    version: 2,
    scope: 'global',
    payload: z.object({
      tags: z.record(z.string(), z.number()),
      groups: z.array(
        z.object({ title: z.string(), members: z.array(z.object({ age: z.number() })) })
      ),
      either: z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]),
      maybe: z.object({ inner: z.number() }).optional(),
    }),
    previous: [
      {
        version: 1,
        payload: z.object({ labels: z.array(z.string()) }),
        // A bad upcast: record keys from the old body end up under `tags`.
        upcast: (old) => ({
          tags: Object.fromEntries((old as { labels: string[] }).labels.map((l) => [l, 'x'])),
          groups: [],
          either: { a: 'a' },
        }),
      },
    ],
  })
  const registry = createMessageRegistry([tagged])
  const wire = (version: number, payload: unknown) =>
    JSON.stringify({
      id: 'm1',
      type: 'test.tagged',
      version,
      occurredAt: '2026-01-01T00:00:00.000Z',
      traceId: 't',
      payload,
    })
  const good = { tags: {}, groups: [], either: { a: 'a' } }

  test('a record key that looks like a field name is masked', () => {
    const result = registry.decode(wire(2, { ...good, tags: { alice_smith: 'x' } }))
    expect(result).toMatchObject({ ok: false, issues: ['tags.*: invalid_type'] })
    expect(JSON.stringify(result)).not.toContain('alice_smith')
  })

  test('ordinary paths through objects and arrays keep their field names', () => {
    const result = registry.decode(
      wire(2, { ...good, groups: [{ title: 't', members: [{ age: 1 }, { age: 'x' }] }] })
    )
    expect(result).toMatchObject({ ok: false, issues: ['groups.*.members.*.age: invalid_type'] })
  })

  test('an optional object keeps its declared field', () => {
    const result = registry.decode(wire(2, { ...good, maybe: { inner: 'x' } }))
    expect(result).toMatchObject({ ok: false, issues: ['maybe.inner: invalid_type'] })
  })

  test('under a union, which cannot be resolved to one branch, every segment is masked', () => {
    const result = registry.decode(wire(2, { ...good, either: { c: 'secret_key' } }))
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('secret_key')
    expect(JSON.stringify(result)).not.toContain('either.a')
  })

  test('the result of an upcast is reported against the current schema, so its record keys are masked too', () => {
    const result = registry.decode(wire(1, { labels: ['bob_jones'] }))
    expect(result).toMatchObject({
      ok: false,
      reason: 'invalid_payload',
      issues: ['tags.*: invalid_type'],
    })
    expect(JSON.stringify(result)).not.toContain('bob_jones')
  })

  test('an old version that fails its own schema is reported against that schema', () => {
    const result = registry.decode(wire(1, { labels: [1] }))
    expect(result).toMatchObject({ ok: false, issues: ['labels.*: invalid_type'] })
  })
})
