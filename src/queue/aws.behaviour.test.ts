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
 * of the hub's local stack (`bun run dev` there, port 9324). It runs only when
 * `QUEUE_TEST_ENDPOINT` names that endpoint (for example `http://127.0.0.1:9324`) and never
 * reaches AWS: the endpoint override is only accepted for `ENVIRONMENT=local`, and a value that
 * does not point at the loopback interface or a compose service is refused here too.
 */
const endpoint = process.env.QUEUE_TEST_ENDPOINT
const LOCAL_ENDPOINT = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]|queue)(:\d+)?\/?$/

if (endpoint === undefined || endpoint === '') {
  console.warn(
    'SKIPPED: the SQS adapter was not run against ElasticMQ. Set QUEUE_TEST_ENDPOINT=http://127.0.0.1:9324 with the hub stack running to execute it.'
  )
  queueBehaviour('SQS adapter on ElasticMQ', async () => Promise.reject(new Error('skipped')), true)
} else if (!LOCAL_ENDPOINT.test(endpoint)) {
  throw new Error('QUEUE_TEST_ENDPOINT must be a local http endpoint, never AWS')
} else {
  const MAX_RECEIVE_COUNT = 3
  const credentials = { accessKeyId: 'test', secretAccessKey: 'test' }
  const admin = new SQSClient({ region: 'eu-west-1', endpoint, credentials })

  queueBehaviour('SQS adapter on ElasticMQ', async () => {
    // The adapter takes credentials from the default chain only, so give the chain some.
    process.env.AWS_ACCESS_KEY_ID ??= credentials.accessKeyId
    process.env.AWS_SECRET_ACCESS_KEY ??= credentials.secretAccessKey
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const dlq = await admin.send(new CreateQueueCommand({ QueueName: `behaviour-dlq-${suffix}` }))
    const dlqArn = (
      await admin.send(
        new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] })
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
    const queueUrl = main.QueueUrl as string
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
      visibilitySeconds: 1,
      maxReceiveCount: MAX_RECEIVE_COUNT,
      pass: (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 300)),
      injectRaw: async (body) => {
        await admin.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }))
      },
      deadLetterIds: async () => {
        const got = await admin.send(
          new ReceiveMessageCommand({
            QueueUrl: dlq.QueueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 1,
            VisibilityTimeout: 0,
          })
        )
        return (got.Messages ?? []).map(
          (message) => (JSON.parse(message.Body ?? '{}') as { id: string }).id
        )
      },
      close: async () => {
        await admin.send(new DeleteQueueCommand({ QueueUrl: queueUrl }))
        await admin.send(new DeleteQueueCommand({ QueueUrl: dlq.QueueUrl }))
      },
    }
  })
}
