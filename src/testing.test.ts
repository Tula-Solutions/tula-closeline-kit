import { describe, expect, test } from 'bun:test'
import { createFixedClock } from './clock'
import { AppError } from './errors'
import { createMemoryLogger, createTestDeps } from './testing'

describe('createMemoryLogger', () => {
  test('records level, message and fields in order', () => {
    const logger = createMemoryLogger()
    logger.debug('one')
    logger.info('two', { a: 1 })
    logger.warn('three')
    logger.error('four', { b: 2 })
    expect(logger.entries).toEqual([
      { level: 'debug', message: 'one', fields: {} },
      { level: 'info', message: 'two', fields: { a: 1 } },
      { level: 'warn', message: 'three', fields: {} },
      { level: 'error', message: 'four', fields: { b: 2 } },
    ])
  })

  test('records fields after redaction', () => {
    const logger = createMemoryLogger()
    logger.info('x', { nested: { Authorization: 'SECRET-VALUE' }, visible: 'ok' })
    const output = JSON.stringify(logger.entries)
    expect(output).not.toContain('SECRET-VALUE')
    expect(output).toContain('ok')
  })

  test('child entries land in the parent list with the child fields merged', () => {
    const logger = createMemoryLogger()
    const child = logger.child({ requestId: 'r_1', token: 'SECRET-VALUE' })
    child.info('x', { step: 1 })
    expect(logger.entries).toEqual([
      {
        level: 'info',
        message: 'x',
        fields: { requestId: 'r_1', token: '[redacted]', step: 1 },
      },
    ])
  })

  test('renames reserved keys the way the real logger does', () => {
    const logger = createMemoryLogger()
    logger.info('x', { level: 'a', msg: 'b', service: 'c', time: 'd', ok: 1 })
    expect(logger.entries[0]?.fields).toEqual({
      field_level: 'a',
      field_msg: 'b',
      field_service: 'c',
      field_time: 'd',
      ok: 1,
    })
  })

  test('renames reserved keys given to child()', () => {
    const logger = createMemoryLogger()
    logger.child({ level: 'a' }).info('x')
    expect(logger.entries[0]?.fields).toEqual({ field_level: 'a' })
  })

  test('call fields beat child fields, and a deeper child beats its parent', () => {
    const logger = createMemoryLogger()
    logger.child({ who: 'parent', keep: 1 }).child({ who: 'child' }).info('x', { other: 2 })
    logger.child({ who: 'child' }).info('y', { who: 'call' })
    expect(logger.entries[0]?.fields).toEqual({ who: 'child', keep: 1, other: 2 })
    expect(logger.entries[1]?.fields).toEqual({ who: 'call' })
  })

  test('never throws on fields that throw', () => {
    const logger = createMemoryLogger()
    const fields = {}
    Object.defineProperty(fields, 'bad', {
      enumerable: true,
      get() {
        throw new Error('boom')
      },
    })
    expect(() => logger.info('x', fields)).not.toThrow()
    expect(logger.entries[0]?.fields).toEqual({ bad: '[unserializable]' })
  })

  test('serialises errors the way the real logger does', () => {
    const logger = createMemoryLogger()
    logger.error('x', { error: new AppError({ code: 'a.b', status: 500, message: 'm' }) })
    expect(logger.entries[0]?.fields.error).toMatchObject({ name: 'AppError', code: 'a.b' })
  })
})

describe('secrets inside message strings', () => {
  test('the memory logger masks a secret in the message and in an error message', () => {
    const logger = createMemoryLogger()
    logger.error('failed password=hunter2', { error: new Error('Bearer abc123def456') })
    const entry = logger.entries[0]
    expect(entry?.message).toBe('failed password=[redacted]')
    expect(JSON.stringify(entry)).not.toContain('abc123def456')
  })
})

describe('createTestDeps', () => {
  test('returns a clock fixed at 2026-01-01T00:00:00.000Z and a memory logger', () => {
    const deps = createTestDeps()
    expect(deps.clock.now()).toEqual(new Date('2026-01-01T00:00:00.000Z'))
    deps.logger.info('hello')
    expect(deps.logger.entries).toHaveLength(1)
  })

  test('the clock can be advanced', () => {
    const deps = createTestDeps()
    deps.clock.advance('10m')
    expect(deps.clock.now()).toEqual(new Date('2026-01-01T00:10:00.000Z'))
  })

  test('each call returns independent deps', () => {
    const first = createTestDeps()
    const second = createTestDeps()
    first.clock.advance('1d')
    first.logger.info('x')
    expect(second.clock.now()).toEqual(new Date('2026-01-01T00:00:00.000Z'))
    expect(second.logger.entries).toHaveLength(0)
  })

  test('overrides replace the clock', () => {
    const clock = createFixedClock('2030-06-15T12:00:00.000Z')
    const deps = createTestDeps({ clock })
    expect(deps.clock).toBe(clock)
    expect(deps.clock.now()).toEqual(new Date('2030-06-15T12:00:00.000Z'))
    expect(deps.logger.entries).toEqual([])
  })

  test('overrides replace the logger', () => {
    const logger = createMemoryLogger()
    const deps = createTestDeps({ logger })
    expect(deps.logger).toBe(logger)
    expect(deps.clock.now()).toEqual(new Date('2026-01-01T00:00:00.000Z'))
  })
})
