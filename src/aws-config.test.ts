import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { S3Client } from '@aws-sdk/client-s3'
import { SQSClient } from '@aws-sdk/client-sqs'
import { createSqsClient } from './queue/client'
import { createS3Client } from './storage/client'

/**
 * The shared AWS config file can carry `endpoint_url`, which redirects the SDK. Outside `local` the
 * adapters' clients must ignore it. The check reads the host a request would be sent to without
 * sending it, and the control (a client built with no such setting) shows the file is honoured.
 */
const DIR = new URL('./.aws-config-test', import.meta.url).pathname
const FILE = `${DIR}/config`
const saved = {
  config: process.env.AWS_CONFIG_FILE,
  profile: process.env.AWS_PROFILE,
  id: process.env.AWS_ACCESS_KEY_ID,
  secret: process.env.AWS_SECRET_ACCESS_KEY,
}

beforeAll(() => {
  mkdirSync(DIR, { recursive: true })
  writeFileSync(FILE, '[default]\nendpoint_url = http://127.0.0.1:9\n')
  process.env.AWS_CONFIG_FILE = FILE
  delete process.env.AWS_PROFILE
  process.env.AWS_ACCESS_KEY_ID = 'test'
  process.env.AWS_SECRET_ACCESS_KEY = 'test'
})
afterAll(() => {
  rmSync(DIR, { recursive: true, force: true })
  for (const [name, value] of [
    ['AWS_CONFIG_FILE', saved.config],
    ['AWS_PROFILE', saved.profile],
    ['AWS_ACCESS_KEY_ID', saved.id],
    ['AWS_SECRET_ACCESS_KEY', saved.secret],
  ] as const) {
    if (value === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = value
    }
  }
})

interface Client {
  middlewareStack: {
    add(
      middleware: (next: unknown) => (args: { request: { hostname?: string } }) => Promise<never>,
      options: { step: 'build'; name: string }
    ): void
  }
  send(command: unknown): Promise<unknown>
}

/** The host the client would send the command to; nothing is sent. */
async function hostOf(client: Client, command: unknown): Promise<string | undefined> {
  let host: string | undefined
  client.middlewareStack.add(
    () => async (args) => {
      host = args.request.hostname
      throw new Error('stop before sending')
    },
    { step: 'build', name: 'captureHost' }
  )
  await client.send(command).catch(() => undefined)
  return host
}

const settings = (environment: 'local' | 'dev' | 'staging' | 'prod') => ({
  region: 'eu-west-1',
  environment,
  endpoint: undefined,
  timeoutMs: 1000,
  maxAttempts: 1,
})

describe('endpoint_url in the shared AWS config file', async () => {
  const { HeadObjectCommand } = await import('@aws-sdk/client-s3')
  const { GetQueueUrlCommand } = await import('@aws-sdk/client-sqs')
  const head = () => new HeadObjectCommand({ Bucket: 'closeline-test', Key: 'k' })
  const queue = () => new GetQueueUrlCommand({ QueueName: 'q' })

  test('control: a client with no such setting follows the file', async () => {
    const s3 = await hostOf(new S3Client({ region: 'eu-west-1', maxAttempts: 1 }) as never, head())
    const sqs = await hostOf(
      new SQSClient({ region: 'eu-west-1', maxAttempts: 1 }) as never,
      queue()
    )
    expect(s3).toContain('127.0.0.1')
    expect(sqs).toContain('127.0.0.1')
  })

  test.each(['dev', 'staging', 'prod'] as const)(
    'the S3 client in %s goes to AWS',
    async (environment) => {
      const host = await hostOf(createS3Client(settings(environment)) as never, head())
      expect(host).toEndWith('.amazonaws.com')
    }
  )

  test.each(['dev', 'staging', 'prod'] as const)(
    'the SQS client in %s goes to AWS',
    async (environment) => {
      const host = await hostOf(createSqsClient(settings(environment)) as never, queue())
      expect(host).toEndWith('.amazonaws.com')
    }
  )

  test('in local the file is still honoured, for the dev stack', async () => {
    const host = await hostOf(createS3Client(settings('local')) as never, head())
    expect(host).toContain('127.0.0.1')
  })
})
