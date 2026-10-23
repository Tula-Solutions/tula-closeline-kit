import { describe, expect, test } from 'bun:test'
import { inspect } from 'node:util'
import { organizationIdSchema } from 'tula-closeline-contract'
import { createMemoryErrorReporter } from '../reporting/testing'
import { createCartesiaTts } from './cartesia'
import { createFakeCartesia, type FakeCartesiaScript } from './cartesia.fake'
import { TTS_ERROR_CODES, TtsError } from './errors'
import type { TtsOpenRequest } from './port'

const KEY = 'sk_car_secret_0123456789abcdef'
const VOICE_ID = 'a0e99841-438c-4a64-b679-ae501e7d6091'
const org = organizationIdSchema.parse(`org_${'a'.repeat(32)}`)
const retry = { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 2 }

function setup(extra: Partial<Parameters<typeof createCartesiaTts>[0]> = {}) {
  const fake = createFakeCartesia()
  const reporter = createMemoryErrorReporter()
  const logs: string[] = []
  const log = (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f }))
  const logger = { debug: log, info: log, warn: log, error: log, child: () => logger }
  const port = createCartesiaTts({
    apiKey: KEY,
    voices: { warm: VOICE_ID },
    socket: fake.socket,
    reporter,
    logger,
    random: () => 0.5,
    ...extra,
  })
  const request = (over: Partial<TtsOpenRequest> = {}): TtsOpenRequest => ({
    organizationId: org,
    voice: 'warm',
    encoding: 'pcm_mulaw',
    sampleRate: 8000,
    retry,
    ...over,
  })
  return { fake, reporter, logs, port, request }
}

async function drain(iterable: AsyncIterable<{ byteLength: number }>): Promise<number[]> {
  const sizes: number[] = []
  for await (const c of iterable) {
    sizes.push(c.byteLength)
  }
  return sizes
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    return error instanceof TtsError ? error.code : String(error)
  }
  return 'no error'
}

