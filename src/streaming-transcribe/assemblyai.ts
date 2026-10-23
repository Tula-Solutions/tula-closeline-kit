import type { CallId, OrganizationId } from 'tula-closeline-contract'
import type { Logger } from '../logger'
import { type Sleep, systemSleep } from '../queue/sleep'
import type { ErrorReporter } from '../reporting/port'
import {
  STREAMING_TRANSCRIBE_ERROR_CODES,
  StreamingTranscribeError,
  type StreamingTranscribeErrorCode,
} from './errors'
import {
  type AudioEncoding,
  MAX_REPLAY_AUDIO_BYTES,
  MAX_WORDS_PER_TURN,
  type OpenStreamRequest,
  type ResolvedReconnectPolicy,
  reconnectDelayMs,
  type SampleRate,
  type StreamEvent,
  type StreamingTranscribeOptions,
  type StreamingTranscribePort,
  type StreamTrack,
  type TranscribedWord,
  type TranscribeStream,
  type TurnEvent,
} from './port'
import { checkChunk, checkOpenRequest, invalid, resolveTimeout } from './validate'

const INSPECT = Symbol.for('nodejs.util.inspect.custom')
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/
/** The close codes that mean the vendor refused the credential or the account, which a retry cannot fix. */
const REJECTED_CLOSE_CODES: readonly number[] = [1008, 4001, 4002, 4003]
/** The longest message from the vendor this adapter reads, in characters. */
const MAX_MESSAGE_CHARS = 1_048_576
/** The longest transcript of one turn event this adapter accepts, in characters. */
const MAX_TRANSCRIPT_CHARS = 100_000
/** The least audio the vendor accepts in one frame, in ms. */
const MIN_FRAME_MS = 50
/** The audio sent in one frame at most, in ms; the vendor's own limit is 1000. */
const MAX_FRAME_MS = 500
/** A connection that dies sooner than this after it was accepted is a quick death. */
const QUICK_DEATH_MS = 1000
/** This many quick deaths in a row fail the stream, whatever is left of its attempts. */
const MAX_QUICK_DEATHS = 5
/** The most bytes a socket may hold unsent before the connection is treated as lost. */
const MAX_SOCKET_BACKLOG_BYTES = 1_048_576

/** The default time to open one connection, in milliseconds. */
export const DEFAULT_ASSEMBLYAI_CONNECT_TIMEOUT_MS = 5_000

/** The default time `close` waits for the vendor to settle the last turn, in milliseconds. */
export const DEFAULT_ASSEMBLYAI_CLOSE_TIMEOUT_MS = 3_000

/** Which AssemblyAI endpoint serves the audio: the US one, or the one that keeps it in the EU. */
export type AssemblyAiRegion = 'us' | 'eu'

/** Who a socket is for. Used to route a test fake; never sent to the vendor. */
export interface AssemblyAiStreamMeta {
  /** The Organization. */
  organizationId: OrganizationId
  /** The Call. */
  callId: CallId
  /** The track. */
  track: StreamTrack
}

/** The callbacks an {@link AssemblyAiSocket} reports through. */
export interface AssemblyAiSocketHandlers {
  /** The connection is open. */
  open(): void
  /** A message arrived; `data` is a string for a text frame. */
  message(data: unknown): void
  /** The connection failed (no detail is kept: it may name a URL). */
  error(): void
  /** The connection closed with this code. */
  close(code: number): void
}

/** The part of a WebSocket the adapter uses, so tests can drive a fake vendor. */
export interface AssemblyAiSocket {
  /** Sends one text or binary frame; throws when the connection cannot take it. */
  send(data: string | Uint8Array): void
  /** Closes the connection. */
  close(code?: number): void
  /** Registers the handlers once, before any event. */
  attach(handlers: AssemblyAiSocketHandlers): void
}

/** Opens a WebSocket to `url` with `headers`; `meta` says whom it is for and is never sent. */
export type AssemblyAiSocketFactory = (
  url: string,
  headers: Readonly<Record<string, string>>,
  meta: AssemblyAiStreamMeta
) => AssemblyAiSocket

