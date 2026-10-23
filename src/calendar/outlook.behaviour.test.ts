import { organizationIdSchema } from 'tula-closeline-contract'
import { calendarBehaviour } from './behaviour'
import { outlookHarness } from './outlook.harness'

calendarBehaviour('outlook adapter (fake Microsoft Graph)', async () => {
  const h = outlookHarness()
  const refreshFor = (connection: { unsafeCredential(): string }) => connection.unsafeCredential()
  return {
    port: h.port,
    organizations: {
      a: organizationIdSchema.parse(`org_${'a'.repeat(32)}`),
      b: organizationIdSchema.parse(`org_${'b'.repeat(32)}`),
    },
    reporter: h.reporter,
    logs: () => h.logs,
    acceptedGrant: (secret, kind = 'authorization_code') => {
      if (kind === 'refresh_token') {
        h.fake.allowRefresh(secret)
        return { kind, refreshToken: secret }
      }
      h.fake.allowCode(secret)
      return { kind, code: secret, redirectUri: 'https://app.example.test/oauth/callback' }
    },
    refusedGrant: () => ({ kind: 'refresh_token', refreshToken: 'never-allowed' }),
    addBusy: (connection, interval) => h.fake.addBusy(refreshFor(connection), interval),
    hang: () => h.fake.hangNext(),
    failNext: (kind, times) => h.fake.failNext(kind, times),
    loseResponse: (times) => h.fake.loseNext(times),
    revokeAtProvider: (connection) => h.fake.revokeAt(refreshFor(connection)),
    vendorRequests: () => h.fake.seen.length,
    abortedRequests: () => h.fake.seen.filter((r) => r.aborted).length,
    remembersDeletes: false,
    revokesAtVendor: false,
    close: async () => undefined,
  }
})
