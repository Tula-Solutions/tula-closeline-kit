import { randomUUID } from 'node:crypto'
import type { OrganizationId } from 'tula-closeline-contract'
import type { Logger } from '../logger'
import { type Sleep, systemSleep } from '../queue/sleep'
import type { ErrorReporter } from '../reporting/port'
import { TtsAudioChunk } from './audio'
import { startTtsDeadline, type TtsDeadline, watchFirstChunk, withTtsRetry } from './deadline'
import { TTS_ERROR_CODES, TtsError } from './errors'
import {
  MAX_TTS_AUDIO_CHUNK_BYTES,
  type TtsOpenRequest,
  type TtsPort,
  type TtsStream,
} from './port'
import { type CheckedOpenRequest, checkOpenRequest, invalid } from './validate'

const INSPECT = Symbol.for('nodejs.util.inspect.custom')
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const VENDOR_CODE = /^[a-z0-9_]{1,64}$/
/** The most undelivered events one connection may hold before the stream fails; a consumer that stopped reading must not grow memory. */
const MAX_BACKLOG_EVENTS = 8192
/** The most undelivered audio bytes one connection may hold (about three minutes of 24 kHz speech); past it the stream fails. */
const MAX_BACKLOG_BYTES = 8 * 1024 * 1024

/** The Cartesia API version this adapter was written against (sent as `Cartesia-Version`). */
export const CARTESIA_API_VERSION = '2026-08-14'

/** The default Cartesia model. */
export const DEFAULT_CARTESIA_MODEL = 'sonic-3.6'

/** The default time to open the WebSocket, in milliseconds. */
export const DEFAULT_CARTESIA_CONNECT_TIMEOUT_MS = 3_000

/** The callbacks a {@link CartesiaSocket} reports through. */
export interface CartesiaSocketHandlers {
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
export interface CartesiaSocket {
  /** Sends one text frame. */
  send(data: string): void
  /** Closes the connection. */
  close(code?: number): void
  /** Registers the handlers once, before any event. */
  attach(handlers: CartesiaSocketHandlers): void
}

/** Opens a WebSocket to `url` with `headers`. */
export type CartesiaSocketFactory = (
  url: string,
  headers: Readonly<Record<string, string>>
) => CartesiaSocket

/** The real factory, on the runtime's WebSocket (Bun accepts request headers). */
export const bunCartesiaSocket: CartesiaSocketFactory = (url, headers) => {
  const ws = new WebSocket(url, { headers: { ...headers } })
  return {
    send: (data) => ws.send(data),
    close: (code) => ws.close(code),
    attach(h) {
      ws.onopen = () => h.open()
      ws.onmessage = (event) => h.message(event.data)
      ws.onerror = () => h.error()
      ws.onclose = (event) => h.close(event.code)
    },
  }
}

/** Options for {@link createCartesiaTts}. */
export interface CartesiaTtsOptions {
  /** The Cartesia API key. Never logged, reported or put in an error. */
  apiKey: string
  /** Stock voice styles: the name callers pass as `voice` mapped to a Cartesia voice id. A voice id (UUID) is also accepted as is. */
  voices?: Readonly<Record<string, string>>
  /** The Cartesia model; default {@link DEFAULT_CARTESIA_MODEL}. */
  model?: string
  /** The language code; default `en`. */
  language?: string
  /** How long Cartesia may buffer text before speaking, 0 to 5000 ms; default 100. */
  maxBufferDelayMs?: number
  /** The most time to open the connection, 1 to 30000 ms; default {@link DEFAULT_CARTESIA_CONNECT_TIMEOUT_MS}. */
  connectTimeoutMs?: number
  /** The WebSocket base URL; default `wss://api.cartesia.ai`. */
  baseUrl?: string
  /** Opens sockets; the real WebSocket by default. */
  socket?: CartesiaSocketFactory
  /** Receives the errors that mean the vendor failed; nothing if absent. */
  reporter?: ErrorReporter
  /** Where retries are noted (metadata only); nothing if absent. */
  logger?: Logger
  /** Pauses between retries; real time by default. */
  sleep?: Sleep
  /** A number in `[0, 1)` for the jitter; `Math.random` by default. */
  random?: () => number
}

/** A {@link TtsPort} on Cartesia Sonic that also says how many streams are open. */
export interface CartesiaTts extends TtsPort {
  /** How many streams have been opened and not yet closed. */
  openStreams(): number
}

type Event =
  | { kind: 'audio'; pieces: Uint8Array[] }
  | { kind: 'done' }
  | { kind: 'error'; error: TtsError }

interface Config {
  apiKey: string
  voices: Readonly<Record<string, string>>
  model: string
  language: string
  maxBufferDelayMs: number
  connectTimeoutMs: number
  url: string
  socket: CartesiaSocketFactory
  options: CartesiaTtsOptions
  sleep: Sleep
}

/** One WebSocket connection (one Cartesia context) and the events it has produced. */
class Attempt {
  readonly contextId = randomUUID()
  readonly events: Event[] = []
  ready = false
  /** Cartesia has said the context is over (done or error), or the socket closed. */
  ended = false
  closed = false
  finalSent = false
  sentTexts = 0
  backlogBytes = 0
  wake: (() => void) | undefined
  #socket: CartesiaSocket
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(socket: CartesiaSocket) {
    this.#socket = socket
  }