/** The real factory, on the runtime's WebSocket (Bun accepts request headers). */
export const bunAssemblyAiSocket: AssemblyAiSocketFactory = (url, headers) => {
  const ws = new WebSocket(url, { headers: { ...headers } })
  return {
    send(data) {
      if (ws.bufferedAmount > MAX_SOCKET_BACKLOG_BYTES) {
        throw new Error('The connection is not taking audio fast enough')
      }
      ws.send(data)
    },
    close: (code) => ws.close(code),
    attach(h) {
      ws.onopen = () => h.open()
      ws.onmessage = (event) => h.message(event.data)
      ws.onerror = () => h.error()
      ws.onclose = (event) => h.close(event.code)
    },
  }
}

/** Options for {@link createAssemblyAiStreamingTranscribe}. */
export interface AssemblyAiStreamingTranscribeOptions {
  /** The AssemblyAI API key. Sent as the `Authorization` header only; never logged, reported or put in an error. */
  apiKey: string
  /** `us` (default) or `eu`, the endpoint that processes the audio in the EU. */
  region?: AssemblyAiRegion
  /** The WebSocket base URL, replacing the region's; `wss`, or `ws` to loopback, with no credentials or query. */
  baseUrl?: string
  /** True to have AssemblyAI punctuate and capitalise turns; the final then arrives with the formatted text, a little later. Default false. */
  formatTurns?: boolean
  /** How sure AssemblyAI must be that the speaker is done before it ends a turn, 0 to 1; the vendor's default when absent. */
  endOfTurnConfidenceThreshold?: number
  /** The silence that ends a turn once the vendor is confident, 0 to 60000 ms; the vendor's default when absent. */
  minEndOfTurnSilenceMs?: number
  /** The silence that ends a turn whatever the confidence, 0 to 60000 ms; the vendor's default when absent. */
  maxTurnSilenceMs?: number
  /** The most time to open one connection, 1 to 30000 ms; default {@link DEFAULT_ASSEMBLYAI_CONNECT_TIMEOUT_MS}. */
  connectTimeoutMs?: number
  /** The most time `close` waits for the vendor to settle, 1 to 30000 ms; default {@link DEFAULT_ASSEMBLYAI_CLOSE_TIMEOUT_MS}. */
  closeTimeoutMs?: number
  /** Opens sockets; the real WebSocket by default. */
  socket?: AssemblyAiSocketFactory
  /** Receives the errors that mean the vendor failed (metadata only); nothing if absent. */
  reporter?: ErrorReporter
  /** Where reconnects and listener failures are noted (metadata only); nothing if absent. */
  logger?: Logger
  /** Pauses between reconnect attempts; real time by default. */
  sleep?: Sleep
  /** A number in `[0, 1)` for the jitter; `Math.random` by default. */
  random?: () => number
}

/** A {@link StreamingTranscribePort} on AssemblyAI that also says how many streams are live. */
export interface AssemblyAiStreamingTranscribe extends StreamingTranscribePort {
  /** How many streams are open or reconnecting. */
  openStreams(): number
}

interface Config {
  apiKey: string
  base: string
  formatTurns: boolean
  query: Readonly<Record<string, string>>
  connectTimeoutMs: number
  closeTimeoutMs: number
  socket: AssemblyAiSocketFactory
  sleep: Sleep
  random: () => number
  reporter: ErrorReporter | undefined
  logger: Logger | undefined
}

interface LinkEvents {
  message(link: Link, data: unknown): void
  lost(link: Link, code: number): void
}

/** One WebSocket session. */
class Link {
  sessionId = ''
  /** True once we closed it or it was lost: nothing more is read from it. */
  down = false
  readonly socket: AssemblyAiSocket

  constructor(socket: AssemblyAiSocket) {
    this.socket = socket
  }

  send(data: string | Uint8Array): void {
    this.socket.send(data)
  }

  shutdown(): void {
    if (this.down) {
      return
    }
    this.down = true
    try {
      this.socket.close(1000)
    } catch {
      // Already closed.
    }
  }
}

function failure(
  code: StreamingTranscribeErrorCode,
  message: string,
  details?: Record<string, unknown>
): StreamingTranscribeError {
  return new StreamingTranscribeError(code, message, details === undefined ? {} : { details })
}

