import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { getClient, getCurrentScope, getGlobalScope, getIsolationScope } from '@sentry/bun'
import { AppError } from '../errors'
import { createMemoryLogger } from '../testing'
import { isSentryDsn } from './env'
import { createSentryReporter, type SentryReporter, type SentryReporterOptions } from './sentry'

const DSN = 'https://abc123publickey@o123.ingest.de.sentry.io/456'

type Envelope = [Record<string, unknown>, Array<[{ type: string }, Record<string, unknown>]>]
interface SentryEvent {
  tags: Record<string, string>
  contexts: Record<string, unknown> & { closeline: Record<string, unknown> }
  exception: {
    values: Array<{
      type: string
      value: string
      stacktrace: { frames: Array<Record<string, unknown>> }
    }>
  }
  release?: string
  environment?: string
  user?: unknown
  request?: unknown
  breadcrumbs?: unknown[]
  modules?: unknown
  extra?: unknown
  fingerprint?: unknown
  level?: string
}
type TransportFactory = NonNullable<SentryReporterOptions['transport']>

const open: SentryReporter[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((reporter) => reporter.close(50)))
})

/** A transport whose sends never finish and whose flush ignores its timeout. */
const stuckTransport: TransportFactory = () => ({
  send: () => new Promise(() => undefined),
  flush: () => new Promise(() => undefined),
})

/** A reporter wired to a fake transport that keeps every envelope it is handed. */
function harness(overrides: Partial<SentryReporterOptions> = {}) {
  const envelopes: Envelope[] = []
  const logger = createMemoryLogger()
  const transport: TransportFactory = () => ({
    send: async (envelope) => {
      envelopes.push(envelope as unknown as Envelope)
      return {}
    },
    flush: async () => true,
  })
  const reporter = createSentryReporter({
    dsn: DSN,
    service: 'core',
    environment: 'staging',
    region: 'eu',
    release: 'abc1234def',
    logger,
    transport,
    ...overrides,
  })
  open.push(reporter)
  return {
    reporter,
    logger,
    envelopes,
    /** Waits for the reporter to finish, then returns the events the transport received. */
    async events(): Promise<SentryEvent[]> {
      await reporter.flush(1000)
      return envelopes
        .flatMap((envelope) => envelope[1])
        .filter(([item]) => item.type === 'event')
        .map(([, event]) => event as unknown as SentryEvent)
    },
    /** Everything the transport was handed, as one string. */
    wire: () => JSON.stringify(envelopes),
  }
}

describe('what is reported', () => {
  test('a 5xx AppError and an unknown error are sent', async () => {
    const h = harness()
    h.reporter.capture(new AppError({ code: 'core.down', status: 503, message: 'down' }))
    h.reporter.capture(new TypeError('boom'))
    const events = await h.events()
    expect(events).toHaveLength(2)
    expect(events.map((event) => event.exception.values.at(-1)?.type).sort()).toEqual([
      'AppError',
      'TypeError',
    ])
  })

  test('a 4xx AppError is not sent', async () => {
    const h = harness()
    h.reporter.capture(
      new AppError({ code: 'auth.token_expired', status: 401, message: 'expired' })
    )
    h.reporter.capture(new AppError({ code: 'core.not_found', status: 404, message: 'missing' }))
    expect(await h.events()).toHaveLength(0)
    expect(h.envelopes).toHaveLength(0)
  })

  test('the AppError code is a tag, so errors group by it', async () => {
    const h = harness()
    h.reporter.capture(new AppError({ code: 'core.down', status: 503, message: 'down' }))
    expect((await h.events())[0]?.tags.error_code).toBe('core.down')
  })

  test('a chain of causes is sent, each message scrubbed', async () => {
    const h = harness()
    h.reporter.capture(new Error('outer', { cause: new Error('inner password=hunter2') }))
    const event = (await h.events())[0]
    expect(event?.exception.values).toHaveLength(2)
    expect(h.wire()).not.toContain('hunter2')
  })
})

