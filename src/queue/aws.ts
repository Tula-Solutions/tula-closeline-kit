import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type ReceiveMessageCommandOutput,
  SendMessageBatchCommand,
  type SendMessageBatchCommandOutput,
  SendMessageCommand,
} from '@aws-sdk/client-sqs'
import { reduceAwsCause } from '../aws-failure'
import type { Environment } from '../reporting/env'
import { createSqsClient } from './client'
import {
  type AnyDefinition,
  type EnvelopeOf,
  MAX_MESSAGE_BYTES,
  type MessageRegistry,
} from './envelope'
import { QUEUE_ERROR_CODES, QueueError } from './errors'
import {
  assertBatchCount,
  assertReceiveOptions,
  assertVisibility,
  type BatchFailure,
  type BatchResult,
  type Delivery,
  type Queue,
  type Receipt,
  type ReceiveOptions,
} from './port'

/** The one SDK method the adapter uses; a test passes a stub with this shape. */
export interface SqsSender {
  /** Sends one SDK command, with an optional per-call timeout and abort signal. */
  send(
    command:
      | SendMessageCommand
      | SendMessageBatchCommand
      | ReceiveMessageCommand
      | DeleteMessageCommand
      | ChangeMessageVisibilityCommand,
    options?: { requestTimeout?: number; abortSignal?: AbortSignal }
  ): Promise<unknown>
}

/** Options for {@link createSqsQueue}. */
export interface SqsQueueOptions<D extends AnyDefinition> {
  /** The queue's URL. */
  queueUrl: string
  /** The AWS Region of the queue; each Closeline Region has its own queues (ADR 0001). */
  region: string
  /** The `ENVIRONMENT` the service runs in. */
  environment: Environment
  /** The message types the queue accepts and delivers. */
  registry: MessageRegistry<D>
  /**
   * An endpoint to use instead of AWS, for ElasticMQ in local development (`http://127.0.0.1:9324`).
   * Accepted only when `environment` is `local`; anywhere else it throws at construction, so a
   * deployed service cannot be pointed away from AWS by a stray setting. Credentials are never an
   * option: they come from the SDK's default chain (the task role in AWS; for ElasticMQ, any
   * `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` values).
   */
  endpoint?: string
  /** Bound on one attempt's connect and request, in ms; default 5000. A long poll adds its wait. */
  timeoutMs?: number
  /** Attempts per call, the first included, with the SDK's jittered exponential back-off; default 3. */
  maxAttempts?: number
  /** A replacement for the SDK client, for unit tests with no network. */
  client?: SqsSender
}

/** The default bound on one attempt, in milliseconds. */
export const SQS_DEFAULT_TIMEOUT_MS = 5_000

/** The default number of attempts per call. */
export const SQS_DEFAULT_MAX_ATTEMPTS = 3

function bytesOf(body: string): number {
  return new TextEncoder().encode(body).length
}

/**
 * Turns an SDK failure into a QueueError. A fault the SDK blames on the client and does not call
 * retryable (no such queue, access denied, invalid contents) can never succeed on retry: it is
 * `queue.rejected`, a configuration or code bug that should be reported. Everything else (server
 * faults, timeouts, throttling, a dropped connection) is `queue.unavailable`.
 */
function mapFailure(operation: string, error: unknown): QueueError {
  const fault = error as { $fault?: unknown; $retryable?: unknown } | null
  if (fault?.$fault === 'client' && fault.$retryable === undefined) {
    return new QueueError(QUEUE_ERROR_CODES.rejected, `the queue refused ${operation}`, {
      cause: reduceAwsCause(error),
    })
  }
  return new QueueError(QUEUE_ERROR_CODES.unavailable, `the queue did not complete ${operation}`, {
    cause: reduceAwsCause(error),
  })
}

const STALE_RECEIPT_NAMES = new Set(['ReceiptHandleIsInvalid', 'MessageNotInflight'])

