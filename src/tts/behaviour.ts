import { afterEach, describe, expect, test } from 'bun:test'
import { inspect } from 'node:util'
import type { OrganizationId } from 'tula-closeline-contract'
import type { MemoryErrorReporter } from '../reporting/testing'
import type { TtsAudioChunk } from './audio'
import { TTS_ERROR_CODES, TtsError } from './errors'
import type { TtsOpenRequest, TtsPort, TtsStream } from './port'

/** What the behaviour suite needs from an adapter under test. */
export interface TtsSubject {
  /** The port under test. */
  port: TtsPort
  /** Two unrelated Organization ids the port accepts. */
  organizations: { a: OrganizationId; b: OrganizationId }
  /** A stock voice the vendor accepts. */
  voice: string
  /** The reporter the port was built with: the suite reads what it was given. */
  reporter: MemoryErrorReporter
  /** Everything the port logged, one JSON or text line per entry. */
  logs(): string[]
  /**
   * Arranges that the next stream request that reaches the vendor delivers `chunks` in order.
   * `chunkDelayMs` is the vendor's pause before each later chunk; `failAfterChunks` makes the
   * vendor stream break (a retryable error) once that many chunks (at least 1) were delivered.
   */
  speak(
    chunks: readonly Uint8Array[],
    options?: { chunkDelayMs?: number; failAfterChunks?: number }
  ): void
  /** Arranges that the next stream request that reaches the vendor never produces a first chunk, until aborted. */
  hang(): void
  /** Arranges that the next `times` vendor requests fail: `retryable` as throttling or a 5xx, `fatal` as refused credentials. */
  failNext(kind: 'retryable' | 'fatal', times: number): void
  /** How many requests have reached the vendor, a retry counting as its own. */
  vendorRequests(): number
  /** How many vendor requests were aborted while they were still pending. */
  abortedRequests(): number
  /** How many streams have been opened and not yet closed. */
  openStreams(): number
  /** Removes what the subject created. */
  close(): Promise<void>
}

const SECRET_TEXT = 'zebra confidential pricing'
const SECRET_AUDIO = 'AUDIO-MARKER-PAYLOAD'

const retry = { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 2 }

function audio(n: number, marker = 'piece'): Uint8Array {
  return new TextEncoder().encode(`${marker}-${n}`)
}

async function collect(stream: TtsStream): Promise<TtsAudioChunk[]> {
  const out: TtsAudioChunk[] = []
  for await (const chunk of stream) {
    out.push(chunk)
  }
  return out
}

async function codeOf(run: () => unknown): Promise<string> {
  try {
    await run()
  } catch (error) {
    if (error instanceof TtsError) {
      return error.code
    }
    throw error
  }
  return 'no error'
}

/**
 * The behaviour every {@link TtsPort} must show: text goes in and audio comes out in order with
 * no gaps; a cancel stops further chunks at once and can be repeated; a read pending at cancel
 * ends as done; a vendor error before the first chunk is retried a bounded number of times and
 * one after it never is (so no audio repeats); a refusal is never retried; text over the limit,
 * a first chunk that never comes, the overall deadline and the caller's signal each fail with
 * their own code and abort the vendor request; a closed stream releases what it holds and fails
 * clearly when used; a bad request is refused before any vendor call; and neither the text nor
 * the audio reaches a log, the error reporter, an error, or the string, JSON or inspect form of
 * anything the port returns. Run it against the memory adapter and any real adapter (which needs
 * a subject that drives the vendor's test mode).
 */