  start(connectTimeoutMs: number, onReady: () => void): void {
    this.#timer = setTimeout(() => {
      this.push({
        kind: 'error',
        error: new TtsError(TTS_ERROR_CODES.unavailable, 'The vendor connection timed out', {
          details: { phase: 'connect', connectTimeoutMs },
        }),
      })
    }, connectTimeoutMs)
    this.#socket.attach({
      open: () => {
        if (this.closed) {
          return
        }
        clearTimeout(this.#timer)
        this.ready = true
        onReady()
      },
      message: (data) => this.#onMessage(data),
      error: () => {
        this.push({
          kind: 'error',
          error: new TtsError(TTS_ERROR_CODES.unavailable, 'The vendor connection failed'),
        })
      },
      close: (code) => {
        if (!this.ended && !this.closed) {
          this.push({
            kind: 'error',
            error: new TtsError(TTS_ERROR_CODES.unavailable, 'The vendor connection closed', {
              details: { code },
            }),
          })
        }
      },
    })
  }

  push(event: Event): void {
    if (this.closed || this.ended) {
      return
    }
    if (event.kind !== 'audio') {
      this.ended = true
      clearTimeout(this.#timer)
    }
    const bytes = event.kind === 'audio' ? event.pieces.reduce((n, p) => n + p.byteLength, 0) : 0
    if (this.events.length >= MAX_BACKLOG_EVENTS || this.backlogBytes + bytes > MAX_BACKLOG_BYTES) {
      this.events.length = 0
      this.backlogBytes = 0
      this.events.push({
        kind: 'error',
        error: new TtsError(TTS_ERROR_CODES.unavailable, 'The audio was not read fast enough'),
      })
      this.ended = true
    } else {
      this.backlogBytes += bytes
      this.events.push(event)
    }
    this.wake?.()
  }

  send(message: Record<string, unknown>): void {
    try {
      this.#socket.send(JSON.stringify(message))
    } catch {
      this.push({
        kind: 'error',
        error: new TtsError(TTS_ERROR_CODES.unavailable, 'The vendor connection failed'),
      })
    }
  }

  /** Tells Cartesia to stop the context (if it is still going) and closes the connection. Idempotent. */
  shutdown(): void {
    if (this.closed) {
      return
    }
    const wasLive = this.ready && !this.ended
    this.closed = true
    clearTimeout(this.#timer)
    if (wasLive) {
      try {
        this.#socket.send(JSON.stringify({ context_id: this.contextId, cancel: true }))
      } catch {
        // The connection is going away either way.
      }
    }
    try {
      this.#socket.close(1000)
    } catch {
      // Already closed.
    }
    this.events.length = 0
    this.wake?.()
  }

  #onMessage(data: unknown): void {
    if (typeof data !== 'string') {
      this.push({
        kind: 'error',
        error: new TtsError(
          TTS_ERROR_CODES.badResponse,
          'The vendor sent a frame this adapter cannot read'
        ),
      })
      return
    }
    let message: unknown
    try {
      message = JSON.parse(data)
    } catch {
      this.push({
        kind: 'error',
        error: new TtsError(
          TTS_ERROR_CODES.badResponse,
          'The vendor sent a message that is not JSON'
        ),
      })
      return
    }
    if (typeof message !== 'object' || message === null) {
      this.push({
        kind: 'error',
        error: new TtsError(TTS_ERROR_CODES.badResponse, 'The vendor sent an unexpected message'),
      })
      return
    }
    const m = message as Record<string, unknown>
    if (m.context_id !== undefined && m.context_id !== this.contextId) {
      return
    }
    switch (m.type) {
      case 'chunk': {
        if (typeof m.data !== 'string') {
          this.push({
            kind: 'error',
            error: new TtsError(
              TTS_ERROR_CODES.badResponse,
              'The vendor sent audio this adapter cannot read'
            ),
          })
          return
        }
        const bytes = Buffer.from(m.data, 'base64')
        if (bytes.byteLength === 0) {
          return
        }
        const pieces: Uint8Array[] = []
        for (let at = 0; at < bytes.byteLength; at += MAX_TTS_AUDIO_CHUNK_BYTES) {
          pieces.push(
            new Uint8Array(
              bytes.buffer,
              bytes.byteOffset + at,
              Math.min(MAX_TTS_AUDIO_CHUNK_BYTES, bytes.byteLength - at)
            )
          )
        }
        this.push({ kind: 'audio', pieces })
        return
      }
      case 'done':
        this.push({ kind: 'done' })
        return
      case 'error':
        this.push({ kind: 'error', error: vendorError(m) })
        return
      default:
        // Timestamps, flush acknowledgements and the like carry nothing this port uses.
        return
    }
  }
}

