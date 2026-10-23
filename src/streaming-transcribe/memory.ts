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
  type OpenStreamRequest,
  reconnectDelayMs,
  type StreamEvent,
  type StreamingTranscribeOptions,
  type StreamingTranscribePort,
  type StreamTrack,
  type TranscribedWord,
  type TranscribeStream,
} from './port'
import { checkChunk, checkOpenRequest, invalid, resolveTimeout } from './validate'

const WORD_MS = 200

/** One turn a scripted speaker says once enough audio has been sent. */
export interface ScriptedTurn {
  /** The words said, separated by spaces: 1 to 200 words. */
  text: string
  /** The turn is spoken when the stream has been sent at least this many audio bytes in all. */
  afterBytes: number
  /** How many interim events come before the final, 0 to the word count minus one; default 2 or fewer. */
  interims?: number
  /** False for a settled part of a turn that goes on; default true. */
  endOfTurn?: boolean
}

/** What a test sees of a stream (never the audio or the text). */
export interface MemoryStreamView {
  /** The adapter's id. */
  streamId: string
  /** The Organization. */
  organizationId: OrganizationId
  /** The Call. */
  callId: CallId
  /** The track. */
  track: StreamTrack
  /** Where it is now. */
  state: 'open' | 'reconnecting' | 'closed' | 'failed'
  /** How many audio bytes it has been sent. */
  audioBytes: number
  /** How many times it dropped and came back. */
  reconnects: number
}

/** Options for {@link createMemoryStreamingTranscribe}. */
export interface MemoryStreamingTranscribeOptions {
  /** Receives the unrecoverable-failure error; nothing if absent. */
  reporter?: ErrorReporter
  /** Where reconnects and listener failures are noted (metadata only); nothing if absent. */
  logger?: Logger
  /** Pauses before a reconnect attempt; real time by default, injected so tests do not wait. */
  sleep?: Sleep
  /** A number in `[0, 1)` for the jitter; `Math.random` by default. */
  random?: () => number
}

/** A {@link StreamingTranscribePort} that plays scripted speakers in the process, for tests. Not for production. */
export interface MemoryStreamingTranscribe extends StreamingTranscribePort {
  /** Sets the turns the speaker of a Call's track says; a later script replaces the earlier. */
  script(
    organizationId: OrganizationId,
    callId: CallId,
    track: StreamTrack,
    turns: readonly ScriptedTurn[]
  ): void
  /**
   * Drops the connection of a stream as a vendor socket closing would, and resolves once the
   * stream is back (`reconnected`) or has failed. Does nothing to a stream that is not open.
   */
  dropConnection(streamId: string): Promise<void>
  /** Makes the next `times` (default 1) reconnect attempts of any stream fail. */
  failReconnects(times?: number): void
  /** Makes the next `times` (default 1) opens throw a StreamingTranscribeError with `code`. */
  failNextOpen(code: StreamingTranscribeErrorCode, times?: number): void
  /** The streams opened so far, in order. */
  streams(): MemoryStreamView[]
}

interface Script {
  turns: ScriptedTurn[]
  next: number
}

interface Stream {
  view: MemoryStreamView
  key: string
  request: OpenStreamRequest
  policy: ReturnType<typeof checkOpenRequest>
  script: Script | undefined
  abort: AbortController
  sequence: number
  turnCounter: number
  lastWordEndMs: number
}

function wordsOf(text: string, startMs: number): TranscribedWord[] {
  return text
    .split(' ')
    .filter((word) => word.length > 0)
    .map((word, index) => ({
      text: word,
      startMs: startMs + index * WORD_MS,
      endMs: startMs + (index + 1) * WORD_MS,
    }))
}

function checkScript(turns: readonly ScriptedTurn[]): ScriptedTurn[] {
  if (!Array.isArray(turns) || turns.length > 1000) {
    invalid('turns')
  }
  let previous = 0
  for (const turn of turns) {
    const count = typeof turn?.text === 'string' ? wordsOf(turn.text, 0).length : 0
    if (count < 1 || count > 200) {
      invalid('turn text')
    }
    if (!Number.isInteger(turn.afterBytes) || turn.afterBytes < previous) {
      invalid('afterBytes')
    }
    if (
      turn.interims !== undefined &&
      !(Number.isInteger(turn.interims) && turn.interims >= 0 && turn.interims < count)
    ) {
      invalid('interims')
    }
    previous = turn.afterBytes
  }
  return [...turns]
}

/**
 * Builds a {@link StreamingTranscribePort} for tests that plays scripted speakers: once a stream
 * has been sent enough audio, its next scripted turn arrives as interim events (the first words,
 * growing), a final and, by default, the end-of-turn mark. It keeps the rules a real adapter
 * must: Organization scoping, one live stream per Call and track, bounded jittered reconnects
 * with continuous word times, one terminal event, and no audio or text in logs or reports. Not
 * for production.
 */
