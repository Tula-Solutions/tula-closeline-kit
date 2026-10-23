import { describe, expect, test } from 'bun:test'
import { callIdSchema, organizationIdSchema } from 'tula-closeline-contract'
import { createMemoryErrorReporter } from '../reporting/testing'
import { createAssemblyAiStreamingTranscribe } from './assemblyai'
import { createFakeAssemblyAi, FAKE_ASSEMBLYAI_KEY } from './assemblyai.fake'
import type { OpenStreamRequest, StreamEvent, TurnEvent } from './port'

const org = organizationIdSchema.parse(`org_${'a'.repeat(32)}`)
const call = callIdSchema.parse(`call_${'c'.repeat(32)}`)
const SECRET_TEXT = 'zebra confidential pricing'

function setup(options: Record<string, unknown> = {}) {
  const fake = createFakeAssemblyAi()
  const reporter = createMemoryErrorReporter()
  const logs: string[] = []
  const logger = {
    debug: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    info: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    warn: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    error: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    child: () => logger,
  }
  const sleeps: number[] = []
  const port = createAssemblyAiStreamingTranscribe({
    apiKey: FAKE_ASSEMBLYAI_KEY,
    socket: fake.socket,
    reporter,
    logger,
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    ...options,
  })
  return { fake, reporter, logs, sleeps, port }
}

function request(overrides: Partial<OpenStreamRequest> = {}): {
  request: OpenStreamRequest
  events: StreamEvent[]
  turns(): TurnEvent[]
} {
  const events: StreamEvent[] = []
  return {
    events,
    turns: () => events.filter((e): e is TurnEvent => e.type === 'turn'),
    request: {
      organizationId: org,
      callId: call,
      track: 'prospect',
      encoding: 'pcm_s16le',
      sampleRate: 16000,
      reconnect: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 4 },
      onEvent: (e) => events.push(e),
      ...overrides,
    },
  }
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

/** Everything an error or report holds, as text, so a test can look for a secret in it. */
function dump(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v instanceof Error
      ? { ...v, name: v.name, message: v.message, stack: v.stack, cause: v.cause }
      : v
  )
}

const pcm = (ms: number, rate = 16000) => new Uint8Array((ms * rate * 2) / 1000).fill(7)