/** Maps Cartesia's error message to a port error. Only the status and its code are kept: the message may echo the request. */
function vendorError(m: Record<string, unknown>): TtsError {
  const status = typeof m.status_code === 'number' ? m.status_code : 0
  const code =
    typeof m.error_code === 'string' && VENDOR_CODE.test(m.error_code) ? m.error_code : undefined
  const details = { vendorStatus: status, ...(code === undefined ? {} : { vendorCode: code }) }
  if (status === 408 || status === 429 || status >= 500) {
    return new TtsError(TTS_ERROR_CODES.unavailable, 'The vendor could not serve the request', {
      details,
    })
  }
  if (status >= 400) {
    return new TtsError(TTS_ERROR_CODES.rejected, 'The vendor refused the request', { details })
  }
  return new TtsError(
    TTS_ERROR_CODES.badResponse,
    'The vendor reported an error this adapter cannot read',
    { details }
  )
}

type State = 'open' | 'finished' | 'cancelled' | 'ended' | 'closed'

interface Host {
  config: Config
  request: TtsOpenRequest
  checked: CheckedOpenRequest
  voiceId: string
  encoding: string
  report(error: unknown): void
  released(): void
}

function closedError(message: string): TtsError {
  return new TtsError(TTS_ERROR_CODES.closed, message)
}