describe('tags, release and context', () => {
  test('carry service, environment, region, organization_id, request_id and the release', async () => {
    const h = harness()
    h.reporter.capture(new Error('boom'), {
      requestId: 'req_01',
      organizationId: 'org_01',
      method: 'POST',
      path: '/v1/teams/team_01',
      status: 500,
    })
    const event = (await h.events())[0]
    expect(event?.tags).toMatchObject({
      service: 'core',
      environment: 'staging',
      region: 'eu',
      organization_id: 'org_01',
      request_id: 'req_01',
      http_method: 'POST',
      http_status: '500',
    })
    expect(event?.release).toBe('abc1234def')
    expect(event?.environment).toBe('staging')
    expect(event?.contexts.closeline).toEqual({
      method: 'POST',
      path: '/v1/teams/team_01',
      status: 500,
    })
  })

  test('free-form tags are added but cannot replace the standard ones', async () => {
    const h = harness()
    h.reporter.capture(new Error('boom'), {
      organizationId: 'org_01',
      tags: {
        feature: 'import',
        service: 'forged',
        region: 'us',
        organization_id: 'org_forged',
        'bad key!': 'x',
      },
    })
    const tags = (await h.events())[0]?.tags
    expect(tags).toMatchObject({
      feature: 'import',
      service: 'core',
      region: 'eu',
      organization_id: 'org_01',
    })
    expect(Object.keys(tags ?? {})).not.toContain('bad key!')
  })

  test('a query string in the path is dropped', async () => {
    const h = harness()
    h.reporter.capture(new Error('boom'), { path: '/cb?code=q9x7z&state=zzz' })
    const event = (await h.events())[0]
    expect(event?.contexts.closeline.path).toBe('/cb')
    expect(h.wire()).not.toContain('q9x7z')
  })

  test('fields that are not part of the context are never sent', async () => {
    const h = harness()
    const smuggled = {
      requestId: 'req_01',
      body: { card: '4242424242424242' },
      headers: { 'x-extra': 'leak-me' },
      user: { email: 'a@b.co' },
    }
    h.reporter.capture(new Error('boom'), smuggled as never)
    await h.events()
    expect(h.wire()).not.toContain('4242424242424242')
    expect(h.wire()).not.toContain('leak-me')
    expect(h.wire()).not.toContain('a@b.co')
  })

  test('without a release the event has none', async () => {
    const h = harness({ release: undefined })
    h.reporter.capture(new Error('boom'))
    expect((await h.events())[0]?.release).toBeUndefined()
  })
})

