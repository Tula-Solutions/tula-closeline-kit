import { describe, expect, test } from 'bun:test'
import { organizationIdSchema } from 'tula-closeline-contract'
import { TtsAudioChunk } from './audio'
import { TTS_ERROR_CODES, TtsError } from './errors'
import { createMemoryTts } from './memory'
import { MAX_TTS_AUDIO_CHUNK_BYTES } from './port'

const org = organizationIdSchema.parse(`org_${'a'.repeat(32)}`)
const request = {
  organizationId: org,
  voice: 'v',
  encoding: 'pcm_mulaw',
  sampleRate: 8000,
} as const

describe('memory TTS adapter', () => {
  test('failNext with the reporter sees tts.bad_response when nothing is scripted', async () => {
    const tts = createMemoryTts()
    const stream = tts.open(request)
    stream.write('hi')
    stream.finish()
    const read = (async () => {
      for await (const _ of stream) {
        // drain
      }
    })()
    await expect(read).rejects.toMatchObject({ code: TTS_ERROR_CODES.badResponse })
  })

  test('speak refuses chunks that are empty, too big or not bytes, and a bad failAfterChunks', () => {
    const tts = createMemoryTts()
    for (const speech of [
      [new Uint8Array(0)],
      [new Uint8Array(MAX_TTS_AUDIO_CHUNK_BYTES + 1)],
      ['x' as unknown as Uint8Array],
      { chunks: [new Uint8Array(1)], failAfterChunks: 0 },
      { chunks: [new Uint8Array(1)], failAfterChunks: 2 },
    ]) {
      expect(() => tts.speak(speech)).toThrow(TtsError)
    }
  })

  test('the consumer pulls: a chunk is not produced until it is asked for', async () => {
    const delays: number[] = []
    const tts = createMemoryTts({
      sleep: async (ms) => {
        delays.push(ms)
      },
    })
    tts.speak({
      chunks: Array.from({ length: 1000 }, () => new Uint8Array(4)),
      chunkDelayMs: 7,
    })
    const stream = tts.open(request)
    stream.write('hi')
    const iterator = stream[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.next()
    expect(delays).toEqual([7])
    await stream.close()
  })

  test('a chunk prints without its audio', () => {
    const chunk = new TtsAudioChunk(3, new Uint8Array([1, 2, 3]))
    expect(String(chunk)).toBe('TtsAudioChunk(#3, 3 bytes)')
    expect(JSON.stringify(chunk)).toBe('{"sequence":3,"byteLength":3}')
  })

  test('a stream stays counted after cancel and is released only by close', async () => {
    const tts = createMemoryTts()
    const stream = tts.open(request)
    expect(tts.openStreams()).toBe(1)
    stream.cancel()
    expect(tts.openStreams()).toBe(1)
    await stream.close()
    expect(tts.openStreams()).toBe(0)
  })

  test('a cancel after close does not undo the close', async () => {
    const tts = createMemoryTts()
    const stream = tts.open(request)
    await stream.close()
    stream.cancel()
    expect(() => stream.write('late')).toThrow(expect.objectContaining({ code: 'tts.closed' }))
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: 'tts.closed',
    })
  })

  test('speak refuses a script that is not an object with tts.invalid_request', () => {
    const tts = createMemoryTts()
    expect(() => tts.speak(null as never)).toThrow(
      expect.objectContaining({ code: 'tts.invalid_request' })
    )
  })
})
