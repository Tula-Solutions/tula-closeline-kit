import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  ChangeMessageVisibilityCommand,
  type DeleteMessageCommand,
  type ReceiveMessageCommand,
  type SendMessageBatchCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs'
import { createFixedClock } from '../clock'
import { createSqsQueue, type SqsSender } from './aws'
import { MAX_MESSAGE_BYTES } from './envelope'
import { createTestRegistry, type TestEnvelope } from './testing'

type Command = Parameters<SqsSender['send']>[0]
type Options = Parameters<SqsSender['send']>[1]

interface Call {
  command: Command
  options: Options
}

/** The input of the SDK command a call carried. */
function inputOf<C extends { input: unknown }>(call: Call | undefined): C['input'] {
  return ((call as Call).command as unknown as C).input
}

function stub(respond: (command: Command, options: Options) => unknown) {
  const calls: Call[] = []
  const client: SqsSender = {
    send: async (command, options) => {
      calls.push({ command, options })
      const result = respond(command, options)
      if (result instanceof Error) {
        throw result
      }
      return result
    },
  }
  return { calls, client }
}

const registry = createTestRegistry({
  clock: createFixedClock('2026-01-01T00:00:00.000Z'),
})
const ping = (n: number, id = `m${n}`) =>
  registry.create({ type: 'test.ping', payload: { n }, organizationId: 'org_a', traceId: 't', id })
const note = (text: string) =>
  registry.create({ type: 'test.note', payload: { text }, traceId: 't' })

function adapter(
  client: SqsSender,
  extra: Partial<
    Parameters<
      typeof createSqsQueue<
        (typeof registry)['definitions'] extends ReadonlyMap<string, infer D> ? D : never
      >
    >[0]
  > = {}
) {
  return createSqsQueue({
    queueUrl: 'http://queue.test/000000000000/q',
    region: 'eu-west-1',
    environment: 'dev',
    registry,
    client,
    ...extra,
  })
}

function named(name: string, message = name): Error {
  const error = new Error(message)
  error.name = name
  return error
}

describe('construction', () => {
  describe('the SDK reads these variables, so outside local they are refused', () => {
    const NAMES = ['AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_SQS']
    const saved: Record<string, string | undefined> = {}
    beforeEach(() => {
      for (const name of NAMES) {
        saved[name] = process.env[name]
      }
    })
    afterEach(() => {
      for (const name of NAMES) {
        if (saved[name] === undefined) {
          delete process.env[name]
        } else {
          process.env[name] = saved[name]
        }
      }
    })

    test.each(NAMES)('%s is refused in prod, with its name in the error', (name) => {
      process.env[name] = 'http://evil.example'
      expect(() => adapter(stub(() => ({})).client, { environment: 'prod' })).toThrow(name)
    })

    test('an empty value is not a setting', () => {
      process.env.AWS_ENDPOINT_URL = ''
      expect(() => adapter(stub(() => ({})).client, { environment: 'prod' })).not.toThrow()
    })

    test('in local they are allowed (ElasticMQ)', () => {
      process.env.AWS_ENDPOINT_URL_SQS = 'http://127.0.0.1:9324'
      expect(() => adapter(stub(() => ({})).client, { environment: 'local' })).not.toThrow()
    })
  })

  test.each(['dev', 'staging', 'prod'] as const)(
    'an endpoint override is refused in %s',
    (environment) => {
      expect(() =>
        createSqsQueue({
          queueUrl: 'http://x/q',
          region: 'eu-west-1',
          environment,
          registry,
          endpoint: 'http://127.0.0.1:9324',
        })
      ).toThrow(/only for ENVIRONMENT=local/)
    }
  )

  test('an endpoint override is accepted in local', () => {
    expect(() =>
      createSqsQueue({
        queueUrl: 'http://x/q',
        region: 'eu-west-1',
        environment: 'local',
        registry,
        endpoint: 'http://127.0.0.1:9324',
      })
    ).not.toThrow()
  })

  test.each([
    [{ timeoutMs: 0 }],
    [{ timeoutMs: 61_000 }],
    [{ timeoutMs: 1000.5 }],
    [{ maxAttempts: 0 }],
    [{ maxAttempts: 11 }],
  ])('refuses %j', (extra) => {
    expect(() => adapter(stub(() => ({})).client, extra)).toThrow(TypeError)
  })
})

