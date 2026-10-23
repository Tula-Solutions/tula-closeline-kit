import { formatId, organizationIdSchema, type ProspectId } from 'tula-closeline-contract'
import { createMemoryContactGuard } from '../consent/memory'
import { createMemoryErrorReporter } from '../reporting/testing'
import { messagingBehaviour } from './behaviour'
import { createMemoryMessaging, MEMORY_MESSAGING_AUTH_TOKEN } from './memory'

messagingBehaviour('memory adapter', async () => {
  const reporter = createMemoryErrorReporter()
  const guard = createMemoryContactGuard()
  const logs: string[] = []
  const logger = {
    debug: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    info: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    warn: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    error: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    child: () => logger,
  }
  const memory = createMemoryMessaging({
    guard,
    reporter,
    logger,
    sleep: async () => undefined,
    random: () => 0.5,
  })
  const recipient = '+14155550142'
  const ourNumber = '+14155550199'
  return {
    port: memory,
    guard,
    organizations: {
      a: organizationIdSchema.parse(`org_${'a'.repeat(32)}`),
      b: organizationIdSchema.parse(`org_${'b'.repeat(32)}`),
    },
    prospect: formatId('prs', '1'.repeat(32)) as ProspectId,
    recipient,
    ourNumber,
    reporter,
    logs: () => logs,
    vendorCalls: () => memory.requests().length,
    abortedCalls: () => memory.requests().filter((r) => r.aborted).length,
    failNext: (kind, times) =>
      memory.failNext(
        {
          retryable: 'messaging.unavailable',
          fatal: 'messaging.rejected',
          opted_out: 'messaging.recipient_opted_out',
          template_required: 'messaging.template_required',
          bad_response: 'messaging.bad_response',
        }[kind] as never,
        times
      ),
    hang: () => memory.hangNext(1),
    signedInbound: (f) => memory.inbound(f),
    signedStatus: (f) => memory.status(f),
    sign: (f) => memory.signedWebhook(f),
    secrets: () => [MEMORY_MESSAGING_AUTH_TOKEN],
    close: async () => undefined,
  }
})