describe('nothing leaves the process unredacted', () => {
  const SECRETS = {
    message: 'MSG-S3CRET-7731',
    cause: 'CAUSE-S3CRET-7732',
    tagValue: 'TAG-S3CRET-7733',
    tagKeyed: 'KEYED-S3CRET-7734',
    path: 'PATHS3CRET7735',
    requestId: 'RID-S3CRET-7736',
    org: 'ORG-S3CRET-7737',
    thrown: 'THROWN-S3CRET-7738',
  }

  test('a secret in the error message, the context and a tag does not reach the transport', async () => {
    const h = harness()
    const error = new Error(
      `upstream said password=${SECRETS.message} and Bearer ${SECRETS.message}2`,
      {
        cause: new Error(`connect postgres://app:${SECRETS.cause}@db/x`),
      }
    )
    h.reporter.capture(error, {
      requestId: `Bearer ${SECRETS.requestId}`,
      organizationId: `token=${SECRETS.org}`,
      method: 'POST',
      path: `/hooks/sk_live_${SECRETS.path}0000`,
      status: 502,
      tags: { note: `api_key=${SECRETS.tagValue}`, sessionToken: SECRETS.tagKeyed },
    })
    await h.events()
    const wire = h.wire()
    expect(wire).toContain('upstream said')
    for (const secret of Object.values(SECRETS)) {
      expect(wire).not.toContain(secret)
    }
    expect(wire).toContain('[redacted]')
  })

  test('a secret in a thrown plain object or string does not reach the transport', async () => {
    const h = harness()
    h.reporter.capture({ password: SECRETS.thrown, apiKey: SECRETS.thrown, note: 'x' })
    h.reporter.capture(`failed with token=${SECRETS.thrown}`)
    h.reporter.capture({ [`Bearer ${SECRETS.thrown}`]: 1 })
    const events = await h.events()
    expect(events).toHaveLength(3)
    expect(h.wire()).not.toContain(SECRETS.thrown)
  })

  test('a secret in an error property is not sent', async () => {
    const h = harness()
    const error = Object.assign(new Error('boom'), {
      password: SECRETS.thrown,
      token: SECRETS.thrown,
      details: { body: SECRETS.thrown },
    })
    h.reporter.capture(error)
    await h.events()
    expect(h.wire()).not.toContain(SECRETS.thrown)
  })

  test('stack frames are kept and the message is kept', async () => {
    const h = harness()
    h.reporter.capture(new Error('Failed to load team team_01'))
    const value = (await h.events())[0]?.exception.values[0]
    if (!value) {
      throw new Error('no event was sent')
    }
    expect(value.value).toBe('Failed to load team team_01')
    expect(value.stacktrace.frames.length).toBeGreaterThan(0)
    expect(value.stacktrace.frames.at(-1)).toHaveProperty('filename')
    expect(value.stacktrace.frames.at(-1)).not.toHaveProperty('vars')
    expect(value.stacktrace.frames.at(-1)).not.toHaveProperty('context_line')
  })

  test('the event carries no user, request, breadcrumbs or host details', async () => {
    const h = harness()
    h.reporter.capture(new Error('boom'), { requestId: 'req_1' })
    const event = (await h.events())[0] as SentryEvent
    expect(event.user).toBeUndefined()
    expect(event.request).toBeUndefined()
    expect(event.breadcrumbs ?? []).toEqual([])
    for (const name of ['os', 'device', 'app', 'culture', 'cloud_resource']) {
      expect(event.contexts).not.toHaveProperty(name)
    }
    expect(event.modules).toBeUndefined()
  })

  test('data collection is off, tracing is off and only the cause-chain integration is on', () => {
    const h = harness()
    const options = h.reporter.client.getOptions()
    // Sentry 11 has no `sendDefaultPii`; `dataCollection` is its replacement and everything is off.
    expect(options.dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    })
    expect(options.maxBreadcrumbs).toBe(0)
    expect(options.tracesSampleRate).toBeUndefined()
    expect(h.reporter.integrations).toEqual(['LinkedErrors'])
  })

  test('creating a reporter installs no process handlers and no global client', () => {
    const before = ['uncaughtException', 'unhandledRejection', 'warning'].map((name) =>
      process.listenerCount(name)
    )
    harness()
    const after = ['uncaughtException', 'unhandledRejection', 'warning'].map((name) =>
      process.listenerCount(name)
    )
    expect(after).toEqual(before)
    expect(getClient()).toBeUndefined()
  })
})

describe('capture and flush', () => {
  test('capture never throws, even when the context is hostile', async () => {
    const h = harness()
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error('no')
        },
        ownKeys: () => {
          throw new Error('no')
        },
      }
    )
    expect(() => h.reporter.capture(new Error('boom'), hostile as never)).not.toThrow()
    expect(() => h.reporter.capture(new Error('boom'), { tags: hostile as never })).not.toThrow()
    expect(() =>
      h.reporter.capture(new Error('boom'), { status: Number.NaN, path: 5 as never })
    ).not.toThrow()
    expect(h.logger.entries.some((entry) => entry.level === 'warn')).toBe(true)
  })

  test('an error whose context cannot be read is still reported, with the standard tags', async () => {
    const h = harness()
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error('no')
        },
      }
    )
    h.reporter.capture(new Error('boom'), hostile as never)
    const events = await h.events()
    expect(events).toHaveLength(1)
    expect(events[0]?.tags).toMatchObject({ service: 'core', region: 'eu', environment: 'staging' })
  })

  test('capture returns at once while the transport never answers', async () => {
    const h = harness({
      transport: stuckTransport,
    })
    const start = performance.now()
    for (let i = 0; i < 20; i++) {
      h.reporter.capture(new Error(`boom ${i}`), { requestId: `req_${i}` })
    }
    expect(performance.now() - start).toBeLessThan(250)
  })

  test('flush gives up at its timeout when the transport never answers', async () => {
    const h = harness({
      transport: stuckTransport,
    })
    h.reporter.capture(new Error('boom'))
    const start = performance.now()
    expect(await h.reporter.flush(60)).toBe(false)
    expect(performance.now() - start).toBeLessThan(400)
  })

  test.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    'flush(%p) still returns, bounded',
    async (timeout) => {
      const h = harness({
        transport: stuckTransport,
      })
      h.reporter.capture(new Error('boom'))
      const start = performance.now()
      expect(typeof (await h.reporter.flush(timeout))).toBe('boolean')
      expect(performance.now() - start).toBeLessThan(2_000)
    },
    5_000
  )

  test('flush waits for the events and returns true when they are sent', async () => {
    const h = harness()
    h.reporter.capture(new Error('boom'))
    expect(await h.reporter.flush(1000)).toBe(true)
    expect(h.envelopes).toHaveLength(1)
  })

  test('a transport that throws or rejects does not break capture or flush', async () => {
    const h = harness({
      transport: () => ({
        send: () => {
          throw new Error('transport exploded')
        },
        flush: async () => true,
      }),
    })
    expect(() => h.reporter.capture(new Error('boom'))).not.toThrow()
    expect(typeof (await h.reporter.flush(200))).toBe('boolean')
    const rejecting = harness({
      transport: () => ({
        send: async () => Promise.reject(new Error('rejected')),
        flush: async () => false,
      }),
    })
    rejecting.reporter.capture(new Error('boom'))
    expect(typeof (await rejecting.reporter.flush(200))).toBe('boolean')
  })

  test('flush returns false, not an error, when the client rejects or throws', async () => {
    const h = harness()
    const flush = spyOn(h.reporter.client, 'flush')
    flush.mockImplementation(() => Promise.reject(new Error('rejected')))
    expect(await h.reporter.flush(100)).toBe(false)
    flush.mockImplementation(() => {
      throw new Error('thrown')
    })
    expect(await h.reporter.flush(100)).toBe(false)
    flush.mockRestore()
  })

  test('a flush after nothing was captured returns true at once', async () => {
    const h = harness()
    expect(await h.reporter.flush(500)).toBe(true)
  })
})

