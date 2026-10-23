import { organizationIdSchema } from 'tula-closeline-contract'
import { createMemoryErrorReporter } from '../reporting/testing'
import { llmBehaviour } from './behaviour'
import { createMemoryLlm } from './memory'

llmBehaviour('memory adapter', async () => {
  const reporter = createMemoryErrorReporter()
  const logs: string[] = []
  const logger = {
    debug: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    info: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    warn: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    error: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    child: () => logger,
  }
  const memory = createMemoryLlm({ reporter, logger })
  return {
    port: memory,
    organizations: {
      a: organizationIdSchema.parse(`org_${'a'.repeat(32)}`),
      b: organizationIdSchema.parse(`org_${'b'.repeat(32)}`),
    },
    reporter,
    logs: () => logs,
    reply: (text, usage) => memory.reply({ text, ...usage }),
    hang: () => memory.reply({ text: '', hang: true }),
    failNext: (kind, times) =>
      memory.failNext(kind === 'retryable' ? 'llm.unavailable' : 'llm.rejected', times),
    vendorRequests: () => memory.requests().length,
    abortedRequests: () => memory.requests().filter((r) => r.aborted).length,
    close: async () => undefined,
  }
})
