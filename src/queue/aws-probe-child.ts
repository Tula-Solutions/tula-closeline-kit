/**
 * Child process of the proxy test for the SQS adapter (`aws-proxy.test.ts`). Proxy variables are
 * read at process start, so each case runs in its own process. Publishes once to the endpoint
 * given as the argument and prints `error <code>` and then `done`. Not part of the public API.
 */
import { createSqsQueue } from './aws'
import { createTestRegistry } from './testing'

const endpoint = process.argv[2]
if (endpoint === undefined) {
  throw new Error('usage: aws-probe-child <endpoint>')
}
process.env.AWS_ACCESS_KEY_ID = 'test'
process.env.AWS_SECRET_ACCESS_KEY = 'test'

const registry = createTestRegistry()
const queue = createSqsQueue({
  queueUrl: `${endpoint}/000000000000/q`,
  region: 'eu-west-1',
  environment: 'local',
  endpoint,
  registry,
  timeoutMs: 2000,
  maxAttempts: 1,
})
try {
  await queue.publish(
    registry.create({ type: 'test.note', payload: { text: 'probe' }, traceId: 'probe' })
  )
  process.stdout.write('ok\ndone\n')
} catch (error) {
  const code = (error as { code?: string }).code ?? 'unknown'
  process.stdout.write(`error ${code}\ndone\n`)
}
process.exit(0)