describe('publish', () => {
  test('sends one SendMessage with the queue URL and the encoded envelope', async () => {
    const s = stub(() => ({}))
    const envelope = ping(1)
    await adapter(s.client).publish(envelope)
    expect(s.calls).toHaveLength(1)
    const command = s.calls[0]?.command
    expect(command).toBeInstanceOf(SendMessageCommand)
    expect((command as SendMessageCommand).input).toEqual({
      QueueUrl: 'http://queue.test/000000000000/q',
      MessageBody: registry.encode(envelope),
    })
  })

  test('a message over 256 KiB is refused before any call', async () => {
    const s = stub(() => ({}))
    await expect(
      adapter(s.client).publish(note('x'.repeat(MAX_MESSAGE_BYTES)))
    ).rejects.toMatchObject({
      code: 'queue.message_too_large',
    })
    expect(s.calls).toHaveLength(0)
  })

  test('the size is counted in bytes, not characters', async () => {
    const s = stub(() => ({}))
    // 90,000 three-byte characters: 90 K characters, 270 KB.
    await expect(adapter(s.client).publish(note('€'.repeat(90_000)))).rejects.toMatchObject({
      code: 'queue.message_too_large',
    })
    expect(s.calls).toHaveLength(0)
  })

  test('an invalid envelope is refused before any call', async () => {
    const s = stub(() => ({}))
    const bad = { ...ping(1), payload: { n: 'x' } } as unknown as TestEnvelope
    await expect(adapter(s.client).publish(bad)).rejects.toMatchObject({
      code: 'queue.invalid_message',
    })
    expect(s.calls).toHaveLength(0)
  })

  test('a failed call is queue.unavailable, keeps the SDK error as cause, and never holds the body', async () => {
    const secret = 'SECRET-PAYLOAD'
    const s = stub(() => named('ServiceUnavailable', `failed with ${secret}`))
    const error = await adapter(s.client)
      .publish(note(secret))
      .then(
        () => undefined,
        (caught: unknown) => caught
      )
    expect(error).toMatchObject({ code: 'queue.unavailable', status: 503 })
    expect((error as Error).message).not.toContain(secret)
    expect(JSON.stringify((error as { details?: unknown }).details ?? {})).not.toContain(secret)
    expect((error as Error).cause).toEqual({ name: 'ServiceUnavailable' })
  })

  test('the cause never holds the queue URL, the message body or the SDK error', async () => {
    const secret = 'SECRET-PAYLOAD'
    const sdkError = Object.assign(named('InvalidMessageContents', `bad ${secret} for q`), {
      $fault: 'client' as const,
      $metadata: { httpStatusCode: 400, requestId: 'REQ-9' },
      $response: { body: secret },
      QueueUrl: 'http://queue.test/000000000000/q',
    })
    const s = stub(() => sdkError)
    const error = (await adapter(s.client)
      .publish(note(secret))
      .catch((caught: unknown) => caught)) as Error
    expect(error.cause).not.toBe(sdkError)
    expect(error.cause).toEqual({
      name: 'InvalidMessageContents',
      httpStatus: 400,
      requestId: 'REQ-9',
      fault: 'client',
    })
    const everything =
      JSON.stringify(error, Object.getOwnPropertyNames(error)) + JSON.stringify(error.cause)
    expect(everything).not.toContain(secret)
    expect(everything).not.toContain('queue.test')
  })
})

describe('publishBatch', () => {
  test('sends one batch with numbered entries and maps the answer to envelope ids', async () => {
    const s = stub(() => ({ Successful: [{ Id: '0' }, { Id: '1' }], Failed: [] }))
    const result = await adapter(s.client).publishBatch([ping(1), ping(2)])
    expect(result).toEqual({ sent: ['m1', 'm2'], failed: [] })
    const input = inputOf<SendMessageBatchCommand>(s.calls[0])
    expect(input.Entries?.map((entry) => entry.Id)).toEqual(['0', '1'])
  })

  test('a partial failure names the envelope that was refused', async () => {
    const s = stub(() => ({
      Successful: [{ Id: '0' }, { Id: '2' }],
      Failed: [{ Id: '1', Code: 'InternalError', SenderFault: false }],
    }))
    const result = await adapter(s.client).publishBatch([ping(1), ping(2), ping(3)])
    expect(result).toEqual({
      sent: ['m1', 'm3'],
      failed: [{ id: 'm2', code: 'InternalError', senderFault: false }],
    })
  })

  test('an entry the answer does not mention counts as failed', async () => {
    const s = stub(() => ({ Successful: [{ Id: '0' }] }))
    const result = await adapter(s.client).publishBatch([ping(1), ping(2)])
    expect(result.failed).toEqual([{ id: 'm2', code: 'MissingFromResponse', senderFault: false }])
  })

  test('a failed call throws queue.unavailable', async () => {
    const s = stub(() => named('RequestTimeout'))
    await expect(adapter(s.client).publishBatch([ping(1)])).rejects.toMatchObject({
      code: 'queue.unavailable',
    })
  })

  test('11 messages, none, or more than 256 KiB in total are refused before any call', async () => {
    const s = stub(() => ({}))
    const queue = adapter(s.client)
    await expect(
      queue.publishBatch(Array.from({ length: 11 }, (_, i) => ping(i)))
    ).rejects.toMatchObject({
      code: 'queue.batch_too_large',
    })
    await expect(queue.publishBatch([])).rejects.toMatchObject({ code: 'queue.batch_too_large' })
    await expect(
      queue.publishBatch([note('a'.repeat(150_000)), note('b'.repeat(150_000))])
    ).rejects.toMatchObject({ code: 'queue.batch_too_large' })
    expect(s.calls).toHaveLength(0)
  })

  test('one invalid envelope refuses the whole batch before any call', async () => {
    const s = stub(() => ({}))
    const bad = { ...ping(2), type: 'test.nope' } as unknown as TestEnvelope
    await expect(adapter(s.client).publishBatch([ping(1), bad])).rejects.toMatchObject({
      code: 'queue.invalid_message',
    })
    expect(s.calls).toHaveLength(0)
  })
})