describe('AssemblyAI streaming adapter: connecting', () => {
  test('sends the key as the Authorization header, never in the URL, and the audio format as query', async () => {
    const { fake, port } = setup()
    const r = request({ encoding: 'pcm_mulaw', sampleRate: 8000 })
    const stream = await port.open(r.request)
    const c = fake.connections[0]
    expect(c?.headers.Authorization).toBe(FAKE_ASSEMBLYAI_KEY)
    expect(c?.url).not.toContain(FAKE_ASSEMBLYAI_KEY)
    expect(c?.url.startsWith('wss://streaming.assemblyai.com/v3/ws?')).toBe(true)
    expect(c?.query).toMatchObject({ sample_rate: '8000', encoding: 'pcm_mulaw' })
    expect(c?.meta).toEqual({ organizationId: org, callId: call, track: 'prospect' })
    await stream.close()
  })

  test('the EU region uses the EU host', async () => {
    const { fake, port } = setup({ region: 'eu' })
    const stream = await port.open(request().request)
    expect(fake.connections[0]?.url.startsWith('wss://streaming.eu.assemblyai.com/v3/ws?')).toBe(
      true
    )
    await stream.close()
  })

  test('a non-English language selects the multilingual model; English keeps the default', async () => {
    const { fake, port } = setup()
    const a = await port.open(request({ language: 'es' }).request)
    const b = await port.open(request({ language: 'en-US', track: 'rep' }).request)
    expect(fake.connections[0]?.query.speech_model).toBe('universal-streaming-multilingual')
    expect(fake.connections[1]?.query.speech_model).toBeUndefined()
    await a.close()
    await b.close()
  })

  test('end-of-turn tuning is passed through', async () => {
    const { fake, port } = setup({
      endOfTurnConfidenceThreshold: 0.6,
      minEndOfTurnSilenceMs: 300,
      maxTurnSilenceMs: 2000,
    })
    const stream = await port.open(request().request)
    expect(fake.connections[0]?.query).toMatchObject({
      end_of_turn_confidence_threshold: '0.6',
      min_end_of_turn_silence_when_confident: '300',
      max_turn_silence: '2000',
    })
    await stream.close()
  })

  test('retries a refused connection with a jittered pause, then succeeds', async () => {
    const { fake, port, sleeps } = setup()
    fake.refuseNext(2)
    const stream = await port.open(
      request({ reconnect: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 } }).request
    )
    expect(fake.connections).toHaveLength(3)
    // random() is 0.5, so the jitter factor is 1: the base doubled each time.
    expect(sleeps).toEqual([100, 200])
    await stream.close()
  })

  test('gives up as unavailable after the bounded retries and reports metadata once', async () => {
    const { fake, port, reporter, logs } = setup()
    fake.refuseNext(3)
    await expect(
      port.open(request({ reconnect: { maxAttempts: 2, baseDelayMs: 1 } }).request)
    ).rejects.toMatchObject({ code: 'streaming_transcribe.unavailable' })
    expect(fake.connections).toHaveLength(3)
    expect(reporter.captured).toHaveLength(1)
    expect(dump(logs) + dump(reporter.captured)).not.toContain(FAKE_ASSEMBLYAI_KEY)
    // The live slot is free again.
    const again = await port.open(request().request)
    await again.close()
  })

  test('a refused credential is rejected at once and not retried', async () => {
    const { fake, port } = setup()
    fake.rejectNext(5, 1008)
    await expect(port.open(request().request)).rejects.toMatchObject({
      code: 'streaming_transcribe.rejected',
    })
    expect(fake.connections).toHaveLength(1)
  })

  test('the wrong key is rejected, and the key is not in the error', async () => {
    const { fake, reporter } = setup()
    const port = createAssemblyAiStreamingTranscribe({
      apiKey: 'wrong-key-value-123',
      socket: fake.socket,
      reporter,
    })
    const error = await port.open(request().request).then(
      () => undefined,
      (e: unknown) => e
    )
    expect(error).toMatchObject({ code: 'streaming_transcribe.rejected' })
    expect(dump(error)).not.toContain('wrong-key-value-123')
    expect(dump(reporter.captured)).not.toContain('wrong-key-value-123')
  })

  test('a vendor that never says Begin is given up on within the timeout', async () => {
    const { fake, port } = setup({ sleep: undefined })
    fake.silentNext(10)
    const started = Date.now()
    await expect(
      port.open(request({ reconnect: { maxAttempts: 10, baseDelayMs: 5 } }).request, {
        timeoutMs: 120,
      })
    ).rejects.toMatchObject({ code: 'streaming_transcribe.unavailable' })
    expect(Date.now() - started).toBeLessThan(1500)
  })

  test('the stream id is the id of the first session', async () => {
    const { fake, port } = setup()
    const stream = await port.open(request().request)
    expect(stream.streamId).toBe(fake.connections[0]?.sessionId ?? '')
    await stream.close()
  })
})

