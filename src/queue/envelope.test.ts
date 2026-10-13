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