/** The stream. Text, audio and state are private fields, so none is in `JSON.stringify`, `String()` or a console dump. */
class CartesiaStream implements TtsStream {
  readonly #host: Host
  readonly #deadline: TtsDeadline
  #state: State = 'open'
  #chars = 0
  /** The text, kept only until the first audio is delivered so a retry can send it again. */
  #texts: string[] = []
  #firstDelivered = false
  #attempt: Attempt | undefined
  #wake: (() => void) | undefined
  #iterator: AsyncIterator<TtsAudioChunk> | undefined

  constructor(host: Host) {
    this.#host = host
    this.#deadline = startTtsDeadline(host.checked.timeoutMs, host.request.signal)
  }

  write(text: string): void {
    this.#assertOpen()
    this.#deadline.check()
    if (typeof text !== 'string') {
      invalid('text')
    }
    if (text.length === 0) {
      return
    }
    const max = this.#host.checked.maxTextChars
    if (this.#chars + text.length > max) {
      throw new TtsError(TTS_ERROR_CODES.textTooLarge, 'The text is over the length limit', {
        details: { maxTextChars: max },
      })
    }
    this.#chars += text.length
    this.#texts.push(text)
    this.#flush()
    this.#wake?.()
  }

  finish(): void {
    if (this.#state === 'closed') {
      throw closedError('The stream is closed')
    }
    if (this.#state !== 'open') {
      return
    }
    this.#state = 'finished'
    this.#flush()
    this.#wake?.()
  }

  cancel(): void {
    if (this.#state === 'closed' || this.#state === 'cancelled' || this.#state === 'ended') {
      return
    }
    this.#state = 'cancelled'
    this.#release()
  }

  async close(): Promise<void> {
    if (this.#state === 'closed') {
      return
    }
    this.#state = 'closed'
    this.#release()
    this.#host.released()
  }

