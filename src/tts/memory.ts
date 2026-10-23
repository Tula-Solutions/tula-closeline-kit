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

/** What the scripted vendor does for the next stream whose first text arrives. */
export interface ScriptedSpeech {
  /** The audio pieces it delivers, in order, each 1 to {@link MAX_TTS_AUDIO_CHUNK_BYTES} bytes. Tenant data: never logged. */
  chunks: readonly Uint8Array[]
  /** Time before the first chunk, in ms; default 0. */
  firstChunkDelayMs?: number
  /** Time before each later chunk, in ms; default 0. */
  chunkDelayMs?: number
  /** Never produces the first chunk; the attempt ends only when it is aborted or times out. */
  hang?: boolean
  /** Fails with `tts.unavailable` (never retried) once this many chunks have been delivered, 1 to `chunks.length`. */
  failAfterChunks?: number
}

/** The codes the vendor can be made to fail with. */
export type ScriptedTtsFailure = 'tts.unavailable' | 'tts.rejected' | 'tts.bad_response'

/** What a test sees of one vendor request (never the text or the audio). */
export interface MemoryTtsRequestView {
  /** The Organization. */
  organizationId: OrganizationId
  /** The voice asked for. */
  voice: string
  /** The characters written when the request was made. */
  chars: number
  /** True once the request's AbortSignal fired while it was still pending (a timeout, a cancel, a closed stream). */
  aborted: boolean
  /** How it ended: still going, delivered everything, failed or aborted. */
  outcome: 'pending' | 'ok' | 'failed' | 'aborted'
}

/** Options for {@link createMemoryTts}. */
export interface MemoryTtsOptions {
  /** Receives the errors that mean the vendor failed; nothing if absent. */
  reporter?: ErrorReporter
  /** Where retries are noted (metadata only); nothing if absent. */
  logger?: Logger
  /** Pauses between retries and models a vendor's delay; real time by default. */
  sleep?: Sleep
  /** A number in `[0, 1)` for the jitter; `Math.random` by default. */
  random?: () => number
}

/** A {@link TtsPort} that plays scripted audio in the process, for tests. Not for production. */
export interface MemoryTts extends TtsPort {
  /** Queues what the vendor says to the next stream request that reaches it; later requests take later scripts. */
  speak(speech: ScriptedSpeech | readonly Uint8Array[]): void
  /** Makes the next `times` (default 1) vendor requests fail with `code`, before any script is used. */
  failNext(code: ScriptedTtsFailure, times?: number): void
  /** Every vendor request so far, in order; a retry is a request of its own. */
  requests(): MemoryTtsRequestView[]
  /** How many streams have been opened and not yet closed. */
  openStreams(): number
}

interface Entry {
  view: MemoryTtsRequestView
}

interface Host {
  options: MemoryTtsOptions
  sleep: Sleep
  request: TtsOpenRequest
  checked: CheckedOpenRequest
  vendorRequest(chars: number): { speech: ScriptedSpeech; entry: Entry }
  report(error: unknown): void
  released(): void
}

type State = 'open' | 'finished' | 'cancelled' | 'ended' | 'closed'

/**
 * The memory stream. The text is only counted, never kept. Its text, its audio and its state are
 * in private fields, so none of them is in `JSON.stringify`, `String()` or a console dump.
 */
