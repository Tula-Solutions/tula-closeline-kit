import { describe, expect, test } from 'bun:test'
import { callIdSchema, organizationIdSchema } from 'tula-closeline-contract'
import { STREAMING_TRANSCRIBE_ERROR_CODES, StreamingTranscribeError } from './errors'
import { createMemoryStreamingTranscribe } from './memory'
import {
  DEFAULT_RECONNECT_POLICY,
  reconnectDelayMs,
  type StreamEvent,
  type TurnEvent,
} from './port'
import { resolveReconnectPolicy } from './validate'

const org = organizationIdSchema.parse(`org_${'a'.repeat(32)}`)
const call = callIdSchema.parse(`call_${'c'.repeat(32)}`)
const request = {
  organizationId: org,
  callId: call,
  track: 'rep',
  encoding: 'pcm_mulaw',
  sampleRate: 8000,
} as const

describe('reconnectDelayMs', () => {
  const policy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 500 }
  test('doubles up to the maximum', () => {
    const half = () => 0.5
    expect([1, 2, 3, 4, 5].map((n) => reconnectDelayMs(n, policy, half))).toEqual([
      100, 200, 400, 500, 500,
    ])
  })
  test('jitters between half and one and a half times', () => {
    expect(reconnectDelayMs(2, policy, () => 0)).toBe(100)
    expect(reconnectDelayMs(2, policy, () => 0.999)).toBe(299)
  })
  test('the default policy is bounded', () => {
    expect(resolveReconnectPolicy(undefined)).toEqual(DEFAULT_RECONNECT_POLICY)
    expect(() => resolveReconnectPolicy({ baseDelayMs: 100, maxDelayMs: 50 })).toThrow()
  })
})

describe('createMemoryStreamingTranscribe', () => {
  test('a scripted turn arrives as growing interims, a final and the end mark', async () => {
    const memory = createMemoryStreamingTranscribe()
    memory.script(org, call, 'rep', [{ text: 'one two three four', afterBytes: 10, interims: 2 }])
    const events: StreamEvent[] = []
    const stream = await memory.open({ ...request, onEvent: (e) => events.push(e) })
    stream.sendAudio(new Uint8Array(9))
    expect(events).toHaveLength(0)
    stream.sendAudio(new Uint8Array(1))
    const turns = events as TurnEvent[]
    expect(turns.map((t) => [t.isFinal, t.endOfTurn, t.text])).toEqual([
      [false, false, 'one'],
      [false, false, 'one two'],
      [true, true, 'one two three four'],
    ])
    expect(turns[2]?.words.map((w) => [w.startMs, w.endMs])).toEqual([
      [0, 200],
      [200, 400],
      [400, 600],
      [600, 800],
    ])
  })

  test('a final without the end mark keeps the turn id', async () => {
    const memory = createMemoryStreamingTranscribe()
    memory.script(org, call, 'rep', [
      { text: 'hello there', afterBytes: 1, interims: 0, endOfTurn: false },
      { text: 'and goodbye', afterBytes: 2, interims: 0 },
    ])
    const events: StreamEvent[] = []
    const stream = await memory.open({ ...request, onEvent: (e) => events.push(e) })
    stream.sendAudio(new Uint8Array(2))
    const turns = events as TurnEvent[]
    expect(turns.map((t) => [t.turnId, t.endOfTurn])).toEqual([
      ['turn-1', false],
      ['turn-1', true],
    ])
  })

  test('failNextOpen throws the code and opens nothing', async () => {
    const memory = createMemoryStreamingTranscribe()
    memory.failNextOpen('streaming_transcribe.rejected')
    await expect(memory.open({ ...request, onEvent: () => undefined })).rejects.toBeInstanceOf(
      StreamingTranscribeError
    )
    expect(memory.streams()).toHaveLength(0)
    await memory.open({ ...request, onEvent: () => undefined })
    expect(memory.streams()).toHaveLength(1)
  })

  test('the pause before a reconnect uses the injected random and sleep', async () => {
    const pauses: number[] = []
    const memory = createMemoryStreamingTranscribe({
      random: () => 0.5,
      sleep: async (ms) => {
        pauses.push(ms)
      },
    })
    const stream = await memory.open({
      ...request,
      reconnect: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 25 },
      onEvent: () => undefined,
    })
    memory.failReconnects(2)
    await memory.dropConnection(stream.streamId)
    expect(pauses).toEqual([10, 20, 25])
    expect(memory.streams()[0]).toMatchObject({ state: 'open', reconnects: 1 })
  })

  test('rejects a script that goes backwards', () => {
    const memory = createMemoryStreamingTranscribe()
    expect(() =>
      memory.script(org, call, 'rep', [
        { text: 'a b', afterBytes: 5 },
        { text: 'c d', afterBytes: 1 },
      ])
    ).toThrow(expect.objectContaining({ code: STREAMING_TRANSCRIBE_ERROR_CODES.invalidRequest }))
  })
})