describe('receive', () => {
  const message = (envelope: TestEnvelope, handle = 'h1', count = '1') => ({
    Body: registry.encode(envelope),
    ReceiptHandle: handle,
    Attributes: { ApproximateReceiveCount: count },
  })

  test('asks for the receive count, bounds the call by the wait plus the timeout and maps messages', async () => {
    const s = stub(() => ({ Messages: [message(ping(1), 'h1', '3')] }))
    const got = await adapter(s.client, { timeoutMs: 4000 }).receive({
      maxMessages: 5,
      visibilityTimeoutSeconds: 30,
      waitSeconds: 20,
    })
    expect(got).toEqual([{ kind: 'message', envelope: ping(1), receipt: 'h1', receiveCount: 3 }])
    const call = s.calls[0]
    expect(inputOf<ReceiveMessageCommand>(call)).toEqual({
      QueueUrl: 'http://queue.test/000000000000/q',
      MaxNumberOfMessages: 5,
      VisibilityTimeout: 30,
      WaitTimeSeconds: 20,
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    })
    expect(call?.options?.requestTimeout).toBe(24_000)
  })

  test('a body that is not a valid message comes back invalid, without the body', async () => {
    const s = stub(() => ({
      Messages: [
        {
          Body: '{"a":"SECRET"',
          ReceiptHandle: 'h9',
          Attributes: { ApproximateReceiveCount: '2' },
        },
      ],
    }))
    const got = await adapter(s.client).receive({
      maxMessages: 1,
      visibilityTimeoutSeconds: 5,
      waitSeconds: 0,
    })
    expect(got).toEqual([
      {
        kind: 'invalid',
        reason: 'malformed',
        issues: ['body: not JSON'],
        receipt: 'h9',
        receiveCount: 2,
      },
    ])
  })

  test('a missing or garbled receive count reads as 1', async () => {
    const s = stub(() => ({
      Messages: [
        { Body: registry.encode(ping(1)), ReceiptHandle: 'a' },
        {
          Body: registry.encode(ping(2)),
          ReceiptHandle: 'b',
          Attributes: { ApproximateReceiveCount: 'x' },
        },
      ],
    }))
    const got = await adapter(s.client).receive({
      maxMessages: 2,
      visibilityTimeoutSeconds: 5,
      waitSeconds: 0,
    })
    expect(got.map((delivery) => delivery.receiveCount)).toEqual([1, 1])
  })

  test('a message without a receipt is a bad response, not a silent drop', async () => {
    const s = stub(() => ({ Messages: [{ Body: registry.encode(ping(1)) }] }))
    await expect(
      adapter(s.client).receive({ maxMessages: 1, visibilityTimeoutSeconds: 5, waitSeconds: 0 })
    ).rejects.toMatchObject({ code: 'queue.bad_response' })
  })

  test('no Messages field gives an empty list', async () => {
    const s = stub(() => ({}))
    expect(
      await adapter(s.client).receive({
        maxMessages: 1,
        visibilityTimeoutSeconds: 5,
        waitSeconds: 0,
      })
    ).toEqual([])
  })

  test('a failure is queue.unavailable; with an aborted signal it is an empty list', async () => {
    const s = stub(() => named('AbortError'))
    const queue = adapter(s.client)
    const args = { maxMessages: 1, visibilityTimeoutSeconds: 5, waitSeconds: 1 }
    await expect(queue.receive(args)).rejects.toMatchObject({ code: 'queue.unavailable' })
    const stop = new AbortController()
    const pending = queue.receive({ ...args, signal: stop.signal })
    stop.abort()
    expect(await pending).toEqual([])
  })

  test('an already aborted signal makes no call', async () => {
    const s = stub(() => ({}))
    const stop = new AbortController()
    stop.abort()
    await adapter(s.client).receive({
      maxMessages: 1,
      visibilityTimeoutSeconds: 5,
      waitSeconds: 1,
      signal: stop.signal,
    })
    expect(s.calls).toHaveLength(0)
  })

  test('the signal is handed to the SDK so a long poll can be cut short', async () => {
    const s = stub(() => ({}))
    const stop = new AbortController()
    await adapter(s.client).receive({
      maxMessages: 1,
      visibilityTimeoutSeconds: 5,
      waitSeconds: 1,
      signal: stop.signal,
    })
    expect(s.calls[0]?.options?.abortSignal).toBe(stop.signal)
  })

  test.each([[{ maxMessages: 11 }], [{ waitSeconds: 21 }], [{ visibilityTimeoutSeconds: 43_201 }]])(
    'refuses %j before any call',
    async (patch) => {
      const s = stub(() => ({}))
      await expect(
        adapter(s.client).receive({
          maxMessages: 1,
          visibilityTimeoutSeconds: 5,
          waitSeconds: 0,
          ...patch,
        })
      ).rejects.toMatchObject({ code: 'queue.invalid_request' })
      expect(s.calls).toHaveLength(0)
    }
  )
})

