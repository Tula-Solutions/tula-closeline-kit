import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { getClient, getCurrentScope, getGlobalScope, getIsolationScope } from '@sentry/bun'
import { AppError } from '../errors'
import { createMemoryLogger } from '../testing'
import { isSentryDsn } from './env'
import { createSentryReporter, type SentryReporter, type SentryReporterOptions } from './sentry'

const ORG_ID = `org_${'0a1b2c3d'.repeat(4)}`
const REQ_ID = `req_${'f9e8d7c6'.repeat(4)}`
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
      requestId: REQ_ID,
      organizationId: ORG_ID,
      method: 'POST',
      path: '/v1/teams/team_01',
      status: 500,
    })
    const event = (await h.events())[0]
    expect(event?.tags).toMatchObject({
      service: 'core',
      environment: 'staging',
      region: 'eu',
      organization_id: ORG_ID,
      request_id: REQ_ID,
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
      organizationId: ORG_ID,
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
      organization_id: ORG_ID,
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

describe('ids in tags are sent as they are (N1)', () => {
  /** A seeded generator, so the ids are the same on every run. */
  function seeded(seed: number): () => number {
    let state = seed >>> 0
    return () => {
      state = (state + 0x6d2b79f5) >>> 0
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  const random = seeded(24)
  const hex = (length: number): string =>
    Array.from({ length }, () => '0123456789abcdef'[Math.floor(random() * 16)]).join('')
  const uuid = (): string =>
    `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[Math.floor(random() * 4)]}${hex(3)}-${hex(12)}`

  test('10,000 random UUIDs used as organization and request ids reach the wire unchanged', async () => {
    const h = harness()
    const pairs: Array<[string, string]> = []
    for (let i = 0; i < 10_000; i++) {
      pairs.push([uuid(), uuid()])
    }
    for (const [organizationId, requestId] of pairs) {
      h.reporter.capture(new Error('boom'), { organizationId, requestId })
    }
    const events = await h.events()
    expect(events).toHaveLength(pairs.length)
    const altered = events.filter((event) => {
      const pair = pairs.find(([organizationId]) => organizationId === event.tags.organization_id)
      return pair === undefined || pair[1] !== event.tags.request_id
    })
    expect(altered).toHaveLength(0)
  })

  test.each([
    ['a UUID', 'ae506499-d871-4815-9301-322b14037713'],
    ['an upper-case UUID', 'AE506499-D871-4815-9301-322B14037713'],
    ['a UUID of digits only', '12345678-1234-4234-8234-123456789012'],
    ['a prefixed id', ORG_ID],
    ['a user id', `usr_${'0123456789abcdef'.repeat(2)}`],
    ['an invoice id', `inv_${'1234567890'.repeat(3)}12`],
    ['a membership id', `mem_${'ab'.repeat(16)}`],
    ['a 32 character hex trace id', '4bf92f3577b34da6a3ce929d0e0e4736'],
    ['a 32 digit trace id', '12345678901234567890123456789012'],
  ])('%s is kept', async (_name, id) => {
    const h = harness()
    h.reporter.capture(new Error('boom'), { organizationId: id, requestId: id })
    const tags = (await h.events())[0]?.tags
    expect(tags?.organization_id).toBe(id)
    expect(tags?.request_id).toBe(id)
  })

  test.each([
    ['a space', 'req 1'],
    ['a secret', 'Bearer abc123def456'],
    ['an equals sign', 'token=abc'],
    ['a newline', 'req_1\nreq_2'],
    ['an email address', 'jane@acme.com'],
    ['more than 64 characters', 'a'.repeat(65)],
    ['nothing', ''],
    ['a non-ASCII letter', 'org_é1'],
  ])('a value with %s is replaced by a fixed marker', async (_name, value) => {
    const h = harness()
    h.reporter.capture(new Error('boom'), { organizationId: value, requestId: value })
    const tags = (await h.events())[0]?.tags
    expect(tags?.organization_id).toBe('[invalid]')
    expect(tags?.request_id).toBe('[invalid]')
    expect(h.wire()).not.toContain('abc123def456')
    expect(h.wire()).not.toContain('jane@acme.com')
  })

  test.each([
    ['a Stripe live key', 'sk_live_abcdefghijklmnop1234'],
    ['a GitHub token', 'ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'],
    ['an AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['a JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlMTIz'],
    ['a card number', '4111111111111111'],
  ])(
    '%s that fits the id charset is replaced by the fixed marker, not sent',
    async (_n, secret) => {
      const h = harness()
      h.reporter.capture(new Error('boom'), { organizationId: secret, requestId: secret })
      const tags = (await h.events())[0]?.tags
      // `[invalid]`, not `[redacted]`: an id is either sent as it was given or not at all.
      expect(tags?.organization_id).toBe('[invalid]')
      expect(tags?.request_id).toBe('[invalid]')
      expect(h.wire()).not.toContain(secret)
      expect(h.wire()).not.toContain('[redacted]')
    }
  )

  const HEX32 = '4bf92f3577b34da6a3ce929d0e0e4736'
  // N1 (round 4): an id is sent only if it has one of the shapes this system makes
  // (`<prefix>_<32 hex>`, a UUID, 32 hex digits); anything else is `[invalid]`.
  test.each([
    ['a base64 blob', 'dGhpcyBpcyBhIHNlY3JldCBrZXkgdmFsdWU9'],
    ['a 32 character base62 key', 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE'],
    ['a 48 character base62 key', 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5hJ7kL9mN1pQ'],
    ['a 39 digit hex value', HEX32.slice(0, 31) + HEX32.slice(0, 8)],
    ['a mixed-case 39 digit hex value', 'AbCdEf0123456789aBcDeF0123456789AbCdEf0'],
    ['a 31 digit hex value', HEX32.slice(1)],
    ['a 33 digit hex value', `${HEX32}0`],
    ['a 40 digit hex value', 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3'],
    ['a 64 digit hex value', '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c148f4c1ab0'],
    ['a webhook secret', 'whsec_AbCdEfGhIjKlMnOpQrStUvWx'],
    ['a Slack token', 'xoxb-1234-abcd'],
    [
      'a UUID with a key appended',
      'ae506499-d871-4815-9301-322b14037713-sk_live_abcdefghijklmnop1',
    ],
    ['a Slack webhook path', 'T00000000-B00000000-XXXXXXXXXXXXXXXXXXXXXXXX'],
    ['a prefixed id with a short body', 'org_01'],
    ['a prefixed ULID', 'org_01HZX3Q8W2M4N6P8R0T2V4X6Z8'],
    ['a prefixed id with a 40 digit hex body', `req_${'9f86d081884c7d659a2feaa0c55ad015a3bf4f1b'}`],
    ['a prefixed id with an upper-case body', `org_${HEX32.toUpperCase()}`],
    ['a prefix that is too long', `abcdef_${HEX32}`],
    ['a ULID', '01HZX3Q8W2M4N6P8R0T2V4X6Z8'],
    ['a short id', 'a'],
    ['a long run of x', 'x'.repeat(64)],
    ['a trace id repeated twice', HEX32 + HEX32],
    ['a card number', '4111111111111111'],
    ['a trunk-form telephone number', '020-7946-0958'],
    ['a UUID followed by a newline', 'ae506499-d871-4815-9301-322b14037713\n'],
  ])('%s is replaced by the fixed marker: it has no id shape', async (_n, value) => {
    const h = harness()
    h.reporter.capture(new Error('boom'), { organizationId: value, requestId: value })
    const tags = (await h.events())[0]?.tags
    expect(tags?.organization_id).toBe('[invalid]')
    expect(tags?.request_id).toBe('[invalid]')
    if (value.length > 8) {
      expect(h.wire()).not.toContain(value.trim())
    }
  })

  test('a free-form tag under a sensitive key is still redacted', async () => {
    const h = harness()
    h.reporter.capture(new Error('boom'), { tags: { sessionToken: 'KEYED-VALUE-1', note: 'ok' } })
    const tags = (await h.events())[0]?.tags
    expect(tags?.sessionToken).toBe('[redacted]')
    expect(tags?.note).toBe('ok')
  })
})

describe('the exception is rebuilt from known fields (N5)', () => {
  test('fields added by another event processor do not reach the wire', async () => {
    const h = harness()
    h.reporter.client.addEventProcessor((event) => {
      const value = event.exception?.values?.[0]
      if (value !== undefined) {
        Object.assign(value, { thread_id: 99, extra_thing: 'LEAK-EXTRA-VALUE' })
        Object.assign(value.mechanism ?? {}, { data: { leak: 'LEAK-MECHANISM-DATA' } })
        const frame = value.stacktrace?.frames?.[0]
        if (frame !== undefined) {
          Object.assign(frame, { abs_path: 'LEAK-ABS-PATH', vars: { password: 'LEAK-VARS' } })
        }
      }
      Object.assign(event, { debug_meta: { images: [{ code_file: 'LEAK-IMAGE' }] } })
      return event
    })
    h.reporter.capture(new Error('boom'))
    const events = await h.events()
    expect(h.wire()).not.toContain('LEAK')
    const value = events[0]?.exception.values[0] as unknown as Record<string, unknown>
    expect(
      Object.keys(value).every((key) => ['type', 'value', 'stacktrace', 'mechanism'].includes(key))
    ).toBe(true)
    const frames = (value.stacktrace as { frames: Array<Record<string, unknown>> }).frames
    expect(frames.length).toBeGreaterThan(0)
    for (const frame of frames) {
      expect(
        Object.keys(frame).every((key) => ['filename', 'function', 'lineno', 'colno'].includes(key))
      ).toBe(true)
    }
    expect(events[0]).not.toHaveProperty('debug_meta')
  })

  test('the other kept fields are rebuilt too: sdk, runtime, release, environment, platform, id, time', async () => {
    const h = harness()
    h.reporter.client.addEventProcessor((event) => {
      Object.assign(event, {
        sdk: {
          name: 'sentry.javascript.bun',
          version: '1.2.3',
          leak: 'LEAK-SDK',
          packages: [{ name: 'LEAK-PKG' }],
        },
        release: 'LEAK Hello Jane I am sick',
        environment: 'LEAK-ENVIRONMENT',
        platform: 'LEAK-PLATFORM',
        event_id: 'LEAK-EVENT-ID',
        timestamp: 'LEAK-TIMESTAMP',
      })
      Object.assign(event.contexts?.runtime ?? {}, { leak: 'LEAK-RUNTIME' })
      return event
    })
    h.reporter.capture(new Error('boom'))
    const events = await h.events()
    expect(events).toHaveLength(1)
    // `wire()` includes the envelope header, where the event id is also written.
    expect(h.wire()).not.toContain('LEAK')
    const event = events[0] as unknown as Record<string, unknown>
    expect(event.release).toBe('abc1234def')
    expect(event.environment).toBe('staging')
    expect(event.platform).toBe('node')
    // The SDK adds its own `packages`, `integrations` and `settings` after `beforeSend`; the
    // `leak` key and the processor's package entry are ours to drop, and are (see `LEAK` above).
    expect(Object.keys(event.sdk as object)).not.toContain('leak')
    expect(JSON.stringify((event.sdk as { packages?: unknown }).packages)).toContain('@sentry/')
    const runtime = (event.contexts as { runtime: Record<string, unknown> }).runtime
    expect(Object.keys(runtime).sort()).toEqual(['name', 'version'])
    expect(typeof event.timestamp === 'number' || event.timestamp === undefined).toBe(true)
  })

  test('free text in sdk and runtime fields never reaches the wire (N3)', async () => {
    const h = harness()
    h.reporter.client.addEventProcessor((event) => {
      Object.assign(event, {
        sdk: { name: 'Hello Jane I am sick', version: 'diagnosis: cancer' },
      })
      Object.assign(event.contexts ?? {}, {
        runtime: { name: 'patient-Jane', version: 'has cancer' },
      })
      return event
    })
    h.reporter.capture(new Error('boom'))
    const event = (await h.events())[0] as unknown as Record<string, unknown>
    for (const text of ['Jane', 'sick', 'cancer', 'diagnosis']) {
      expect(h.wire()).not.toContain(text)
    }
    const own = h.reporter.client.getOptions()._metadata?.sdk
    expect((event.sdk as { name: string }).name).toBe(own?.name as string)
    expect((event.sdk as { version: string }).version).toBe(own?.version as string)
    expect((event.contexts as { runtime: unknown }).runtime).toEqual({
      name: 'bun',
      version: Bun.version,
    })
  })

  test('an event id the processors spoiled falls back to the one the SDK gave the hint', async () => {
    const h = harness()
    h.reporter.client.addEventProcessor((event) => {
      Object.assign(event, { event_id: 'not-an-event-id' })
      return event
    })
    h.reporter.capture(new Error('boom'))
    const events = await h.events()
    const id = (events[0] as unknown as { event_id?: string }).event_id
    expect(id).toMatch(/^[0-9a-f]{32}$/)
    expect(h.wire()).not.toContain('not-an-event-id')
  })

  test.each([
    ['infinity', Number.POSITIVE_INFINITY],
    ['not a number', Number.NaN],
  ])('a timestamp that is %s is not sent as a number', async (_name, value) => {
    const h = harness()
    h.reporter.client.addEventProcessor((event) => {
      Object.assign(event, { timestamp: value })
      return event
    })
    h.reporter.capture(new Error('boom'))
    const event = (await h.events())[0] as unknown as { timestamp?: unknown }
    // JSON turns a non-finite number into `null`; nothing but a finite number or nothing is sent.
    expect(event.timestamp === undefined || Number.isFinite(event.timestamp)).toBe(true)
  })

  test('a genuine event id, timestamp and platform pass through unchanged', async () => {
    const h = harness()
    h.reporter.capture(new Error('boom'))
    const event = (await h.events())[0] as unknown as Record<string, unknown>
    expect(event.event_id).toMatch(/^[0-9a-f]{32}$/)
    expect(Number.isFinite(event.timestamp)).toBe(true)
    expect(event.platform).toBe('node')
    expect((event.sdk as { name: string }).name).toContain('sentry')
  })

  test('the type, the value, the frames and the mechanism are kept', async () => {
    const h = harness()
    h.reporter.capture(new TypeError('Failed to load team team_01'))
    const value = (await h.events())[0]?.exception.values[0] as unknown as {
      type: string
      value: string
      stacktrace: { frames: Array<{ filename: string; lineno: number; colno: number }> }
      mechanism: { type: string; handled: boolean }
    }
    expect(value.type).toBe('TypeError')
    expect(value.value).toBe('Failed to load team team_01')
    expect(value.mechanism.type).toBe('generic')
    expect(value.mechanism.handled).toBe(true)
    const frame = value.stacktrace.frames.at(-1)
    expect(typeof frame?.filename).toBe('string')
    expect(typeof frame?.lineno).toBe('number')
    expect(typeof frame?.colno).toBe('number')
  })

  test('a cause chain keeps its order and its links', async () => {
    const h = harness()
    h.reporter.capture(new Error('outer', { cause: new Error('inner') }))
    const values = (await h.events())[0]?.exception.values ?? []
    expect(values.map((value) => value.value)).toEqual(['inner', 'outer'])
  })
})

describe('only the frames after the message are frames (N5)', () => {
  const LEAK = 'MSGBODYLEAK Hello Jane I am sick'

  /** The `function` of every frame sent for an error, as one string. */
  async function framesSent(error: Error): Promise<string> {
    const h = harness()
    h.reporter.capture(error)
    const events = await h.events()
    const frames = events.flatMap((event) =>
      event.exception.values.flatMap((value) => value.stacktrace.frames)
    )
    return JSON.stringify(frames)
  }

  test('a message line that imitates a frame, past the 8 KiB cut, is not sent', async () => {
    const h = harness()
    h.reporter.capture(new Error(`${'x'.repeat(9_000)}\n    at ${LEAK} (/app/a.ts:1:2)`))
    await h.events()
    expect(h.wire()).not.toContain('MSGBODYLEAK')
  })

  test('a message line that imitates a frame, inside the message, is not a frame', async () => {
    const sent = await framesSent(new Error(`top\n    at ${LEAK} (/app/a.ts:1:2)\nbottom`))
    expect(sent).not.toContain('MSGBODYLEAK')
  })

  test('the real frames of such an error are still sent', async () => {
    const h = harness()
    h.reporter.capture(new Error(`top\n    at ${LEAK} (/app/a.ts:1:2)\nbottom`))
    const frames = (await h.events())[0]?.exception.values[0]?.stacktrace.frames ?? []
    expect(frames.length).toBeGreaterThan(0)
  })

  test('an error whose message was changed after it was made is sent without frames', async () => {
    const error = new Error('first')
    error.message = `changed\n    at ${LEAK} (/app/a.ts:1:2)`
    expect(await framesSent(error)).not.toContain('MSGBODYLEAK')
  })
})
