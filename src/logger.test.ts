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

  test('keys that merely contain a sensitive word are not redacted', () => {
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

describe('credential-shaped keys', () => {
  test.each([
    'set-cookie',
    'Set-Cookie',
    'x-api-key',
    'client_secret',
    'clientSecret',
    'idToken',
    'sessionToken',
    'newPassword',
    'Proxy-Authorization',
  ])('%s is redacted', (key) => {
    const { logger, lines } = capture()
    logger.info('x', { [key]: 'SECRET-VALUE', visible: 'ok' })
    expect(lines.join('')).not.toContain('SECRET-VALUE')
    expect(lines.join('')).toContain('"visible":"ok"')
  })

  test.each(['recordingUrl', 'transcriptId', 'bodyLength', 'tokenCount', 'secretary', 'cookies'])(
    '%s is not redacted',
    (key) => {
      const { logger, lines } = capture()
      logger.info('x', { [key]: 'KEEP-VALUE' })
      expect(lines.join('')).toContain('KEEP-VALUE')
    }
  )
})

function throwingGetter(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const value: Record<string, unknown> = { before: 'ok-before', ...extra }
  Object.defineProperty(value, 'bad', {
    enumerable: true,
    get() {
      throw new Error('getter exploded')
    },
  })
  value.after = 'ok-after'
  return value
}

function throwingKeys(): object {
  return new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('ownKeys exploded')
      },
    }
  )
}

describe('logging never throws', () => {
  test('a throwing getter is replaced and its siblings are still logged and redacted', () => {
    const { logger, lines } = capture()
    expect(() =>
      logger.info('x', { nested: throwingGetter({ password: 'SECRET-VALUE' }) })
    ).not.toThrow()
    const output = lines.join('')
    expect(output).toContain('"bad":"[unserializable]"')
    expect(output).toContain('ok-before')
    expect(output).toContain('ok-after')
    expect(output).not.toContain('SECRET-VALUE')
  })

  test('a throwing getter on the top-level fields does not throw from info, error or child', () => {
    const { logger, lines } = capture()
    expect(() => logger.info('x', throwingGetter())).not.toThrow()
    expect(() => logger.error('x', throwingGetter())).not.toThrow()
    expect(() => logger.child(throwingGetter()).warn('x')).not.toThrow()
    expect(lines).toHaveLength(3)
    expect(lines.join('')).toContain('ok-after')
  })

  test('a getter on a redacted key is never read', () => {
    const { logger, lines } = capture()
    const fields = {}
    Object.defineProperty(fields, 'password', {
      enumerable: true,
      get() {
        throw new Error('should not be read')
      },
    })
    expect(() => logger.info('x', fields)).not.toThrow()
    expect(lines.join('')).toContain('"password":"[redacted]"')
  })

  test('a Proxy whose ownKeys throws is replaced and its siblings are still logged', () => {
    const { logger, lines } = capture()
    expect(() => logger.info('x', { proxy: throwingKeys(), sibling: 'ok-sibling' })).not.toThrow()
    expect(lines.join('')).toContain('"proxy":"[unserializable]"')
    expect(lines.join('')).toContain('ok-sibling')
  })

  test('a Proxy whose ownKeys throws as the top-level fields does not throw', () => {
    const { logger, lines } = capture()
    const fields = throwingKeys() as Record<string, unknown>
    expect(() => logger.info('x', fields)).not.toThrow()
    expect(() => logger.child(fields).info('y')).not.toThrow()
    expect(lines).toHaveLength(2)
  })

  test('a Proxy whose get throws (toJSON lookup) does not throw', () => {
    const { logger, lines } = capture()
    const proxy = new Proxy(
      { a: 1 },
      {
        get() {
          throw new Error('get exploded')
        },
      }
    )
    expect(() => logger.info('x', { proxy, sibling: 'ok-sibling' })).not.toThrow()
    expect(lines.join('')).toContain('ok-sibling')
  })

  test('an Error whose stack, message, code or cause throw is still logged', () => {
    const { logger, parsed } = capture()
    const error = new Error('real message')
    for (const key of ['stack', 'code', 'cause']) {
      Object.defineProperty(error, key, {
        get() {
          throw new Error(`${key} exploded`)
        },
      })
    }
    expect(() => logger.error('x', { error })).not.toThrow()
    expect(parsed()[0]?.error).toMatchObject({
      name: 'Error',
      message: 'real message',
      stack: '[unserializable]',
      code: '[unserializable]',
      cause: '[unserializable]',
    })
  })

  test('an Error whose message getter throws is still logged', () => {
    const { logger, parsed } = capture()
    const error = new Error('x')
    Object.defineProperty(error, 'message', {
      get() {
        throw new Error('message exploded')
      },
    })
    expect(() => logger.error('x', { error })).not.toThrow()
    expect(parsed()[0]?.error).toMatchObject({ name: 'Error', message: '[unserializable]' })
  })
})