describe('failures that retrying cannot fix', () => {
  const clientFault = (name: string, message = name) =>
    Object.assign(named(name, message), { $fault: 'client' as const })

  test.each([
    'QueueDoesNotExist',
    'AccessDenied',
    'InvalidMessageContents',
    'AWS.SimpleQueueService.NonExistentQueue',
  ])('%s is queue.rejected, not unavailable, on every operation', async (name) => {
    const s = stub(() => clientFault(name))
    const queue = adapter(s.client)
    const args = { maxMessages: 1, visibilityTimeoutSeconds: 5, waitSeconds: 0 }
    await expect(queue.publish(ping(1))).rejects.toMatchObject({ code: 'queue.rejected' })
    await expect(queue.publishBatch([ping(1)])).rejects.toMatchObject({ code: 'queue.rejected' })
    await expect(queue.receive(args)).rejects.toMatchObject({ code: 'queue.rejected' })
    await expect(queue.acknowledge('h')).rejects.toMatchObject({ code: 'queue.rejected' })
    await expect(queue.extendVisibility('h', 5)).rejects.toMatchObject({ code: 'queue.rejected' })
  })

  test('a client fault the SDK marks retryable (throttling) stays unavailable', async () => {
    const throttled = Object.assign(clientFault('RequestThrottled'), {
      $retryable: { throttling: true },
    })
    const s = stub(() => throttled)
    await expect(adapter(s.client).publish(ping(1))).rejects.toMatchObject({
      code: 'queue.unavailable',
    })
  })

  test('a server fault is unavailable', async () => {
    const s = stub(() => Object.assign(named('InternalError'), { $fault: 'server' }))
    await expect(adapter(s.client).publish(ping(1))).rejects.toMatchObject({
      code: 'queue.unavailable',
    })
  })

  test('InvalidParameterValue about a receipt handle is a stale receipt; about anything else it is rejected', async () => {
    const receipt = stub(() =>
      clientFault('InvalidParameterValue', 'Value abc for parameter ReceiptHandle is invalid')
    )
    await expect(adapter(receipt.client).extendVisibility('h', 5)).rejects.toMatchObject({
      code: 'queue.receipt_invalid',
    })
    await expect(adapter(receipt.client).acknowledge('h')).resolves.toBeUndefined()
    const other = stub(() =>
      clientFault('InvalidParameterValue', 'Value 99 for parameter VisibilityTimeout is invalid')
    )
    await expect(adapter(other.client).extendVisibility('h', 5)).rejects.toMatchObject({
      code: 'queue.rejected',
    })
  })
})

