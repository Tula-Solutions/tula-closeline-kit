import { afterEach, describe, expect, test } from 'bun:test'
import { type CallId, callIdSchema, type OrganizationId } from 'tula-closeline-contract'
import type { MemoryErrorReporter } from '../reporting/testing'
import type {
  OpenStreamRequest,
  StreamEvent,
  StreamingTranscribePort,
  StreamTrack,
  TranscribeStream,
  TurnEvent,
} from './port'

/** The words the vendor is arranged to hear once the stream has been sent enough audio. */
export interface HeardTurn {
  /** The words, separated by spaces: at least three. */
  text: string
}

/** What the behaviour suite needs from an adapter under test. */
export interface StreamingTranscribeSubject {
  /** The port under test, with no streams for the Organizations below. */
  port: StreamingTranscribePort
  /** Two unrelated Organization ids the port accepts. */
  organizations: { a: OrganizationId; b: OrganizationId }
  /** The reporter the port was built with: the suite reads what it was given. */
  reporter: MemoryErrorReporter
  /** Everything the port logged, one JSON or text line per entry. */
  logs(): string[]
  /**
   * Arranges that the stream to be opened for this Call and track hears `turns`, one after
   * another: the first once the stream has been sent `bytesPerTurn` bytes, the next after twice
   * that, and so on. Called before `open`.
   */
  hear(
    organizationId: OrganizationId,
    callId: CallId,
    track: StreamTrack,
    turns: readonly HeardTurn[],
    bytesPerTurn: number
  ): void
  /** Drops the connection of a stream, as the vendor's socket closing would; resolves once it is back or has failed. */
  dropConnection(streamId: string): Promise<void>
  /** Makes the next `times` reconnect attempts fail. */
  failReconnects(times: number): void
  /** Removes what the subject created, including every vendor stream. */
  close(): Promise<void>
}

const CHUNK = 3200
const SECRET_TEXT = 'zebra confidential pricing'
const AUDIO_MARKER = 'AUDIO-MARKER-PAYLOAD'

function audio(bytes: number): Uint8Array {
  const marker = new TextEncoder().encode(AUDIO_MARKER)
  const out = new Uint8Array(bytes)
  for (let i = 0; i < bytes; i++) {
    out[i] = marker[i % marker.length] ?? 0
  }
  return out
}

/**
 * The behaviour every {@link StreamingTranscribePort} must show: interims come before the final
 * of a turn and the end-of-turn mark is on the last final only; word times are continuous; a
 * dropped stream reconnects within its bounded attempts and keeps going; one that cannot be
 * restored ends with one `failed` event and one report of metadata; closing is idempotent and
 * ends the events; one live stream per Call and track; Organizations are separate; and neither
 * audio nor transcript text reaches a log or the error reporter. Run it against the memory
 * adapter and any real adapter (which needs a subject that drives the vendor's test mode).
 */