describe('bounded work and output', () => {
  const LIMIT_MS = 200

  function logTimed(fields: Record<string, unknown>) {
    const { logger, lines } = capture()
    const started = performance.now()
    logger.info('x', fields)
    const elapsed = performance.now() - started
    return { elapsed, line: lines.join('') }
  }

  test('a 10 MB Buffer is summarised, not logged', () => {
    const buffer = Buffer.alloc(10 * 1024 * 1024, 7)
    const { elapsed, line } = logTimed({ audio: buffer })
    expect(elapsed).toBeLessThan(LIMIT_MS)
    expect(line.length).toBeLessThan(100_000)
    expect(line).toContain('"byteLength":10485760')
    expect(line).not.toContain('7,7,7')
    expect(line).not.toContain('"data"')
  })

  test('a 10 MB Uint8Array is summarised, not logged', () => {
    const bytes = new Uint8Array(10 * 1024 * 1024).fill(7)
    const { elapsed, line } = logTimed({ audio: bytes })
    expect(elapsed).toBeLessThan(LIMIT_MS)
    expect(line.length).toBeLessThan(100_000)
    expect(line).toContain('"type":"Uint8Array"')
    expect(line).toContain('"byteLength":10485760')
    expect(line).not.toContain('7,7,7')
    expect(line).not.toContain('"7":7')
  })

  test('an ArrayBuffer, a DataView and a Float32Array are summarised', () => {
    const { logger, parsed } = capture()
    logger.info('x', {
      buffer: new ArrayBuffer(8),
      view: new DataView(new ArrayBuffer(4)),
      floats: new Float32Array(3),
    })
    expect(parsed()[0]).toMatchObject({
      buffer: { type: 'ArrayBuffer', byteLength: 8 },
      view: { type: 'DataView', byteLength: 4 },
      floats: { type: 'Float32Array', byteLength: 12 },
    })
  })

  test('a 22-level diamond of shared references is cut off by the node budget', () => {
    let node: Record<string, unknown> = { leaf: 'end' }
    for (let i = 0; i < 22; i++) {
      node = { a: node, b: node }
    }
    const { elapsed, line } = logTimed({ node })
    expect(elapsed).toBeLessThan(LIMIT_MS)
    expect(line.length).toBeLessThan(100_000)
    expect(line).toContain('[truncated]')
  })

  test('a long array keeps its first 100 items and a marker', () => {
    const { logger, parsed } = capture()
    logger.info('x', { list: Array.from({ length: 150 }, (_, i) => i) })
    const list = parsed()[0]?.list as unknown[]
    expect(list).toHaveLength(101)
    expect(list[99]).toBe(99)
    expect(list[100]).toBe('[+50 more]')
  })

  test('an object with many keys keeps its first 200 and a marker', () => {
    const { logger, parsed } = capture()
    const big: Record<string, number> = {}
    for (let i = 0; i < 250; i++) {
      big[`k${i}`] = i
    }
    logger.info('x', { big })
    const logged = parsed()[0]?.big as Record<string, unknown>
    expect(Object.keys(logged)).toHaveLength(201)
    expect(logged.k199).toBe(199)
    expect(logged).not.toHaveProperty('k200')
    expect(logged['[more]']).toBe('[+50 more]')
  })

  test('a sensitive key is still redacted when the budget is spent', () => {
    const { logger, lines } = capture()
    const wide = Array.from({ length: 100 }, () => Array.from({ length: 100 }, (_, i) => i))
    logger.info('x', { wide, password: 'SECRET-VALUE', later: [{ token: 'SECRET-VALUE' }] })
    expect(lines.join('')).toContain('[truncated]')
    expect(lines.join('')).not.toContain('SECRET-VALUE')
  })
})