describe('AssemblyAI streaming adapter: audio', () => {
  test('small frames are joined to at least 50 ms and big ones split to at most 1 s', async () => {
    const { fake, port } = setup()
    const stream = await port.open(request().request)
    for (let i = 0; i < 10; i++) {
      stream.sendAudio(pcm(20))
    }
    stream.sendAudio(pcm(1900))
    await until(() => (fake.connections[0]?.audioBytes ?? 0) >= 16000 * 2 * 2, 'the audio')
    const c = fake.connections[0]
    expect(c?.closed).toBe(false)
    for (const frame of c?.frames ?? []) {
      expect(frame).toBeGreaterThanOrEqual(1600)
      expect(frame).toBeLessThanOrEqual(32_000)
    }
    // 200 ms + 1900 ms, minus the part of a frame still waiting to reach 50 ms (none here).
    expect(c?.audioBytes).toBe(pcm(2100).length)
    await stream.close()
  })

  test('audio sent while the connection is down is replayed after it is back', async () => {
    const { fake, port } = setup()
    const r = request()
    const stream = await port.open(r.request)
    stream.sendAudio(pcm(100))
    await until(() => (fake.connections[0]?.audioBytes ?? 0) > 0, 'the first audio')
    fake.refuseNext(1)
    fake.drop(stream.streamId)
    stream.sendAudio(pcm(100))
    stream.sendAudio(pcm(100))
    await until(() => r.events.some((e) => e.type === 'reconnected'), 'the reconnection')
    await until(() => (fake.connections.at(-1)?.audioBytes ?? 0) >= pcm(200).length, 'the replay')
    expect(fake.connections.at(-1)?.audioBytes).toBe(pcm(200).length)
    await stream.close()
  })

  test('only the newest audio up to the replay bound is kept while down', async () => {
    let release: () => void = () => undefined
    const pause = new Promise<void>((resolve) => {
      release = resolve
    })
    const { fake, port } = setup({ sleep: () => pause })
    const r = request()
    const stream = await port.open(r.request)
    fake.drop(stream.streamId)
    const second = 16000 * 2
    // 40 seconds of audio against a bound of 524,288 bytes (about 16 s).
    for (let i = 0; i < 40; i++) {
      stream.sendAudio(new Uint8Array(second))
    }
    expect(r.events.map((e) => e.type)).toEqual(['reconnecting'])
    release()
    await until(() => r.events.some((e) => e.type === 'reconnected'), 'the reconnection')
    await until(() => (fake.connections.at(-1)?.audioBytes ?? 0) >= 480_000, 'the replay')
    await new Promise((resolve) => setTimeout(resolve, 20))
    const replayed = fake.connections.at(-1)?.audioBytes ?? 0
    expect(replayed).toBeLessThanOrEqual(524_288)
    expect(replayed).toBeGreaterThanOrEqual(480_000)
    await stream.close()
  })

  test('closing frees a stream whose reconnect pause never ends', async () => {
    const { fake, port } = setup({ sleep: () => new Promise(() => undefined) })
    const r = request()
    const stream = await port.open(r.request)
    fake.drop(stream.streamId)
    await stream.close()
    expect(r.events.map((e) => e.type)).toEqual(['reconnecting', 'closed'])
  })

  test('word times and turn ids keep going across a reconnection', async () => {
    const { fake, port } = setup()
    fake.hear(org, call, 'prospect', [
      { text: 'we need a lower price', afterBytes: pcm(100).length },
      { text: 'send me the quote today', afterBytes: pcm(200).length },
    ])
    const r = request()
    const stream = await port.open(r.request)
    stream.sendAudio(pcm(100))
    await until(() => r.turns().some((t) => t.endOfTurn), 'the first turn')
    fake.drop(stream.streamId)
    await until(() => r.events.some((e) => e.type === 'reconnected'), 'the reconnection')
    stream.sendAudio(pcm(100))
    await until(() => r.turns().filter((t) => t.endOfTurn).length === 2, 'the second turn')
    const [first, second] = r.turns().filter((t) => t.endOfTurn)
    // The vendor's clock restarts at 0 in the new session; the adapter shifts it by the 100 ms already sent.
    expect(first?.words.at(-1)?.endMs).toBe(100)
    expect(second?.words[0]?.startMs).toBe(100)
    expect(second?.words.at(-1)?.endMs).toBe(200)
    expect(first?.turnId).not.toBe(second?.turnId)
    await stream.close()
  })

  test('a connection that keeps dying right after it opens fails the stream', async () => {
    const { fake, port } = setup()
    const r = request({ reconnect: { maxAttempts: 10, baseDelayMs: 1 } })
    const stream = await port.open(r.request)
    fake.dieAfterBeginNext(20)
    fake.drop(stream.streamId)
    await until(() => r.events.some((e) => e.type === 'failed'), 'the failure')
    expect(r.events.at(-1)).toMatchObject({
      type: 'failed',
      code: 'streaming_transcribe.unavailable',
    })
    expect(() => stream.sendAudio(pcm(100))).toThrow()
  })
})