  [Symbol.asyncIterator](): AsyncIterator<TtsAudioChunk> {
    if (this.#iterator === undefined) {
      const inner = this.#produce()
      const self = this
      this.#iterator = {
        next() {
          if (self.#state === 'closed') {
            return Promise.reject(closedError('The stream is closed'))
          }
          return inner.next()
        },
        return() {
          self.cancel()
          return inner.return(undefined)
        },
      }
    }
    return this.#iterator
  }

  /** The metadata, for `JSON.stringify`; the text and the audio are not in it. */
  toJSON(): { state: State; chars: number } {
    return { state: this.#state, chars: this.#chars }
  }

  /** A readable label without the text. */
  toString(): string {
    return `CartesiaStream(${this.#state}, ${this.#chars} chars)`
  }

  /** The console and `util.inspect` form, without the text. */
  [INSPECT](): string {
    return this.toString()
  }

  #release(): void {
    this.#deadline.cancel()
    this.#deadline.stop()
    this.#attempt?.shutdown()
    this.#texts = []
    this.#wake?.()
  }

  #assertOpen(): void {
    if (this.#state === 'closed') {
      throw closedError('The stream is closed')
    }
    if (this.#state === 'cancelled') {
      throw closedError('The stream was cancelled')
    }
    if (this.#state === 'ended') {
      throw closedError('The stream has ended')
    }
    if (this.#state === 'finished') {
      throw closedError('The stream was finished')
    }
  }

  #stopped(): boolean {
    return this.#state === 'cancelled' || this.#state === 'closed'
  }

  #message(transcript: string, more: boolean): Record<string, unknown> {
    const { config, request, voiceId } = this.#host
    return {
      model_id: config.model,
      transcript,
      voice: { mode: 'id', id: voiceId },
      language: config.language,
      context_id: this.#attempt?.contextId,
      output_format: {
        container: 'raw',
        encoding: this.#host.encoding,
        sample_rate: request.sampleRate,
      },
      continue: more,
      max_buffer_delay_ms: config.maxBufferDelayMs,
    }
  }

  /** Sends what the open connection has not yet been given. */
  #flush(): void {
    const attempt = this.#attempt
    if (attempt === undefined || !attempt.ready || attempt.closed || attempt.ended) {
      return
    }
    const pending = this.#texts.slice(attempt.sentTexts).join('')
    attempt.sentTexts = this.#texts.length
    if (pending.length > 0) {
      attempt.send(this.#message(pending, true))
    }
    if (this.#state === 'finished' && !attempt.finalSent) {
      attempt.finalSent = true
      attempt.send(this.#message('', false))
    }
    if (this.#firstDelivered) {
      this.#texts = []
      attempt.sentTexts = 0
    }
  }

  /** Waits for the next event of `attempt`; `undefined` when `signal` fires first or the stream stops. */
  async #pull(attempt: Attempt, signal: AbortSignal): Promise<Event | undefined> {
    for (;;) {
      const event = attempt.events.shift()
      if (event !== undefined) {
        if (event.kind === 'audio') {
          attempt.backlogBytes -= event.pieces.reduce((n, p) => n + p.byteLength, 0)
        }
        return event
      }
      if (signal.aborted || this.#stopped()) {
        return undefined
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          signal.removeEventListener('abort', done)
          resolve()
        }
        attempt.wake = done
        signal.addEventListener('abort', done, { once: true })
      })
      attempt.wake = undefined
    }
  }

  async #waitForText(): Promise<void> {
    while (!(this.#chars > 0 || this.#state === 'finished') && !this.#stopped()) {
      this.#deadline.check()
      await new Promise<void>((resolve) => {
        const done = () => {
          this.#deadline.signal.removeEventListener('abort', done)
          resolve()
        }
        this.#wake = done
        this.#deadline.signal.addEventListener('abort', done, { once: true })
      })
      this.#wake = undefined
    }
  }

  /** One connection, up to and including the first event that is audio, done or an error. */
  async #connectAndFirst(): Promise<{ attempt: Attempt; first: Event } | undefined> {
    const { config } = this.#host
    const deadline = this.#deadline
    const attempt = new Attempt(
      config.socket(config.url, {
        'X-API-Key': config.apiKey,
        'Cartesia-Version': CARTESIA_API_VERSION,
      })
    )
    this.#attempt?.shutdown()
    this.#attempt = attempt
    const watch = watchFirstChunk([deadline.signal], this.#host.checked.firstChunkTimeoutMs)
    try {
      attempt.start(config.connectTimeoutMs, () => this.#flush())
      const first = await this.#pull(attempt, watch.signal)
      if (first === undefined) {
        if (!this.#stopped()) {
          deadline.check()
          watch.check()
        }
        attempt.shutdown()
        return undefined
      }
      if (first.kind === 'error') {
        throw first.error
      }
      return { attempt, first }
    } catch (error) {
      attempt.shutdown()
      throw error
    } finally {
      watch.stop()
    }
  }

  async *#produce(): AsyncGenerator<TtsAudioChunk, void, undefined> {
    const host = this.#host
    const deadline = this.#deadline
    let sequence = 0
    try {
      await this.#waitForText()
      if (this.#stopped()) {
        return
      }
      deadline.check()
      if (this.#chars === 0) {
        return
      }
      const started = await withTtsRetry(() => this.#connectAndFirst(), {
        policy: host.checked.retry,
        deadline,
        sleep: host.config.sleep,
        ...(host.config.options.random === undefined ? {} : { random: host.config.options.random }),
        onRetry: (retry, delayMs) =>
          host.config.options.logger?.warn('A speech request is retrying', {
            voice: host.request.voice,
            retry,
            delayMs,
          }),
      })
      if (started === undefined || this.#stopped()) {
        return
      }
      const { attempt } = started
      this.#firstDelivered = true
      this.#flush()
      let event: Event | undefined = started.first
      while (event !== undefined && event.kind !== 'done') {
        if (event.kind === 'error') {
          throw event.error
        }
        for (const piece of event.pieces) {
          yield new TtsAudioChunk(sequence++, piece)
          if (this.#stopped()) {
            return
          }
        }
        event = await this.#pull(attempt, deadline.signal)
        if (event === undefined) {
          if (this.#stopped()) {
            return
          }
          deadline.check()
        }
      }
      attempt.shutdown()
    } catch (error) {
      if (this.#stopped()) {
        return
      }
      this.#attempt?.shutdown()
      host.report(error)
      throw error
    } finally {
      if (this.#state === 'open' || this.#state === 'finished') {
        this.#state = 'ended'
      }
      this.#attempt?.shutdown()
      deadline.stop()
      this.#chars = 0
      this.#texts = []
    }
  }
}

