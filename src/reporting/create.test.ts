import { describe, expect, test } from 'bun:test'
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
