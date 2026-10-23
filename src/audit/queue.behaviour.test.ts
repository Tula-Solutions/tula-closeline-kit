import { createFixedClock } from '../clock'
import { createMessageRegistry } from '../queue/envelope'
import { createMemoryQueue } from '../queue/memory'
import { auditBehaviour } from './behaviour'
import { type AuditRecordedEnvelope, auditRecordedMessage } from './message'
import { createQueueAuditRecorder } from './queue'

auditBehaviour('queue adapter', async () => {
  const logs: string[] = []
  const log = (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f }))
  const logger = { debug: log, info: log, warn: log, error: log, child: () => logger }
  const clock = createFixedClock('2026-01-01T00:00:00.000Z')
  const registry = createMessageRegistry([auditRecordedMessage], { clock })
  const queue = createMemoryQueue({ registry, clock })
  const published: AuditRecordedEnvelope[] = []
  const recorder = createQueueAuditRecorder({
    queue: {
      publish: async (envelope) => {
        await queue.publish(envelope)
        published.push(envelope)
      },
    },
    clock,
    logger,
  })
  return {
    recorder,
    delivered: async () =>
      published.map((e) => ({
        id: e.id,
        organizationId: e.organizationId,
        action: e.payload.action,
      })),
    logs: () => logs,
    close: async () => undefined,
  }
})
