import { organizationIdSchema } from 'tula-closeline-contract'
import { createMemoryErrorReporter } from '../reporting/testing'
import { streamingTranscribeBehaviour } from './behaviour'
import { createMemoryStreamingTranscribe } from './memory'

streamingTranscribeBehaviour('memory adapter', async () => {
  const reporter = createMemoryErrorReporter()
  const logs: string[] = []
  const logger = {
    debug: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    info: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    warn: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    error: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    child: () => logger,
  }
  const memory = createMemoryStreamingTranscribe({
    reporter,
    logger,
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms)
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            resolve()
          },
          { once: true }
        )
      }),
  })
  return {
    port: memory,
    organizations: {
      a: organizationIdSchema.parse(`org_${'a'.repeat(32)}`),
      b: organizationIdSchema.parse(`org_${'b'.repeat(32)}`),
    },
    reporter,
    logs: () => logs,
    hear: (organizationId, callId, track, turns, bytesPerTurn) =>
      memory.script(
        organizationId,
        callId,
        track,
        turns.map((turn, index) => ({ text: turn.text, afterBytes: bytesPerTurn * (index + 1) }))
      ),
    dropConnection: (streamId) => memory.dropConnection(streamId),
    failReconnects: (times) => memory.failReconnects(times),
    close: async () => undefined,
  }
})
