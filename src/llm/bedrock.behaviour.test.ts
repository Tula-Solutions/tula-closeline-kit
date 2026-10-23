import { organizationIdSchema } from 'tula-closeline-contract'
import { createMemoryErrorReporter } from '../reporting/testing'
import { createBedrockLlm } from './bedrock'
import { createFakeBedrock } from './bedrock.fake'
import { llmBehaviour } from './behaviour'

llmBehaviour('Bedrock adapter on a scripted client', async () => {
  const reporter = createMemoryErrorReporter()
  const logs: string[] = []
  const logger = {
    debug: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    info: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    warn: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    error: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    child: () => logger,
  }
  const fake = createFakeBedrock()
  const port = createBedrockLlm({
    region: 'eu-west-1',
    client: fake.sender,
    reporter,
    logger,
    sleep: async () => undefined,
  })
  return {
    port,
    organizations: {
      a: organizationIdSchema.parse(`org_${'a'.repeat(32)}`),
      b: organizationIdSchema.parse(`org_${'b'.repeat(32)}`),
    },
    reporter,
    logs: () => logs,
    reply: (text, usage) => fake.reply(text, usage),
    hang: () => fake.hang(),
    failNext: (kind, times) => fake.failNext(kind, times),
    vendorRequests: () => fake.requests.length,
    abortedRequests: () => fake.requests.filter((r) => r.aborted).length,
    close: async () => undefined,
  }
})