/**
 * Builds a {@link TtsPort} on Cartesia Sonic over its WebSocket API: one connection and one
 * context per stream, opened when the first text is written. Text is sent as it is written,
 * audio is read as raw `pcm_s16le` or `pcm_mulaw` and handed out in chunks of at most 64 KiB.
 * The connect, first-chunk and overall limits abort the connection; a failure before the first
 * chunk (`tts.unavailable`) is retried on a fresh connection, bounded and jittered, and one after
 * it never is. A cancel tells Cartesia to stop the context and closes the connection. The API
 * key, the text and the audio never reach a log, a report, an error or a printed form.
 */
export function createCartesiaTts(options: CartesiaTtsOptions): CartesiaTts {
  if (typeof options.apiKey !== 'string' || options.apiKey.length === 0) {
    invalid('apiKey')
  }
  const maxBufferDelayMs = options.maxBufferDelayMs ?? 100
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CARTESIA_CONNECT_TIMEOUT_MS
  if (!Number.isInteger(maxBufferDelayMs) || maxBufferDelayMs < 0 || maxBufferDelayMs > 5000) {
    invalid('maxBufferDelayMs')
  }
  if (!Number.isInteger(connectTimeoutMs) || connectTimeoutMs < 1 || connectTimeoutMs > 30_000) {
    invalid('connectTimeoutMs')
  }
  const base = options.baseUrl ?? 'wss://api.cartesia.ai'
  if (!isSafeBaseUrl(base)) {
    invalid('baseUrl')
  }
  const voices = options.voices ?? {}
  for (const id of Object.values(voices)) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
      invalid('voices')
    }
  }
  const config: Config = {
    apiKey: options.apiKey,
    voices,
    model: options.model ?? DEFAULT_CARTESIA_MODEL,
    language: options.language ?? 'en',
    maxBufferDelayMs,
    connectTimeoutMs,
    url: `${base.replace(/\/+$/, '')}/tts/websocket?cartesia_version=${CARTESIA_API_VERSION}`,
    socket: options.socket ?? bunCartesiaSocket,
    options,
    sleep: options.sleep ?? systemSleep,
  }
  let open = 0

  return {
    open(request: TtsOpenRequest): TtsStream {
      const checked = checkOpenRequest(request)
      const named = Object.hasOwn(voices, request.voice) ? voices[request.voice] : undefined
      const voiceId = named ?? (UUID.test(request.voice) ? request.voice : undefined)
      if (voiceId === undefined) {
        invalid('voice')
      }
      open += 1
      let released = false
      return new CartesiaStream({
        config,
        request,
        checked,
        voiceId,
        encoding: request.encoding,
        report(error) {
          if (
            !(error instanceof TtsError) ||
            (error.code !== TTS_ERROR_CODES.unavailable &&
              error.code !== TTS_ERROR_CODES.rejected &&
              error.code !== TTS_ERROR_CODES.badResponse)
          ) {
            return
          }
          try {
            options.reporter?.capture(error, {
              organizationId: request.organizationId satisfies OrganizationId,
              tags: { feature: 'tts' },
            })
          } catch {
            // Reporting must never turn an error into a different one.
          }
        },
        released() {
          if (!released) {
            released = true
            open -= 1
          }
        },
      })
    },
    openStreams() {
      return open
    },
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
