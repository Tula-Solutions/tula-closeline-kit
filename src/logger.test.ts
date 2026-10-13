import { describe, expect, test } from 'bun:test'
import { AppError } from './errors'
import { createLogger } from './logger'

function capture(level?: 'debug' | 'info' | 'warn' | 'error' | 'silent') {
  const lines: string[] = []
  const logger = createLogger({
    service: 'test-service',
    level,
    destination: { write: (line) => void lines.push(line) },
  })
  const parsed = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>)
  return { logger, lines, parsed }
}

const REDACTED_KEYS = [
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'cookie',
  'secret',
  'apiKey',
  'recording',
  'transcript',
  'body',
]

describe('createLogger', () => {
  test('writes one JSON line per entry with service, level, message and fields', () => {
    const { logger, lines, parsed } = capture()
    logger.info('user signed in', { userId: 'u_1' })
    logger.warn('slow')
    expect(lines).toHaveLength(2)
    expect(lines.every((line) => line.endsWith('\n') && line.trim().split('\n').length === 1)).toBe(
      true
    )
    expect(parsed()[0]).toMatchObject({
      service: 'test-service',
      level: 30,
      msg: 'user signed in',
      userId: 'u_1',
    })
    expect(parsed()[1]).toMatchObject({ level: 40, msg: 'slow' })
  })

  test('defaults to info and honours level', () => {
    const info = capture()
    info.logger.debug('hidden')
    info.logger.info('shown')
    expect(info.parsed().map((entry) => entry.msg)).toEqual(['shown'])

    const debug = capture('debug')
    debug.logger.debug('shown')
    expect(debug.parsed()).toHaveLength(1)

    const error = capture('error')
    error.logger.warn('hidden')
    error.logger.error('shown')
    expect(error.parsed().map((entry) => entry.msg)).toEqual(['shown'])
  })

  test('child adds fields to every entry and does not affect the parent', () => {
    const { logger, parsed } = capture()
    const child = logger.child({ requestId: 'r_1' })
    child.info('inside', { step: 1 })
    logger.info('outside')
    expect(parsed()[0]).toMatchObject({ service: 'test-service', requestId: 'r_1', step: 1 })
    expect(parsed()[1]).not.toHaveProperty('requestId')
  })

  test('a caller field cannot overwrite level, msg or service', () => {
    const { logger, parsed } = capture()
    logger.info('real', { level: 'fake', msg: 'fake', service: 'fake', time: 'fake' })
    const entry = parsed()[0]
    expect(entry?.level).toBe(30)
    expect(entry?.msg).toBe('real')
    expect(entry?.service).toBe('test-service')
    expect(entry?.time).not.toBe('fake')
  })

  test('uses stdout when no destination is given', () => {
    expect(() => createLogger({ service: 'x', level: 'silent' }).info('nothing')).not.toThrow()
  })
})