function closeError(code: number): StreamingTranscribeError {
  return REJECTED_CLOSE_CODES.includes(code)
    ? failure(STREAMING_TRANSCRIBE_ERROR_CODES.rejected, 'The vendor refused the stream', {
        closeCode: code,
      })
    : failure(STREAMING_TRANSCRIBE_ERROR_CODES.unavailable, 'The vendor connection closed', {
        closeCode: code,
      })
}

function parseJson(data: unknown): Record<string, unknown> | undefined {
  if (typeof data !== 'string' || data.length > MAX_MESSAGE_CHARS) {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(data)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Opens one connection and resolves once the vendor says `Begin`. Rejects when the connection
 * fails, closes, is refused, takes longer than `timeoutMs` or `signal` aborts. After it resolves,
 * the messages and the loss of the connection go to `events`.
 */
function connectLink(
  config: Config,
  meta: AssemblyAiStreamMeta,
  url: string,
  timeoutMs: number,
  signal: AbortSignal,
  events: LinkEvents
): Promise<Link> {
  return new Promise<Link>((resolve, reject) => {
    let link: Link
    try {
      link = new Link(config.socket(url, { Authorization: config.apiKey }, meta))
    } catch {
      reject(failure(STREAMING_TRANSCRIBE_ERROR_CODES.unavailable, 'The vendor connection failed'))
      return
    }
    let settled = false
    const timer = setTimeout(() => {
      finish(
        failure(STREAMING_TRANSCRIBE_ERROR_CODES.unavailable, 'The vendor connection timed out', {
          phase: 'connect',
          timeoutMs,
        })
      )
    }, timeoutMs)
    const onAbort = () =>
      finish(failure(STREAMING_TRANSCRIBE_ERROR_CODES.unavailable, 'The connection was abandoned'))
    function finish(error?: StreamingTranscribeError) {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      if (error === undefined) {
        resolve(link)
      } else {
        link.shutdown()
        reject(error)
      }
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    link.socket.attach({
      open: () => undefined,
      message: (data) => {
        if (link.down) {
          return
        }
        if (settled) {
          events.message(link, data)
          return
        }
        const m = parseJson(data)
        if (m?.type === 'Begin') {
          if (typeof m.id !== 'string' || !SESSION_ID.test(m.id)) {
            finish(
              failure(
                STREAMING_TRANSCRIBE_ERROR_CODES.badResponse,
                'The vendor sent a session this adapter cannot use'
              )
            )
            return
          }
          link.sessionId = m.id
          finish()
        } else if (typeof m?.error === 'string') {
          finish(failure(STREAMING_TRANSCRIBE_ERROR_CODES.unavailable, 'The vendor sent an error'))
        }
      },
      error: () => {
        if (!settled) {
          finish(
            failure(STREAMING_TRANSCRIBE_ERROR_CODES.unavailable, 'The vendor connection failed')
          )
        } else if (!link.down) {
          link.shutdown()
          events.lost(link, 1006)
        }
      },
      close: (code) => {
        if (!settled) {
          finish(closeError(code))
        } else if (!link.down) {
          link.down = true
          events.lost(link, code)
        }
      },
    })
  })
}

type State = 'open' | 'reconnecting' | 'closing' | 'closed' | 'failed'

interface Host {
  config: Config
  request: OpenStreamRequest
  policy: ResolvedReconnectPolicy
  url: string
  meta: AssemblyAiStreamMeta
  bytesPerMs: number
  frameBytes: number
  released(): void
  report(error: StreamingTranscribeError): void
}

interface ParsedTurn {
  order: number
  text: string
  endOfTurn: boolean
  formatted: boolean
  words: { text: string; start: number; end: number; confidence: number | undefined }[]
}

function badResponse(): StreamingTranscribeError {
  return failure(
    STREAMING_TRANSCRIBE_ERROR_CODES.badResponse,
    'The vendor sent a message this adapter cannot read'
  )
}

function wholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Reads a `Turn` message strictly; `undefined` when it is not one this adapter can use. */
function parseTurn(m: Record<string, unknown>): ParsedTurn | undefined {
  if (
    !(typeof m.turn_order === 'number' && Number.isInteger(m.turn_order) && m.turn_order >= 0) ||
    typeof m.transcript !== 'string' ||
    m.transcript.length > MAX_TRANSCRIPT_CHARS ||
    typeof m.end_of_turn !== 'boolean' ||
    !Array.isArray(m.words) ||
    !(m.turn_is_formatted === undefined || typeof m.turn_is_formatted === 'boolean')
  ) {
    return undefined
  }
  const words: ParsedTurn['words'] = []
  for (const raw of m.words.slice(0, MAX_WORDS_PER_TURN) as unknown[]) {
    if (typeof raw !== 'object' || raw === null) {
      return undefined
    }
    const w = raw as Record<string, unknown>
    if (typeof w.text !== 'string' || !wholeNumber(w.start) || !wholeNumber(w.end)) {
      return undefined
    }
    const confidence =
      typeof w.confidence === 'number' && w.confidence >= 0 && w.confidence <= 1
        ? w.confidence
        : undefined
    words.push({ text: w.text, start: w.start, end: w.end, confidence })
  }
  return {
    order: m.turn_order,
    text: m.transcript,
    endOfTurn: m.end_of_turn,
    formatted: m.turn_is_formatted === true,
    words,
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) {
    return b.slice()
  }
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

/**
 * One stream. The audio, the text and the connection are private fields, so none is in
 * `JSON.stringify`, `String()` or a console dump.
 */
class AssemblyAiStream implements TranscribeStream {
  readonly streamId: string
  readonly #host: Host
  readonly #abort = new AbortController()
  readonly events: LinkEvents
  #state: State = 'open'
  #link: Link | undefined
  #connectedAt = 0
  #quickDeaths = 0
  /** Audio not yet long enough for a frame. */
  #pending: Uint8Array = new Uint8Array(0)
  /** Audio produced while the connection was down, oldest first. */
  #replay: Uint8Array[] = []
  #replayBytes = 0
  /** All audio that has left the pending buffer, sent or not; the stream's clock. */
  #timelineBytes = 0
  #offsetMs = 0
  #turnBase = 0
  #lastTurnNumber = -1
  #endedOrder = -1
  #sequence = 0
  #finished = false
  #settle: (() => void) | undefined
  #closing: Promise<void> | undefined

  constructor(host: Host, streamId: string) {
    this.#host = host
    this.streamId = streamId
    this.events = {
      message: (link, data) => this.#onMessage(link, data),
      lost: (link, code) => this.#onLost(link, code),
    }
  }

  /** Takes over the first connection. */
  adopt(link: Link): void {
    this.#link = link
    this.#connectedAt = performance.now()
  }

  sendAudio(chunk: Uint8Array): void {
    const bytes = checkChunk(chunk)
    if (this.#state === 'closing' || this.#state === 'closed' || this.#state === 'failed') {
      throw new StreamingTranscribeError(
        STREAMING_TRANSCRIBE_ERROR_CODES.closed,
        'The stream has ended'
      )
    }
    const { bytesPerMs, frameBytes } = this.#host
    const minBytes = Math.ceil((MIN_FRAME_MS * bytesPerMs) / frameBytes) * frameBytes
    const maxBytes = Math.floor((MAX_FRAME_MS * bytesPerMs) / frameBytes) * frameBytes
    this.#pending = concat(this.#pending, bytes)
    while (this.#pending.length >= minBytes) {
      const take = Math.min(this.#pending.length - (this.#pending.length % frameBytes), maxBytes)
      const frame = this.#pending.slice(0, take)
      this.#pending = this.#pending.slice(take)
      this.#dispatch(frame)
      if (this.#finished) {
        return
      }
    }
  }

  close(): Promise<void> {
    if (this.#closing !== undefined) {
      return this.#closing
    }
    if (this.#state === 'closed' || this.#state === 'failed') {
      return Promise.resolve()
    }
    this.#closing = this.#doClose()
    return this.#closing
  }

  /** The metadata, for `JSON.stringify`; the audio and the text are not in it. */
  toJSON(): { streamId: string; state: State } {
    return { streamId: this.streamId, state: this.#state }
  }

  /** A readable label without the audio or the text. */
  toString(): string {
    return `AssemblyAiStream(${this.streamId}, ${this.#state})`
  }

  /** The console and `util.inspect` form, without the audio or the text. */
  [INSPECT](): string {
    return this.toString()
  }

  async #doClose(): Promise<void> {
    if (this.#state === 'reconnecting') {
      this.#end('closed')
      return
    }
    this.#state = 'closing'
    const link = this.#link
    if (link !== undefined && !link.down) {
      const settled = new Promise<void>((resolve) => {
        this.#settle = resolve
      })
      let timer: ReturnType<typeof setTimeout> | undefined
      const timedOut = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.#host.config.closeTimeoutMs)
      })
      try {
        this.#flushTail(link)
        link.send(JSON.stringify({ type: 'ForceEndpoint' }))
        link.send(JSON.stringify({ type: 'Terminate' }))
        await Promise.race([settled, timedOut])
      } catch {
        // The connection is gone; there is nothing to wait for.
      } finally {
        clearTimeout(timer)
      }
    }
    this.#end('closed')
  }

  /** Sends the audio too short for a frame, padded with silence to the vendor's minimum. */
  #flushTail(link: Link): void {
    if (this.#pending.length === 0) {
      return
    }
    const { bytesPerMs, frameBytes, request } = this.#host
    const minBytes = Math.ceil((MIN_FRAME_MS * bytesPerMs) / frameBytes) * frameBytes
    const frame = new Uint8Array(Math.max(minBytes, this.#pending.length))
    frame.fill(request.encoding === 'pcm_mulaw' ? 0xff : 0)
    frame.set(this.#pending)
    this.#pending = new Uint8Array(0)
    this.#timelineBytes += frame.length
    link.send(frame)
  }

  #emit(event: StreamEvent): void {
    if (this.#finished) {
      return
    }
    if (event.type === 'closed' || event.type === 'failed') {
      this.#finished = true
    }
    try {
      this.#host.request.onEvent(event)
    } catch {
      // The listener's error may hold text, so only the fact is noted.
      this.#host.config.logger?.warn('A stream listener threw', { streamId: this.streamId })
    }
  }

  /** Ends the stream for good; `closed` by the caller, `failed` otherwise. */
  #end(state: 'closed'): void
  #end(state: 'failed', error: StreamingTranscribeError, attempts: number): void
  #end(state: 'closed' | 'failed', error?: StreamingTranscribeError, attempts = 0): void {
    if (this.#finished) {
      return
    }
    this.#state = state
    this.#abort.abort()
    this.#link?.shutdown()
    this.#pending = new Uint8Array(0)
    this.#replay = []
    this.#replayBytes = 0
    this.#settle?.()
    this.#host.released()
    if (state === 'closed' || error === undefined) {
      this.#emit({ type: 'closed' })
      return
    }
    this.#emit({ type: 'failed', code: error.code, attempts })
    this.#host.config.logger?.error('A stream failed', {
      streamId: this.streamId,
      track: this.#host.meta.track,
      code: error.code,
      attempts,
    })
    this.#host.report(error)
  }

  #fail(error: StreamingTranscribeError, attempts: number): void {
    this.#end('failed', error, attempts)
  }

  #dispatch(frame: Uint8Array): void {
    this.#timelineBytes += frame.length
    const link = this.#link
    if (this.#state === 'open' && link !== undefined && !link.down) {
      try {
        link.send(frame)
        return
      } catch {
        // Keep the audio for the new connection.
      }
      this.#keep(frame)
      link.shutdown()
      this.#onLost(link, 1006)
      return
    }
    this.#keep(frame)
  }

  #keep(frame: Uint8Array): void {
    this.#replay.push(frame.slice())
    this.#replayBytes += frame.length
    while (this.#replayBytes > MAX_REPLAY_AUDIO_BYTES && this.#replay.length > 0) {
      this.#replayBytes -= this.#replay.shift()?.length ?? 0
    }
  }

  #onMessage(link: Link, data: unknown): void {
    if (link !== this.#link || this.#finished) {
      return
    }
    const m = parseJson(data)
    if (m === undefined) {
      this.#fail(badResponse(), 0)
      return
    }
    switch (m.type) {
      case 'Turn': {
        const turn = parseTurn(m)
        if (turn === undefined) {
          this.#fail(badResponse(), 0)
          return
        }
        this.#onTurn(turn)
        return
      }
      case 'Termination':
        this.#settle?.()
        return
      default:
        if (typeof m.error === 'string') {
          link.shutdown()
          this.#onLost(link, 1011)
        }
      // Begin and the other notices carry nothing this port uses.
    }
  }

  #onTurn(turn: ParsedTurn): void {
    const { formatTurns } = this.#host.config
    if (turn.order <= this.#endedOrder) {
      return
    }
    // With formatting on, the unformatted end of turn is followed by the formatted one, which is the final.
    if (turn.endOfTurn && formatTurns && !turn.formatted) {
      return
    }
    const number = this.#turnBase + turn.order
    this.#lastTurnNumber = Math.max(this.#lastTurnNumber, number)
    if (turn.endOfTurn) {
      this.#endedOrder = turn.order
    }
    if (turn.text.length === 0) {
      return
    }
    const offset = this.#offsetMs
    const words: TranscribedWord[] = turn.words.map((w) => {
      const startMs = Math.round(w.start) + offset
      return {
        text: w.text,
        startMs,
        endMs: Math.max(startMs, Math.round(w.end) + offset),
        ...(w.confidence === undefined ? {} : { confidence: w.confidence }),
      }
    })
    this.#sequence += 1
    const event: TurnEvent = {
      type: 'turn',
      turnId: `turn-${number}`,
      sequence: this.#sequence,
      isFinal: turn.endOfTurn,
      endOfTurn: turn.endOfTurn,
      text: turn.text,
      words,
    }
    this.#emit(event)
  }

  #onLost(link: Link, code: number): void {
    if (link !== this.#link) {
      return
    }
    if (this.#state === 'closing') {
      this.#settle?.()
      return
    }
    if (this.#state !== 'open') {
      return
    }
    if (REJECTED_CLOSE_CODES.includes(code)) {
      this.#fail(closeError(code), 0)
      return
    }
    this.#quickDeaths =
      performance.now() - this.#connectedAt < QUICK_DEATH_MS ? this.#quickDeaths + 1 : 0
    if (this.#quickDeaths >= MAX_QUICK_DEATHS) {
      this.#fail(
        failure(
          STREAMING_TRANSCRIBE_ERROR_CODES.unavailable,
          'The vendor connection keeps closing as soon as it opens'
        ),
        0
      )
      return
    }
    void this.#reconnect()
  }

  async #reconnect(): Promise<void> {
    const host = this.#host
    const { policy, config } = host
    this.#state = 'reconnecting'
    this.#link?.shutdown()
    let last: StreamingTranscribeError | undefined
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
      const delayMs = reconnectDelayMs(attempt, policy, config.random)
      this.#emit({ type: 'reconnecting', attempt, delayMs })
      config.logger?.warn('A stream is reconnecting', {
        streamId: this.streamId,
        attempt,
        delayMs,
      })
      await config.sleep(delayMs, this.#abort.signal)
      if (this.#state !== 'reconnecting') {
        return
      }
      let link: Link
      try {
        link = await connectLink(
          config,
          host.meta,
          host.url,
          config.connectTimeoutMs,
          this.#abort.signal,
          this.events
        )
      } catch (error) {
        if (this.#state !== 'reconnecting') {
          return
        }
        last = error instanceof StreamingTranscribeError ? error : badResponse()
        if (
          last.code === STREAMING_TRANSCRIBE_ERROR_CODES.rejected ||
          last.code === STREAMING_TRANSCRIBE_ERROR_CODES.badResponse
        ) {
          this.#fail(last, attempt)
          return
        }
        continue
      }
      if (this.#state !== 'reconnecting') {
        link.shutdown()
        return
      }
      // The new session's clock and turn numbers start again; shift them to carry on from here.
      this.#offsetMs = Math.floor((this.#timelineBytes - this.#replayBytes) / host.bytesPerMs)
      this.#turnBase = this.#lastTurnNumber + 1
      this.#endedOrder = -1
      this.#link = link
      this.#connectedAt = performance.now()
      this.#state = 'open'
      this.#emit({ type: 'reconnected', attempts: attempt })
      this.#replayAudio(link)
      return
    }
    this.#fail(
      last ??
        failure(STREAMING_TRANSCRIBE_ERROR_CODES.unavailable, 'The stream could not be restored'),
      policy.maxAttempts
    )
  }

  #replayAudio(link: Link): void {
    while (this.#replay.length > 0 && this.#state === 'open' && !link.down) {
      const frame = this.#replay[0]
      if (frame === undefined) {
        return
      }
      try {
        link.send(frame)
      } catch {
        link.shutdown()
        this.#onLost(link, 1006)
        return
      }
      this.#replay.shift()
      this.#replayBytes -= frame.length
    }
  }
}