describe('level gating', () => {
  function watched() {
    const reads: string[] = []
    const fields: Record<string, unknown> = {}
    Object.defineProperty(fields, 'spy', {
      enumerable: true,
      get() {
        reads.push('spy')
        return 'value'
      },
    })
    return { reads, fields }
  }

  test('a debug call at level info never touches its fields', () => {
    const { logger, lines } = capture('info')
    const { reads, fields } = watched()
    logger.debug('x', fields)
    expect(reads).toEqual([])
    expect(lines).toEqual([])
  })

  test.each(['debug', 'info', 'warn', 'error'] as const)(
    'a %s call at level silent never touches its fields',
    (method) => {
      const { logger } = capture('silent')
      const { reads, fields } = watched()
      logger[method]('x', fields)
      expect(reads).toEqual([])
    }
  )

  test('an enabled call still reads its fields', () => {
    const { logger } = capture('info')
    const { reads, fields } = watched()
    logger.info('x', fields)
    expect(reads).toEqual(['spy'])
  })
})

describe('inputs that used to be lost', () => {
  test('a Map is logged as an object of its entries and redacts sensitive keys', () => {
    const { logger, lines, parsed } = capture()
    logger.info('x', {
      map: new Map<unknown, unknown>([
        ['token', 'SECRET-VALUE'],
        ['a', 1],
        [42, 'numeric-key-value'],
        [{}, 'object-key-value'],
      ]),
    })
    expect(lines.join('')).not.toContain('SECRET-VALUE')
    const map = parsed()[0]?.map as Record<string, unknown>
    expect(map.a).toBe(1)
    expect(map.token).toBe('[redacted]')
    expect(Object.values(map)).toContain('numeric-key-value')
    expect(Object.values(map)).toContain('object-key-value')
    expect(Object.keys(map).filter((key) => key.startsWith('[key'))).toHaveLength(2)
  })

  test('a Set is logged as an array and redacts inside its members', () => {
    const { logger, lines, parsed } = capture()
    logger.info('x', { set: new Set([1, 'two', { password: 'SECRET-VALUE', ok: true }]) })
    expect(lines.join('')).not.toContain('SECRET-VALUE')
    expect(parsed()[0]?.set).toEqual([1, 'two', { password: '[redacted]', ok: true }])
  })

  test('a Map and a Set obey the same caps', () => {
    const { logger, parsed } = capture()
    logger.info('x', {
      map: new Map(Array.from({ length: 250 }, (_, i) => [`k${i}`, i] as const)),
      set: new Set(Array.from({ length: 150 }, (_, i) => i)),
    })
    const logged = parsed()[0]
    const set = logged?.set as unknown[]
    expect(Object.keys(logged?.map as object)).toHaveLength(201)
    expect(set).toHaveLength(101)
    expect(set.at(100)).toBe('[+50 more]')
  })

  test('an Error cause is logged and redacted', () => {
    const { logger, lines, parsed } = capture()
    const error = new Error('outer', { cause: { password: 'SECRET-VALUE', host: 'db' } })
    logger.error('x', { error })
    expect(lines.join('')).not.toContain('SECRET-VALUE')
    expect(parsed()[0]?.error).toMatchObject({
      cause: { password: '[redacted]', host: 'db' },
    })
  })

  test('an Error cause that is an Error is serialised, and a cyclic cause does not throw', () => {
    const { logger, parsed } = capture()
    const inner = new Error('inner')
    const outer = new Error('outer', { cause: inner })
    logger.error('x', { error: outer })
    expect(parsed()[0]?.error).toMatchObject({ cause: { name: 'Error', message: 'inner' } })

    const loop = new Error('loop')
    loop.cause = loop
    expect(() => logger.error('y', { error: loop })).not.toThrow()
    expect(parsed()[1]?.error).toMatchObject({ cause: '[circular]' })
  })

  test('an own __proto__ key from JSON.parse is kept as data', () => {
    const { logger, lines } = capture()
    logger.info('x', { parsed: JSON.parse('{"__proto__":{"a":1},"b":2}') })
    expect(lines.join('')).toContain('"__proto__":{"a":1}')
    expect(lines.join('')).toContain('"b":2')
  })

  test('an own __proto__ key in a Map and in the top-level fields is kept as data', () => {
    const { logger, lines } = capture()
    logger.info('x', JSON.parse('{"__proto__":{"top":1}}'))
    logger.info('y', { map: new Map([['__proto__', { inMap: 1 }]]) })
    expect(lines[0]).toContain('"__proto__":{"top":1}')
    expect(lines[1]).toContain('"__proto__":{"inMap":1}')
  })
})
