import type {
  AssemblyAiSocket,
  AssemblyAiSocketFactory,
  AssemblyAiSocketHandlers,
  AssemblyAiStreamMeta,
} from './assemblyai'

/** Test-only: a fake AssemblyAI streaming (v3) vendor. */

/** The API key the fake accepts. */
export const FAKE_ASSEMBLYAI_KEY = 'aai_test_0123456789abcdef'

/** One turn the fake speaker says. */
export interface FakeTurn {
  /** The words, separated by spaces. */
  text: string
  /** Said once the Call and track has been sent this many audio bytes in all (across reconnects). */
  afterBytes: number
}

/** One connection the fake has seen. */
export interface FakeAssemblyAiConnection {
  /** A unique id, sent as the session id in `Begin`. */
  sessionId: string
  /** The URL asked for. */
  url: string
  /** The query of the URL. */
  query: Readonly<Record<string, string>>
  /** The headers sent with the upgrade. */
  headers: Readonly<Record<string, string>>
  /** The routing information the adapter gave its factory. */
  meta: AssemblyAiStreamMeta
  /** The JSON messages the client sent. */
  messages: Record<string, unknown>[]
  /** The sizes of the audio frames the client sent. */
  frames: number[]
  /** All audio bytes the client sent. */
  audioBytes: number
  /** True once `Begin` was sent. */
  began: boolean
  /** True once either side closed it. */
  closed: boolean
}

/** The fake vendor. */
export interface FakeAssemblyAi {
  /** The factory to hand to the adapter. */
  socket: AssemblyAiSocketFactory
  /** Sets what the speaker of a Call's track says; a later call replaces the earlier and starts counting again. */
  hear(
    organizationId: string,
    callId: string,
    track: string,
    turns: readonly FakeTurn[],
    options?: { interims?: number }
  ): void
  /** Closes the connection with this session id from the vendor's side, as a lost socket would. */
  drop(sessionId: string, code?: number): void
  /** Makes the next `times` connections fail before `Begin`. */
  refuseNext(times: number): void
  /** Makes the next `times` connections be closed before `Begin` with this code. */
  rejectNext(times: number, code: number): void
  /** Makes the next `times` connections open but never send `Begin`. */
  silentNext(times: number): void
  /** Makes the next `times` connections send a `Begin` and then drop at once. */
  dieAfterBeginNext(times: number): void
  /** Sends this raw frame on every open connection. */
  sendRaw(frame: unknown): void
  /** Stops answering `Terminate`: the connection just stays open. */
  ignoreTerminate(): void
  /** Every connection so far, in order. */
  connections: FakeAssemblyAiConnection[]
}

interface Lineage {
  turns: readonly FakeTurn[]
  interims: number
  next: number
  bytes: number
}

const WORD_TIMES_ERROR = 'The fake needs words'