function checkNumber(
  value: number | undefined,
  what: string,
  min: number,
  max: number,
  whole: boolean
) {
  if (value === undefined) {
    return
  }
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (whole && !Number.isInteger(value))
  ) {
    invalid(what)
  }
}

/** True for a wss URL, or a ws URL to loopback, with no credentials, query or fragment. */
function isSafeBaseUrl(base: string): boolean {
  let url: URL
  try {
    url = new URL(base)
  } catch {
    return false
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return false
  }
  if (url.protocol === 'wss:') {
    return true
  }
  return url.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
}

const HOSTS: Record<AssemblyAiRegion, string> = {
  us: 'wss://streaming.assemblyai.com',
  eu: 'wss://streaming.eu.assemblyai.com',
}

/**
 * Builds a {@link StreamingTranscribePort} on AssemblyAI's streaming speech-to-text (v3) over
 * its WebSocket API, with the EU endpoint selectable. One connection per stream; audio is sent as
 * binary frames of 50 to 500 ms (small chunks are joined, big ones split), and a `Turn` message
 * becomes a turn event, the one with `end_of_turn` the final. Opening and each reconnect are
 * bounded by a timeout and a bounded, jittered retry; a dropped connection is retried with the
 * request's policy, replays the audio sent while it was down (up to the port's bound), and
 * shifts the new session's word times and turn numbers so they carry on. A refused credential
 * is `streaming_transcribe.rejected` and is never retried. The API key (sent only as the
 * `Authorization` header), the audio and the transcript never reach a log, a report, an error
 * or a printed form.
 */
