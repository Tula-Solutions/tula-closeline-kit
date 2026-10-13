import { describe, expect, spyOn, test } from 'bun:test'
import { NodeClient } from '@sentry/bun'
import { createMemoryLogger } from '../testing'
import { createErrorReporter } from './create'
import { createNoopErrorReporter } from './noop'

const base = { service: 'core', environment: 'local', region: 'us', release: 'abc1234' } as const

describe('createErrorReporter', () => {
  test.each([undefined, '', '   '])('with the DSN %p it gives the no-op reporter', (dsn) => {
    const logger = createMemoryLogger()
    const reporter = createErrorReporter({ ...base, dsn, logger })
    expect(reporter).toBe(createNoopErrorReporter())
  })

  test('with no DSN in local it says so at info, and outside local at warn', () => {
    const local = createMemoryLogger()
    createErrorReporter({ ...base, logger: local })
    expect(local.entries).toMatchObject([{ level: 'info' }])
    const prod = createMemoryLogger()
    createErrorReporter({ ...base, environment: 'prod', logger: prod })
    expect(prod.entries).toMatchObject([{ level: 'warn' }])
  })

  test('with a DSN it gives a reporter that is not the no-op one, and logs nothing', () => {
    const logger = createMemoryLogger()
    const reporter = createErrorReporter({
      ...base,
      environment: 'dev',
      dsn: 'https://abc123publickey@o123.ingest.de.sentry.io/456',
      logger,
    })
    expect(reporter).not.toBe(createNoopErrorReporter())
    expect(logger.entries).toEqual([])
  })

  test('with a DSN that cannot be parsed it falls back to the no-op reporter and warns', () => {
    const logger = createMemoryLogger()
    const reporter = createErrorReporter({ ...base, environment: 'dev', dsn: 'garbage', logger })
    expect(reporter).toBe(createNoopErrorReporter())
    expect(logger.entries).toMatchObject([{ level: 'warn' }])
    expect(JSON.stringify(logger.entries)).not.toContain('garbage')
  })
})

describe('createErrorReporter and the DSN rules (review F2, F6)', () => {
  test.each([
    'https://abc123@o1.ingest.sentry.io/42/',
    'https://ab-cd@o1.ingest.sentry.io/42',
    'https://abc123@o1.ingest.sentry.io/',
  ])('%p gives the no-op reporter, one warning, and no console output', (dsn) => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const logger = createMemoryLogger()
      const reporter = createErrorReporter({ ...base, environment: 'prod', dsn, logger })
      expect(reporter).toBe(createNoopErrorReporter())
      expect(logger.entries).toMatchObject([{ level: 'warn' }])
      expect(JSON.stringify(logger.entries)).not.toContain('abc123')
      expect(JSON.stringify(logger.entries)).not.toContain('ab-cd')
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  })

  test.each(['dev', 'staging', 'prod'] as const)(
    'an http DSN gives the no-op reporter in %s',
    (environment) => {
      const logger = createMemoryLogger()
      const reporter = createErrorReporter({
        ...base,
        environment,
        dsn: 'http://abc123@sentry.example.com/42',
        logger,
      })
      expect(reporter).toBe(createNoopErrorReporter())
      expect(logger.entries).toMatchObject([{ level: 'warn' }])
    }
  )

  test('a DSN the check accepts but the SDK does not take gives the no-op reporter and one warning', () => {
    const before = process.listenerCount('beforeExit')
    const getDsn = spyOn(NodeClient.prototype, 'getDsn').mockReturnValue(undefined)
    try {
      const logger = createMemoryLogger()
      const reporter = createErrorReporter({
        ...base,
        environment: 'prod',
        dsn: 'https://abc123@o1.ingest.sentry.io/42',
        logger,
      })
      expect(reporter).toBe(createNoopErrorReporter())
      expect(logger.entries).toMatchObject([{ level: 'warn' }])
      expect(JSON.stringify(logger.entries)).not.toContain('abc123')
    } finally {
      getDsn.mockRestore()
    }
    // The client that was built is closed, so it leaves no listeners behind.
    return Bun.sleep(20).then(() => expect(process.listenerCount('beforeExit')).toBe(before))
  })

  test('an http DSN gives the Sentry reporter in local', async () => {
    const logger = createMemoryLogger()
    const reporter = createErrorReporter({
      ...base,
      environment: 'local',
      dsn: 'http://abc123@localhost:9000/42',
      logger,
    })
    expect(reporter).not.toBe(createNoopErrorReporter())
    expect(logger.entries).toEqual([])
    await reporter.close(50)
  })

  test('a DSN with spaces around it is trimmed and accepted', async () => {
    const reporter = createErrorReporter({
      ...base,
      environment: 'dev',
      dsn: '  https://abc123@o1.ingest.sentry.io/42\n',
      logger: createMemoryLogger(),
    })
    expect(reporter).not.toBe(createNoopErrorReporter())
    await reporter.close(50)
  })
})

describe('importing the kit', () => {
  const root = new URL('../index.ts', import.meta.url).pathname
  const script = `
    import * as Sentry from '@sentry/bun'
    const before = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length
    const kit = await import(${JSON.stringify(root)})
    const reporter = kit.createErrorReporter({
      service: 'core', environment: 'local', region: 'us',
      logger: kit.createLogger({ service: 'core', level: 'silent' }),
    })
    reporter.capture(new Error('boom'), { requestId: 'r' })
    await reporter.flush(10)
    console.log(JSON.stringify({
      client: Sentry.getClient() === undefined,
      initialized: Sentry.isInitialized(),
      timers: process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length - before,
      beforeExit: process.listenerCount('beforeExit'),
      uncaught: process.listenerCount('uncaughtException'),
      rejection: process.listenerCount('unhandledRejection'),
    }))
  `

  test('and creating a reporter without a DSN does not initialise Sentry or start a timer', async () => {
    const proc = Bun.spawn(['bun', '-e', script], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 20_000,
    })
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    expect(err).toBe('')
    expect(JSON.parse(out.trim())).toEqual({
      client: true,
      initialized: false,
      timers: 0,
      beforeExit: 0,
      uncaught: 0,
      rejection: 0,
    })
  }, 25_000)
})