export function createMemoryStreamingTranscribe(
  options: MemoryStreamingTranscribeOptions = {}
): MemoryStreamingTranscribe {
  const sleep = options.sleep ?? systemSleep
  const random = options.random ?? Math.random
  const scripts = new Map<string, Script>()
  const live = new Set<string>()
  const all = new Map<string, Stream>()
  const openFailures: StreamingTranscribeErrorCode[] = []
  let reconnectFailures = 0
  let counter = 0

  const scriptKey = (organizationId: string, callId: string, track: string) =>
    `${organizationId}|${callId}|${track}`

  function emit(stream: Stream, event: StreamEvent) {
    try {
      stream.request.onEvent(event)
    } catch {
      // The listener's error may hold text, so only the fact is noted.
      options.logger?.warn('A stream listener threw', { streamId: stream.view.streamId })
    }
  }

  function turnEvent(stream: Stream, isFinal: boolean, endOfTurn: boolean, text: string) {
    stream.sequence += 1
    const words = wordsOf(text, stream.lastWordEndMs)
    emit(stream, {
      type: 'turn',
      turnId: `turn-${stream.turnCounter}`,
      sequence: stream.sequence,
      isFinal,
      endOfTurn,
      text,
      words,
    })
    if (isFinal) {
      stream.lastWordEndMs = words.at(-1)?.endMs ?? stream.lastWordEndMs
    }
  }

  function pump(stream: Stream) {
    const script = stream.script
    while (
      script !== undefined &&
      stream.view.state === 'open' &&
      script.next < script.turns.length
    ) {
      const turn = script.turns[script.next]
      if (turn === undefined || stream.view.audioBytes < turn.afterBytes) {
        return
      }
      script.next += 1
      const words = turn.text.split(' ').filter((word) => word.length > 0)
      const interims = turn.interims ?? Math.min(2, words.length - 1)
      for (let i = 1; i <= interims; i++) {
        const take = Math.max(1, Math.floor((words.length * i) / (interims + 1)))
        turnEvent(stream, false, false, words.slice(0, take).join(' '))
      }
      const endOfTurn = turn.endOfTurn ?? true
      turnEvent(stream, true, endOfTurn, words.join(' '))
      if (endOfTurn) {
        stream.turnCounter += 1
      }
    }
  }

  function finish(stream: Stream, state: 'closed' | 'failed') {
    stream.view.state = state
    live.delete(stream.key)
    stream.abort.abort()
  }

  function fail(stream: Stream, attempts: number) {
    finish(stream, 'failed')
    emit(stream, {
      type: 'failed',
      code: STREAMING_TRANSCRIBE_ERROR_CODES.unavailable,
      attempts,
    })
    options.logger?.error('A stream could not be restored', {
      streamId: stream.view.streamId,
      track: stream.view.track,
      attempts,
    })
    options.reporter?.capture(
      new StreamingTranscribeError(
        STREAMING_TRANSCRIBE_ERROR_CODES.unavailable,
        'The stream could not be restored',
        { details: { attempts, track: stream.view.track } }
      ),
      {
        organizationId: stream.view.organizationId,
        tags: { feature: 'streaming-transcribe', track: stream.view.track },
      }
    )
  }

  async function reconnect(stream: Stream) {
    stream.view.state = 'reconnecting'
    for (let attempt = 1; attempt <= stream.policy.maxAttempts; attempt++) {
      const delayMs = reconnectDelayMs(attempt, stream.policy, random)
      emit(stream, { type: 'reconnecting', attempt, delayMs })
      options.logger?.warn('A stream is reconnecting', {
        streamId: stream.view.streamId,
        attempt,
        delayMs,
      })
      await sleep(delayMs, stream.abort.signal)
      if (stream.view.state !== 'reconnecting') {
        return
      }
      if (reconnectFailures > 0) {
        reconnectFailures -= 1
        continue
      }
      stream.view.state = 'open'
      stream.view.reconnects += 1
      emit(stream, { type: 'reconnected', attempts: attempt })
      pump(stream)
      return
    }
    fail(stream, stream.policy.maxAttempts)
  }

  const port: MemoryStreamingTranscribe = {
    async open(request: OpenStreamRequest, opts?: StreamingTranscribeOptions) {
      const policy = checkOpenRequest(request)
      resolveTimeout(opts)
      const code = openFailures.shift()
      if (code !== undefined) {
        throw new StreamingTranscribeError(code, 'The vendor failed')
      }
      const key = scriptKey(request.organizationId, request.callId, request.track)
      if (live.has(key)) {
        throw new StreamingTranscribeError(
          STREAMING_TRANSCRIBE_ERROR_CODES.conflict,
          'A stream for this Call and track is already open'
        )
      }
      counter += 1
      const streamId = `memstream-${counter.toString(16).padStart(8, '0')}`
      const stream: Stream = {
        view: {
          streamId,
          organizationId: request.organizationId,
          callId: request.callId,
          track: request.track,
          state: 'open',
          audioBytes: 0,
          reconnects: 0,
        },
        key,
        request,
        policy,
        script: scripts.get(key),
        abort: new AbortController(),
        sequence: 0,
        turnCounter: 1,
        lastWordEndMs: 0,
      }
      live.add(key)
      all.set(streamId, stream)
      const handle: TranscribeStream = {
        streamId,
        sendAudio(chunk) {
          const bytes = checkChunk(chunk)
          if (stream.view.state === 'closed' || stream.view.state === 'failed') {
            throw new StreamingTranscribeError(
              STREAMING_TRANSCRIBE_ERROR_CODES.closed,
              'The stream has ended'
            )
          }
          stream.view.audioBytes += bytes.length
          pump(stream)
        },
        async close() {
          if (stream.view.state === 'closed' || stream.view.state === 'failed') {
            return
          }
          finish(stream, 'closed')
          emit(stream, { type: 'closed' })
        },
      }
      return handle
    },
    script(organizationId, callId, track, turns) {
      scripts.set(scriptKey(organizationId, callId, track), {
        turns: checkScript(turns),
        next: 0,
      })
    },
    async dropConnection(streamId) {
      const stream = all.get(streamId)
      if (stream?.view.state === 'open') {
        await reconnect(stream)
      }
    },
    failReconnects(times = 1) {
      reconnectFailures += times
    },
    failNextOpen(code, times = 1) {
      for (let i = 0; i < times; i++) {
        openFailures.push(code)
      }
    },
    streams() {
      return [...all.values()].map((stream) => ({ ...stream.view }))
    },
  }
  return port
}