export function createAssemblyAiStreamingTranscribe(
  options: AssemblyAiStreamingTranscribeOptions
): AssemblyAiStreamingTranscribe {
  if (
    typeof options.apiKey !== 'string' ||
    options.apiKey.length === 0 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: a header value must hold no control character.
    /[\u0000-\u001f\u007f\s]/.test(options.apiKey)
  ) {
    invalid('apiKey')
  }
  const region = options.region ?? 'us'
  if (!Object.hasOwn(HOSTS, region)) {
    invalid('region')
  }
  const base = options.baseUrl ?? HOSTS[region]
  if (!isSafeBaseUrl(base)) {
    invalid('baseUrl')
  }
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_ASSEMBLYAI_CONNECT_TIMEOUT_MS
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_ASSEMBLYAI_CLOSE_TIMEOUT_MS
  checkNumber(connectTimeoutMs, 'connectTimeoutMs', 1, 30_000, true)
  checkNumber(closeTimeoutMs, 'closeTimeoutMs', 1, 30_000, true)
  checkNumber(options.endOfTurnConfidenceThreshold, 'endOfTurnConfidenceThreshold', 0, 1, false)
  checkNumber(options.minEndOfTurnSilenceMs, 'minEndOfTurnSilenceMs', 0, 60_000, true)
  checkNumber(options.maxTurnSilenceMs, 'maxTurnSilenceMs', 0, 60_000, true)
  if (options.formatTurns !== undefined && typeof options.formatTurns !== 'boolean') {
    invalid('formatTurns')
  }
  const formatTurns = options.formatTurns ?? false
  const tuning: Record<string, string> = {}
  if (options.endOfTurnConfidenceThreshold !== undefined) {
    tuning.end_of_turn_confidence_threshold = String(options.endOfTurnConfidenceThreshold)
  }
  if (options.minEndOfTurnSilenceMs !== undefined) {
    tuning.min_end_of_turn_silence_when_confident = String(options.minEndOfTurnSilenceMs)
  }
  if (options.maxTurnSilenceMs !== undefined) {
    tuning.max_turn_silence = String(options.maxTurnSilenceMs)
  }
  const config: Config = {
    apiKey: options.apiKey,
    base: base.replace(/\/+$/, ''),
    formatTurns,
    query: tuning,
    connectTimeoutMs,
    closeTimeoutMs,
    socket: options.socket ?? bunAssemblyAiSocket,
    sleep: options.sleep ?? systemSleep,
    random: options.random ?? Math.random,
    reporter: options.reporter,
    logger: options.logger,
  }
  const live = new Set<string>()

  function urlFor(
    request: OpenStreamRequest & { encoding: AudioEncoding; sampleRate: SampleRate }
  ): string {
    const query = new URLSearchParams({
      sample_rate: String(request.sampleRate),
      encoding: request.encoding,
      format_turns: String(formatTurns),
      ...config.query,
    })
    if (request.language !== undefined && request.language.split('-')[0] !== 'en') {
      query.set('speech_model', 'universal-streaming-multilingual')
    }
    return `${config.base}/v3/ws?${query.toString()}`
  }

  function report(request: OpenStreamRequest, error: StreamingTranscribeError): void {
    if (
      error.code !== STREAMING_TRANSCRIBE_ERROR_CODES.unavailable &&
      error.code !== STREAMING_TRANSCRIBE_ERROR_CODES.rejected &&
      error.code !== STREAMING_TRANSCRIBE_ERROR_CODES.badResponse
    ) {
      return
    }
    try {
      config.reporter?.capture(error, {
        organizationId: request.organizationId,
        tags: { feature: 'streaming-transcribe', track: request.track },
      })
    } catch {
      // Reporting must never turn an error into a different one.
    }
  }

  return {
    async open(request: OpenStreamRequest, opts?: StreamingTranscribeOptions) {
      const policy = checkOpenRequest(request)
      const timeoutMs = resolveTimeout(opts)
      const key = `${request.organizationId}|${request.callId}|${request.track}`
      if (live.has(key)) {
        throw new StreamingTranscribeError(
          STREAMING_TRANSCRIBE_ERROR_CODES.conflict,
          'A stream for this Call and track is already open'
        )
      }
      live.add(key)
      const meta: AssemblyAiStreamMeta = {
        organizationId: request.organizationId,
        callId: request.callId,
        track: request.track,
      }
      const host: Host = {
        config,
        request,
        policy,
        url: urlFor(request),
        meta,
        bytesPerMs: (request.sampleRate * (request.encoding === 'pcm_s16le' ? 2 : 1)) / 1000,
        frameBytes: request.encoding === 'pcm_s16le' ? 2 : 1,
        released: () => {
          live.delete(key)
        },
        report: (error) => report(request, error),
      }
      let stream: AssemblyAiStream | undefined
      const events: LinkEvents = {
        message: (link, data) => stream?.events.message(link, data),
        lost: (link, code) => stream?.events.lost(link, code),
      }
      const deadline = performance.now() + timeoutMs
      const abort = new AbortController()
      try {
        let link: Link | undefined
        let last: StreamingTranscribeError | undefined
        for (let attempt = 0; attempt <= policy.maxAttempts && link === undefined; attempt++) {
          if (attempt > 0) {
            const delayMs = reconnectDelayMs(attempt, policy, config.random)
            if (performance.now() + delayMs >= deadline) {
              break
            }
            await config.sleep(delayMs, abort.signal)
          }
          const remaining = deadline - performance.now()
          if (remaining <= 0) {
            break
          }
          try {
            link = await connectLink(
              config,
              meta,
              host.url,
              Math.min(config.connectTimeoutMs, remaining),
              abort.signal,
              events
            )
          } catch (error) {
            last = error instanceof StreamingTranscribeError ? error : badResponse()
            if (last.code !== STREAMING_TRANSCRIBE_ERROR_CODES.unavailable) {
              throw last
            }
          }
        }
        if (link === undefined) {
          throw (
            last ??
            failure(
              STREAMING_TRANSCRIBE_ERROR_CODES.unavailable,
              'The vendor did not answer in time'
            )
          )
        }
        stream = new AssemblyAiStream(host, link.sessionId)
        stream.adopt(link)
        return stream
      } catch (error) {
        abort.abort()
        live.delete(key)
        const failed =
          error instanceof StreamingTranscribeError
            ? error
            : failure(STREAMING_TRANSCRIBE_ERROR_CODES.unavailable, 'The vendor connection failed')
        report(request, failed)
        throw failed
      }
    },
    openStreams() {
      return live.size
    },
  }
}
