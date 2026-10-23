import { organizationIdSchema } from 'tula-closeline-contract'
import { createMemoryErrorReporter } from '../reporting/testing'
import { ttsBehaviour } from './behaviour'
import { createMemoryTts } from './memory'

ttsBehaviour('memory adapter', async () => {
  const reporter = createMemoryErrorReporter()
  const logs: string[] = []
  const logger = {
    debug: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    info: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    warn: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    error: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    child: () => logger,
  }
  const memory = createMemoryTts({ reporter, logger })
  return {
    port: memory,
    organizations: {
      a: organizationIdSchema.parse(`org_${'a'.repeat(32)}`),
      b: organizationIdSchema.parse(`org_${'b'.repeat(32)}`),
    },
    voice: 'stock-friendly',
    reporter,
    logs: () => logs,
    speak: (chunks, options) => memory.speak({ chunks, ...options }),
    hang: () => memory.speak({ chunks: [new Uint8Array([1])], hang: true }),
    failNext: (kind, times) =>
      memory.failNext(kind === 'retryable' ? 'tts.unavailable' : 'tts.rejected', times),
    vendorRequests: () => memory.requests().length,
    abortedRequests: () => memory.requests().filter((r) => r.aborted).length,
    openStreams: () => memory.openStreams(),
    close: async () => undefined,
  }
})
