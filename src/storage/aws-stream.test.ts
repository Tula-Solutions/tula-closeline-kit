import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { createS3ObjectStore, type S3Sender } from './aws'

type Command = Parameters<S3Sender['send']>[0]

const ORG = `org_${'1'.repeat(32)}`
const MIB = 1024 * 1024

interface Seen {
  name: string
  input: Record<string, unknown>
}

/** An S3 stand-in that records commands and keeps only the hash of each part body. */
function multipartStub(fail?: (name: string, number: number) => Error | undefined) {
  const seen: Seen[] = []
  const parts = new Map<number, Buffer>()
  let live = 0
  let peakLive = 0
  const client: S3Sender = {
    send: async (command: Command) => {
      const name = command.constructor.name
      const input = (command as unknown as { input: Record<string, unknown> }).input
      // Keep no part body: a stub that retained them would hide (or fake) a leak.
      const { Body: _body, ...kept } = input
      seen.push({ name, input: kept })
      if (name === 'UploadPartCommand') {
        const number = input.PartNumber as number
        const error = fail?.(name, number)
        live += 1
        peakLive = Math.max(peakLive, live)
        await new Promise((resolve) => setTimeout(resolve, 1))
        const body = input.Body as Buffer
        parts.set(number, createHash('sha256').update(body).digest())
        live -= 1
        if (error !== undefined) {
          throw error
        }
        return { ETag: `"etag-${number}"` }
      }
      if (name === 'CreateMultipartUploadCommand') {
        return { UploadId: 'upload-1' }
      }
      return {}
    },
  }
  return { client, seen, names: () => seen.map((entry) => entry.name), peak: () => peakLive }
}

function adapter(client: S3Sender, extra: Record<string, number> = {}) {
  return createS3ObjectStore({
    bucket: 'closeline-test',
    region: 'eu-west-1',
    environment: 'dev',
    client,
    partBytes: 5 * MIB,
    ...extra,
  })
}

async function* chunks(total: number, size = 64 * 1024): AsyncGenerator<Uint8Array> {
  const chunk = new Uint8Array(size).fill(7)
  for (let sent = 0; sent < total; sent += size) {
    yield chunk.subarray(0, Math.min(size, total - sent))
  }
}