describe('Cartesia adapter', () => {
  test('sends the key and version as headers, never in the URL, and the requested format', async () => {
    const { fake, port, request } = setup()
    fake.script({ chunks: [new Uint8Array([1, 2])] })
    const stream = port.open(request())
    stream.write('Hi')
    stream.finish()
    await drain(stream)
    const c = fake.connections[0]
    expect(c?.headers['X-API-Key']).toBe(KEY)
    expect(c?.headers['Cartesia-Version']).toBe('2026-08-14')
    expect(c?.url).toBe('wss://api.cartesia.ai/tts/websocket?cartesia_version=2026-08-14')
    expect(c?.url).not.toContain(KEY)
    const first = c?.messages[0]
    expect(first).toMatchObject({
      model_id: 'sonic-3.6',
      transcript: 'Hi',
      voice: { mode: 'id', id: VOICE_ID },
      continue: true,
      output_format: { container: 'raw', encoding: 'pcm_mulaw', sample_rate: 8000 },
    })
    expect(c?.messages.at(-1)).toMatchObject({ transcript: '', continue: false })
    expect(new Set(c?.messages.map((m) => m.context_id)).size).toBe(1)
  })

  test('a voice id is accepted as is; an unknown name is refused at open', () => {
    const { port, request } = setup()
    expect(() => port.open(request({ voice: VOICE_ID }))).not.toThrow()
    try {
      port.open(request({ voice: 'unknown-style' }))
      throw new Error('should have thrown')
    } catch (error) {
      expect((error as TtsError).code).toBe(TTS_ERROR_CODES.invalidRequest)
    }
    expect(port.openStreams()).toBe(1)
  })

  test('refuses an unusable configuration', () => {
    for (const bad of [
      { apiKey: '' },
      { maxBufferDelayMs: 9000 },
      { connectTimeoutMs: 0 },
      { baseUrl: 'https://x.test' },
      { baseUrl: 'ws://example.com' },
      { baseUrl: 'ws://localhost:80@evil.example' },
      { baseUrl: 'ws://127.0.0.1:@evil.example/x' },
      { baseUrl: 'wss://user:pw@host.test' },
      { voices: { a: '' } },
    ]) {
      expect(() => createCartesiaTts({ apiKey: KEY, ...bad })).toThrow()
    }
  })

  test('large audio is split into chunks of at most 64 KiB, in order', async () => {
    const { fake, port, request } = setup()
    fake.script({ chunks: [new Uint8Array(150_000).fill(7)] })
    const stream = port.open(request())
    stream.write('Hi')
    stream.finish()
    expect(await drain(stream)).toEqual([65_536, 65_536, 18_928])
  })

  test('a retry opens a fresh connection, a fresh context and sends all the text again', async () => {
    const { fake, port, request } = setup()
    fake.script({ errorStatus: 503 })
    fake.script({ chunks: [new Uint8Array([1])] })
    const stream = port.open(request())
    stream.write('one ')
    stream.write('two')
    stream.finish()
    await drain(stream)
    const [a, b] = fake.connections
    expect(a?.closed).toBe(true)
    expect(b?.messages[0]?.transcript).toBe('one two')
    expect(a?.messages[0]?.context_id).not.toBe(b?.messages[0]?.context_id)
  })

  test('a refused or dropped connection is retried, then tts.unavailable', async () => {
    const { fake, port, request, reporter } = setup()
    fake.script({ refuseConnect: true })
    fake.script({ refuseConnect: true })
    const stream = port.open(request())
    stream.write('Hi')
    stream.finish()
    expect(await codeOf(() => drain(stream))).toBe(TTS_ERROR_CODES.unavailable)
    expect(fake.connections.length).toBe(2)
    expect(reporter.captured.length).toBe(1)
  })

  test('a connection that never opens fails at the connect timeout and is retried', async () => {
    const { fake, port, request } = setup({ connectTimeoutMs: 20 })
    fake.script({ neverOpen: true })
    fake.script({ chunks: [new Uint8Array([1])] })
    const stream = port.open(request())
    stream.write('Hi')
    stream.finish()
    expect(await drain(stream)).toEqual([1])
    expect(fake.connections.length).toBe(2)
    expect(fake.connections[0]?.aborted).toBe(true)
  })

  test.each([
    [{ errorStatus: 429 }, TTS_ERROR_CODES.unavailable],
    [{ errorStatus: 402 }, TTS_ERROR_CODES.rejected],
    [{ errorStatus: 404 }, TTS_ERROR_CODES.rejected],
    [{ rawFrame: 'not json' }, TTS_ERROR_CODES.badResponse],
    [{ rawFrame: new Uint8Array([1]) }, TTS_ERROR_CODES.badResponse],
  ] as [FakeCartesiaScript, string][])('vendor reply %j maps to %s', async (script, code) => {
    const { fake, port, request } = setup()
    fake.script(script)
    if (code === TTS_ERROR_CODES.unavailable) {
      fake.script(script)
    }
    const stream = port.open(request())
    stream.write('Hi')
    expect(await codeOf(() => drain(stream))).toBe(code)
  })

  test('a cancel tells Cartesia to stop the context and closes the connection', async () => {
    const { fake, port, request } = setup()
    fake.script({ chunks: [new Uint8Array([1]), new Uint8Array([2])], chunkDelayMs: 1000 })
    const stream = port.open(request())
    stream.write('Hi')
    const it = stream[Symbol.asyncIterator]()
    await it.next()
    stream.cancel()
    const c = fake.connections[0]
    expect(c?.messages.at(-1)).toEqual({ context_id: c?.messages[0]?.context_id, cancel: true })
    expect(c?.closed).toBe(true)
  })

  test('the key, the text and the audio are in no log, report, error or printed form', async () => {
    const { fake, port, request, logs, reporter } = setup()
    fake.script({ errorStatus: 503 })
    fake.script({ errorStatus: 401 })
    const stream = port.open(request())
    stream.write('zebra confidential pricing')
    let message = ''
    try {
      await drain(stream)
    } catch (error) {
      message = `${(error as Error).message}${JSON.stringify((error as TtsError).details)}${inspect(error, { depth: 6 })}`
    }
    const all = [
      message,
      ...logs,
      JSON.stringify(reporter.captured),
      inspect(reporter.captured, { depth: 8 }),
      inspect(stream),
      inspect(port),
      JSON.stringify(fake.connections[0]?.url),
    ].join('\n')
    expect(all).not.toContain(KEY)
    expect(all).not.toContain('zebra')
    expect(message).toContain('vendorStatus')
  })

  test('a slow consumer may read hundreds of queued chunks without failing', async () => {
    const { fake, port, request } = setup()
    fake.script({ chunks: Array.from({ length: 600 }, () => new Uint8Array(160)) })
    const stream = port.open(request())
    stream.write('Hi')
    stream.finish()
    expect((await drain(stream)).length).toBe(600)
  })

  test('cancel after the stream ended is a no-op', async () => {
    const { fake, port, request } = setup()
    fake.script({ chunks: [new Uint8Array([1])] })
    const stream = port.open(request())
    stream.write('Hi')
    stream.finish()
    await drain(stream)
    stream.cancel()
    expect(() => stream.write('x')).toThrow('The stream has ended')
  })

  test('a consumer that stops reading cannot grow the backlog without bound', async () => {
    const { fake, port, request } = setup()
    fake.script({ chunks: Array.from({ length: 200 }, () => new Uint8Array(65_536)) })
    const stream = port.open(request({ retry: { maxRetries: 0 } }))
    stream.write('Hi')
    expect(await codeOf(() => drain(stream))).toBe(TTS_ERROR_CODES.unavailable)
    expect(fake.connections[0]?.closed).toBe(true)
  })
})
