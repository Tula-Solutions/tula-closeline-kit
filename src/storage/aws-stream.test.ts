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

interface StubOptions {
  /** Throws for this part after it was stored. */
  fail?: (number: number) => Error | undefined
  /** Milliseconds an UploadPart takes, by part number. */
  delay?: (number: number) => number
  /** Throws from Complete after the object was assembled and kept (the store finished, the answer was lost). */
  completeError?: Error
}

/**
 * An S3 stand-in that really reassembles: it keeps every part body it is sent (a copy, so a
 * caller that reuses its buffer is caught), checks the ETags and order Complete lists, and keeps
 * the finished object. Commands are recorded without their bodies.
 */
function multipartStub(options: StubOptions = {}) {
  const seen: Seen[] = []
  const parts = new Map<number, { bytes: Buffer; etag: string }>()
  let object: Buffer | undefined
  let live = 0
  let peakLive = 0
  const client: S3Sender = {
    send: async (command: Command) => {
      const name = command.constructor.name
      const input = (command as unknown as { input: Record<string, unknown> }).input
      const { Body: body, ...kept } = input
      seen.push({ name, input: kept })
      if (name === 'PutObjectCommand') {
        object = Buffer.from(body as Uint8Array)
        return {}
      }
      if (name === 'UploadPartCommand') {
        const number = input.PartNumber as number
        live += 1
        peakLive = Math.max(peakLive, live)
        await new Promise((resolve) => setTimeout(resolve, options.delay?.(number) ?? 1))
        // Read the body only now, as the SDK does while it sends: a buffer the caller reused meanwhile shows.
        const bytes = Buffer.from(body as Uint8Array)
        const etag = `"${createHash('md5').update(bytes).digest('hex')}"`
        parts.set(number, { bytes, etag })
        live -= 1
        const error = options.fail?.(number)
        if (error !== undefined) {
          throw error
        }
        return { ETag: etag }
      }
      if (name === 'CreateMultipartUploadCommand') {
        return { UploadId: 'upload-1' }
      }
      if (name === 'CompleteMultipartUploadCommand') {
        const listed = (
          input.MultipartUpload as { Parts: Array<{ ETag: string; PartNumber: number }> }
        ).Parts
        const chunks: Buffer[] = []
        for (const [index, part] of listed.entries()) {
          const held = parts.get(part.PartNumber)
          if (held === undefined || held.etag !== part.ETag || part.PartNumber !== index + 1) {
            throw Object.assign(new Error('InvalidPart'), { name: 'InvalidPart', $fault: 'client' })
          }
          chunks.push(held.bytes)
        }
        object = Buffer.concat(chunks)
        if (options.completeError !== undefined) {
          throw options.completeError
        }
      }
      return {}
    },
  }
  return {
    client,
    seen,
    names: () => seen.map((entry) => entry.name),
    peak: () => peakLive,
    object: () => object,
  }
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

/** Deterministic bytes that never repeat within a chunk or across chunks (xorshift32). */
function bytesOf(total: number): Buffer {
  const out = Buffer.allocUnsafe(total)
  let x = 0x9e3779b9
  for (let i = 0; i < total; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    out[i] = x & 0xff
  }
  return out
}

async function* chunks(total: number, size = 64 * 1024): AsyncGenerator<Uint8Array> {
  const all = bytesOf(total)
  for (let at = 0; at < total; at += size) {
    // A fresh copy per chunk, as a network source hands out.
    yield Uint8Array.from(all.subarray(at, Math.min(at + size, total)))
  }
}

/** Chunks of a size that does not divide the part size, so part boundaries fall inside a chunk. */
const ODD = 64 * 1024 + 13

const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

describe('S3 streamed put', () => {
  test('a body of one part or less is one PutObject, an empty one too', async () => {
    const stub = multipartStub()
    const store = adapter(stub.client)

    const result = await store.putStream(ORG, 'small', chunks(1000), { maxBytes: 10 * MIB })
    expect(stub.object()).toEqual(bytesOf(1000))
    await store.putStream(ORG, 'empty', chunks(0), { maxBytes: 10 * MIB })

    expect(stub.names()).toEqual(['PutObjectCommand', 'PutObjectCommand'])
    expect(result).toEqual({ size: 1000, sha256: sha(bytesOf(1000)) })
    expect(stub.seen[0]?.input.Key).toBe(`orgs/${ORG}/small`)
    expect(stub.seen[1]?.input.ContentLength).toBe(0)
    expect(stub.object()?.byteLength).toBe(0)
  })

  test('a larger body is a multipart upload whose reassembled bytes are the source, in order', async () => {
    const stub = multipartStub()
    const total = 12 * MIB + 5

    const result = await adapter(stub.client).putStream(ORG, 'big', chunks(total, ODD), {
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
    // The stub reassembled what Complete listed, checking every ETag against the part it holds.
    const object = stub.object() as Buffer
    expect(object.equals(bytesOf(total))).toBe(true)
    expect(result).toEqual({ size: total, sha256: sha(bytesOf(total)) })
    const complete = stub.seen.at(-1)?.input.MultipartUpload as {
      Parts: Array<{ PartNumber: number }>
    }
    const listed = complete.Parts
    expect(listed.map((part) => part.PartNumber)).toEqual([1, 2, 3])
  })

  test('parts that finish out of order are still completed in part order', async () => {
    // Part 1 is the slowest, so it finishes last: dropping the sort lists [2, 3, 1].
    const stub = multipartStub({ delay: (number) => (number === 1 ? 60 : number === 2 ? 30 : 1) })
    const total = 12 * MIB

    await adapter(stub.client, { partConcurrency: 3 }).putStream(ORG, 'k', chunks(total, ODD), {
      maxBytes: 20 * MIB,
    })

    expect((stub.object() as Buffer).equals(bytesOf(total))).toBe(true)
  })

  test('a part still uploading is not overwritten while the next part fills', async () => {
    // Every part takes 80 ms while the next 5 MiB arrive at once: a reused buffer corrupts part 1.
    const stub = multipartStub({ delay: () => 80 })
    const total = 17 * MIB + 3

    await adapter(stub.client, { partConcurrency: 2 }).putStream(ORG, 'k', chunks(total, ODD), {
      maxBytes: 30 * MIB,
    })

    expect((stub.object() as Buffer).equals(bytesOf(total))).toBe(true)
  })

  test('a body of exactly two parts has two parts and no empty third', async () => {
    const stub = multipartStub()
    await adapter(stub.client).putStream(ORG, 'two', chunks(10 * MIB), { maxBytes: 20 * MIB })

    expect(stub.names().filter((name) => name === 'UploadPartCommand')).toHaveLength(2)
    expect((stub.object() as Buffer).equals(bytesOf(10 * MIB))).toBe(true)
  })

  test('at most partConcurrency parts upload at once', async () => {
    const stub = multipartStub({ delay: () => 5 })
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
    expect(stub.object()).toBeUndefined()
  })

  test('a failing part aborts the upload, stops reading and reports rejected', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'AccessDenied', $fault: 'client' })
    const stub = multipartStub({ fail: (number) => (number === 2 ? denied : undefined) })
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

    await expect(
      adapter(stub.client).putStream(ORG, 'k', stalled, { maxBytes: MIB, idleTimeoutMs: 50 })
    ).rejects.toMatchObject({ code: 'storage.unavailable' })
  })

  test('Complete that times out after the store finished: the call throws, the object may exist, abort is only attempted', async () => {
    // The documented residual case: a throw after the last part was sent means the content under
    // the key is unknown. Here the store did finish; the caller cannot tell from the error.
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    const stub = multipartStub({ completeError: timeout })
    const total = 12 * MIB

    await expect(
      adapter(stub.client).putStream(ORG, 'k', chunks(total), { maxBytes: 20 * MIB })
    ).rejects.toMatchObject({ code: 'storage.unavailable' })

    expect((stub.object() as Buffer).equals(bytesOf(total))).toBe(true)
    expect(stub.names().at(-1)).toBe('AbortMultipartUploadCommand')
    // Writing the same stream again is safe: put is idempotent.
    const again = multipartStub()
    await adapter(again.client).putStream(ORG, 'k', chunks(total), { maxBytes: 20 * MIB })
    expect((again.object() as Buffer).equals(bytesOf(total))).toBe(true)
  })

  test('memory stays flat while 300 MiB go through', async () => {
    const used = () => {
      const usage = process.memoryUsage()
      return usage.heapUsed + usage.arrayBuffers
    }
    // The stub keeps no part, so memory use is the adapter's alone.
    const keepNothing: S3Sender = {
      send: async (command: Command) => {
        const name = command.constructor.name
        const input = (command as unknown as { input: { PartNumber?: number } }).input
        if (name === 'CreateMultipartUploadCommand') {
          return { UploadId: 'u' }
        }
        if (name === 'UploadPartCommand') {
          return { ETag: `"${input.PartNumber}"` }
        }
        return {}
      },
    }
    const flat = adapter(keepNothing, { partBytes: 8 * MIB })
    Bun.gc(true)
    const before = used()
    let peak = before
    async function* sampled(): AsyncGenerator<Uint8Array> {
      let count = 0
      const block = new Uint8Array(256 * 1024).fill(5)
      for (let sent = 0; sent < 300 * MIB; sent += block.byteLength) {
        count += 1
        if (count % 32 === 0) {
          Bun.gc(true)
          peak = Math.max(peak, used())
        }
        yield block
      }
    }

    const result = await flat.putStream(ORG, 'huge', sampled(), { maxBytes: 400 * MIB })

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
  const object = (body: ReadableStream<Uint8Array>, destroy?: () => void) => ({
    ContentLength: 6,
    ContentType: 'audio/ogg',
    LastModified: new Date(0),
    Body: { transformToWebStream: () => body, ...(destroy === undefined ? {} : { destroy }) },
  })

  test('returns the body as a stream with the object info and no size cap', async () => {
    const body = new Uint8Array([1, 2, 3])
    const store = adapter({
      send: async () => object(new Blob([body]).stream()),
    })

    const got = await store.getStream(ORG, 'k')

    expect(got?.size).toBe(6)
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

  test('the per-call deadline covers the headers only: a body read after it still completes', async () => {
    let signal: AbortSignal | undefined
    const slow = new ReadableStream<Uint8Array>({
      async start(controller) {
        await new Promise((resolve) => setTimeout(resolve, 350))
        controller.enqueue(new Uint8Array([1, 2, 3]))
        controller.close()
      },
    })
    const store = adapter(
      {
        send: async (_command, options) => {
          signal = options?.abortSignal
          return object(slow)
        },
      },
      { timeoutMs: 100, deadlineMs: 100 }
    )

    const got = await store.getStream(ORG, 'k')
    await new Promise((resolve) => setTimeout(resolve, 250))
    const bytes = new Uint8Array(await new Response(got?.body).arrayBuffer())

    expect(bytes).toEqual(new Uint8Array([1, 2, 3]))
    // The deadline would have fired by now had it stayed live.
    expect(signal?.aborted).toBe(false)
  })

  test('the deadline still bounds getting the headers', async () => {
    const store = adapter(
      {
        send: (_command, options) =>
          new Promise((_resolve, reject) => {
            options?.abortSignal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            )
          }),
      },
      { timeoutMs: 100, deadlineMs: 120 }
    )

    await expect(store.getStream(ORG, 'k')).rejects.toMatchObject({ code: 'storage.unavailable' })
  })

  test('a mid-stream failure reaches the reader as a StorageError, and the connection is released', async () => {
    let destroyed = 0
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]))
        queueMicrotask(() => controller.error(new Error('ECONNRESET to 10.0.0.5')))
      },
    })
    const store = adapter({
      send: async () =>
        object(failing, () => {
          destroyed += 1
        }),
    })
    const got = await store.getStream(ORG, 'k')

    const read = (async () => {
      const stream = got?.body as ReadableStream<Uint8Array>
      for await (const _chunk of stream) {
        // read until it fails
      }
    })()

    await expect(read).rejects.toMatchObject({ name: 'StorageError', code: 'storage.unavailable' })
    await expect(read).rejects.not.toMatchObject({ message: expect.stringContaining('10.0.0.5') })
    expect(destroyed).toBeGreaterThan(0)
  })

  test('a body that stalls ends as storage.unavailable and the connection is destroyed', async () => {
    let destroyed = 0
    const stalled = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) })
    const store = adapter(
      {
        send: async () =>
          object(stalled, () => {
            destroyed += 1
          }),
      },
      { streamIdleTimeoutMs: 40 }
    )
    const got = await store.getStream(ORG, 'k')

    await expect(got?.body.getReader().read()).rejects.toMatchObject({
      code: 'storage.unavailable',
    })
    expect(destroyed).toBe(1)
  })

  test('cancel destroys the underlying body', async () => {
    let destroyed = 0
    let cancelled = 0
    const open = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]))
      },
      cancel() {
        cancelled += 1
      },
    })
    const store = adapter({
      send: async () =>
        object(open, () => {
          destroyed += 1
        }),
    })
    const got = await store.getStream(ORG, 'k')

    await got?.body.cancel()

    expect(destroyed).toBe(1)
    expect(cancelled).toBe(1)
  })
})
