import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import net from 'node:net'
import type {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { createLogger } from '../logger'
import { createS3ObjectStore, type S3Sender } from './aws'
import { encodeCursor } from './validate'

type Command = Parameters<S3Sender['send']>[0]
type Options = Parameters<S3Sender['send']>[1]

const ORG = `org_${'1'.repeat(32)}`
const OTHER = `org_${'2'.repeat(32)}`

interface Call {
  command: Command
  options: Options
}

function inputOf<C extends { input: unknown }>(call: Call | undefined): C['input'] {
  return ((call as Call).command as unknown as C).input
}

function stub(respond: (command: Command, options: Options) => unknown = () => ({})) {
  const calls: Call[] = []
  const client: S3Sender = {
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

function adapter(client: S3Sender, extra: Partial<Parameters<typeof createS3ObjectStore>[0]> = {}) {
  return createS3ObjectStore({
    bucket: 'closeline-test',
    region: 'eu-west-1',
    environment: 'dev',
    client,
    ...extra,
  })
}

function failure(name: string, fault: 'client' | 'server', retryable?: unknown): Error {
  const error = new Error(`${name} for orgs/${ORG}/secret-name.txt`) as Error & {
    $fault: string
    $retryable?: unknown
  }
  error.name = name
  error.$fault = fault
  if (retryable !== undefined) {
    error.$retryable = retryable
  }
  return error
}

describe('construction', () => {
  const NAMES = ['AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_S3']
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const name of NAMES) {
      saved[name] = process.env[name]
      delete process.env[name]
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

  test.each(['dev', 'staging', 'prod'] as const)(
    'an endpoint override is refused in %s',
    (environment) => {
      expect(() =>
        adapter(stub().client, { environment, endpoint: 'http://127.0.0.1:9090' })
      ).toThrow(/only for ENVIRONMENT=local/)
    }
  )

  test('an endpoint override is accepted in local', () => {
    expect(() =>
      adapter(stub().client, { environment: 'local', endpoint: 'http://127.0.0.1:9090' })
    ).not.toThrow()
  })

  test.each(NAMES)(
    '%s in the environment is refused outside local and ignored in local',
    (name) => {
      process.env[name] = 'http://elsewhere.example'
      expect(() => adapter(stub().client, { environment: 'prod' })).toThrow(
        /only for ENVIRONMENT=local/
      )
      expect(() => adapter(stub().client, { environment: 'local' })).not.toThrow()
    }
  )

  test.each([
    [{ bucket: '' }],
    [{ bucket: 'Has Space' }],
    [{ bucket: 'a/b' }],
    [{ timeoutMs: 99 }],
    [{ timeoutMs: 60_001 }],
    [{ timeoutMs: 1000.5 }],
    [{ deadlineMs: 4999 }],
    [{ deadlineMs: 600_001 }],
    [{ maxAttempts: 0 }],
    [{ maxAttempts: 11 }],
    [{ maxObjectBytes: 0 }],
    [{ maxObjectBytes: 100 * 1024 * 1024 + 1 }],
  ])('the option %p is refused', (extra) => {
    expect(() => adapter(stub().client, extra)).toThrow(TypeError)
  })
})

describe('where an object lives', () => {
  test('put writes under orgs/<organization>/<key> in the bucket, with the declared type and length', async () => {
    const { calls, client } = stub()
    const body = new Uint8Array([1, 2, 3])
    await adapter(client, { isOrganizationId: () => true }).put(ORG, 'docs/a.pdf', body, {
      contentType: 'application/pdf',
    })
    expect(calls).toHaveLength(1)
    expect(inputOf<PutObjectCommand>(calls[0])).toEqual({
      Bucket: 'closeline-test',
      Key: `orgs/${ORG}/docs/a.pdf`,
      Body: body,
      ContentLength: 3,
      ContentType: 'application/pdf',
    })
  })

  test('every call carries an attempt timeout and a deadline signal', async () => {
    const { calls, client } = stub((command) =>
      command.constructor.name === 'ListObjectsV2Command' ? { Contents: [] } : {}
    )
    const store = adapter(client, { timeoutMs: 1234, deadlineMs: 20_000 })
    await store.put(ORG, 'k', new Uint8Array())
    await store.delete(ORG, 'k')
    await store.list(ORG)
    expect(calls).toHaveLength(3)
    for (const call of calls) {
      expect(call.options?.requestTimeout).toBe(1234)
      expect(call.options?.abortSignal).toBeInstanceOf(AbortSignal)
      expect(call.options?.abortSignal?.aborted).toBe(false)
    }
  })

  test.each(['../x', '/x', 'a/../b', '%2e%2e/x', 'a%2fb', '.hidden', 'a//b', '', 'x'.repeat(513)])(
    'the key %p never reaches the SDK',
    async (key) => {
      const { calls, client } = stub()
      const store = adapter(client)
      await expect(store.put(ORG, key, new Uint8Array())).rejects.toMatchObject({
        code: 'storage.invalid_request',
      })
      await expect(store.get(ORG, key)).rejects.toMatchObject({ code: 'storage.invalid_request' })
      await expect(store.head(ORG, key)).rejects.toMatchObject({ code: 'storage.invalid_request' })
      await expect(store.delete(ORG, key)).rejects.toMatchObject({
        code: 'storage.invalid_request',
      })
      expect(calls).toEqual([])
    }
  )

  test.each([`${ORG}/../${OTHER}`, `${ORG}/`, '..', '', 'org_a'])(
    'the Organization id %p never reaches the SDK',
    async (id) => {
      const { calls, client } = stub()
      const store = adapter(client)
      await expect(store.get(id, 'k')).rejects.toMatchObject({ code: 'storage.invalid_request' })
      await expect(store.list(id)).rejects.toMatchObject({ code: 'storage.invalid_request' })
      expect(calls).toEqual([])
    }
  )

  test('an oversized body and a bad content type never reach the SDK', async () => {
    const { calls, client } = stub()
    const store = adapter(client, { maxObjectBytes: 10 })
    await expect(store.put(ORG, 'k', new Uint8Array(11))).rejects.toMatchObject({
      code: 'storage.object_too_large',
    })
    await expect(
      store.put(ORG, 'k', new Uint8Array(1), { contentType: 'a\r\nb: c' })
    ).rejects.toMatchObject({ code: 'storage.invalid_request' })
    expect(calls).toEqual([])
  })
})

describe('reading', () => {
  const okOutput = (body: Uint8Array, extra: Record<string, unknown> = {}) => ({
    Body: { transformToByteArray: async () => body },
    ContentLength: body.byteLength,
    ContentType: 'text/plain',
    LastModified: new Date('2026-01-01T00:00:00.000Z'),
    ...extra,
  })

  test('get returns the key relative to the Organization, the size, type and time', async () => {
    const { calls, client } = stub(() => okOutput(new Uint8Array([104, 105])))
    const got = await adapter(client).get(ORG, 'docs/a.txt')
    expect(got).toEqual({
      key: 'docs/a.txt',
      size: 2,
      contentType: 'text/plain',
      lastModified: new Date('2026-01-01T00:00:00.000Z'),
      body: new Uint8Array([104, 105]),
    })
    expect(inputOf<GetObjectCommand>(calls[0])).toEqual({
      Bucket: 'closeline-test',
      Key: `orgs/${ORG}/docs/a.txt`,
    })
  })

  test('a missing content type reads as application/octet-stream', async () => {
    const { client } = stub(() => okOutput(new Uint8Array(), { ContentType: undefined }))
    expect((await adapter(client).get(ORG, 'k'))?.contentType).toBe('application/octet-stream')
  })

  test.each(['NoSuchKey', 'NotFound'])('%s reads as undefined for get and head', async (name) => {
    const { client } = stub(() => failure(name, 'client'))
    const store = adapter(client)
    expect(await store.get(ORG, 'k')).toBeUndefined()
    expect(await store.head(ORG, 'k')).toBeUndefined()
  })

  test('a missing bucket is a refusal, not a missing object', async () => {
    const { client } = stub(() => failure('NoSuchBucket', 'client'))
    await expect(adapter(client).get(ORG, 'k')).rejects.toMatchObject({ code: 'storage.rejected' })
  })

  test('an object larger than the limit is refused before its body is read', async () => {
    let read = false
    const { client } = stub(() => ({
      Body: {
        transformToByteArray: async () => {
          read = true
          return new Uint8Array()
        },
      },
      ContentLength: 11,
      LastModified: new Date(),
    }))
    await expect(adapter(client, { maxObjectBytes: 10 }).get(ORG, 'k')).rejects.toMatchObject({
      code: 'storage.object_too_large',
    })
    expect(read).toBe(false)
  })

  test.each([
    ['no body', { Body: undefined }],
    ['no length', { ContentLength: undefined }],
    ['no time', { LastModified: undefined }],
    ['a body of another size', { ContentLength: 5 }],
  ])('a response with %s is a bad response', async (_label, change) => {
    const { client } = stub(() => okOutput(new Uint8Array([1, 2]), change))
    await expect(adapter(client).get(ORG, 'k')).rejects.toMatchObject({
      code: 'storage.bad_response',
    })
  })

  test('a body that fails while it is read is unavailable', async () => {
    const { client } = stub(() => ({
      Body: {
        transformToByteArray: async () => {
          throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
        },
      },
      ContentLength: 3,
      LastModified: new Date(),
    }))
    await expect(adapter(client).get(ORG, 'k')).rejects.toMatchObject({
      code: 'storage.unavailable',
    })
  })

  test('head sends a HEAD for the same location', async () => {
    const { calls, client } = stub(() => ({
      ContentLength: 4,
      ContentType: 'image/png',
      LastModified: new Date('2026-01-01T00:00:00.000Z'),
    }))
    expect(await adapter(client).head(ORG, 'a.png')).toMatchObject({
      key: 'a.png',
      size: 4,
      contentType: 'image/png',
    })
    expect(inputOf<HeadObjectCommand>(calls[0]).Key).toBe(`orgs/${ORG}/a.png`)
  })
})

describe('failures', () => {
  test.each([
    ['access denied', failure('AccessDenied', 'client'), 'storage.rejected'],
    ['a missing bucket', failure('NoSuchBucket', 'client'), 'storage.rejected'],
    ['throttling', failure('SlowDown', 'client', { throttling: true }), 'storage.unavailable'],
    ['a server fault', failure('InternalError', 'server'), 'storage.unavailable'],
    ['a timeout', failure('TimeoutError', 'client', {}), 'storage.unavailable'],
    [
      'an abort at the deadline',
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
      'storage.unavailable',
    ],
    [
      'a dropped connection',
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      'storage.unavailable',
    ],
    [
      'a refused connection',
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      'storage.unavailable',
    ],
    [
      'a name lookup failure',
      Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' }),
      'storage.unavailable',
    ],
    [
      'a 502 with no fault named',
      Object.assign(new Error('bad gateway'), { $metadata: { httpStatusCode: 502 } }),
      'storage.unavailable',
    ],
    [
      'a 400 with no fault named',
      Object.assign(new Error('bad request'), { $metadata: { httpStatusCode: 400 } }),
      'storage.rejected',
    ],
    [
      'a credentials provider failure',
      Object.assign(new Error('Could not load credentials from any providers'), {
        name: 'CredentialsProviderError',
      }),
      'storage.rejected',
    ],
    [
      'an error with no status and no name we know',
      new Error('something broke'),
      'storage.rejected',
    ],
  ])('%s becomes %s', async (_label, error, code) => {
    const { client } = stub(() => error)
    const store = adapter(client)
    await expect(store.put(ORG, 'k', new Uint8Array())).rejects.toMatchObject({ code })
    await expect(store.list(ORG)).rejects.toMatchObject({ code })
    await expect(store.delete(ORG, 'k')).rejects.toMatchObject({ code })
  })

  test('an error carries the SDK error as cause but no key, bucket path or body in its message', async () => {
    const { client } = stub(() => failure('AccessDenied', 'client'))
    const error = await adapter(client)
      .put(ORG, 'secret-name.txt', new TextEncoder().encode('SECRET BODY'))
      .catch((e: Error) => e)
    expect((error as Error).message).not.toContain('secret-name')
    expect((error as Error).message).not.toContain(ORG)
    expect(JSON.stringify(error)).not.toContain('SECRET BODY')
    expect((error as Error).cause).toMatchObject({ name: 'AccessDenied' })
  })

  /** Every string reachable from `value` through own properties, including non-enumerable ones. */
  function allStrings(value: unknown, seen = new Set<unknown>(), out: string[] = []): string[] {
    if (typeof value === 'string') {
      out.push(value)
    } else if (typeof value === 'object' && value !== null && !seen.has(value)) {
      seen.add(value)
      for (const name of Object.getOwnPropertyNames(value)) {
        out.push(name)
        allStrings((value as Record<string, unknown>)[name], seen, out)
      }
    }
    return out
  }

  test('the cause is a reduced description: no key, Organization id, response or SDK object', async () => {
    const sdkError = Object.assign(new Error(`Access denied to orgs/${ORG}/secret-name.txt`), {
      name: 'AccessDenied',
      $fault: 'client',
      $metadata: { httpStatusCode: 403, requestId: 'REQ-123' },
      $response: {
        body: `orgs/${ORG}/secret-name.txt`,
        headers: { 'x-amz-key': 'secret-name.txt' },
      },
      Key: `orgs/${ORG}/secret-name.txt`,
    })
    const { client } = stub(() => sdkError)
    const store = adapter(client)
    const attempts = [
      store.put(ORG, 'secret-name.txt', new Uint8Array()),
      store.get(ORG, 'secret-name.txt'),
      store.head(ORG, 'secret-name.txt'),
      store.delete(ORG, 'secret-name.txt'),
      store.list(ORG, { prefix: 'secret-name' }),
    ]
    for (const attempt of attempts) {
      const error = (await attempt.catch((e: unknown) => e)) as Error
      expect((error as { code?: string }).code).toBe('storage.rejected')
      expect(error.cause).not.toBe(sdkError)
      expect(error.cause).toEqual({
        name: 'AccessDenied',
        httpStatus: 403,
        requestId: 'REQ-123',
        fault: 'client',
      })
      for (const text of allStrings(error)) {
        expect(text).not.toContain('secret-name')
        expect(text).not.toContain(ORG)
      }
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('secret-name')
      const lines: string[] = []
      createLogger({
        service: 't',
        level: 'debug',
        destination: { write: (l) => lines.push(l) },
      }).error('failed', { err: error })
      expect(lines.join('')).not.toContain('secret-name')
      expect(lines.join('')).not.toContain(ORG)
    }
  })

  test('deleting a key the store reports missing still resolves, and a refusal does not', async () => {
    await adapter(stub(() => failure('NoSuchKey', 'client')).client).delete(ORG, 'k')
    await expect(
      adapter(stub(() => failure('AccessDenied', 'client')).client).delete(ORG, 'k')
    ).rejects.toMatchObject({ code: 'storage.rejected' })
  })

  test('delete sends one DeleteObject for the exact location', async () => {
    const { calls, client } = stub()
    await adapter(client).delete(ORG, 'a/b.txt')
    expect(inputOf<DeleteObjectCommand>(calls[0])).toEqual({
      Bucket: 'closeline-test',
      Key: `orgs/${ORG}/a/b.txt`,
    })
  })
})

describe('listing', () => {
  const entry = (key: string) => ({
    Key: key,
    Size: 3,
    LastModified: new Date('2026-01-01T00:00:00.000Z'),
  })

  test("asks for the Organization's prefix and the page size, and returns relative keys", async () => {
    const { calls, client } = stub(() => ({
      Contents: [entry(`orgs/${ORG}/docs/a`), entry(`orgs/${ORG}/docs/b`)],
      IsTruncated: false,
    }))
    const page = await adapter(client).list(ORG, { prefix: 'docs/', limit: 50 })
    expect(inputOf<ListObjectsV2Command>(calls[0])).toEqual({
      Bucket: 'closeline-test',
      Prefix: `orgs/${ORG}/docs/`,
      MaxKeys: 50,
    })
    expect(page.items.map((item) => item.key)).toEqual(['docs/a', 'docs/b'])
    expect(page.nextCursor).toBeUndefined()
  })

  test("a list without a limit asks for 100, and with no prefix asks for the Organization's alone", async () => {
    const { calls, client } = stub(() => ({ Contents: [] }))
    await adapter(client).list(ORG)
    expect(inputOf<ListObjectsV2Command>(calls[0])).toEqual({
      Bucket: 'closeline-test',
      Prefix: `orgs/${ORG}/`,
      MaxKeys: 100,
    })
  })

  test('a truncated page gives a cursor that starts the next one after the last key', async () => {
    const { calls, client } = stub(() => ({
      Contents: [entry(`orgs/${ORG}/a`), entry(`orgs/${ORG}/b`)],
      IsTruncated: true,
    }))
    const store = adapter(client)
    const page = await store.list(ORG, { limit: 2 })
    expect(page.nextCursor).toBe(encodeCursor('b'))
    await store.list(ORG, { limit: 2, cursor: page.nextCursor as string })
    expect(inputOf<ListObjectsV2Command>(calls[1]).StartAfter).toBe(`orgs/${ORG}/b`)
  })

  test('a cursor cannot start anywhere outside the Organization', async () => {
    const { calls, client } = stub(() => ({ Contents: [] }))
    const store = adapter(client)
    for (const key of [`../${OTHER}/x`, `/${OTHER}/x`]) {
      await expect(
        store.list(ORG, { cursor: Buffer.from(key).toString('base64url') })
      ).rejects.toMatchObject({
        code: 'storage.invalid_request',
      })
    }
    expect(calls).toEqual([])
  })

  test.each([
    ['a key of another Organization', [entry(`orgs/${OTHER}/x`)]],
    ['a key of an Organization whose id starts with this one', [entry(`orgs/${ORG}ff/x`)]],
    ['a key with an odd shape', [entry(`orgs/${ORG}/a//b`)]],
    ['no size', [{ Key: `orgs/${ORG}/a`, LastModified: new Date() }]],
    ['no key', [{ Size: 1, LastModified: new Date() }]],
  ])('a listing that holds %s is a bad response', async (_label, Contents) => {
    const { client } = stub(() => ({ Contents }))
    await expect(adapter(client).list(ORG)).rejects.toMatchObject({ code: 'storage.bad_response' })
  })

  test('a listing with more keys than asked for is a bad response', async () => {
    const { client } = stub(() => ({
      Contents: [entry(`orgs/${ORG}/a`), entry(`orgs/${ORG}/b`)],
    }))
    await expect(adapter(client).list(ORG, { limit: 1 })).rejects.toMatchObject({
      code: 'storage.bad_response',
    })
  })
})

describe('against a real SDK client and a local server', () => {
  const hits: Array<{ method: string; path: string }> = []
  let respond: (request: Request) => Response | Promise<Response> = () => new Response('')
  let server: ReturnType<typeof Bun.serve>
  const savedKeys = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY }

  beforeAll(() => {
    process.env.AWS_ACCESS_KEY_ID = 'test'
    process.env.AWS_SECRET_ACCESS_KEY = 'test'
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => {
        hits.push({ method: request.method, path: new URL(request.url).pathname })
        return respond(request)
      },
    })
  })
  afterAll(async () => {
    await server.stop(true)
    for (const [name, value] of [
      ['AWS_ACCESS_KEY_ID', savedKeys.id],
      ['AWS_SECRET_ACCESS_KEY', savedKeys.secret],
    ] as const) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
  })
  beforeEach(() => {
    hits.length = 0
  })

  const xmlError = (status: number, code: string) =>
    new Response(
      `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>no</Message></Error>`,
      {
        status,
        headers: { 'content-type': 'application/xml' },
      }
    )
  const real = (extra: Partial<Parameters<typeof createS3ObjectStore>[0]> = {}) =>
    createS3ObjectStore({
      bucket: 'closeline-test',
      region: 'eu-west-1',
      environment: 'local',
      endpoint: `http://127.0.0.1:${server.port}`,
      timeoutMs: 1000,
      ...extra,
    })

  test('a put goes to the path-style location of the Organization', async () => {
    respond = () => new Response('', { status: 200, headers: { etag: '"x"' } })
    await real().put(ORG, 'docs/a.txt', new Uint8Array([1]), { contentType: 'text/plain' })
    expect(hits).toEqual([{ method: 'PUT', path: `/closeline-test/orgs/${ORG}/docs/a.txt` }])
  })

  test('a throttled call is retried and then succeeds, and the retry is the same request', async () => {
    let n = 0
    respond = () => (++n === 1 ? xmlError(503, 'SlowDown') : new Response('', { status: 200 }))
    await real({ maxAttempts: 3 }).put(ORG, 'k', new Uint8Array([1]))
    expect(hits).toHaveLength(2)
    expect(hits[1]).toEqual(hits[0] as { method: string; path: string })
  })

  test('retries stop at maxAttempts and end as unavailable', async () => {
    respond = () => xmlError(500, 'InternalError')
    await expect(real({ maxAttempts: 2 }).delete(ORG, 'k')).rejects.toMatchObject({
      code: 'storage.unavailable',
    })
    expect(hits).toHaveLength(2)
  })

  test('access denied is not retried and is a refusal', async () => {
    respond = () => xmlError(403, 'AccessDenied')
    await expect(real({ maxAttempts: 3 }).put(ORG, 'k', new Uint8Array())).rejects.toMatchObject({
      code: 'storage.rejected',
    })
    expect(hits).toHaveLength(1)
  })

  test('a missing key reads as undefined without a retry', async () => {
    respond = () => xmlError(404, 'NoSuchKey')
    expect(await real({ maxAttempts: 3 }).get(ORG, 'k')).toBeUndefined()
    expect(hits).toHaveLength(1)
  })

  test('a get returns the bytes the server sent', async () => {
    respond = () =>
      new Response(new Uint8Array([7, 8, 9]), {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'last-modified': 'Thu, 01 Jan 2026 00:00:00 GMT',
        },
      })
    const got = await real().get(ORG, 'k')
    expect([...(got?.body ?? [])]).toEqual([7, 8, 9])
    expect(got?.size).toBe(3)
    expect(got?.lastModified).toEqual(new Date('2026-01-01T00:00:00.000Z'))
  })

  test('a server that never answers ends as unavailable within the bounds', async () => {
    respond = () => new Promise<Response>(() => undefined)
    const started = performance.now()
    await expect(real({ timeoutMs: 100, maxAttempts: 1 }).get(ORG, 'k')).rejects.toMatchObject({
      code: 'storage.unavailable',
    })
    expect(performance.now() - started).toBeLessThan(5000)
  })

  test('the deadline ends an operation even when attempts keep failing slowly', async () => {
    respond = () => new Promise<Response>(() => undefined)
    const started = performance.now()
    await expect(
      real({ timeoutMs: 1000, deadlineMs: 1000, maxAttempts: 5 }).get(ORG, 'k')
    ).rejects.toMatchObject({ code: 'storage.unavailable' })
    expect(performance.now() - started).toBeLessThan(4000)
  })
})