describe('acknowledge, extend and release', () => {
  test('acknowledge sends DeleteMessage', async () => {
    const s = stub(() => ({}))
    await adapter(s.client).acknowledge('h1')
    expect(inputOf<DeleteMessageCommand>(s.calls[0])).toEqual({
      QueueUrl: 'http://queue.test/000000000000/q',
      ReceiptHandle: 'h1',
    })
  })

  test.each(['ReceiptHandleIsInvalid', 'MessageNotInflight'])(
    'acknowledge treats %s as already settled',
    async (name) => {
      const s = stub(() => named(name))
      await expect(adapter(s.client).acknowledge('h1')).resolves.toBeUndefined()
    }
  )

  test('acknowledge reports any other failure as unavailable', async () => {
    const s = stub(() => named('InternalError'))
    await expect(adapter(s.client).acknowledge('h1')).rejects.toMatchObject({
      code: 'queue.unavailable',
    })
  })

  test('extendVisibility and release send ChangeMessageVisibility', async () => {
    const s = stub(() => ({}))
    const queue = adapter(s.client)
    await queue.extendVisibility('h1', 45)
    await queue.release('h1')
    expect(
      s.calls.map((call) => inputOf<ChangeMessageVisibilityCommand>(call).VisibilityTimeout)
    ).toEqual([45, 0])
    expect(s.calls[0]?.command).toBeInstanceOf(ChangeMessageVisibilityCommand)
  })

  test.each(['ReceiptHandleIsInvalid', 'MessageNotInflight'])(
    '%s becomes queue.receipt_invalid',
    async (name) => {
      const s = stub(() => named(name))
      await expect(adapter(s.client).extendVisibility('h1', 5)).rejects.toMatchObject({
        code: 'queue.receipt_invalid',
      })
    }
  )

  test('other failures are unavailable, and a bad number is refused before any call', async () => {
    const s = stub(() => named('InternalError'))
    const queue = adapter(s.client)
    await expect(queue.release('h1')).rejects.toMatchObject({ code: 'queue.unavailable' })
    await expect(queue.extendVisibility('h1', 43_201)).rejects.toMatchObject({
      code: 'queue.invalid_request',
    })
    await expect(queue.extendVisibility('h1', 1.5)).rejects.toMatchObject({
      code: 'queue.invalid_request',
    })
    expect(s.calls).toHaveLength(1)
  })
})

describe('the real SDK client, against a local stand-in server', () => {
  const saved: Record<string, string | undefined> = {}
  let hits: Array<{ target: string | null; body: string }> = []
  let hang = false
  let server: ReturnType<typeof Bun.serve>

  beforeEach(() => {
    for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) {
      saved[name] = process.env[name]
    }
    process.env.AWS_ACCESS_KEY_ID = 'test-key'
    process.env.AWS_SECRET_ACCESS_KEY = 'test-secret'
    hits = []
    hang = false
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        hits.push({ target: request.headers.get('x-amz-target'), body: await request.text() })
        if (hang) {
          await new Promise(() => undefined)
        }
        return new Response(JSON.stringify({ __type: 'InternalFailure' }), {
          status: 500,
          headers: { 'content-type': 'application/x-amz-json-1.0' },
        })
      },
    })
  })
  afterEach(async () => {
    await server.stop(true)
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
  })

  const real = (extra: { timeoutMs?: number; maxAttempts?: number }) =>
    createSqsQueue({
      queueUrl: 'http://queue.test/000000000000/q',
      region: 'eu-west-1',
      environment: 'local',
      endpoint: `http://127.0.0.1:${server.port}`,
      registry,
      ...extra,
    })

  test('sends a signed SQS request for the queue and retries a server error exactly maxAttempts times', async () => {
    await expect(real({ maxAttempts: 3 }).publish(ping(1))).rejects.toMatchObject({
      code: 'queue.unavailable',
    })
    expect(hits).toHaveLength(3)
    expect(hits[0]?.target).toBe('AmazonSQS.SendMessage')
    const sent = JSON.parse(hits[0]?.body ?? '{}') as { QueueUrl?: string; MessageBody?: string }
    expect(sent.QueueUrl).toBe('http://queue.test/000000000000/q')
    expect(sent.MessageBody).toBe(registry.encode(ping(1)))
  }, 15_000)

  test('maxAttempts 1 means no retry', async () => {
    await expect(real({ maxAttempts: 1 }).publish(ping(1))).rejects.toMatchObject({
      code: 'queue.unavailable',
    })
    expect(hits).toHaveLength(1)
  })

  test('a server that never answers is cut off by the timeout on every attempt', async () => {
    hang = true
    await expect(real({ maxAttempts: 2, timeoutMs: 200 }).publish(ping(1))).rejects.toMatchObject({
      code: 'queue.unavailable',
    })
    expect(hits).toHaveLength(2)
  }, 15_000)
})