describe('S3 streamed put', () => {
  test('a body of one part or less is one PutObject, an empty one too', async () => {
    const stub = multipartStub()
    const store = adapter(stub.client)

    const result = await store.putStream(ORG, 'small', chunks(1000), { maxBytes: 10 * MIB })
    await store.putStream(ORG, 'empty', chunks(0), { maxBytes: 10 * MIB })

    expect(stub.names()).toEqual(['PutObjectCommand', 'PutObjectCommand'])
    expect(result.size).toBe(1000)
    expect(stub.seen[0]?.input.Key).toBe(`orgs/${ORG}/small`)
    expect(stub.seen[1]?.input.ContentLength).toBe(0)
  })

  test('a larger body is a multipart upload in parts of the set size, completed in order', async () => {
    const stub = multipartStub()
    const store = adapter(stub.client)
    const total = 12 * MIB + 5

    const result = await store.putStream(ORG, 'big', chunks(total), {
      maxBytes: 20 * MIB,
      contentType: 'audio/wav',
    })

    expect(stub.names()).toEqual([
      'CreateMultipartUploadCommand',
      'UploadPartCommand',
      'UploadPartCommand',
      'UploadPartCommand',
      'CompleteMultipartUploadCommand',
    ])
    const sizes = stub.seen
      .filter((e) => e.name === 'UploadPartCommand')
      .map((e) => e.input.ContentLength)
    expect(sizes).toEqual([5 * MIB, 5 * MIB, 2 * MIB + 5])
    expect(stub.seen[0]?.input.ContentType).toBe('audio/wav')
    const complete = stub.seen.at(-1)?.input.MultipartUpload as {
      Parts: Array<{ PartNumber: number }>
    }
    expect(complete.Parts.map((part) => part.PartNumber)).toEqual([1, 2, 3])
    const expected = createHash('sha256')
    for await (const chunk of chunks(total)) {
      expected.update(chunk)
    }
    expect(result).toEqual({ size: total, sha256: expected.digest('hex') })
  })

  test('a body of exactly two parts has two parts and no empty third', async () => {
    const stub = multipartStub()
    await adapter(stub.client).putStream(ORG, 'two', chunks(10 * MIB), { maxBytes: 20 * MIB })

    expect(stub.names().filter((name) => name === 'UploadPartCommand')).toHaveLength(2)
  })

  test('at most partConcurrency parts upload at once', async () => {
    const stub = multipartStub()
    await adapter(stub.client, { partConcurrency: 3 }).putStream(ORG, 'k', chunks(40 * MIB), {
      maxBytes: 50 * MIB,
    })

    expect(stub.peak()).toBeGreaterThan(1)
    expect(stub.peak()).toBeLessThanOrEqual(3)
  })

  test('a stream over the limit aborts the multipart upload and never completes it', async () => {
    const stub = multipartStub()

    await expect(
      adapter(stub.client).putStream(ORG, 'big', chunks(30 * MIB), { maxBytes: 12 * MIB })
    ).rejects.toMatchObject({ code: 'storage.object_too_large' })

    expect(stub.names()).toContain('AbortMultipartUploadCommand')
    expect(stub.names()).not.toContain('CompleteMultipartUploadCommand')
    expect(stub.seen.at(-1)?.input.UploadId).toBe('upload-1')
  })

  test('a failing part aborts the upload, stops reading and reports unavailable or rejected', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'AccessDenied', $fault: 'client' })
    const stub = multipartStub((_name, number) => (number === 2 ? denied : undefined))
    let read = 0
    async function* counted(): AsyncGenerator<Uint8Array> {
      for await (const chunk of chunks(200 * MIB)) {
        read += chunk.byteLength
        yield chunk
      }
    }

    await expect(
      adapter(stub.client).putStream(ORG, 'k', counted(), { maxBytes: 300 * MIB })
    ).rejects.toMatchObject({ code: 'storage.rejected' })

    expect(stub.names().at(-1)).toBe('AbortMultipartUploadCommand')
    expect(stub.names()).not.toContain('CompleteMultipartUploadCommand')
    expect(read).toBeLessThan(40 * MIB)
  })

  test('a source that fails midway aborts the upload', async () => {
    const stub = multipartStub()
    async function* broken(): AsyncGenerator<Uint8Array> {
      yield* chunks(7 * MIB)
      throw new Error('the client went away')
    }

    await expect(
      adapter(stub.client).putStream(ORG, 'k', broken(), { maxBytes: 50 * MIB })
    ).rejects.toMatchObject({ code: 'storage.invalid_request' })

    expect(stub.names().at(-1)).toBe('AbortMultipartUploadCommand')
  })

  test('a fired signal aborts the upload', async () => {
    const stub = multipartStub()
    const controller = new AbortController()
    async function* aborting(): AsyncGenerator<Uint8Array> {
      yield* chunks(7 * MIB)
      controller.abort()
      yield* chunks(7 * MIB)
    }

    await expect(
      adapter(stub.client).putStream(ORG, 'k', aborting(), {
        maxBytes: 50 * MIB,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: 'storage.unavailable' })

    expect(stub.names().at(-1)).toBe('AbortMultipartUploadCommand')
  })

  test('a source that stalls ends the write with unavailable', async () => {
    const stub = multipartStub()
    const stalled = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) })
    const started = performance.now()

    await expect(
      adapter(stub.client).putStream(ORG, 'k', stalled, { maxBytes: MIB, idleTimeoutMs: 50 })
    ).rejects.toMatchObject({ code: 'storage.unavailable' })
    expect(performance.now() - started).toBeLessThan(2000)
  })

  test('memory stays flat while 300 MiB go through', async () => {
    const stub = multipartStub()
    const store = adapter(stub.client, { partBytes: 8 * MIB })
    const used = () => {
      const usage = process.memoryUsage()
      return usage.heapUsed + usage.arrayBuffers
    }
    Bun.gc(true)
    const before = used()
    let peak = before
    async function* sampled(): AsyncGenerator<Uint8Array> {
      let count = 0
      for await (const chunk of chunks(300 * MIB, 256 * 1024)) {
        count += 1
        if (count % 32 === 0) {
          Bun.gc(true)
          peak = Math.max(peak, used())
        }
        yield chunk
      }
    }

    const result = await store.putStream(ORG, 'huge', sampled(), { maxBytes: 400 * MIB })

    expect(result.size).toBe(300 * MIB)
    // Bound: a few parts of 8 MiB (about 32 MiB) plus slack; the object itself is 300 MiB.
    expect(peak - before).toBeLessThan(64 * MIB)
  }, 60_000)

  test('partBytes and partConcurrency outside their range are refused at construction', () => {
    const { client } = multipartStub()

    expect(() => adapter(client, { partBytes: 4 * MIB })).toThrow(TypeError)
    expect(() => adapter(client, { partBytes: 65 * MIB })).toThrow(TypeError)
    expect(() => adapter(client, { partConcurrency: 0 })).toThrow(TypeError)
    expect(() => adapter(client, { partConcurrency: 9 })).toThrow(TypeError)
  })
})

describe('S3 streamed get', () => {
  test('returns the body as a stream with the object info and no size cap', async () => {
    const body = new Uint8Array([1, 2, 3])
    const client: S3Sender = {
      send: async () => ({
        ContentLength: 3,
        ContentType: 'audio/ogg',
        LastModified: new Date(0),
        Body: { transformToWebStream: () => new Blob([body]).stream() },
      }),
    }
    const store = adapter(client, {})

    const got = await store.getStream(ORG, 'k')

    expect(got?.size).toBe(3)
    expect(got?.contentType).toBe('audio/ogg')
    expect(new Uint8Array(await new Response(got?.body).arrayBuffer())).toEqual(body)
  })

  test('an object that is missing is undefined', async () => {
    const missing = Object.assign(new Error('x'), { name: 'NoSuchKey' })
    const store = adapter({
      send: async () => {
        throw missing
      },
    })

    expect(await store.getStream(ORG, 'k')).toBeUndefined()
  })
})