describe('redaction', () => {
  test.each(REDACTED_KEYS)('%s is redacted at the top level', (key) => {
    const { logger, lines } = capture()
    logger.info('x', { [key]: 'SECRET-VALUE', visible: 'ok' })
    expect(lines.join('')).not.toContain('SECRET-VALUE')
    expect(lines.join('')).toContain('[redacted]')
    expect(lines.join('')).toContain('"visible":"ok"')
  })

  test.each(REDACTED_KEYS)('%s is redacted three levels deep and inside an array', (key) => {
    const { logger, lines } = capture()
    logger.info('x', {
      a: { b: { c: { [key]: 'SECRET-VALUE', sibling: 'keep-me' } } },
      list: [{ nested: [{ [key]: 'SECRET-VALUE', sibling: 'keep-me-too' }] }],
    })
    const output = lines.join('')
    expect(output).not.toContain('SECRET-VALUE')
    expect(output).toContain('keep-me')
    expect(output).toContain('keep-me-too')
  })

  test('redacts an object or array stored under a redacted key as a whole', () => {
    const { logger, lines } = capture()
    logger.info('x', { body: { text: 'SECRET-VALUE' }, token: ['SECRET-VALUE'] })
    expect(lines.join('')).not.toContain('SECRET-VALUE')
  })

  test.each([
    'Authorization',
    'AUTHORIZATION',
    'ApiKey',
    'apikey',
    'APIKEY',
    'Password',
    'ACCESSTOKEN',
    'API_KEY',
    'refresh-token',
  ])('matches the key %s case-insensitively', (key) => {
    const { logger, lines } = capture()
    logger.info('x', { [key]: 'SECRET-VALUE' })
    expect(lines.join('')).not.toContain('SECRET-VALUE')
  })

  test('only exact keys are redacted, not keys that merely contain a sensitive word', () => {
    const { logger, lines } = capture()
    logger.info('x', { tokenCount: 3, bodyLength: 'KEEP' })
    expect(lines.join('')).toContain('"tokenCount":3')
    expect(lines.join('')).toContain('KEEP')
  })

  test('redacts fields given to child()', () => {
    const { logger, lines } = capture()
    logger.child({ token: 'SECRET-VALUE', requestId: 'r_1' }).info('x')
    expect(lines.join('')).not.toContain('SECRET-VALUE')
    expect(lines.join('')).toContain('r_1')
  })

  test('does not throw on a cyclic object and still redacts inside it', () => {
    const { logger, lines } = capture()
    const cyclic: Record<string, unknown> = { name: 'loop', password: 'SECRET-VALUE' }
    cyclic.self = cyclic
    cyclic.list = [cyclic, { inner: cyclic }]
    expect(() => logger.info('x', { cyclic })).not.toThrow()
    expect(lines).toHaveLength(1)
    expect(lines.join('')).not.toContain('SECRET-VALUE')
    expect(lines.join('')).toContain('[circular]')
  })

  test('a value that appears twice without a cycle is not marked circular', () => {
    const { logger, lines } = capture()
    const shared = { id: 1 }
    logger.info('x', { a: shared, b: shared })
    expect(lines.join('')).not.toContain('[circular]')
  })

  test('does not mutate the caller object', () => {
    const { logger } = capture()
    const fields = { password: 'SECRET-VALUE', nested: { token: 'SECRET-VALUE' } }
    logger.info('x', fields)
    expect(fields).toEqual({ password: 'SECRET-VALUE', nested: { token: 'SECRET-VALUE' } })
  })

  test('truncates absurdly deep objects instead of overflowing the stack', () => {
    const { logger, lines } = capture()
    let deep: Record<string, unknown> = { leaf: 'end', password: 'SECRET-VALUE' }
    for (let i = 0; i < 5_000; i++) {
      deep = { next: deep }
    }
    expect(() => logger.info('x', { deep })).not.toThrow()
    expect(lines.join('')).toContain('[truncated]')
    expect(lines.join('')).not.toContain('SECRET-VALUE')
  })

  test('redacts what toJSON would have serialised', () => {
    const { logger, lines } = capture()
    const value = { toJSON: () => ({ password: 'SECRET-VALUE', ok: 'yes' }) }
    logger.info('x', { value })
    expect(lines.join('')).not.toContain('SECRET-VALUE')
    expect(lines.join('')).toContain('"ok":"yes"')
  })

  test('survives a toJSON that throws', () => {
    const { logger, lines } = capture()
    const value = {
      toJSON: () => {
        throw new Error('boom')
      },
    }
    expect(() => logger.info('x', { value })).not.toThrow()
    expect(lines.join('')).toContain('[unserializable]')
  })

  test('keeps Dates, primitives, null and bigint', () => {
    const { logger, parsed } = capture()
    logger.info('x', {
      at: new Date('2026-01-01T00:00:00.000Z'),
      n: 1,
      nil: null,
      big: 10n,
      ok: true,
    })
    expect(parsed()[0]).toMatchObject({
      at: '2026-01-01T00:00:00.000Z',
      n: 1,
      nil: null,
      ok: true,
    })
    expect(parsed()[0]).toHaveProperty('big')
  })
})

describe('errors as fields', () => {
  test('an Error is logged with name, message and stack', () => {
    const { logger, parsed } = capture()
    logger.error('failed', { error: new TypeError('bad input') })
    const logged = parsed()[0]?.error as Record<string, unknown>
    expect(logged.name).toBe('TypeError')
    expect(logged.message).toBe('bad input')
    expect(typeof logged.stack).toBe('string')
    expect(logged).not.toHaveProperty('code')
  })

  test('an AppError is also logged with its code', () => {
    const { logger, parsed } = capture()
    logger.error('failed', {
      error: new AppError({ code: 'auth.token_expired', status: 401, message: 'expired' }),
    })
    const logged = parsed()[0]?.error as Record<string, unknown>
    expect(logged.name).toBe('AppError')
    expect(logged.code).toBe('auth.token_expired')
    expect(logged.message).toBe('expired')
  })

  test('an Error under the key err is not re-serialised by pino', () => {
    const { logger, parsed } = capture()
    logger.error('failed', { err: new AppError({ code: 'a.b', status: 500, message: 'm' }) })
    expect(parsed()[0]?.err).toMatchObject({ name: 'AppError', code: 'a.b', message: 'm' })
  })

  test('an Error nested in an object or array is serialised too', () => {
    const { logger, parsed } = capture()
    logger.error('failed', { results: [{ error: new Error('inner') }] })
    expect(JSON.stringify(parsed()[0]?.results)).toContain('"message":"inner"')
  })
})