describe('a response body that is refused is not left open', () => {
  let open = 0
  const sockets = new Set<net.Socket>()
  // Answers every request with headers for `length` bytes and 5 bytes of body, then goes quiet,
  // so a client that does not read or destroy the body keeps the connection open.
  let announce = { length: 1000, withTime: true }
  const server = net.createServer((socket) => {
    open += 1
    sockets.add(socket)
    socket.on('error', () => undefined)
    socket.on('close', () => {
      open -= 1
      sockets.delete(socket)
    })
    socket.on('data', () => {
      socket.write(
        `HTTP/1.1 200 OK\r\nContent-Length: ${announce.length}\r\nContent-Type: text/plain\r\n` +
          (announce.withTime ? 'Last-Modified: Thu, 01 Jan 2026 00:00:00 GMT\r\n' : '') +
          '\r\n12345'
      )
    })
  })
  let port = 0
  const saved = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY }
  beforeAll(async () => {
    process.env.AWS_ACCESS_KEY_ID = 'test'
    process.env.AWS_SECRET_ACCESS_KEY = 'test'
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as net.AddressInfo).port
  })
  afterAll(() => {
    for (const socket of sockets) {
      socket.destroy()
    }
    server.close()
    for (const [name, value] of [
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
  const store = () =>
    createS3ObjectStore({
      bucket: 'closeline-test',
      region: 'eu-west-1',
      environment: 'local',
      endpoint: `http://127.0.0.1:${port}`,
      maxObjectBytes: 10,
      timeoutMs: 5000,
      maxAttempts: 1,
    })
  async function settle(): Promise<number> {
    for (let i = 0; i < 40 && open > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return open
  }

  test('several gets of an oversize object leave no connection open', async () => {
    announce = { length: 1000, withTime: true }
    const objects = store()
    for (let i = 0; i < 5; i++) {
      await expect(objects.get(ORG, `big${i}`)).rejects.toMatchObject({
        code: 'storage.object_too_large',
      })
    }
    expect(await settle()).toBe(0)
  })

  test('several gets of an object the store describes badly leave no connection open', async () => {
    announce = { length: 8, withTime: false }
    const objects = store()
    for (let i = 0; i < 5; i++) {
      await expect(objects.get(ORG, `odd${i}`)).rejects.toMatchObject({
        code: 'storage.bad_response',
      })
    }
    expect(await settle()).toBe(0)
  })
})
