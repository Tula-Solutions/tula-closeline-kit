import { organizationIdSchema } from 'tula-closeline-contract'
import { createMemoryErrorReporter } from '../reporting/testing'
import { calendarBehaviour } from './behaviour'
import { createMemoryCalendar } from './memory'

calendarBehaviour('memory adapter', async () => {
  const reporter = createMemoryErrorReporter()
  const logs: string[] = []
  const logger = {
    debug: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    info: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    warn: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    error: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    child: () => logger,
  }
  const memory = createMemoryCalendar({ reporter, logger })
  return {
    port: memory,
    organizations: {
      a: organizationIdSchema.parse(`org_${'a'.repeat(32)}`),
      b: organizationIdSchema.parse(`org_${'b'.repeat(32)}`),
    },
    reporter,
    logs: () => logs,
    acceptedGrant: (secret, kind = 'authorization_code') => {
      memory.allowGrant(secret)
      return kind === 'refresh_token'
        ? { kind, refreshToken: secret }
        : { kind, code: secret, redirectUri: 'https://app.example.test/oauth/callback' }
    },
    refusedGrant: () => ({ kind: 'refresh_token', refreshToken: 'never-allowed' }),
    addBusy: (connection, interval) => memory.addBusy(connection, interval),
    hang: () => memory.hangNext(),
    failNext: (kind, times) =>
      memory.failNext(kind === 'retryable' ? 'calendar.unavailable' : 'calendar.rejected', times),
    loseResponse: (times) => memory.loseNextResponse(times),
    revokeAtProvider: (connection) => memory.revokeAtProvider(connection),
    vendorRequests: () => memory.requests().length,
    abortedRequests: () => memory.requests().filter((r) => r.aborted).length,
    close: async () => undefined,
  }
})
