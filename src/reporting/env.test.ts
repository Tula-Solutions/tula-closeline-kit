import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
  ENVIRONMENTS,
  environmentSchema,
  isSentryDsn,
  requireSentryDsn,
  sentryDsnSchema,
} from './env'

const DSN = 'https://abc123@o1.ingest.sentry.io/42'

// How a service uses the helpers in its own src/env.ts.
const serviceEnv = z
  .object({ ENVIRONMENT: environmentSchema, SENTRY_DSN: sentryDsnSchema, PORT: z.coerce.number() })
  .superRefine(requireSentryDsn)

describe('SENTRY_DSN in a service env schema', () => {
  test('is optional in local', () => {
    expect(serviceEnv.parse({ ENVIRONMENT: 'local', PORT: '3000' }).SENTRY_DSN).toBeUndefined()
  })

  test.each(['dev', 'staging', 'prod'])(
    'is required in %s, so boot fails without it',
    (environment) => {
      const result = serviceEnv.safeParse({ ENVIRONMENT: environment, PORT: '3000' })
      expect(result.success).toBe(false)
      expect(result.error?.issues[0]?.path).toEqual(['SENTRY_DSN'])
      expect(result.error?.issues[0]?.message).toContain('SENTRY_DSN')
    }
  )

  test.each(['dev', 'staging', 'prod'])('an empty value is missing in %s', (environment) => {
    expect(
      serviceEnv.safeParse({ ENVIRONMENT: environment, SENTRY_DSN: '', PORT: '1' }).success
    ).toBe(false)
  })

  test.each(['dev', 'staging', 'prod', 'local'])('a DSN is accepted in %s', (environment) => {
    const parsed = serviceEnv.parse({ ENVIRONMENT: environment, SENTRY_DSN: DSN, PORT: '1' })
    expect(parsed.SENTRY_DSN).toBe(DSN)
  })

  test('an empty value in local means no DSN', () => {
    expect(
      serviceEnv.parse({ ENVIRONMENT: 'local', SENTRY_DSN: '', PORT: '1' }).SENTRY_DSN
    ).toBeUndefined()
  })

  test.each(['not a url', 'ftp://abc@host/1', 'abc123'])('%p is not a DSN', (value) => {
    expect(
      serviceEnv.safeParse({ ENVIRONMENT: 'local', SENTRY_DSN: value, PORT: '1' }).success
    ).toBe(false)
  })

  test('an unknown ENVIRONMENT fails on ENVIRONMENT, not on the DSN', () => {
    const result = serviceEnv.safeParse({ ENVIRONMENT: 'production', PORT: '1' })
    expect(result.success).toBe(false)
    expect(result.error?.issues.every((issue) => issue.path[0] === 'ENVIRONMENT')).toBe(true)
  })

  test('the environments are exactly local, dev, staging and prod', () => {
    expect([...ENVIRONMENTS]).toEqual(['local', 'dev', 'staging', 'prod'])
  })
})

