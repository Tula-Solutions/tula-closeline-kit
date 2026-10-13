import { afterEach, describe, expect, test } from 'bun:test'
import { AppError } from '../errors'
import { createMemoryLogger } from '../testing'
import { createNoopErrorReporter } from './noop'
import type { ErrorReporter } from './port'
import { createSentryReporter, type SentryReporter } from './sentry'
import { createMemoryErrorReporter } from './testing'

interface Subject {
  reporter: ErrorReporter
  /** How many errors the adapter would send or record; undefined when it never does either. */
  sent: () => Promise<number | undefined>
  close: () => Promise<unknown>
}

function memory(): Subject {
  const reporter = createMemoryErrorReporter()
  return { reporter, sent: async () => reporter.captured.length, close: async () => undefined }
}

function noop(): Subject {
  return {
    reporter: createNoopErrorReporter(),
    sent: async () => undefined,
    close: async () => undefined,
  }
}

function sentry(): Subject {
  const events: unknown[] = []
  const reporter: SentryReporter = createSentryReporter({
    dsn: 'https://abc123publickey@o123.ingest.sentry.io/456',
    service: 'core',
    environment: 'dev',
    region: 'us',
    logger: createMemoryLogger(),
    transport: () => ({
      send: async (envelope) => {
        events.push(
          ...(envelope[1] as unknown[]).filter(
            (item) => (item as [{ type: string }])[0].type === 'event'
          )
        )
        return {}
      },
      flush: async () => true,
    }),
  })
  return {
    reporter,
    sent: async () => {
      await reporter.flush(1000)
      return events.length
    },
    close: () => reporter.close(50),
  }
}

const ADAPTERS: Array<[string, () => Subject]> = [
  ['memory', memory],
  ['no-op', noop],
  ['sentry', sentry],
]

const hostile = new Proxy(
  {},
  {
    get: () => {
      throw new Error('get')
    },
    ownKeys: () => {
      throw new Error('ownKeys')
    },
    getPrototypeOf: () => {
      throw new Error('getPrototypeOf')
    },
    has: () => {
      throw new Error('has')
    },
  }
)
const cyclic: Record<string, unknown> = { name: 'cyclic' }
cyclic.self = cyclic
const throwingMessage = new Error('x')
Object.defineProperty(throwingMessage, 'message', {
  get() {
    throw new Error('message exploded')
  },
})
const throwingStack = new Error('y')
Object.defineProperty(throwingStack, 'stack', {
  get() {
    throw new Error('stack exploded')
  },
})

const open: Subject[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((subject) => subject.close()))
})
function subjectFor(make: () => Subject): Subject {
  const subject = make()
  open.push(subject)
  return subject
}

describe.each(ADAPTERS)('ErrorReporter behaviour: %s adapter', (_name, make) => {
  test.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'boom'],
    ['a number', 42],
    ['a bigint', 10n],
    ['a symbol', Symbol('s')],
    ['a cyclic object', cyclic],
    ['an object that throws on every access', hostile],
    ['an Error whose message getter throws', throwingMessage],
    ['an Error whose stack getter throws', throwingStack],
    ['an Error with a 1 MB message', new Error('m'.repeat(1_000_000))],
  ])('capture does not throw for %s', async (_label, error) => {
    const { reporter } = subjectFor(make)
    expect(() => reporter.capture(error)).not.toThrow()
    expect(reporter.capture(error)).toBeUndefined()
  })

  test('capture does not throw for a hostile context', () => {
    const { reporter } = subjectFor(make)
    expect(() => reporter.capture(new Error('boom'), hostile as never)).not.toThrow()
    expect(() => reporter.capture(new Error('boom'), null as never)).not.toThrow()
  })

  test('capture returns before any asynchronous work is done', () => {
    const { reporter } = subjectFor(make)
    const result: unknown = reporter.capture(new Error('boom'), { requestId: 'req_1' })
    expect(result).toBeUndefined()
  })

  test('flush resolves a boolean within its timeout when nothing is pending', async () => {
    const { reporter } = subjectFor(make)
    const start = performance.now()
    expect(await reporter.flush(500)).toBe(true)
    expect(performance.now() - start).toBeLessThan(450)
  })

  test('capture is repeatable: the same error captured twice does not throw', () => {
    const { reporter } = subjectFor(make)
    const error = new Error('boom')
    expect(() => {
      reporter.capture(error)
      reporter.capture(error)
    }).not.toThrow()
  })
})

describe.each(ADAPTERS)('ErrorReporter close: %s adapter', (_name, make) => {
  test('close resolves a boolean within its timeout', async () => {
    const { reporter } = subjectFor(make)
    const start = performance.now()
    expect(typeof (await reporter.close(500))).toBe('boolean')
    expect(performance.now() - start).toBeLessThan(450)
  })

  test('capture after close does not throw', async () => {
    const { reporter } = subjectFor(make)
    await reporter.close(50)
    expect(() => reporter.capture(new Error('late'))).not.toThrow()
  })

  test('closing twice is harmless', async () => {
    const { reporter } = subjectFor(make)
    await reporter.close(50)
    expect(typeof (await reporter.close(50))).toBe('boolean')
  })
})

describe.each(ADAPTERS.filter(([name]) => name !== 'no-op'))(
  'what an ErrorReporter sends: %s adapter',
  (_name, make) => {
    test('an expected 4xx AppError is not sent', async () => {
      const subject = subjectFor(make)
      subject.reporter.capture(
        new AppError({ code: 'auth.token_expired', status: 401, message: 'expired' })
      )
      expect(await subject.sent()).toBe(0)
    })

    test.each([500, 503])('a %i AppError is sent', async (status) => {
      const subject = subjectFor(make)
      subject.reporter.capture(new AppError({ code: 'core.down', status, message: 'down' }))
      expect(await subject.sent()).toBe(1)
    })

    test('an unknown error is sent', async () => {
      const subject = subjectFor(make)
      subject.reporter.capture(new RangeError('boom'), { requestId: 'req_1', status: 500 })
      expect(await subject.sent()).toBe(1)
    })

    test('a thrown value that is not an Error is sent', async () => {
      const subject = subjectFor(make)
      subject.reporter.capture('just a string')
      expect(await subject.sent()).toBe(1)
    })
  }
)

describe('the no-op reporter', () => {
  test('sends nothing and is one shared instance', async () => {
    expect(createNoopErrorReporter()).toBe(createNoopErrorReporter())
    expect(await createNoopErrorReporter().flush(0)).toBe(true)
  })

  test('close resolves true, and flush after it is still true: there is nothing to deliver', async () => {
    expect(await createNoopErrorReporter().close(0)).toBe(true)
    expect(await createNoopErrorReporter().flush(0)).toBe(true)
  })
})
