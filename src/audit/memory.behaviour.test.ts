import { auditBehaviour } from './behaviour'
import { createMemoryAuditRecorder } from './memory'

auditBehaviour('memory adapter', async () => {
  const logs: string[] = []
  const log = (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f }))
  const logger = { debug: log, info: log, warn: log, error: log, child: () => logger }
  const recorder = createMemoryAuditRecorder({ logger })
  return {
    recorder,
    delivered: async () =>
      recorder.entries().map((e) => ({
        id: e.id,
        organizationId: e.organizationId,
        action: e.action,
      })),
    logs: () => logs,
    close: async () => undefined,
  }
})