describe('SENTRY_DSN must be one the Sentry SDK accepts (review F2)', () => {
  test.each([
    ['a trailing slash', 'https://abc123@o1.ingest.sentry.io/42/'],
    ['a dash in the key', 'https://ab-cd@o1.ingest.sentry.io/42'],
    ['a space inside', 'https://abc123@o1.ingest.sentry.io/4 2'],
    ['no project id', 'https://abc123@o1.ingest.sentry.io/'],
    ['a project id that is not a number', 'https://abc123@o1.ingest.sentry.io/abc'],
    ['a project id with a suffix', 'https://abc123@o1.ingest.sentry.io/42abc'],
    ['a query string', 'https://abc123@o1.ingest.sentry.io/42?x=1'],
    ['a port that is not a number', 'https://abc123@o1.ingest.sentry.io:port/42'],
    ['an upper-case scheme', 'HTTPS://abc123@o1.ingest.sentry.io/42'],
    ['no key', 'https://@o1.ingest.sentry.io/42'],
    ['no host', 'https://abc123@/42'],
    ['no path', 'https://abc123@o1.ingest.sentry.io'],
    ['an ftp scheme', 'ftp://abc123@o1.ingest.sentry.io/42'],
    ['a double slash in the path', 'https://abc123@o1.ingest.sentry.io//42'],
    ['a path with a space', 'https://abc123@o1.ingest.sentry.io/a b/42'],
  ])('%s is rejected', (_name, dsn) => {
    expect(isSentryDsn(dsn, 'local')).toBe(false)
    expect(isSentryDsn(dsn, 'prod')).toBe(false)
    expect(serviceEnv.safeParse({ ENVIRONMENT: 'local', SENTRY_DSN: dsn, PORT: '1' }).success).toBe(
      false
    )
  })

  test.each([
    'https://abc123@o1.ingest.sentry.io/42',
    'https://abc123:secret@o1.ingest.sentry.io/42',
    'https://abc123@o1.ingest.de.sentry.io:8443/42',
    'https://abc123@sentry.internal.example.com/prefix/path/42',
    'https://abc123@[::1]/42',
    'https://AbC_123@o1.ingest.sentry.io/0',
  ])('%s is accepted', (dsn) => {
    expect(isSentryDsn(dsn, 'prod')).toBe(true)
    expect(serviceEnv.safeParse({ ENVIRONMENT: 'prod', SENTRY_DSN: dsn, PORT: '1' }).success).toBe(
      true
    )
  })
})

describe('the env schema trims the DSN as createErrorReporter does (N-trim)', () => {
  test.each([
    ['a leading space', ' https://abc123@o1.ingest.sentry.io/42'],
    ['a trailing space', 'https://abc123@o1.ingest.sentry.io/42 '],
    ['a trailing newline', 'https://abc123@o1.ingest.sentry.io/42\n'],
    ['a carriage return and newline', 'https://abc123@o1.ingest.sentry.io/42\r\n'],
  ])('%s is trimmed and the trimmed DSN is the value', (_name, dsn) => {
    const result = serviceEnv.safeParse({ ENVIRONMENT: 'prod', SENTRY_DSN: dsn, PORT: '1' })
    expect(result.success).toBe(true)
    expect(result.data?.SENTRY_DSN).toBe('https://abc123@o1.ingest.sentry.io/42')
  })

  test('a DSN of only whitespace is not set', () => {
    expect(
      serviceEnv.safeParse({ ENVIRONMENT: 'local', SENTRY_DSN: ' \n ', PORT: '1' }).data?.SENTRY_DSN
    ).toBeUndefined()
  })
})

test('an empty string is not a DSN', () => {
  expect(isSentryDsn('', 'local')).toBe(false)
})

describe('an http DSN is only for local (review F6)', () => {
  const HTTP = 'http://abc123@localhost:9000/42'

  test('is accepted in local', () => {
    expect(isSentryDsn(HTTP, 'local')).toBe(true)
    expect(
      serviceEnv.safeParse({ ENVIRONMENT: 'local', SENTRY_DSN: HTTP, PORT: '1' }).success
    ).toBe(true)
  })

  test.each(['dev', 'staging', 'prod'])(
    'is rejected in %s, by the env schema and by the check',
    (environment) => {
      expect(isSentryDsn(HTTP, environment as 'dev')).toBe(false)
      const result = serviceEnv.safeParse({ ENVIRONMENT: environment, SENTRY_DSN: HTTP, PORT: '1' })
      expect(result.success).toBe(false)
      expect(result.error?.issues[0]?.path).toEqual(['SENTRY_DSN'])
      expect(result.error?.issues[0]?.message).toContain('https')
      expect(JSON.stringify(result.error?.issues)).not.toContain('abc123')
    }
  )

  test('an https DSN is accepted everywhere', () => {
    for (const environment of ENVIRONMENTS) {
      expect(isSentryDsn(DSN, environment)).toBe(true)
    }
  })
})
