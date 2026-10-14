import { describe, expect, test } from 'bun:test'
import { createMemoryTranscriber } from './memory'
import type { TranscribeRequest } from './port'
import { waitForTranscription } from './wait'

const A = `org_${'a'.repeat(32)}`
const B = `org_${'b'.repeat(32)}`

const send = (reference: string, extra: Partial<TranscribeRequest> = {}): TranscribeRequest => ({
  clientReference: reference,
  audio: { url: `https://audio.example.test/${reference}?sig=abc` },
  speakers: 'diarize',
  ...extra,
})

describe('the memory transcriber', () => {
  test('a send is pending for one read and then done with the same four turns every time', async () => {
    const first = createMemoryTranscriber()
    const second = createMemoryTranscriber()
    for (const transcriber of [first, second]) {
      await transcriber.submit(A, send('c:1'))
    }

    expect(await first.getResult(A, 'c:1')).toEqual({ status: 'pending' })
    const done = await first.getResult(A, 'c:1')
    await second.getResult(A, 'c:1')
    expect(await second.getResult(A, 'c:1')).toEqual(done)
    expect(done).toMatchObject({ status: 'done', durationMs: 20_000 })
    expect(done?.status === 'done' && done.turns.map((turn) => turn.speaker)).toEqual([
      'A',
      'B',
      'A',
      'B',
    ])
  })

  test('split channels give each turn its channel', async () => {
    const transcriber = createMemoryTranscriber()
    transcriber.script(A, 'c:1', {
      pendingReads: 0,
      result: { status: 'done', durationMs: 1, turns: [] },
    })
    await transcriber.submit(A, send('c:2', { speakers: 'split_channels' }))
    await transcriber.getResult(A, 'c:2')
    const result = await transcriber.getResult(A, 'c:2')

    expect(result?.status === 'done' && result.turns.map((turn) => turn.channel)).toEqual([
      0, 1, 0, 1,
    ])
  })

  test('a scripted outcome applies before and after the send, and a scripted failure is a listed reason', async () => {
    const transcriber = createMemoryTranscriber()
    transcriber.script(A, 'c:1', {
      pendingReads: 0,
      result: { status: 'failed', reason: 'no_speech' },
    })
    await transcriber.submit(A, send('c:1'))
    expect(await transcriber.getResult(A, 'c:1')).toEqual({ status: 'failed', reason: 'no_speech' })

    transcriber.script(A, 'c:1', {
      pendingReads: 2,
      result: { status: 'done', durationMs: 5, turns: [] },
    })
    expect((await transcriber.getResult(A, 'c:1'))?.status).toBe('pending')
    expect((await transcriber.getResult(A, 'c:1'))?.status).toBe('pending')
    expect((await transcriber.getResult(A, 'c:1'))?.status).toBe('done')
  })

  test('a scripted failure changes nothing and is used once', async () => {
    const transcriber = createMemoryTranscriber()
    transcriber.failNext('submit', 'transcriber.unavailable')

    await expect(transcriber.submit(A, send('c:1'))).rejects.toMatchObject({
      code: 'transcriber.unavailable',
    })
    expect(transcriber.copies()).toEqual([])
    expect((await transcriber.submit(A, send('c:1'))).created).toBe(true)
    transcriber.failNext('getResult', 'transcriber.rejected', 2)
    await expect(transcriber.getResult(A, 'c:1')).rejects.toMatchObject({
      code: 'transcriber.rejected',
    })
    await expect(transcriber.getResult(A, 'c:1')).rejects.toMatchObject({
      code: 'transcriber.rejected',
    })
    expect((await transcriber.getResult(A, 'c:1'))?.status).toBe('pending')
  })

  test('accepted but the caller crashed before storing the id: the copy is held, a purge by prefix removes it', async () => {
    const transcriber = createMemoryTranscriber()
    transcriber.acceptThenFailNext()

    await expect(transcriber.submit(A, send('call_1:1'))).rejects.toMatchObject({
      code: 'transcriber.unavailable',
    })

    const held = transcriber.copies(A)
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({ clientReference: 'call_1:1', vendorId: 'mem_1' })
    for (const entry of (await transcriber.list(A, { prefix: 'call_1:' })).items) {
      await transcriber.delete(A, entry.clientReference)
    }
    expect(transcriber.copies()).toEqual([])
  })

  test('a send that is retried after that crash finds the copy and creates nothing', async () => {
    const transcriber = createMemoryTranscriber()
    transcriber.acceptThenFailNext()
    await transcriber.submit(A, send('call_1:1')).catch(() => undefined)

    expect((await transcriber.submit(A, send('call_1:1'))).created).toBe(false)
    expect(transcriber.copies()).toHaveLength(1)
  })

  test('copies show every Organization, in order, and never the audio URL or the text', async () => {
    const transcriber = createMemoryTranscriber()
    await transcriber.submit(B, send('b:1'))
    await transcriber.submit(A, send('a:2'))
    await transcriber.submit(A, send('a:1'))

    expect(
      transcriber
        .copies()
        .map((copy) => `${copy.organizationId.slice(4, 5)}${copy.clientReference}`)
    ).toEqual(['aa:1', 'aa:2', 'bb:1'])
    expect(JSON.stringify(transcriber.copies())).not.toContain('example.test')
    expect(JSON.stringify(transcriber.copies())).not.toContain('Turn')
  })

  test('the result handed out is a copy', async () => {
    const transcriber = createMemoryTranscriber()
    transcriber.script(A, 'c:1', {
      pendingReads: 0,
      result: {
        status: 'done',
        durationMs: 5,
        turns: [{ speaker: 'A', startMs: 0, endMs: 1, text: 'hi' }],
      },
    })
    await transcriber.submit(A, send('c:1'))
    const first = await transcriber.getResult(A, 'c:1')
    if (first?.status === 'done') {
      ;(first.turns[0] as { text: string }).text = 'changed'
    }

    const again = await transcriber.getResult(A, 'c:1')
    expect(again?.status === 'done' && again.turns[0]?.text).toBe('hi')
  })
})

