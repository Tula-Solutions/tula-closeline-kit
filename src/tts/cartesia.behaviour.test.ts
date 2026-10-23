import { organizationIdSchema } from 'tula-closeline-contract'
import { createMemoryErrorReporter } from '../reporting/testing'
import { ttsBehaviour } from './behaviour'
import { createCartesiaTts } from './cartesia'
import { createFakeCartesia } from './cartesia.fake'

export const FAKE_API_KEY = 'sk_car_test_0123456789abcdef'

ttsBehaviour('cartesia adapter over a fake vendor', async () => {
  const reporter = createMemoryErrorReporter()
  const logs: string[] = []
  const logger = {
    debug: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    info: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    warn: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    error: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    child: () => logger,
  }
  const fake = createFakeCartesia()
  const port = createCartesiaTts({
    apiKey: FAKE_API_KEY,
    voices: { 'stock-friendly': 'a0e99841-438c-4a64-b679-ae501e7d6091' },
    socket: fake.socket,
    reporter,
    logger,
    random: () => 0.5,
  })
  return {
    port,
    organizations: {
      a: organizationIdSchema.parse(`org_${'a'.repeat(32)}`),
      b: organizationIdSchema.parse(`org_${'b'.repeat(32)}`),
    },
    voice: 'stock-friendly',
    reporter,
    logs: () => logs,
    speak: (chunks, options) =>
      fake.script({
        chunks,
        ...(options?.chunkDelayMs === undefined ? {} : { chunkDelayMs: options.chunkDelayMs }),
        ...(options?.failAfterChunks === undefined
          ? {}
          : { dropAfterChunks: options.failAfterChunks }),
      }),
    hang: () => fake.script({ hang: true }),
    failNext: (kind, times) => {
      for (let i = 0; i < times; i++) {
        fake.script({ errorStatus: kind === 'retryable' ? 503 : 401 })
      }
    },
    vendorRequests: () => fake.connections.length,
    abortedRequests: () => fake.connections.filter((c) => c.aborted).length,
    openStreams: () => port.openStreams(),
    close: async () => undefined,
  }
})