export function ttsBehaviour(name: string, make: () => Promise<TtsSubject>, skip = false): void {
  const run = skip ? describe.skip : describe
  run(`TTS behaviour: ${name}`, () => {
    const made: TtsSubject[] = []
    afterEach(async () => {
      await Promise.all(made.splice(0).map((subject) => subject.close()))
    })
    async function subject(): Promise<TtsSubject> {
      const next = await make()
      made.push(next)
      return next
    }

    function open(s: TtsSubject, overrides: Partial<TtsOpenRequest> = {}): TtsStream {
      return s.port.open({
        organizationId: s.organizations.a,
        voice: s.voice,
        encoding: 'pcm_s16le',
        sampleRate: 24000,
        retry,
        ...overrides,
      })
    }

    test('chunks come out in order, with their sequence, as text goes in', async () => {
      const s = await subject()
      const pieces = [audio(0), audio(1), audio(2)]
      s.speak(pieces)
      const stream = open(s)
      stream.write('Hello, ')
      stream.write('this is a call.')
      const reading = collect(stream)
      stream.write(' One more sentence.')
      stream.finish()
      const chunks = await reading
      expect(chunks.map((c) => c.sequence)).toEqual([0, 1, 2])
      expect(chunks.map((c) => [...c.audio])).toEqual(pieces.map((p) => [...p]))
      expect(chunks.map((c) => c.byteLength)).toEqual(pieces.map((p) => p.byteLength))
      expect(s.vendorRequests()).toBe(1)
    })

    test('a stream finished without text ends empty and sends nothing to the vendor', async () => {
      const s = await subject()
      const stream = open(s)
      stream.write('')
      stream.finish()
      expect(await collect(stream)).toEqual([])
      expect(s.vendorRequests()).toBe(0)
    })

    test('finish is idempotent and a write after it fails with tts.closed', async () => {
      const s = await subject()
      s.speak([audio(0)])
      const stream = open(s)
      stream.write('hi')
      stream.finish()
      stream.finish()
      expect(await codeOf(() => stream.write('more'))).toBe(TTS_ERROR_CODES.closed)
      expect((await collect(stream)).length).toBe(1)
    })

    test('a cancel mid-stream stops further chunks and can be repeated', async () => {
      const s = await subject()
      s.speak([audio(0), audio(1), audio(2), audio(3), audio(4)], { chunkDelayMs: 5 })
      const stream = open(s)
      stream.write('a long reply that the prospect interrupts')
      const iterator = stream[Symbol.asyncIterator]()
      expect((await iterator.next()).value?.sequence).toBe(0)
      expect((await iterator.next()).value?.sequence).toBe(1)
      stream.cancel()
      stream.cancel()
      expect((await iterator.next()).done).toBe(true)
      expect((await iterator.next()).done).toBe(true)
      expect(s.abortedRequests()).toBe(1)
      expect(await codeOf(() => stream.write('more'))).toBe(TTS_ERROR_CODES.closed)
      stream.finish()
      await stream.close()
    })

    test('a read pending at cancel ends as done', async () => {
      const s = await subject()
      s.speak([audio(0), audio(1)], { chunkDelayMs: 5_000 })
      const stream = open(s)
      stream.write('hello')
      const iterator = stream[Symbol.asyncIterator]()
      expect((await iterator.next()).done).toBe(false)
      const pending = iterator.next()
      stream.cancel()
      expect((await pending).done).toBe(true)
    })

    test('a cancel before any text sends nothing to the vendor', async () => {
      const s = await subject()
      const stream = open(s)
      const reading = collect(stream)
      stream.cancel()
      expect(await reading).toEqual([])
      expect(s.vendorRequests()).toBe(0)
    })

    test('leaving the loop early cancels the stream', async () => {
      const s = await subject()
      s.speak([audio(0), audio(1), audio(2)], { chunkDelayMs: 5 })
      const stream = open(s)
      stream.write('hello')
      for await (const chunk of stream) {
        expect(chunk.sequence).toBe(0)
        break
      }
      expect(s.abortedRequests()).toBe(1)
      expect(await codeOf(() => stream.write('more'))).toBe(TTS_ERROR_CODES.closed)
    })

    test('a vendor error before the first chunk is retried and no audio repeats', async () => {
      const s = await subject()
      s.failNext('retryable', 1)
      s.speak([audio(0), audio(1)])
      const stream = open(s)
      stream.write('hello')
      stream.finish()
      const chunks = await collect(stream)
      expect(chunks.map((c) => c.sequence)).toEqual([0, 1])
      expect(s.vendorRequests()).toBe(2)
    })

    test('retries are bounded: tts.unavailable after the policy, reported without text', async () => {
      const s = await subject()
      s.failNext('retryable', 5)
      const stream = open(s, { retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 } })
      stream.write(SECRET_TEXT)
      stream.finish()
      expect(await codeOf(() => collect(stream))).toBe(TTS_ERROR_CODES.unavailable)
      expect(s.vendorRequests()).toBe(3)
      expect(JSON.stringify(s.reporter.captured)).not.toContain(SECRET_TEXT)
      expect(s.reporter.captured.length).toBeGreaterThan(0)
    })

    test('a refusal is tts.rejected and is not retried', async () => {
      const s = await subject()
      s.failNext('fatal', 1)
      const stream = open(s)
      stream.write('hello')
      stream.finish()
      expect(await codeOf(() => collect(stream))).toBe(TTS_ERROR_CODES.rejected)
      expect(s.vendorRequests()).toBe(1)
    })

    test('a vendor error after the first chunk is thrown, never retried, never repeated', async () => {
      const s = await subject()
      s.speak([audio(0), audio(1), audio(2)], { failAfterChunks: 2 })
      s.speak([audio(7), audio(8)])
      const stream = open(s)
      stream.write('hello')
      stream.finish()
      const heard: number[] = []
      let code = 'no error'
      try {
        for await (const chunk of stream) {
          heard.push(chunk.sequence)
        }
      } catch (error) {
        code = error instanceof TtsError ? error.code : String(error)
      }
      expect(heard).toEqual([0, 1])
      expect(code).toBe(TTS_ERROR_CODES.unavailable)
      expect(s.vendorRequests()).toBe(1)
    })

    test('text over the limit is tts.text_too_large and adds nothing', async () => {
      const s = await subject()
      s.speak([audio(0)])
      const stream = open(s, { maxTextChars: 10 })
      stream.write('12345')
      expect(await codeOf(() => stream.write('678901'))).toBe(TTS_ERROR_CODES.textTooLarge)
      stream.write('67890')
      expect(await codeOf(() => stream.write('1'))).toBe(TTS_ERROR_CODES.textTooLarge)
      stream.finish()
      expect((await collect(stream)).length).toBe(1)
    })

    test('a first chunk that never comes is tts.timeout and aborts the vendor request', async () => {
      const s = await subject()
      s.hang()
      const stream = open(s, { firstChunkTimeoutMs: 30 })
      stream.write('hello')
      let error: unknown
      try {
        await collect(stream)
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(TtsError)
      expect((error as TtsError).code).toBe(TTS_ERROR_CODES.timeout)
      expect((error as TtsError).details).toMatchObject({ phase: 'first_chunk' })
      expect(s.abortedRequests()).toBe(1)
    })

    test('the overall deadline is tts.timeout and aborts the vendor request', async () => {
      const s = await subject()
      s.speak([audio(0), audio(1), audio(2)], { chunkDelayMs: 500 })
      const stream = open(s, { timeoutMs: 60 })
      stream.write('hello')
      let error: unknown
      try {
        await collect(stream)
      } catch (caught) {
        error = caught
      }
      expect((error as TtsError).code).toBe(TTS_ERROR_CODES.timeout)
      expect((error as TtsError).details).toMatchObject({ phase: 'overall' })
      expect(s.abortedRequests()).toBe(1)
    })

    test("the caller's signal is tts.aborted and aborts the vendor request", async () => {
      const s = await subject()
      s.speak([audio(0), audio(1)], { chunkDelayMs: 500 })
      const controller = new AbortController()
      const stream = open(s, { signal: controller.signal })
      stream.write('hello')
      const iterator = stream[Symbol.asyncIterator]()
      await iterator.next()
      const pending = iterator.next()
      controller.abort()
      expect(await codeOf(() => pending)).toBe(TTS_ERROR_CODES.aborted)
      expect(s.abortedRequests()).toBe(1)
    })

    test('a signal that already fired sends nothing to the vendor', async () => {
      const s = await subject()
      const stream = open(s, { signal: AbortSignal.abort() })
      expect(await codeOf(() => stream.write('hello'))).toBe(TTS_ERROR_CODES.aborted)
      expect(await codeOf(() => collect(stream))).toBe(TTS_ERROR_CODES.aborted)
      expect(s.vendorRequests()).toBe(0)
    })

    test('close releases the stream, aborts a pending request and is idempotent', async () => {
      const s = await subject()
      s.hang()
      const before = s.openStreams()
      const stream = open(s, { firstChunkTimeoutMs: 10_000 })
      expect(s.openStreams()).toBe(before + 1)
      stream.write('hello')
      const reading = collect(stream)
      await new Promise((resolve) => setTimeout(resolve, 20))
      await stream.close()
      await stream.close()
      expect(await reading).toEqual([])
      expect(s.openStreams()).toBe(before)
      expect(s.abortedRequests()).toBe(1)
    })

    test('using a closed stream fails clearly with tts.closed', async () => {
      const s = await subject()
      const stream = open(s)
      await stream.close()
      expect(await codeOf(() => stream.write('hello'))).toBe(TTS_ERROR_CODES.closed)
      expect(await codeOf(() => stream.finish())).toBe(TTS_ERROR_CODES.closed)
      expect(await codeOf(() => collect(stream))).toBe(TTS_ERROR_CODES.closed)
      stream.cancel()
      expect(s.vendorRequests()).toBe(0)
    })

    describe('a bad request is tts.invalid_request and nothing reaches the vendor', () => {
      const cases: [string, (s: TtsSubject) => Partial<TtsOpenRequest>][] = [
        ['organizationId', () => ({ organizationId: 'nope' as OrganizationId })],
        ['voice (empty)', () => ({ voice: '' })],
        ['voice (characters)', () => ({ voice: 'a b/c' })],
        ['encoding', () => ({ encoding: 'mp3' as never })],
        ['sampleRate', () => ({ sampleRate: 44100 as never })],
        ['timeoutMs (zero)', () => ({ timeoutMs: 0 })],
        ['timeoutMs (huge)', () => ({ timeoutMs: 10 ** 9 })],
        ['firstChunkTimeoutMs', () => ({ firstChunkTimeoutMs: 1.5 })],
        ['maxTextChars (zero)', () => ({ maxTextChars: 0 })],
        ['maxTextChars (huge)', () => ({ maxTextChars: 10 ** 9 })],
        ['retry.maxRetries', () => ({ retry: { maxRetries: 99 } })],
        ['retry.maxDelayMs below base', () => ({ retry: { baseDelayMs: 10, maxDelayMs: 5 } })],
        ['signal', () => ({ signal: {} as AbortSignal })],
      ]
      test.each(cases)('%s', async (_name, overrides) => {
        const s = await subject()
        const before = s.openStreams()
        expect(await codeOf(() => open(s, overrides(s)))).toBe(TTS_ERROR_CODES.invalidRequest)
        expect(s.vendorRequests()).toBe(0)
        expect(s.openStreams()).toBe(before)
      })

      test('text that is not a string', async () => {
        const s = await subject()
        const stream = open(s)
        expect(await codeOf(() => stream.write(42 as unknown as string))).toBe(
          TTS_ERROR_CODES.invalidRequest
        )
        await stream.close()
      })
    })

    test('neither the text nor the audio reaches a log, a report, an error or any printed form', async () => {
      const s = await subject()
      const marked = [audio(0, SECRET_AUDIO), audio(1, SECRET_AUDIO)]
      const base64 = marked.map((m) => Buffer.from(m).toString('base64'))
      const forms: string[] = []
      const record = (value: unknown) => {
        forms.push(String(value), inspect(value, { depth: 6 }))
        try {
          forms.push(JSON.stringify(value) ?? '')
        } catch {
          // a value that cannot be stringified holds nothing readable
        }
      }

      s.failNext('retryable', 1)
      s.speak(marked)
      const stream = open(s)
      record(stream)
      stream.write(SECRET_TEXT)
      stream.write(` ${SECRET_TEXT}`)
      stream.finish()
      record(stream)
      for await (const chunk of stream) {
        record(chunk)
        record({ chunk })
        record([chunk])
        record({ ...chunk })
        expect(Buffer.from(chunk.audio).toString()).toContain(SECRET_AUDIO)
      }

      s.failNext('fatal', 1)
      const failing = open(s, { maxTextChars: 40 })
      failing.write(SECRET_TEXT)
      try {
        await collect(failing)
      } catch (error) {
        record(error)
        forms.push((error as Error).message)
        forms.push(JSON.stringify((error as TtsError).details ?? {}))
      }
      try {
        failing.write(`${SECRET_TEXT} ${SECRET_TEXT}`)
      } catch (error) {
        record(error)
        forms.push((error as Error).message)
      }

      s.speak(marked, { failAfterChunks: 1 })
      const breaking = open(s)
      breaking.write(SECRET_TEXT)
      try {
        await collect(breaking)
      } catch (error) {
        record(error)
      }

      const everything = [
        ...forms,
        ...s.logs(),
        JSON.stringify(s.reporter.captured),
        inspect(s.reporter.captured, { depth: 8 }),
      ].join('\n')
      expect(everything).not.toContain(SECRET_TEXT)
      expect(everything).not.toContain(SECRET_AUDIO)
      for (const encoded of base64) {
        expect(everything).not.toContain(encoded)
      }
      expect(everything).not.toContain(`[${[...(marked[0] ?? [])].join(',')}`)
    })
  })
}