class MemoryTtsStream implements TtsStream {
  readonly #host: Host
  readonly #deadline: TtsDeadline
  #state: State = 'open'
  #chars = 0
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
    this.#wake?.()
  }

  cancel(): void {
    if (this.#state === 'closed' || this.#state === 'cancelled') {
      return
    }
    this.#state = 'cancelled'
    this.#deadline.cancel()
    this.#deadline.stop()
    this.#wake?.()
  }

  async close(): Promise<void> {
    if (this.#state === 'closed') {
      return
    }
    this.#state = 'closed'
    this.#deadline.cancel()
    this.#deadline.stop()
    this.#wake?.()
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
    return `MemoryTtsStream(${this.#state}, ${this.#chars} chars)`
  }

  /** The console and `util.inspect` form, without the text. */
  [INSPECT](): string {
    return this.toString()
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

  /** Waits until `ready()` holds, the stream is stopped, or the deadline passes. */
  async #waitUntil(ready: () => boolean): Promise<void> {
    while (!ready() && !this.#stopped()) {
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

  async *#produce(): AsyncGenerator<TtsAudioChunk, void, undefined> {
    const host = this.#host
    const deadline = this.#deadline
    let entry: Entry | undefined
    try {
      // The vendor has nothing to say until it has text, or knows there will be none.
      await this.#waitUntil(() => this.#chars > 0 || this.#state === 'finished')
      if (this.#stopped()) {
        return
      }
      deadline.check()
      if (this.#chars === 0) {
        return
      }
      const started = await withTtsRetry(
        async () => {
          const attempt = host.vendorRequest(this.#chars)
          entry = attempt.entry
          const watch = watchFirstChunk([deadline.signal], host.checked.firstChunkTimeoutMs)
          deadline.signal.addEventListener('abort', () => markAborted(attempt.entry), {
            once: true,
          })
          try {
            if (attempt.speech.hang) {
              await new Promise<void>((resolve) =>
                watch.signal.addEventListener('abort', () => resolve(), { once: true })
              )
            } else if ((attempt.speech.firstChunkDelayMs ?? 0) > 0) {
              await host.sleep(attempt.speech.firstChunkDelayMs ?? 0, watch.signal)
            }
            if (this.#stopped()) {
              return undefined
            }
            deadline.check()
            watch.check()
            return attempt
          } catch (error) {
            if (
              error instanceof TtsError &&
              (error.code === TTS_ERROR_CODES.timeout || error.code === TTS_ERROR_CODES.aborted)
            ) {
              markAborted(attempt.entry)
            } else if (attempt.entry.view.outcome === 'pending') {
              attempt.entry.view.outcome = 'failed'
            }
            throw error
          } finally {
            watch.stop()
          }
        },
        {
          policy: host.checked.retry,
          deadline,
          sleep: host.sleep,
          ...(host.options.random === undefined ? {} : { random: host.options.random }),
          onRetry: (retry, delayMs) =>
            host.options.logger?.warn('A speech request is retrying', {
              voice: host.request.voice,
              retry,
              delayMs,
            }),
        }
      )
      if (started === undefined || this.#stopped()) {
        return
      }
      const { speech } = started
      const chunks = speech.chunks
      for (let i = 0; i < chunks.length; i++) {
        if (i > 0) {
          if (speech.failAfterChunks === i) {
            // Past the first chunk the listener has heard audio: never retried, never repeated.
            throw new TtsError(TTS_ERROR_CODES.unavailable, 'The vendor stream broke')
          }
          if ((speech.chunkDelayMs ?? 0) > 0) {
            await host.sleep(speech.chunkDelayMs ?? 0, deadline.signal)
          }
          if (this.#stopped()) {
            return
          }
          deadline.check()
        }
        yield new TtsAudioChunk(i, chunks[i] as Uint8Array)
        if (this.#stopped()) {
          return
        }
      }
      if (speech.failAfterChunks === chunks.length) {
        throw new TtsError(TTS_ERROR_CODES.unavailable, 'The vendor stream broke')
      }
      started.entry.view.outcome = 'ok'
      // The vendor keeps the stream open until it is told no more text is coming.
      await this.#waitUntil(() => this.#state === 'finished')
      deadline.check()
    } catch (error) {
      if (this.#stopped()) {
        return
      }
      if (entry?.view.outcome === 'pending') {
        entry.view.outcome = 'failed'
      }
      host.report(error)
      throw error
    } finally {
      if (this.#state === 'open' || this.#state === 'finished') {
        this.#state = 'ended'
      }
      deadline.stop()
      this.#chars = 0
    }
  }
}

function closedError(message: string): TtsError {
  return new TtsError(TTS_ERROR_CODES.closed, message)
}

function markAborted(entry: Entry): void {
  if (entry.view.outcome === 'pending') {
    entry.view.aborted = true
    entry.view.outcome = 'aborted'
  }
}

/**
 * Builds a {@link TtsPort} for tests that plays scripted audio. It keeps the rules a real adapter
 * must: validation before any vendor call, a bounded text length, an overall deadline and a
 * first-chunk limit that abort the vendor request, chunks delivered in order and only as the
 * consumer pulls them, bounded jittered retries of `tts.unavailable` before the first chunk and
 * never after, an idempotent cancel, a close that releases everything, and no text or audio in
 * logs, reports, errors or any object it returns. Not for production.
 */
export function createMemoryTts(options: MemoryTtsOptions = {}): MemoryTts {
  const sleep = options.sleep ?? systemSleep
  const scripts: ScriptedSpeech[] = []
  const failures: ScriptedTtsFailure[] = []
  const requests: Entry[] = []
  let open = 0

  return {
    open(request: TtsOpenRequest): TtsStream {
      const checked = checkOpenRequest(request)
      open += 1
      let released = false
      return new MemoryTtsStream({
        options,
        sleep,
        request,
        checked,
        vendorRequest(chars) {
          const entry: Entry = {
            view: {
              organizationId: request.organizationId,
              voice: request.voice,
              chars,
              aborted: false,
              outcome: 'pending',
            },
          }
          requests.push(entry)
          const code = failures.shift()
          if (code !== undefined) {
            entry.view.outcome = 'failed'
            throw new TtsError(code, 'The vendor failed')
          }
          const speech = scripts.shift()
          if (speech === undefined) {
            entry.view.outcome = 'failed'
            throw new TtsError(TTS_ERROR_CODES.badResponse, 'The vendor sent nothing usable')
          }
          return { speech, entry }
        },
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
              organizationId: request.organizationId,
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

    speak(speech) {
      const scripted: ScriptedSpeech = Array.isArray(speech)
        ? { chunks: speech as readonly Uint8Array[] }
        : (speech as ScriptedSpeech)
      if (
        typeof scripted !== 'object' ||
        scripted === null ||
        !Array.isArray(scripted.chunks) ||
        scripted.chunks.some(
          (c) =>
            !(c instanceof Uint8Array) ||
            c.byteLength < 1 ||
            c.byteLength > MAX_TTS_AUDIO_CHUNK_BYTES
        )
      ) {
        invalid('speech chunks')
      }
      const failAfter = scripted.failAfterChunks
      if (
        failAfter !== undefined &&
        (!Number.isInteger(failAfter) || failAfter < 1 || failAfter > scripted.chunks.length)
      ) {
        invalid('speech failAfterChunks')
      }
      scripts.push({ ...scripted })
    },
    failNext(code, times = 1) {
      for (let i = 0; i < times; i++) {
        failures.push(code)
      }
    },
    requests() {
      return requests.map((entry) => ({ ...entry.view }))
    },
    openStreams() {
      return open
    },
  }
}
