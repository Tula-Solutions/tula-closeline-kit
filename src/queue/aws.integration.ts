import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs'
import { createSqsQueue } from './aws'
import { queueBehaviour } from './behaviour'
import { createTestRegistry } from './testing'

/**
 * Runs the shared behaviour suite against the SQS adapter on ElasticMQ, the SQS-compatible stand-in
 * of the hub's local stack (and of this repo's `compose.yaml`). It is an integration test: `bun
 * test src` does not pick it up; `bun run test:integration` runs it, and CI starts `compose.yaml`
 * first. It never reaches AWS: the endpoint override is only accepted for `ENVIRONMENT=local`, and
 * an endpoint that is not on the loopback interface or the `queue` compose host is refused here.
 *
 * Without `QUEUE_TEST_ENDPOINT` it is skipped with a notice on a developer machine, and fails when
 * `CI` is set, so CI cannot pass by running nothing.
 */
const endpoint = process.env.QUEUE_TEST_ENDPOINT
const LOCAL_ENDPOINT = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]|queue)(:\d+)?\/?$/

if (endpoint === undefined || endpoint === '') {
  if (process.env.CI !== undefined && process.env.CI !== '') {
    throw new Error('CI is set but QUEUE_TEST_ENDPOINT is not: the SQS suite would run nothing')
  }
  process.stderr.write(
    'SKIPPED: the SQS adapter was not run against ElasticMQ. Run `docker compose up -d --wait` and `bun run test:integration`.' +
      '\n'
  )
  queueBehaviour('SQS adapter on ElasticMQ', async () => Promise.reject(new Error('skipped')), true)
} else if (!LOCAL_ENDPOINT.test(endpoint)) {
  throw new Error('QUEUE_TEST_ENDPOINT must be a local http endpoint, never AWS')
} else {
  const MAX_RECEIVE_COUNT = 3
  const VISIBILITY_SECONDS = 2
  const credentials = { accessKeyId: 'test', secretAccessKey: 'test' }
  const admin = new SQSClient({ region: 'eu-west-1', endpoint, credentials })
  // ElasticMQ builds queue URLs from its own node address, which can differ from the address the
  // test reaches it on (localhost against 127.0.0.1); keep its path and use ours.
  const urlOf = (created: string | undefined) =>
    `${endpoint.replace(/\/$/, '')}${new URL(created ?? '').pathname}`

  queueBehaviour('SQS adapter on ElasticMQ', async () => {
    // The adapter takes credentials from the default chain only, so give the chain some.
    process.env.AWS_ACCESS_KEY_ID ??= credentials.accessKeyId
    process.env.AWS_SECRET_ACCESS_KEY ??= credentials.secretAccessKey
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const dlq = await admin.send(new CreateQueueCommand({ QueueName: `behaviour-dlq-${suffix}` }))
    const dlqUrl = urlOf(dlq.QueueUrl)
    const dlqArn = (
      await admin.send(
        new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] })
      )
    ).Attributes?.QueueArn
    const main = await admin.send(
      new CreateQueueCommand({
        QueueName: `behaviour-${suffix}`,
        Attributes: {
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlqArn,
            maxReceiveCount: MAX_RECEIVE_COUNT,
          }),
        },
      })
    )
    const queueUrl = urlOf(main.QueueUrl)
    const registry = createTestRegistry()
    return {
      queue: createSqsQueue({
        queueUrl,
        region: 'eu-west-1',
        environment: 'local',
        endpoint,
        registry,
      }),
      registry,
      visibilitySeconds: VISIBILITY_SECONDS,
      emptyWaitSeconds: 1,
      maxReceiveCount: MAX_RECEIVE_COUNT,
      // Real time: the queue's clock is not ours. The margin covers ElasticMQ's own timer; the
      // suite's receives retry for a few seconds, so a late redelivery is waited for, not missed.
      pass: (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 1000)),
      injectRaw: async (body) => {
        await admin.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }))
      },
      deadLetterIds: async () => {
        const got = await admin.send(
          new ReceiveMessageCommand({
            QueueUrl: dlqUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 2,
            VisibilityTimeout: 0,
          })
        )
        return (got.Messages ?? []).map(
          (message) => (JSON.parse(message.Body ?? '{}') as { id: string }).id
        )
      },
      close: async () => {
        await admin.send(new DeleteQueueCommand({ QueueUrl: queueUrl }))
        await admin.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }))
      },
    }
  })
}