describe('AssemblyAI streaming adapter: turns', () => {
  test('with formatting on, the final is the formatted turn and arrives once', async () => {
    const { fake, port } = setup({ formatTurns: true })
    fake.hear(org, call, 'prospect', [{ text: 'send me the quote', afterBytes: pcm(100).length }])
    const r = request()
    const stream = await port.open(r.request)
    expect(fake.connections[0]?.query.format_turns).toBe('true')
    stream.sendAudio(pcm(100))
    await until(() => r.turns().some((t) => t.isFinal), 'the final')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(r.turns().filter((t) => t.isFinal)).toHaveLength(1)
    expect(r.turns().every((t) => t.isFinal || !t.endOfTurn)).toBe(true)
    await stream.close()
  })

  test('with formatting off, format_turns is false and the first end of turn is final', async () => {
    const { fake, port } = setup()
    fake.hear(org, call, 'prospect', [{ text: 'send me the quote', afterBytes: pcm(100).length }])
    const r = request()
    const stream = await port.open(r.request)
    expect(fake.connections[0]?.query.format_turns).toBe('false')
    stream.sendAudio(pcm(100))
    await until(() => r.turns().some((t) => t.endOfTurn), 'the end of turn')
    await stream.close()
  })

  test('unknown message types are ignored', async () => {
    const { fake, port } = setup()
    const r = request()
    const stream = await port.open(r.request)
    fake.sendRaw(JSON.stringify({ type: 'SpeechStarted', timestamp: 1 }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(r.events).toHaveLength(0)
    await stream.close()
  })

  test('a malformed turn ends the stream as bad_response and reports metadata only', async () => {
    const { fake, port, reporter } = setup()
    const r = request()
    const stream = await port.open(r.request)
    fake.sendRaw(
      JSON.stringify({ type: 'Turn', turn_order: 'x', transcript: SECRET_TEXT, words: 5 })
    )
    await until(() => r.events.some((e) => e.type === 'failed'), 'the failure')
    expect(r.events.at(-1)).toMatchObject({
      type: 'failed',
      code: 'streaming_transcribe.bad_response',
    })
    expect(reporter.captured).toHaveLength(1)
    expect(dump(reporter.captured)).not.toContain('zebra')
    expect(() => stream.sendAudio(pcm(100))).toThrow()
  })

  test('a frame that is not text ends the stream as bad_response', async () => {
    const { fake, port } = setup()
    const r = request()
    await port.open(r.request)
    fake.sendRaw(new Uint8Array([1, 2, 3]))
    await until(() => r.events.some((e) => e.type === 'failed'), 'the failure')
    expect(r.events.at(-1)).toMatchObject({
      type: 'failed',
      code: 'streaming_transcribe.bad_response',
    })
  })

  test('words are cut at the port limit and the confidence is kept only in range', async () => {
    const { fake, port } = setup()
    const r = request()
    const stream = await port.open(r.request)
    const words = Array.from({ length: 2100 }, (_, i) => ({
      text: `w${i}`,
      start: i,
      end: i + 1,
      confidence: i === 0 ? 7 : 0.5,
      word_is_final: true,
    }))
    fake.sendRaw(
      JSON.stringify({
        type: 'Turn',
        turn_order: 0,
        turn_is_formatted: false,
        end_of_turn: true,
        transcript: 'many words',
        words,
      })
    )
    await until(() => r.turns().length === 1, 'the turn')
    const turn = r.turns()[0]
    expect(turn?.words).toHaveLength(2000)
    expect(turn?.words[0]?.confidence).toBeUndefined()
    expect(turn?.words[1]?.confidence).toBe(0.5)
    await stream.close()
  })
})

describe('AssemblyAI streaming adapter: closing', () => {
  test('close sends the audio still waiting for a full frame, padded with silence', async () => {
    const { fake, port } = setup()
    const stream = await port.open(request().request)
    stream.sendAudio(pcm(30))
    expect(fake.connections[0]?.frames).toEqual([])
    await stream.close()
    expect(fake.connections[0]?.frames).toEqual([1600])
  })

  test('asks the vendor to settle, then terminates, and ends with closed', async () => {
    const { fake, port } = setup()
    const r = request()
    const stream = await port.open(r.request)
    await stream.close()
    expect(fake.connections[0]?.messages.map((m) => m.type)).toEqual(['ForceEndpoint', 'Terminate'])
    expect(r.events.map((e) => e.type)).toEqual(['closed'])
    expect(fake.connections[0]?.closed).toBe(true)
  })

  test('a vendor that does not answer is waited for only as long as the close timeout', async () => {
    const { fake, port } = setup({ closeTimeoutMs: 50 })
    fake.ignoreTerminate()
    const r = request()
    const stream = await port.open(r.request)
    const started = Date.now()
    await stream.close()
    expect(Date.now() - started).toBeLessThan(1000)
    expect(r.events.at(-1)?.type).toBe('closed')
    expect(fake.connections[0]?.closed).toBe(true)
  })

  test('concurrent closes share one close', async () => {
    const { fake, port } = setup()
    const r = request()
    const stream = await port.open(r.request)
    await Promise.all([stream.close(), stream.close()])
    expect(r.events.filter((e) => e.type === 'closed')).toHaveLength(1)
    expect(fake.connections[0]?.messages.filter((m) => m.type === 'Terminate')).toHaveLength(1)
  })
})

describe('AssemblyAI streaming adapter: options', () => {
  const bad: [string, Record<string, unknown>][] = [
    ['an empty key', { apiKey: '' }],
    ['a key with a line break', { apiKey: 'abc\r\nX-Evil: 1' }],
    ['an unknown region', { region: 'asia' }],
    ['a ws URL to a remote host', { baseUrl: 'ws://example.com' }],
    ['a URL with credentials', { baseUrl: 'wss://user:pass@example.com' }],
    ['a URL with a query', { baseUrl: 'wss://example.com?x=1' }],
    ['a zero connect timeout', { connectTimeoutMs: 0 }],
    ['a huge close timeout', { closeTimeoutMs: 31_000 }],
    ['a threshold above 1', { endOfTurnConfidenceThreshold: 1.5 }],
    ['a fractional silence', { minEndOfTurnSilenceMs: 1.5 }],
    ['a negative max silence', { maxTurnSilenceMs: -1 }],
  ]
  for (const [name, options] of bad) {
    test(`refuses ${name} without echoing it`, () => {
      let thrown: unknown
      try {
        createAssemblyAiStreamingTranscribe({ apiKey: 'good-key', ...options })
      } catch (error) {
        thrown = error
      }
      expect(thrown).toMatchObject({ code: 'streaming_transcribe.invalid_request' })
      const text = dump(thrown)
      expect(text).not.toContain('Evil')
      expect(text).not.toContain('pass@')
    })
  }

  test('a loopback ws URL is allowed', async () => {
    const { fake } = setup()
    const port = createAssemblyAiStreamingTranscribe({
      apiKey: FAKE_ASSEMBLYAI_KEY,
      baseUrl: 'ws://127.0.0.1:9',
      socket: fake.socket,
    })
    const stream = await port.open(request().request)
    expect(fake.connections[0]?.url.startsWith('ws://127.0.0.1:9/v3/ws?')).toBe(true)
    await stream.close()
  })
})