/**
 * True for the errors SQS (and ElasticMQ) give for a receipt that no longer names an in-flight
 * message. `InvalidParameterValue` counts only when it is about the receipt handle.
 */
function isStaleReceipt(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return (
    STALE_RECEIPT_NAMES.has(error.name) ||
    (error.name === 'InvalidParameterValue' && /receipt ?handle/i.test(error.message))
  )
}

const ENDPOINT_VARIABLES = ['AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_SQS'] as const

/**
 * Creates the SQS adapter, built on the AWS SDK v3 SQS client.
 *
 * Timeouts: every attempt has a connect and a request timeout (`timeoutMs`; a long poll adds its
 * wait). Retries: the SDK's own, `maxAttempts` with the `standard` mode's jittered exponential
 * back-off and retry quota; the adapter adds no second layer. A failed publish after the retries
 * throws `queue.unavailable`; republishing the same envelope is safe because consumers dedupe on
 * its id. Limits are checked before anything is sent. Message bodies are never logged: the
 * adapter does not log, and its errors carry the SDK error as `cause` but never a body.
 *
 * Proxies: the SDK's Node HTTP handler is used with its default agents, which in Bun do not read
 * `HTTP_PROXY`, `HTTPS_PROXY` or `ALL_PROXY` (proven by `aws-proxy.test.ts`). Queue traffic
 * therefore never goes through a proxy named in the environment (ADR 0013). There is no option for
 * a deliberate proxy yet; add one here, and a test, if infrastructure ever needs it.
 *
 * Complexity: publish O(message size); receive O(batch size); one HTTP call each.
 */