export function streamingTranscribeBehaviour(
  name: string,
  make: () => Promise<StreamingTranscribeSubject>,
  skip = false
): void {
  const run = skip ? describe.skip : describe
  run(`Streaming transcribe behaviour: ${name}`, () => {
    const made: StreamingTranscribeSubject[] = []
    const streams: TranscribeStream[] = []
    afterEach(async () => {
      await Promise.all(streams.splice(0).map((stream) => stream.close().catch(() => undefined)))
      await Promise.all(made.splice(0).map((subject) => subject.close()))
    })
    async function subject(): Promise<StreamingTranscribeSubject> {
      const next = await make()
      made.push(next)
      return next
    }

    const callId = callIdSchema.parse(`call_${'c'.repeat(32)}`)
    const otherCallId = callIdSchema.parse(`call_${'d'.repeat(32)}`)

    interface Opened {
      stream: TranscribeStream
      events: StreamEvent[]
      turns(): TurnEvent[]
    }

    async function open(
      s: StreamingTranscribeSubject,
      overrides: Partial<Omit<OpenStreamRequest, 'onEvent'>> = {}
    ): Promise<Opened> {
      const events: StreamEvent[] = []
      const stream = await s.port.open({
        organizationId: s.organizations.a,
        callId,
        track: 'prospect',
        encoding: 'pcm_s16le',
        sampleRate: 16000,
        reconnect: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 4 },
        ...overrides,
        onEvent: (event) => events.push(event),
      })
      streams.push(stream)
      return {
        stream,
        events,
        turns: () => events.filter((e): e is TurnEvent => e.type === 'turn'),
      }
    }

    async function until(condition: () => boolean, what: string): Promise<void> {
      const deadline = Date.now() + 5000
      while (!condition()) {
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for ${what}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
    }

    const sayTwo = [{ text: 'we need a lower price' }, { text: 'send me the quote today' }]

    test('interims come before the final of a turn, with continuous word times', async () => {
      const s = await subject()
      s.hear(s.organizations.a, callId, 'prospect', sayTwo, CHUNK)
      const { stream, turns } = await open(s)
      stream.sendAudio(audio(CHUNK))
      await until(() => turns().some((t) => t.isFinal), 'the first final')
      stream.sendAudio(audio(CHUNK))
      await until(() => turns().filter((t) => t.isFinal).length === 2, 'the second final')

      const all = turns()
      expect(all.map((t) => t.sequence)).toEqual(all.map((_, i) => i + 1))
      for (const id of new Set(all.map((t) => t.turnId))) {
        const ofTurn = all.filter((t) => t.turnId === id)
        const final = ofTurn.at(-1)
        expect(final?.isFinal).toBe(true)
        expect(ofTurn.filter((t) => t.isFinal)).toHaveLength(1)
        expect(ofTurn.length).toBeGreaterThan(1)
        for (const interim of ofTurn.slice(0, -1)) {
          expect(interim.isFinal).toBe(false)
          expect(interim.endOfTurn).toBe(false)
          expect(final?.text.startsWith(interim.text)).toBe(true)
        }
      }
      let previousEnd = 0
      for (const final of all.filter((t) => t.isFinal)) {
        expect(final.words.map((w) => w.text).join(' ')).toBe(final.text)
        for (const word of final.words) {
          expect(word.startMs).toBeGreaterThanOrEqual(previousEnd)
          expect(word.endMs).toBeGreaterThanOrEqual(word.startMs)
          previousEnd = word.endMs
        }
      }
    })

    test('the end of turn is marked on the final only, and the next turn has a new id', async () => {
      const s = await subject()
      s.hear(s.organizations.a, callId, 'prospect', sayTwo, CHUNK)
      const { stream, turns } = await open(s)
      stream.sendAudio(audio(CHUNK * 2))
      await until(() => turns().filter((t) => t.endOfTurn).length === 2, 'two ends of turn')
      const all = turns()
      expect(all.filter((t) => t.endOfTurn).every((t) => t.isFinal)).toBe(true)
      const ends = all.filter((t) => t.endOfTurn)
      expect(ends[0]?.turnId).not.toBe(ends[1]?.turnId)
      expect(all.at(-1)?.endOfTurn).toBe(true)
    })

    test('a dropped stream reconnects and goes on, with word times continuing', async () => {
      const s = await subject()
      s.hear(s.organizations.a, callId, 'prospect', sayTwo, CHUNK)
      const { stream, events, turns } = await open(s)
      stream.sendAudio(audio(CHUNK))
      await until(() => turns().some((t) => t.endOfTurn), 'the first turn')
      const firstEnd =
        turns()
          .find((t) => t.endOfTurn)
          ?.words.at(-1)?.endMs ?? 0

      s.failReconnects(1)
      await s.dropConnection(stream.streamId)
      const kinds = events.filter((e) => e.type !== 'turn').map((e) => e.type)
      expect(kinds).toEqual(['reconnecting', 'reconnecting', 'reconnected'])
      const attempts = events.filter((e) => e.type === 'reconnecting')
      expect(attempts.map((e) => (e.type === 'reconnecting' ? e.attempt : 0))).toEqual([1, 2])
      for (const attempt of attempts) {
        if (attempt.type === 'reconnecting') {
          expect(attempt.delayMs).toBeGreaterThanOrEqual(1)
          expect(attempt.delayMs).toBeLessThanOrEqual(6)
        }
      }

      stream.sendAudio(audio(CHUNK))
      await until(() => turns().filter((t) => t.endOfTurn).length === 2, 'the turn after')
      const second = turns().filter((t) => t.endOfTurn)[1]
      expect(second?.words[0]?.startMs).toBeGreaterThanOrEqual(firstEnd)
      const sequences = turns().map((t) => t.sequence)
      expect(sequences).toEqual(sequences.map((_, i) => i + 1))
    })

    test('a stream that cannot be restored ends with one failed event and one metadata report', async () => {
      const s = await subject()
      s.hear(s.organizations.a, callId, 'prospect', [{ text: SECRET_TEXT }], CHUNK)
      const { stream, events } = await open(s, { reconnect: { maxAttempts: 2, baseDelayMs: 1 } })
      s.failReconnects(10)
      await s.dropConnection(stream.streamId)

      const reconnecting = events.filter((e) => e.type === 'reconnecting')
      expect(reconnecting).toHaveLength(2)
      expect(events.filter((e) => e.type === 'reconnected')).toHaveLength(0)
      const last = events.at(-1)
      expect(last).toMatchObject({
        type: 'failed',
        code: 'streaming_transcribe.unavailable',
        attempts: 2,
      })
      expect(events.filter((e) => e.type === 'failed' || e.type === 'closed')).toHaveLength(1)
      expect(() => stream.sendAudio(audio(CHUNK))).toThrow(
        expect.objectContaining({ code: 'streaming_transcribe.closed' })
      )
      await stream.close()
      expect(events.at(-1)?.type).toBe('failed')

      expect(s.reporter.captured).toHaveLength(1)
      expect(s.reporter.captured[0]?.error).toMatchObject({
        code: 'streaming_transcribe.unavailable',
      })
      expect(s.reporter.captured[0]?.context.organizationId).toBe(s.organizations.a)
    })

    test('a drop with no attempts allowed fails at once', async () => {
      const s = await subject()
      const { stream, events } = await open(s, { reconnect: { maxAttempts: 0 } })
      await s.dropConnection(stream.streamId)
      expect(events.map((e) => e.type)).toEqual(['failed'])
    })

    test('closing ends the events, is idempotent and frees the Call and track', async () => {
      const s = await subject()
      s.hear(s.organizations.a, callId, 'prospect', sayTwo, CHUNK)
      const { stream, events } = await open(s)
      await stream.close()
      await stream.close()
      expect(events.filter((e) => e.type === 'closed')).toHaveLength(1)
      expect(events.at(-1)?.type).toBe('closed')
      expect(() => stream.sendAudio(audio(CHUNK))).toThrow(
        expect.objectContaining({ code: 'streaming_transcribe.closed' })
      )
      const count = events.length
      await s.dropConnection(stream.streamId)
      expect(events).toHaveLength(count)
      const again = await open(s)
      await again.stream.close()
    })

    test('closing during a reconnect stops it and ends with closed', async () => {
      const s = await subject()
      const { stream, events } = await open(s, {
        reconnect: { maxAttempts: 5, baseDelayMs: 20, maxDelayMs: 20 },
      })
      s.failReconnects(10)
      const dropping = s.dropConnection(stream.streamId)
      await until(() => events.some((e) => e.type === 'reconnecting'), 'a reconnect attempt')
      await stream.close()
      await dropping
      expect(events.at(-1)?.type).toBe('closed')
      expect(events.some((e) => e.type === 'failed')).toBe(false)
    })

    test('one live stream per Call and track; another track or Organization is separate', async () => {
      const s = await subject()
      const first = await open(s)
      await expect(open(s)).rejects.toMatchObject({ code: 'streaming_transcribe.conflict' })
      const rep = await open(s, { track: 'rep' })
      const other = await open(s, { organizationId: s.organizations.b })
      s.hear(s.organizations.b, callId, 'prospect', [{ text: 'only for the other org' }], CHUNK)
      expect(first.events).toHaveLength(0)
      expect(rep.events).toHaveLength(0)
      expect(other.events).toHaveLength(0)
    })

    test('a stream hears only what was arranged for its own Organization', async () => {
      const s = await subject()
      s.hear(s.organizations.a, otherCallId, 'prospect', sayTwo, CHUNK)
      const b = await open(s, { organizationId: s.organizations.b, callId: otherCallId })
      b.stream.sendAudio(audio(CHUNK * 2))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(b.turns()).toHaveLength(0)
    })

    test('refuses a bad request or chunk before talking to the vendor', async () => {
      const s = await subject()
      const bad = [
        { track: 'both' },
        { encoding: 'mp3' },
        { sampleRate: 44100 },
        { callId: 'nope' },
        { organizationId: 'nope' },
        { language: 'english please' },
        { reconnect: { maxAttempts: 11 } },
        { reconnect: { baseDelayMs: 0 } },
      ]
      for (const override of bad) {
        await expect(
          open(s, override as Partial<Omit<OpenStreamRequest, 'onEvent'>>)
        ).rejects.toMatchObject({ code: 'streaming_transcribe.invalid_request' })
      }
      await expect(
        s.port.open(
          {
            organizationId: s.organizations.a,
            callId,
            track: 'rep',
            encoding: 'pcm_s16le',
            sampleRate: 16000,
            onEvent: () => undefined,
          },
          { timeoutMs: 0 }
        )
      ).rejects.toMatchObject({ code: 'streaming_transcribe.invalid_request' })
      const { stream } = await open(s)
      for (const chunk of [new Uint8Array(0), new Uint8Array(65_537)]) {
        expect(() => stream.sendAudio(chunk)).toThrow(
          expect.objectContaining({ code: 'streaming_transcribe.invalid_request' })
        )
      }
    })

    test('a throwing listener does not stop the stream', async () => {
      const s = await subject()
      s.hear(s.organizations.a, callId, 'prospect', sayTwo, CHUNK)
      let seen = 0
      const stream = await s.port.open({
        organizationId: s.organizations.a,
        callId,
        track: 'prospect',
        encoding: 'pcm_s16le',
        sampleRate: 16000,
        onEvent: () => {
          seen += 1
          throw new Error(SECRET_TEXT)
        },
      })
      streams.push(stream)
      stream.sendAudio(audio(CHUNK * 2))
      await until(() => seen >= 2, 'events to a throwing listener')
      expect(s.logs().join('\n')).not.toContain(SECRET_TEXT)
    })

    test('no audio and no transcript text reaches a log or the error reporter', async () => {
      const s = await subject()
      s.hear(s.organizations.a, callId, 'prospect', [{ text: SECRET_TEXT }], CHUNK)
      const { stream, turns } = await open(s, { reconnect: { maxAttempts: 1, baseDelayMs: 1 } })
      stream.sendAudio(audio(CHUNK))
      await until(() => turns().some((t) => t.endOfTurn), 'the turn')
      s.failReconnects(10)
      await s.dropConnection(stream.streamId)
      expect(s.reporter.captured).toHaveLength(1)

      const seen = [
        ...s.logs(),
        JSON.stringify(s.reporter.captured, (_key, value) =>
          value instanceof Error
            ? { ...value, name: value.name, message: value.message, stack: value.stack }
            : value
        ),
      ].join('\n')
      for (const secret of [SECRET_TEXT, 'confidential', 'zebra', AUDIO_MARKER]) {
        expect(seen).not.toContain(secret)
      }
      const reported = s.reporter.captured[0]
      const tags = reported?.context.tags ?? {}
      expect(Object.keys(reported?.context ?? {}).sort()).toEqual(['organizationId', 'tags'])
      expect(Object.keys(tags).sort()).toEqual(['feature', 'track'])
    })
  })
}
