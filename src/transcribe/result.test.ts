import { describe, expect, test } from 'bun:test'
import { checkTranscriptionResult } from './result'

const turn = (change: Record<string, unknown> = {}) => ({
  speaker: 'A',
  startMs: 0,
  endMs: 1000,
  text: 'hello',
  ...change,
})
const done = (turns: unknown[], change: Record<string, unknown> = {}) => ({
  status: 'done',
  durationMs: 10_000,
  turns,
  ...change,
})
const bad = { code: 'transcriber.bad_response' }

describe('checkTranscriptionResult', () => {
  test('accepts pending, a failure with a listed reason, and an ordered conversation', () => {
    expect(checkTranscriptionResult({ status: 'pending' })).toEqual({ status: 'pending' })
    expect(checkTranscriptionResult({ status: 'failed', reason: 'no_speech' })).toEqual({
      status: 'failed',
      reason: 'no_speech',
    })
    const result = done([turn(), turn({ speaker: 'B', startMs: 500, endMs: 900 })])
    expect(checkTranscriptionResult(result, { speakers: 'diarize', maxSpeakers: 2 })).toEqual(
      result as never
    )
  })

  test('returns a copy', () => {
    const input = done([turn()])
    const out = checkTranscriptionResult(input)
    expect(out).not.toBe(input)
  })

  test.each([
    ['not an object', 'done'],
    ['an unknown status', { status: 'complete' }],
    ['an unlisted failure reason', { status: 'failed', reason: 'because' }],
    ['no failure reason', { status: 'failed' }],
    ['a negative duration', done([], { durationMs: -1 })],
    ['a fractional duration', done([], { durationMs: 1.5 })],
    ['a duration that is not finite', done([], { durationMs: Number.POSITIVE_INFINITY })],
    ['a duration over 12 hours', done([], { durationMs: 43_200_001 })],
    ['turns that are not a list', done('turns' as unknown as unknown[])],
    [
      'more than 50,000 turns',
      done(
        Array.from({ length: 50_001 }, (_, i) => turn({ startMs: i, endMs: i })),
        { durationMs: 60_000 }
      ),
    ],
    ['a turn with no speaker', done([turn({ speaker: '' })])],
    ['a speaker label over 64 characters', done([turn({ speaker: 'x'.repeat(65) })])],
    ['a fractional start', done([turn({ startMs: 0.5 })])],
    ['a start that is NaN', done([turn({ startMs: Number.NaN })])],
    ['a negative start', done([turn({ startMs: -1 })])],
    ['an end before the start', done([turn({ startMs: 500, endMs: 400 })])],
    ['an end after the audio', done([turn({ endMs: 10_001 })])],
    [
      'turns out of order',
      done([turn({ startMs: 500, endMs: 600 }), turn({ startMs: 100, endMs: 200 })]),
    ],
    ['text that is not a string', done([turn({ text: 5 })])],
    ['text over 20,000 characters', done([turn({ text: 'x'.repeat(20_001) })])],
    [
      'more than 4 million characters of text in all',
      done(
        Array.from({ length: 201 }, (_, i) =>
          turn({ startMs: i, endMs: i, text: 'x'.repeat(20_000) })
        ),
        { durationMs: 60_000 }
      ),
    ],
  ])('refuses %s', (_label, result) => {
    expect(() => checkTranscriptionResult(result)).toThrow()
    try {
      checkTranscriptionResult(result)
    } catch (error) {
      expect(error).toMatchObject(bad)
      expect(JSON.stringify(error)).not.toContain('hello')
    }
  })

  test('applies the request: more speakers than the cap, a channel with diarize, no channel with split', () => {
    const three = done([turn(), turn({ speaker: 'B' }), turn({ speaker: 'C' })])

    expect(() => checkTranscriptionResult(three, { speakers: 'diarize', maxSpeakers: 2 })).toThrow()
    expect(() => checkTranscriptionResult(three, { speakers: 'diarize' })).not.toThrow()
    expect(() =>
      checkTranscriptionResult(done([turn({ channel: 0 })]), { speakers: 'diarize' })
    ).toThrow()
    expect(() => checkTranscriptionResult(done([turn()]), { speakers: 'split_channels' })).toThrow()
    expect(() =>
      checkTranscriptionResult(done([turn({ channel: 1 })]), { speakers: 'split_channels' })
    ).not.toThrow()
    expect(() =>
      checkTranscriptionResult(done([turn({ channel: -1 })]), { speakers: 'split_channels' })
    ).toThrow()
  })
})