export function createSqsQueue<const D extends AnyDefinition>(
  options: SqsQueueOptions<D>
): Queue<EnvelopeOf<D>> {
  if (options.endpoint !== undefined && options.environment !== 'local') {
    throw new TypeError(
      `an SQS endpoint override is only for ENVIRONMENT=local, not ${options.environment}`
    )
  }
  if (options.environment !== 'local') {
    // The SDK reads these itself; they would send queue traffic anywhere without a code change.
    for (const name of ENDPOINT_VARIABLES) {
      if ((process.env[name] ?? '') !== '') {
        throw new TypeError(
          `${name} is set; an SQS endpoint override is only for ENVIRONMENT=local`
        )
      }
    }
  }
  const timeoutMs = options.timeoutMs ?? SQS_DEFAULT_TIMEOUT_MS
  const maxAttempts = options.maxAttempts ?? SQS_DEFAULT_MAX_ATTEMPTS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new TypeError('timeoutMs must be a whole number from 100 to 60000')
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new TypeError('maxAttempts must be a whole number from 1 to 10')
  }
  const { registry, queueUrl } = options
  const client: SqsSender =
    options.client ??
    createSqsClient({
      region: options.region,
      environment: options.environment,
      endpoint: options.endpoint,
      timeoutMs,
      maxAttempts,
    })

  function encodeChecked(envelope: EnvelopeOf<D>): string {
    const body = registry.encode(envelope)
    if (bytesOf(body) > MAX_MESSAGE_BYTES) {
      throw new QueueError(QUEUE_ERROR_CODES.messageTooLarge, 'the message is over 256 KiB', {
        details: { limitBytes: MAX_MESSAGE_BYTES },
      })
    }
    return body
  }

  async function changeVisibility(receipt: Receipt, seconds: number): Promise<void> {
    assertVisibility(seconds)
    try {
      await client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receipt,
          VisibilityTimeout: seconds,
        })
      )
    } catch (error) {
      if (isStaleReceipt(error)) {
        throw new QueueError(QUEUE_ERROR_CODES.receiptInvalid, 'the message is not in flight', {
          cause: reduceAwsCause(error),
        })
      }
      throw mapFailure('a visibility change', error)
    }
  }

  return {
    async publish(envelope) {
      const body = encodeChecked(envelope)
      try {
        await client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }))
      } catch (error) {
        throw mapFailure('a publish', error)
      }
    },

    async publishBatch(envelopes) {
      assertBatchCount(envelopes.length)
      const bodies = envelopes.map(encodeChecked)
      const total = bodies.reduce((sum, body) => sum + bytesOf(body), 0)
      if (total > MAX_MESSAGE_BYTES) {
        throw new QueueError(
          QUEUE_ERROR_CODES.batchTooLarge,
          'a batch is at most 256 KiB in total',
          {
            details: { limitBytes: MAX_MESSAGE_BYTES, totalBytes: total },
          }
        )
      }
      let output: SendMessageBatchCommandOutput
      try {
        output = (await client.send(
          new SendMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: bodies.map((body, index) => ({ Id: String(index), MessageBody: body })),
          })
        )) as SendMessageBatchCommandOutput
      } catch (error) {
        throw mapFailure('a batch publish', error)
      }
      const accepted = new Set((output.Successful ?? []).map((entry) => entry.Id))
      const refused = new Map((output.Failed ?? []).map((entry) => [entry.Id, entry]))
      const result: BatchResult = { sent: [], failed: [] }
      envelopes.forEach((envelope, index) => {
        const entryId = String(index)
        const failure = refused.get(entryId)
        if (failure !== undefined) {
          const item: BatchFailure = {
            id: envelope.id,
            code: failure.Code ?? 'Unknown',
            senderFault: failure.SenderFault === true,
          }
          result.failed.push(item)
        } else if (accepted.has(entryId)) {
          result.sent.push(envelope.id)
        } else {
          // Neither list names it: count it as not sent rather than assume it was.
          result.failed.push({ id: envelope.id, code: 'MissingFromResponse', senderFault: false })
        }
      })
      return result
    },

    async receive(receiveOptions: ReceiveOptions) {
      assertReceiveOptions(receiveOptions)
      const { maxMessages, visibilityTimeoutSeconds, waitSeconds, signal } = receiveOptions
      if (signal?.aborted) {
        return []
      }
      let output: ReceiveMessageCommandOutput
      try {
        output = (await client.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: maxMessages,
            VisibilityTimeout: visibilityTimeoutSeconds,
            WaitTimeSeconds: waitSeconds,
            MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          }),
          {
            requestTimeout: waitSeconds * 1000 + timeoutMs,
            ...(signal === undefined ? {} : { abortSignal: signal }),
          }
        )) as ReceiveMessageCommandOutput
      } catch (error) {
        if (signal?.aborted) {
          return []
        }
        throw mapFailure('a receive', error)
      }
      const deliveries: Delivery<EnvelopeOf<D>>[] = []
      for (const message of output.Messages ?? []) {
        if (message.ReceiptHandle === undefined || message.Body === undefined) {
          throw new QueueError(
            QUEUE_ERROR_CODES.badResponse,
            'the queue returned a message without a body or receipt'
          )
        }
        const receiveCount = Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? '1', 10)
        const count = Number.isInteger(receiveCount) && receiveCount > 0 ? receiveCount : 1
        const decoded = registry.decode(message.Body)
        deliveries.push(
          decoded.ok
            ? {
                kind: 'message',
                envelope: decoded.envelope,
                receipt: message.ReceiptHandle,
                receiveCount: count,
              }
            : {
                kind: 'invalid',
                reason: decoded.reason,
                issues: decoded.issues,
                ...(decoded.messageId === undefined ? {} : { messageId: decoded.messageId }),
                receipt: message.ReceiptHandle,
                receiveCount: count,
              }
        )
      }
      return deliveries
    },

    async acknowledge(receipt) {
      try {
        await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receipt }))
      } catch (error) {
        // A receipt that no longer names an in-flight message is already settled: nothing to delete.
        if (!isStaleReceipt(error)) {
          throw mapFailure('an acknowledge', error)
        }
      }
    },

    extendVisibility: changeVisibility,

    release: (receipt) => changeVisibility(receipt, 0),
  }
}