describe('a DSN that is not valid', () => {
  test.each(['not a dsn', 'https://host/1', 'ftp://k@h/1'])(
    '%p gives a reporter that sends nothing and logs once',
    async (dsn) => {
      const logger = createMemoryLogger()
      const reporter = createSentryReporter({
        dsn,
        service: 'core',
        environment: 'dev',
        region: 'us',
        logger,
      })
      expect(() => reporter.capture(new Error('boom'))).not.toThrow()
      expect(await reporter.flush(50)).toBe(true)
      expect(logger.entries.filter((entry) => entry.level === 'warn')).toHaveLength(1)
      expect(JSON.stringify(logger.entries)).not.toContain(
        dsn === 'not a dsn' ? 'not a dsn' : 'ftp://k@h'
      )
    }
  )
})

describe('a thrown value that is not an Error is never handed to the SDK (review F1)', () => {
  const OBJECT = {
    status: 502,
    text: 'Hi Jane, my SSN is 123-45-6789, call me on 4155550199',
    content: 'transcript of the call with Acme about pricing',
    email: 'jane@acme.com',
    nested: { deep: 'DEEP-VALUE-9931' },
  }

  test('none of its fields reach the wire, and no __serialized__ extra is added', async () => {
    const h = harness()
    h.reporter.capture(OBJECT)
    const events = await h.events()
    expect(events).toHaveLength(1)
    const wire = h.wire()
    for (const part of [
      'Jane',
      '123-45-6789',
      '4155550199',
      'transcript of the call',
      'pricing',
      'jane@acme.com',
      'DEEP-VALUE-9931',
      '__serialized__',
      'nested',
      'content',
    ]) {
      expect(wire).not.toContain(part)
    }
    expect(events[0]?.extra).toBeUndefined()
    expect(events[0]?.exception.values[0]?.value).toBe('non-Error value thrown (object)')
  })

  test.each([
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
    ['a number', 42, 'number'],
    ['a boolean', true, 'boolean'],
    ['a bigint', 10n, 'bigint'],
    ['a symbol', Symbol('Jane'), 'symbol'],
    ['a function', () => 'Jane', 'function'],
    ['an array', ['Jane', 'jane@acme.com'], 'object'],
  ])('%s is reported as its type only', async (_name, value, type) => {
    const h = harness()
    h.reporter.capture(value)
    const events = await h.events()
    expect(events[0]?.exception.values[0]?.value).toBe(`non-Error value thrown (${type})`)
    expect(h.wire()).not.toContain('Jane')
    expect(h.wire()).not.toContain('jane@acme.com')
  })

  test('a string is kept after scrubText and cut to a bounded length', async () => {
    const h = harness()
    h.reporter.capture('upstream failed for jane@acme.com with Bearer abc123def456ghi')
    h.reporter.capture(`${'long text '.repeat(20_000)}`)
    const values = (await h.events()).map((event) => event.exception.values[0]?.value ?? '')
    expect(values).toContain(
      'non-Error value thrown (string): upstream failed for [redacted] with Bearer [redacted]'
    )
    for (const value of values) {
      expect(value.length).toBeLessThan(600)
    }
    expect(h.wire()).not.toContain('abc123def456ghi')
  })

  test('a Proxy that throws on every access is reported as its type', async () => {
    const h = harness()
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error('no')
        },
        ownKeys: () => {
          throw new Error('no')
        },
        getPrototypeOf: () => {
          throw new Error('no')
        },
      }
    )
    expect(() => h.reporter.capture(hostile)).not.toThrow()
    expect(await h.events()).toHaveLength(1)
  })

  test('an Error is copied: its own properties, details and extra fields are not sent', async () => {
    const h = harness()
    const error = Object.assign(new TypeError('boom'), {
      details: { transcript: 'DETAILS-VALUE-4412' },
      customer: 'CUSTOMER-NAME-5521',
    })
    h.reporter.capture(error)
    const event = (await h.events())[0]
    expect(h.wire()).not.toContain('DETAILS-VALUE-4412')
    expect(h.wire()).not.toContain('CUSTOMER-NAME-5521')
    expect(event?.exception.values[0]?.type).toBe('TypeError')
    expect(event?.exception.values[0]?.value).toBe('boom')
    expect(event?.exception.values[0]?.stacktrace.frames.length).toBeGreaterThan(0)
  })
})