/** Builds the fake. */
export function createFakeAssemblyAi(): FakeAssemblyAi {
  const lineages = new Map<string, Lineage>()
  const connections: FakeAssemblyAiConnection[] = []
  const live = new Map<
    string,
    { handlers: AssemblyAiSocketHandlers; closeNow(code: number): void }
  >()
  let refuse = 0
  let silent = 0
  let dieAfterBegin = 0
  let rejectTimes = 0
  let rejectCode = 1008
  let answerTerminate = true
  const key = (m: AssemblyAiStreamMeta) => `${m.organizationId}|${m.callId}|${m.track}`

  return {
    connections,
    hear(organizationId, callId, track, turns, options = {}) {
      lineages.set(`${organizationId}|${callId}|${track}`, {
        turns,
        interims: options.interims ?? 2,
        next: 0,
        bytes: 0,
      })
    },
    drop(sessionId, code = 1006) {
      live.get(sessionId)?.closeNow(code)
    },
    refuseNext(times) {
      refuse += times
    },
    rejectNext(times, code) {
      rejectTimes += times
      rejectCode = code
    },
    silentNext(times) {
      silent += times
    },
    dieAfterBeginNext(times) {
      dieAfterBegin += times
    },
    sendRaw(frame) {
      for (const entry of live.values()) {
        entry.handlers.message(frame)
      }
    },
    ignoreTerminate() {
      answerTerminate = false
    },
    socket(url, headers, meta) {
      const parsed = new URL(url)
      const query = Object.fromEntries(parsed.searchParams.entries())
      const sessionId = `fake-session-${connections.length + 1}`
      const record: FakeAssemblyAiConnection = {
        sessionId,
        url,
        query,
        headers,
        meta,
        messages: [],
        frames: [],
        audioBytes: 0,
        began: false,
        closed: false,
      }
      connections.push(record)
      const sampleRate = Number(query.sample_rate)
      const bytesPerMs = (sampleRate * (query.encoding === 'pcm_mulaw' ? 1 : 2)) / 1000
      const formatTurns = query.format_turns === 'true'
      const timers = new Set<ReturnType<typeof setTimeout>>()
      let handlers: AssemblyAiSocketHandlers | undefined
      let sessionBytes = 0
      let lastFinalEndMs = 0
      let order = 0

      const later = (run: () => void) => {
        const t = setTimeout(() => {
          timers.delete(t)
          if (!record.closed) {
            run()
          }
        }, 0)
        timers.add(t)
      }
      const emit = (body: Record<string, unknown>) => handlers?.message(JSON.stringify(body))
      const closeNow = (code: number) => {
        if (record.closed) {
          return
        }
        record.closed = true
        live.delete(sessionId)
        for (const t of timers) {
          clearTimeout(t)
        }
        handlers?.close(code)
      }

      function layout(text: string) {
        const words = text.split(' ').filter((w) => w.length > 0)
        if (words.length === 0) {
          throw new Error(WORD_TIMES_ERROR)
        }
        const audioMs = Math.floor(sessionBytes / bytesPerMs)
        const from = Math.min(lastFinalEndMs, audioMs)
        const span = audioMs - from
        return words.map((w, i) => ({
          text: w,
          start: from + Math.floor((span * i) / words.length),
          end: from + Math.floor((span * (i + 1)) / words.length),
          confidence: 0.9,
        }))
      }
      function turnMessage(
        words: ReturnType<typeof layout>,
        count: number,
        endOfTurn: boolean,
        formatted: boolean
      ) {
        const shown = words.slice(0, count)
        return {
          type: 'Turn',
          turn_order: order,
          turn_is_formatted: formatted,
          end_of_turn: endOfTurn,
          transcript: shown.map((w) => w.text).join(' '),
          words: shown.map((w) => ({ ...w, word_is_final: endOfTurn })),
          end_of_turn_confidence: 0.8,
        }
      }
      function pump() {
        const lineage = lineages.get(key(meta))
        while (lineage !== undefined && lineage.next < lineage.turns.length) {
          const turn = lineage.turns[lineage.next]
          if (turn === undefined || lineage.bytes < turn.afterBytes) {
            return
          }
          lineage.next += 1
          const words = layout(turn.text)
          const interims = Math.min(lineage.interims, words.length - 1)
          for (let i = 1; i <= interims; i++) {
            const take = Math.max(1, Math.floor((words.length * i) / (interims + 1)))
            emit(turnMessage(words, take, false, false))
          }
          if (formatTurns) {
            emit(turnMessage(words, words.length, true, false))
          }
          emit(turnMessage(words, words.length, true, formatTurns))
          lastFinalEndMs = words.at(-1)?.end ?? lastFinalEndMs
          order += 1
        }
      }

      const socket: AssemblyAiSocket = {
        attach(h) {
          handlers = h
          live.set(sessionId, { handlers: h, closeNow })
          later(() => {
            if (refuse > 0) {
              refuse -= 1
              record.closed = true
              live.delete(sessionId)
              h.error()
              h.close(1006)
              return
            }
            if (rejectTimes > 0) {
              rejectTimes -= 1
              closeNow(rejectCode)
              return
            }
            if (silent > 0) {
              silent -= 1
              return
            }
            if (headers.Authorization !== FAKE_ASSEMBLYAI_KEY) {
              closeNow(1008)
              return
            }
            h.open()
            record.began = true
            emit({ type: 'Begin', id: sessionId, expires_at: 4_102_444_800 })
            if (dieAfterBegin > 0) {
              dieAfterBegin -= 1
              later(() => closeNow(1006))
            }
          })
        },
        send(data) {
          if (typeof data === 'string') {
            const message = JSON.parse(data) as Record<string, unknown>
            record.messages.push(message)
            if (message.type === 'ForceEndpoint') {
              return
            }
            if (message.type === 'Terminate' && answerTerminate) {
              later(() => {
                emit({
                  type: 'Termination',
                  audio_duration_seconds: sessionBytes / bytesPerMs / 1000,
                  session_duration_seconds: 1,
                })
                closeNow(1000)
              })
            }
            return
          }
          const ms = data.byteLength / bytesPerMs
          record.frames.push(data.byteLength)
          if (ms < 50 || ms > 1000) {
            later(() => closeNow(3007))
            return
          }
          record.audioBytes += data.byteLength
          sessionBytes += data.byteLength
          const lineage = lineages.get(key(meta))
          if (lineage !== undefined) {
            lineage.bytes += data.byteLength
          }
          pump()
        },
        close() {
          if (!record.closed) {
            record.closed = true
            live.delete(sessionId)
            for (const t of timers) {
              clearTimeout(t)
            }
          }
        },
      }
      return socket
    },
  }
}