describe('waitForTranscription', () => {
  test('reads until done, pausing with jitter between reads', async () => {
    const transcriber = createMemoryTranscriber()
    transcriber.script(A, 'c:1', {
      pendingReads: 3,
      result: { status: 'done', durationMs: 5, turns: [] },
    })
    await transcriber.submit(A, send('c:1'))
    const pauses: number[] = []

    const result = await waitForTranscription(transcriber, A, 'c:1', {
      intervalMs: 1000,
      random: () => 0.25,
      sleep: async (ms) => {
        pauses.push(ms)
      },
    })

    expect(result?.status).toBe('done')
    expect(pauses).toEqual([750, 750, 750])
  })

  test('is bounded: after maxAttempts it returns pending and reads no more', async () => {
    const transcriber = createMemoryTranscriber()
    transcriber.script(A, 'c:1', {
      pendingReads: 1000,
      result: { status: 'done', durationMs: 5, turns: [] },
    })
    await transcriber.submit(A, send('c:1'))
    const pauses: number[] = []

    const result = await waitForTranscription(transcriber, A, 'c:1', {
      maxAttempts: 4,
      random: () => 0.5,
      sleep: async (ms) => {
        pauses.push(ms)
      },
    })

    expect(result).toEqual({ status: 'pending' })
    expect(pauses).toHaveLength(3)
    expect(pauses.every((ms) => ms === 5000)).toBe(true)
  })

  test('returns undefined for a missing send, a failed result as it is, and surfaces an error', async () => {
    const transcriber = createMemoryTranscriber()
    expect(await waitForTranscription(transcriber, A, 'none')).toBeUndefined()
    transcriber.script(A, 'c:1', {
      pendingReads: 0,
      result: { status: 'failed', reason: 'too_long' },
    })
    await transcriber.submit(A, send('c:1'))
    expect(await waitForTranscription(transcriber, A, 'c:1')).toEqual({
      status: 'failed',
      reason: 'too_long',
    })
    transcriber.failNext('getResult', 'transcriber.unavailable')
    await expect(waitForTranscription(transcriber, A, 'c:1')).rejects.toMatchObject({
      code: 'transcriber.unavailable',
    })
  })

  test('refuses settings out of range and stops when the signal fires', async () => {
    const transcriber = createMemoryTranscriber()
    await transcriber.submit(A, send('c:1'))

    await expect(waitForTranscription(transcriber, A, 'c:1', { maxAttempts: 0 })).rejects.toThrow(
      TypeError
    )
    await expect(waitForTranscription(transcriber, A, 'c:1', { intervalMs: -1 })).rejects.toThrow(
      TypeError
    )
    const controller = new AbortController()
    controller.abort()
    expect(
      await waitForTranscription(transcriber, A, 'c:1', { signal: controller.signal })
    ).toEqual({
      status: 'pending',
    })
  })
})
