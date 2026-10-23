import type { CartesiaSocket, CartesiaSocketFactory, CartesiaSocketHandlers } from './cartesia'

/** Test-only: a fake Cartesia WebSocket vendor. */

/** What the fake does for the next connection that sends its first message. */
export interface FakeCartesiaScript {
  /** Audio pieces, sent in order as `chunk` messages. */
  chunks?: readonly Uint8Array[]
  /** Pause before each chunk after the first, in ms. */
  chunkDelayMs?: number
  /** Never sends a chunk. */
  hang?: boolean
  /** Sends an `error` message with this status instead of audio. */
  errorStatus?: number
  /** Drops the connection (code 1006) once this many chunks were sent. */
  dropAfterChunks?: number
  /** Refuses the connection before it opens. */
  refuseConnect?: boolean
  /** Never opens the connection. */
  neverOpen?: boolean
  /** Sends this raw frame instead of audio. */
  rawFrame?: unknown
}

/** One connection the fake has seen. */
export interface FakeCartesiaConnection {
  /** The URL. */
  url: string
  /** The headers sent with the upgrade. */
  headers: Readonly<Record<string, string>>
  /** Every parsed JSON message the client sent. */
  messages: Record<string, unknown>[]
  /** True once the client closed it before Cartesia was done with the context. */
  aborted: boolean
  /** True once the client closed it. */
  closed: boolean
}

/** The fake vendor. */
export interface FakeCartesia {
  /** The factory to hand to the adapter. */
  socket: CartesiaSocketFactory
  /** Queues what the next connection that gets a message does. */
  script(next: FakeCartesiaScript): void
  /** Every connection so far. */
  connections: FakeCartesiaConnection[]
}

/** Builds the fake. */
export function createFakeCartesia(): FakeCartesia {
  const scripts: FakeCartesiaScript[] = []
  const connections: FakeCartesiaConnection[] = []
  return {
    connections,
    script: (next) => {
      scripts.push(next)
    },
    socket: (url, headers) => {
      const record: FakeCartesiaConnection = {
        url,
        headers,
        messages: [],
        aborted: false,
        closed: false,
      }
      connections.push(record)
      let handlers: CartesiaSocketHandlers | undefined
      let script: FakeCartesiaScript | undefined
      let finished = false
      const timers = new Set<ReturnType<typeof setTimeout>>()
      let contextId: unknown
      const later = (ms: number, run: () => void) => {
        const t = setTimeout(() => {
          timers.delete(t)
          if (!record.closed) {
            run()
          }
        }, ms)
        timers.add(t)
      }
      const emit = (body: Record<string, unknown>) =>
        handlers?.message(JSON.stringify({ context_id: contextId, ...body }))
      const play = (s: FakeCartesiaScript) => {
        if (s.errorStatus !== undefined) {
          finished = true
          emit({
            type: 'error',
            done: true,
            status_code: s.errorStatus,
            error_code: 'fake_error',
            message: 'x',
          })
          return
        }
        if (s.rawFrame !== undefined) {
          finished = true
          handlers?.message(s.rawFrame)
          return
        }
        if (s.hang) {
          return
        }
        const chunks = s.chunks ?? []
        const sendAt = (i: number) => {
          if (s.dropAfterChunks === i) {
            finished = true
            record.closed = true
            handlers?.close(1006)
            return
          }
          const piece = chunks[i]
          if (piece === undefined) {
            return
          }
          emit({
            type: 'chunk',
            done: false,
            status_code: 206,
            data: Buffer.from(piece).toString('base64'),
          })
          if ((s.chunkDelayMs ?? 0) === 0) {
            sendAt(i + 1)
          } else {
            later(s.chunkDelayMs ?? 0, () => sendAt(i + 1))
          }
        }
        sendAt(0)
      }
      const socket: CartesiaSocket = {
        attach(h) {
          handlers = h
          later(0, () => {
            const head = scripts[0]
            if (head?.refuseConnect) {
              scripts.shift()
              finished = true
              h.error()
              h.close(1006)
            } else if (!head?.neverOpen) {
              h.open()
            } else {
              scripts.shift()
            }
          })
        },
        send(data) {
          const message = JSON.parse(data) as Record<string, unknown>
          record.messages.push(message)
          if (message.cancel === true) {
            return
          }
          contextId = message.context_id
          if (script === undefined) {
            script = scripts.shift() ?? { chunks: [] }
            const s = script
            later(0, () => play(s))
          }
          if (message.continue === false) {
            const s = script
            const wait = (s.chunks?.length ?? 0) * (s.chunkDelayMs ?? 0) + 5
            later(wait, () => {
              if (!finished && !s.hang && s.dropAfterChunks === undefined) {
                finished = true
                emit({ type: 'done', done: true, status_code: 200 })
              }
            })
          }
        },
        close() {
          if (!record.closed) {
            record.closed = true
            record.aborted = !finished
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
