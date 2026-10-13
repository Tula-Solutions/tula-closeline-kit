import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { ENVIRONMENTS, environmentSchema, requireSentryDsn, sentryDsnSchema } from './env'

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