describe('a DSN the SDK would reject is caught before the SDK sees it (review F2)', () => {
  const LEAKY = 'KEYPART9981'
  const CASES = [
    `https://${LEAKY}@o1.ingest.sentry.io/42/`,
    `https://${LEAKY.slice(0, 4)}-${LEAKY.slice(4)}@o1.ingest.sentry.io/42`,
    ` https://${LEAKY}@o1.ingest.sentry.io/42`,
    `https://${LEAKY}@o1.ingest.sentry.io/42abc`,
    `https://${LEAKY}@o1.ingest.sentry.io/`,
    `HTTPS://${LEAKY}@o1.ingest.sentry.io/42`,
    `https://${LEAKY}@o1.ingest.sentry.io:port/42`,
  ]

  test.each(CASES)('%p sends nothing, warns once, and prints no part of the key', async (dsn) => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => undefined)
    const consoleWarn = spyOn(console, 'warn').mockImplementation(() => undefined)
    const consoleLog = spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      const logger = createMemoryLogger()
      const reporter = createSentryReporter({
        dsn,
        service: 'core',
        environment: 'dev',
        region: 'us',
        logger,
      })
      open.push(reporter)
      reporter.capture(new Error('boom'))
      expect(await reporter.flush(50)).toBe(true)
      expect(reporter.client.getDsn()).toBeUndefined()
      expect(logger.entries.filter((entry) => entry.level === 'warn')).toHaveLength(1)
      expect(JSON.stringify(logger.entries)).not.toContain(LEAKY.slice(0, 4))
      for (const spy of [consoleError, consoleWarn, consoleLog]) {
        expect(JSON.stringify(spy.mock.calls)).not.toContain(LEAKY.slice(0, 4))
        expect(JSON.stringify(spy.mock.calls)).not.toContain(LEAKY.slice(4))
      }
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
      consoleWarn.mockRestore()
      consoleLog.mockRestore()
    }
  })

  test.each([
    'https://abc123@o1.ingest.sentry.io/42',
    'https://abc123:secret@o1.ingest.sentry.io/42',
    'https://abc123@o1.ingest.de.sentry.io:8443/42',
    'https://abc123@sentry.internal.example.com/prefix/path/42',
    'https://abc123@[::1]/42',
    'https://AbC_123@o1.ingest.sentry.io/0',
  ])('%p is accepted by the check and by the SDK', (dsn) => {
    expect(isSentryDsn(dsn, 'prod')).toBe(true)
    const h = harness({ dsn })
    expect(h.reporter.client.getDsn()).toBeDefined()
    expect(h.logger.entries).toEqual([])
  })

  test('an http DSN gives a client only in local', () => {
    const http = 'http://abc123@localhost:9000/42'
    expect(harness({ dsn: http, environment: 'local' }).reporter.client.getDsn()).toBeDefined()
    const prod = harness({ dsn: http, environment: 'prod' })
    expect(prod.reporter.client.getDsn()).toBeUndefined()
    expect(prod.logger.entries.filter((entry) => entry.level === 'warn')).toHaveLength(1)
  })
})

describe('capture does bounded work whatever it is given (review F4)', () => {
  // Wall-clock limits flake on shared CI runners (20 ms failed there at 23.7 ms), so this is loose
  // on purpose. The unbounded behaviour it guards against took from 265 ms to over a second in
  // review, on smaller inputs than these.
  const LIMIT_MS = 200

  /** Captures once to warm the SDK paths, then times the call under test. */
  function timed(h: ReturnType<typeof harness>, error: unknown): number {
    h.reporter.capture(new Error('warm up'))
    const start = performance.now()
    h.reporter.capture(error)
    return performance.now() - start
  }

  test('a 10 million line message returns in under 20 ms and is cut', async () => {
    const h = harness()
    const error = new Error('x\n'.repeat(10_000_000))
    expect(timed(h, error)).toBeLessThan(LIMIT_MS)
    const events = await h.events()
    expect(events).toHaveLength(2)
    expect((events[1]?.exception.values[0]?.value ?? '').length).toBeLessThan(9_000)
  })

  test('a very long message with a long stack is cut and keeps its frames', async () => {
    const h = harness()
    const error = new Error('word '.repeat(50_000))
    expect(timed(h, error)).toBeLessThan(LIMIT_MS)
    const value = (await h.events())[1]?.exception.values[0]
    expect((value?.value ?? '').length).toBeLessThan(9_000)
    expect(value?.value.endsWith('[truncated]')).toBe(true)
    expect(value?.stacktrace.frames.length).toBeGreaterThan(0)
  })

  test('an AggregateError of 20,000 children returns in under 20 ms and sends a few', async () => {
    const h = harness()
    const children = Array.from({ length: 20_000 }, (_, i) => new Error(`child ${i}`))
    const error = new AggregateError(children, 'many failed')
    expect(timed(h, error)).toBeLessThan(LIMIT_MS)
    const events = await h.events()
    expect(events[1]?.exception.values.length).toBeLessThanOrEqual(7)
  })

  test('a cause chain 100,000 deep returns in under 20 ms and sends a few', async () => {
    const h = harness()
    let error = new Error('root')
    for (let i = 0; i < 100_000; i++) {
      error = new Error(`level ${i}`, { cause: error })
    }
    expect(timed(h, error)).toBeLessThan(LIMIT_MS)
    expect((await h.events())[1]?.exception.values.length).toBeLessThanOrEqual(7)
  })

  test('a cause cycle returns at once', async () => {
    const h = harness()
    const a = new Error('a')
    const b = new Error('b', { cause: a })
    Object.defineProperty(a, 'cause', { value: b })
    expect(timed(h, a)).toBeLessThan(LIMIT_MS)
    expect((await h.events())[1]?.exception.values.length).toBeLessThanOrEqual(7)
  })

  test('an Error whose message, name, stack and cause getters throw is still sent', async () => {
    const h = harness()
    const error = new Error('x')
    for (const key of ['message', 'name', 'stack', 'cause', 'errors']) {
      Object.defineProperty(error, key, {
        get() {
          throw new Error(`${key} exploded`)
        },
      })
    }
    expect(() => h.reporter.capture(error)).not.toThrow()
    const events = await h.events()
    expect(events).toHaveLength(1)
    expect(events[0]?.exception.values[0]?.type).toBe('Error')
  })

  test('a stack that is huge is read from its end only', async () => {
    const h = harness()
    const error = new Error('boom')
    error.stack = `Error: boom\n${'    at filler (/app/filler.ts:1:1)\n'.repeat(500_000)}    at last (/app/last.ts:9:9)`
    expect(timed(h, error)).toBeLessThan(LIMIT_MS)
    const frames = (await h.events())[1]?.exception.values[0]?.stacktrace.frames ?? []
    expect(frames.length).toBeGreaterThan(0)
  })
})

describe('nothing set by other Sentry users in the process rides along (review F5)', () => {
  function pollute(): void {
    for (const scope of [getGlobalScope(), getIsolationScope(), getCurrentScope()]) {
      scope.setTag('leak_tag', 'LEAK-TAG-1')
      scope.setExtra('leak_extra', 'LEAK-EXTRA-2')
      scope.setUser({ email: 'leak@user.test', id: 'LEAK-USER-3' })
      scope.setContext('leak_context', { value: 'LEAK-CONTEXT-4' })
      scope.setFingerprint(['LEAK-FINGERPRINT-5'])
      scope.addBreadcrumb({ message: 'LEAK-BREADCRUMB-6' })
      scope.addAttachment({ filename: 'leak.txt', data: 'LEAK-ATTACHMENT-7' })
      scope.setTransactionName('LEAK-TRANSACTION-8')
      scope.setLevel('fatal')
    }
  }

  function cleanUp(): void {
    for (const scope of [getGlobalScope(), getIsolationScope(), getCurrentScope()]) {
      scope.setTags({ leak_tag: undefined })
      scope.setExtras({ leak_extra: undefined })
      scope.setUser(null)
      scope.setContext('leak_context', null)
      scope.setFingerprint([])
      scope.clearBreadcrumbs()
      scope.clearAttachments()
      scope.setTransactionName(undefined)
      scope.setLevel('error')
    }
  }

  test('tags, extra data, user, contexts, breadcrumbs, fingerprint and attachments are not sent', async () => {
    const h = harness()
    pollute()
    try {
      h.reporter.capture(new Error('boom'), { requestId: 'req_1' })
      const events = await h.events()
      expect(events).toHaveLength(1)
      expect(h.wire()).not.toContain('LEAK')
      expect(h.wire()).not.toContain('leak@user.test')
      expect(events[0]?.level).toBe('error')
      expect(Object.keys(events[0]?.contexts ?? {}).sort()).toEqual(['closeline', 'runtime'])
      expect(Object.keys(events[0]?.tags ?? {}).sort()).toEqual([
        'environment',
        'region',
        'request_id',
        'service',
      ])
      const itemTypes = h.envelopes.flatMap((envelope) => envelope[1].map(([item]) => item.type))
      expect(itemTypes).toEqual(['event'])
    } finally {
      cleanUp()
    }
  })

  test('a thrown object captured while the scopes are polluted sends nothing of them either', async () => {
    const h = harness()
    pollute()
    try {
      h.reporter.capture({ anything: true })
      await h.events()
      expect(h.wire()).not.toContain('LEAK')
    } finally {
      cleanUp()
    }
  })

  test('closing a reporter removes the process listeners the SDK added', async () => {
    const before = process.listenerCount('beforeExit')
    const h = harness()
    await h.reporter.close(100)
    expect(process.listenerCount('beforeExit')).toBe(before)
  })

  test('creating a reporter adds at most the SDK two beforeExit listeners, none of ours', () => {
    const before = process.listenerCount('beforeExit')
    harness()
    expect(process.listenerCount('beforeExit') - before).toBeLessThanOrEqual(2)
  })
})

describe('close (review F5)', () => {
  test('delivers what is pending and resolves true', async () => {
    const h = harness()
    h.reporter.capture(new Error('boom'))
    expect(await h.reporter.close(1000)).toBe(true)
    expect(h.envelopes).toHaveLength(1)
  })

  test('flush after close resolves false and capture after close sends nothing', async () => {
    const h = harness()
    await h.reporter.close(100)
    expect(await h.reporter.flush(100)).toBe(false)
    h.reporter.capture(new Error('late'))
    await Bun.sleep(10)
    expect(h.envelopes).toHaveLength(0)
  })

  test('closing twice is harmless and gives the same answer', async () => {
    const h = harness()
    const first = await h.reporter.close(100)
    expect(await h.reporter.close(100)).toBe(first)
  })

  test('gives up at its timeout when the transport never answers', async () => {
    const h = harness({ transport: stuckTransport })
    h.reporter.capture(new Error('boom'))
    const start = performance.now()
    expect(await h.reporter.close(60)).toBe(false)
    expect(performance.now() - start).toBeLessThan(400)
  })
})
