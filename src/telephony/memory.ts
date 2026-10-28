import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type {
  CallId,
  MembershipId,
  OrganizationId,
  SoftphoneToken,
  VoiceCallFailureReason,
} from 'tula-closeline-contract'
import { type Clock, systemClock } from '../clock'
import type { Environment } from '../reporting/env'
import { TELEPHONY_ERROR_CODES, TelephonyError, type TelephonyErrorCode } from './errors'
import {
  type AnswerCallRequest,
  type AnsweredBy,
  type AnsweredCall,
  type BridgeRequest,
  type BrowserTokenRequest,
  DEFAULT_TELEPHONY_TIMEOUT_MS,
  type DisclosurePlayed,
  type FetchedRecording,
  type ForkedTracks,
  type ForkTracksRequest,
  type HangUpRequest,
  MAX_WEBHOOK_BODY_BYTES,
  type PlaceAgentCallRequest,
  type PlaceCallRequest,
  type PlacedCall,
  type PlayDisclosureRequest,
  type ProviderCallRef,
  type RecordingRef,
  type StartedRecording,
  type TelephonyEvent,
  type TelephonyEventType,
  type TelephonyOptions,
  type TelephonyPort,
  type WebhookRequest,
} from './port'
import {
  checkCallId,
  checkDestinationUrl,
  checkDetectionWindow,
  checkDisclosure,
  checkIdentity,
  checkNumber,
  checkOrganizationId,
  checkProviderId,
  checkRingIdentities,
  invalid,
  requireDisclosure,
  resolveTimeout,
} from './validate'

/** What a scripted Prospect does when the memory provider dials their number. */
export type ScriptedProspect =
  /** Answers at once; the default for a number nobody scripted. */
  | { kind: 'answers'; detection?: AnsweredBy }
  /** Rings and never answers: the call ends with `no_answer`. */
  | { kind: 'no_answer' }
  /** Is busy: the call ends with `busy`. */
  | { kind: 'busy' }
  /** Answers and then hangs up, during the Disclosure or right after the Rep is bridged. */
  | { kind: 'hangs_up'; when: 'during_disclosure' | 'after_bridge' }
  /** The carrier fails the call: when dialing, or right after the Rep is bridged. */
  | {
      kind: 'carrier_failure'
      reason?: Extract<
        VoiceCallFailureReason,
        'carrier_dropped' | 'carrier_rejected' | 'provider_error'
      >
      when?: 'dial' | 'after_bridge'
    }

/** The operations a test can make fail or stall. */
export type TelephonyOperation =
  | 'placeCall'
  | 'answerCall'
  | 'playDisclosure'
  | 'bridge'
  | 'startRecording'
  | 'forkTracks'
  | 'hangUp'
  | 'fetchRecording'
  | 'deleteRecording'
  | 'mintBrowserToken'

/** {@link TelephonyOperation} and the Agent-leg dial, which the shared suite does not time out. */
export type MemoryOperation = TelephonyOperation | 'placeAgentCall'

/** Options for {@link createMemoryTelephony}. */
export interface MemoryTelephonyOptions {
  /** The clock for event times and token expiry; the system clock by default. */
  clock?: Clock
  /** The `ENVIRONMENT` to behave as: a `ws:` fork destination is accepted only in `local`; default `local`. */
  environment?: Environment
  /** The secret webhooks are signed with, at least 16 characters; a fixed test value by default. */
  webhookSecret?: string
  /** The timeout of an operation that names none, in ms; default {@link DEFAULT_TELEPHONY_TIMEOUT_MS}. */
  defaultTimeoutMs?: number
  /** The bytes every Recording holds; a few bytes of fake audio by default. */
  recordingAudio?: Uint8Array
}

/** What a test sees of a provider call (never a number or a Disclosure text). */
export interface MemoryCallView {
  /** The Organization. */
  organizationId: OrganizationId
  /** The provider's id. */
  providerCallId: string
  /** Our Call id, when the call was placed or answered with one. */
  callId: CallId | null
  /** Placed by us, or received. */
  direction: 'outbound' | 'inbound'
  /** `ringing` for an Agent-leg call not yet played out, `incoming` until answered, `connected` while up, `ended` after. */
  state: 'incoming' | 'ringing' | 'connected' | 'ended'
  /** The Disclosure that played, if one has. */
  disclosure: DisclosurePlayed | null
  /** The Rep whose browser leg is joined, if any. */
  bridgedTo: MembershipId | null
  /** The Recording, if started. */
  recordingId: string | null
  /** The fork stream, if started. */
  streamId: string | null
  /** Who ended it, when it has ended. */
  endedBy: 'rep' | 'prospect' | 'system' | null
}

/** One operation the provider carried out, in order; the proof the Disclosure came first. */
export interface MemoryOperationRecord {
  /** The operation. */
  operation: MemoryOperation | 'prospectHangsUp'
  /** The provider call it applied to, when it applied to one. */
  providerCallId: string | null
}

/** A webhook request that carries a signature. */
export interface SignedWebhook extends WebhookRequest {
  /** The valid signature. */
  signature: string
}

/** A {@link TelephonyPort} that plays scripted Prospects in the process, for tests. Not for production. */
export interface MemoryTelephony extends TelephonyPort {
  /**
   * Plays out an Agent-leg call that is still ringing as its script says: answered then one
   * `detection` event (`human` unless scripted), or no answer, busy or a carrier failure. A call that
   * has ended (hung up or cancelled) is left alone, so no detection follows a hang-up.
   */
  ring(organizationId: OrganizationId, providerCallId: string): void
  /** Sets what the Prospect at `number` (E.164) does when dialed; a later script replaces the earlier. */
  script(number: string, behaviour: ScriptedProspect): void
  /** Receives an inbound call on a Line, as the provider's webhook would; returns the provider's call id. */
  receiveInbound(organizationId: OrganizationId, from: string, to: string): string
  /** Has the Prospect on this call hang up now; a call that has ended is left alone. */
  prospectHangsUp(organizationId: OrganizationId, providerCallId: string): void
  /** Makes the next `times` (default 1) calls of `operation` throw a TelephonyError with `code`, changing nothing. */
  failNext(operation: MemoryOperation, code: TelephonyErrorCode, times?: number): void
  /** Makes the next `times` (default 1) calls of `operation` never answer, so the timeout fires; changes nothing. */
  stallNext(operation: MemoryOperation, times?: number): void
  /** Every event so far, in order. */
  readonly events: readonly TelephonyEvent[]
  /** Returns the events not yet taken, in order, and forgets them. */
  takeEvents(): TelephonyEvent[]
  /** Every operation carried out, in order; failed, refused and timed-out ones are not in it. */
  readonly operations: readonly MemoryOperationRecord[]
  /** The calls, for one Organization or all, in the order they were made. */
  calls(organizationId?: string): MemoryCallView[]
  /** The webhook the provider would send for `event`: a URL, the JSON body and its valid signature. */
  webhookFor(event: TelephonyEvent): SignedWebhook
  /** The valid signature for a URL and body. */
  sign(url: string, body: string): string
  /** How many Recordings the provider still holds. */
  recordingCount(): number
}

interface Call {
  organizationId: OrganizationId
  providerCallId: string
  callId: CallId | null
  direction: 'outbound' | 'inbound'
  state: 'incoming' | 'ringing' | 'connected' | 'ended'
  to: string
  from: string
  script: ScriptedProspect
  disclosure: DisclosurePlayed | null
  bridgedTo: MembershipId | null
  recordingId: string | null
  streamId: string | null
  ringing: number | null
  agent: boolean
  endedBy: 'rep' | 'prospect' | 'system' | null
}

interface Recording {
  organizationId: OrganizationId
  recordingId: string
  providerCallId: string
  ready: boolean
}

const DEFAULT_SECRET = 'memory-webhook-secret'
const DEFAULT_TTL_SECONDS = 900
const FAKE_AUDIO = new TextEncoder().encode('RIFF....WAVEmemory-recording')

function chunked(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice())
      controller.close()
    },
  })
}

/**
 * Builds a {@link TelephonyPort} for tests, which plays scripted Prospects: one who answers (the
 * default), one who does not, one who is busy, one who hangs up and a carrier that fails. It keeps
 * the same rules a real adapter must: Organization scoping, idempotent placing, the Disclosure
 * before bridging, recording or forking, timeouts, and constant-time webhook verification. Events
 * a real provider would send as webhooks are collected in `events`. Not for production.
 */
export function createMemoryTelephony(options: MemoryTelephonyOptions = {}): MemoryTelephony {
  const clock = options.clock ?? systemClock
  const allowPlainSocket = (options.environment ?? 'local') === 'local'
  const secret = options.webhookSecret ?? DEFAULT_SECRET
  if (secret.length < 16) {
    throw new TypeError('createMemoryTelephony needs a webhookSecret of at least 16 characters')
  }
  const defaultTimeout = options.defaultTimeoutMs ?? DEFAULT_TELEPHONY_TIMEOUT_MS
  try {
    resolveTimeout(undefined, defaultTimeout)
  } catch {
    throw new TypeError('createMemoryTelephony needs a defaultTimeoutMs from 1 to 60000')
  }
  const audio = options.recordingAudio ?? FAKE_AUDIO

  const calls = new Map<string, Call>()
  const recordings = new Map<string, Recording>()
  const placed = new Map<string, string>()
  const scripts = new Map<string, ScriptedProspect>()
  const failures = new Map<MemoryOperation, TelephonyErrorCode[]>()
  const stalls = new Map<MemoryOperation, number>()
  const events: TelephonyEvent[] = []
  const operations: MemoryOperationRecord[] = []
  let taken = 0
  let counter = 0

  const nextId = (prefix: string) => {
    counter += 1
    return `${prefix}${counter.toString(16).padStart(8, '0')}`
  }

  const sign = (url: string, body: string) =>
    createHmac('sha256', secret).update(url).update('\n').update(body).digest('base64')

  function emit(
    call: Call,
    type: TelephonyEventType,
    extra: Partial<
      Pick<TelephonyEvent, 'failureReason' | 'endedBy' | 'recordingId' | 'answeredBy'>
    > = {}
  ) {
    events.push({
      eventId: nextId('evt-'),
      organizationId: call.organizationId,
      providerCallId: call.providerCallId,
      type,
      at: clock.now().toISOString(),
      ...extra,
    })
  }

  function finishRecording(call: Call) {
    const recording = call.recordingId === null ? undefined : recordings.get(call.recordingId)
    if (recording && !recording.ready) {
      recording.ready = true
      emit(call, 'recording_ready', { recordingId: recording.recordingId })
    }
  }

  function end(call: Call, by: 'rep' | 'prospect' | 'system') {
    call.state = 'ended'
    call.endedBy = by
    emit(call, 'completed', { endedBy: by })
    finishRecording(call)
  }

  function fail(call: Call, reason: VoiceCallFailureReason) {
    call.state = 'ended'
    call.endedBy = 'system'
    emit(call, 'failed', { failureReason: reason })
    finishRecording(call)
  }

  function find(organizationId: string, providerCallId: string): Call {
    const call = calls.get(providerCallId)
    if (!call || call.organizationId !== organizationId) {
      throw new TelephonyError(TELEPHONY_ERROR_CODES.notFound, 'There is no such call')
    }
    return call
  }

  function live(call: Call): void {
    if (call.state === 'ended') {
      throw new TelephonyError(TELEPHONY_ERROR_CODES.callEnded, 'The call has ended')
    }
    if (call.state === 'incoming' || call.state === 'ringing') {
      invalid('call: it has not been answered, so it')
    }
  }

  function needDisclosure(call: Call, needsAi = false): DisclosurePlayed {
    return requireDisclosure(call.disclosure, needsAi)
  }

  function checkRef(request: ProviderCallRef) {
    checkOrganizationId(request.organizationId)
    checkProviderId(request.providerCallId, 'providerCallId')
  }

  async function run<T>(
    operation: MemoryOperation,
    opts: TelephonyOptions | undefined,
    body: () => T
  ): Promise<T> {
    const timeoutMs = resolveTimeout(opts, defaultTimeout)
    const stalled = stalls.get(operation) ?? 0
    if (stalled > 0) {
      stalls.set(operation, stalled - 1)
      await new Promise((resolve) => setTimeout(resolve, timeoutMs))
      throw new TelephonyError(
        TELEPHONY_ERROR_CODES.unavailable,
        'The provider did not answer in time'
      )
    }
    const code = failures.get(operation)?.shift()
    if (code !== undefined) {
      throw new TelephonyError(code, 'The provider failed')
    }
    return body()
  }

  function record(operation: MemoryOperationRecord['operation'], providerCallId: string | null) {
    operations.push({ operation, providerCallId })
  }

  function dial(request: PlaceCallRequest, agent: boolean): PlacedCall {
    checkOrganizationId(request.organizationId)
    checkCallId(request.callId)
    checkProviderId(request.idempotencyKey, 'idempotencyKey')
    checkNumber(request.from, 'from')
    checkNumber(request.to, 'to')
    const key = `${request.organizationId}|${request.idempotencyKey}`
    const existing = placed.get(key)
    if (existing !== undefined) {
      const first = calls.get(existing)
      if (
        first &&
        (first.to !== request.to || first.from !== request.from || first.agent !== agent)
      ) {
        invalid('idempotencyKey: it was used for another call, so it')
      }
      return { providerCallId: existing, created: false }
    }
    const script = scripts.get(request.to) ?? { kind: 'answers' }
    const call: Call = {
      organizationId: request.organizationId,
      providerCallId: nextId('memcall-'),
      callId: request.callId,
      direction: 'outbound',
      state: 'connected',
      to: request.to,
      from: request.from,
      script,
      disclosure: null,
      bridgedTo: null,
      recordingId: null,
      streamId: null,
      ringing: null,
      agent,
      endedBy: null,
    }
    calls.set(call.providerCallId, call)
    placed.set(key, call.providerCallId)
    record(agent ? 'placeAgentCall' : 'placeCall', call.providerCallId)
    emit(call, 'ringing')
    if (agent) {
      call.state = 'ringing'
    } else {
      play(call)
    }
    return { providerCallId: call.providerCallId, created: true }
  }

  /** Plays out what the Prospect's script says happens once the number rings. */
  function play(call: Call) {
    const script = call.script
    if (script.kind === 'no_answer') {
      call.state = 'ended'
      emit(call, 'no_answer', { failureReason: 'no_answer' })
    } else if (script.kind === 'busy') {
      call.state = 'ended'
      emit(call, 'busy', { failureReason: 'busy' })
    } else if (script.kind === 'carrier_failure' && (script.when ?? 'dial') === 'dial') {
      fail(call, script.reason ?? 'carrier_rejected')
    } else {
      call.state = 'connected'
      emit(call, 'answered')
      if (call.agent) {
        emit(call, 'detection', {
          answeredBy: script.kind === 'answers' ? (script.detection ?? 'human') : 'human',
        })
      }
    }
  }

  const port: MemoryTelephony = {
    events,
    operations,
    placeCall(request: PlaceCallRequest, opts) {
      return run('placeCall', opts, () => dial(request, false))
    },
    placeAgentCall(request: PlaceAgentCallRequest, opts) {
      return run('placeAgentCall', opts, () => {
        checkDestinationUrl(request.streamUrl, allowPlainSocket)
        checkDetectionWindow(request.detectionWindowMs)
        return dial(request, true)
      })
    },
    answerCall(request: AnswerCallRequest, opts) {
      return run('answerCall', opts, (): AnsweredCall => {
        checkRef(request)
        checkCallId(request.callId)
        const identities = checkRingIdentities(request.ringIdentities)
        const call = find(request.organizationId, request.providerCallId)
        if (call.state === 'ended') {
          throw new TelephonyError(TELEPHONY_ERROR_CODES.callEnded, 'The call has ended')
        }
        if (call.state === 'incoming') {
          call.state = 'connected'
          call.callId = request.callId
          call.ringing = identities.length
          record('answerCall', call.providerCallId)
          emit(call, 'answered')
        }
        return { ringing: call.ringing ?? identities.length }
      })
    },
    playDisclosure(request: PlayDisclosureRequest, opts) {
      return run('playDisclosure', opts, (): DisclosurePlayed => {
        checkRef(request)
        checkDisclosure(request.wordingVersion, request.text, request.aiAssisted)
        const call = find(request.organizationId, request.providerCallId)
        if (call.disclosure !== null && call.disclosure.wordingVersion === request.wordingVersion) {
          return call.disclosure
        }
        live(call)
        if (call.script.kind === 'hangs_up' && call.script.when === 'during_disclosure') {
          end(call, 'prospect')
          throw new TelephonyError(TELEPHONY_ERROR_CODES.callEnded, 'The Prospect hung up')
        }
        const played: DisclosurePlayed = {
          wordingVersion: request.wordingVersion,
          aiAssisted: request.aiAssisted,
          playedAt: clock.now().toISOString(),
        }
        call.disclosure = played
        record('playDisclosure', call.providerCallId)
        return played
      })
    },
    bridge(request: BridgeRequest, opts) {
      return run('bridge', opts, () => {
        checkRef(request)
        checkIdentity(request.repIdentity)
        const call = find(request.organizationId, request.providerCallId)
        live(call)
        needDisclosure(call)
        if (call.bridgedTo === request.repIdentity) {
          return
        }
        call.bridgedTo = request.repIdentity
        record('bridge', call.providerCallId)
        if (call.script.kind === 'hangs_up' && call.script.when === 'after_bridge') {
          end(call, 'prospect')
        } else if (call.script.kind === 'carrier_failure' && call.script.when === 'after_bridge') {
          fail(call, call.script.reason ?? 'carrier_dropped')
        }
      })
    },
    startRecording(request: ProviderCallRef, opts) {
      return run('startRecording', opts, (): StartedRecording => {
        checkRef(request)
        const call = find(request.organizationId, request.providerCallId)
        if (call.recordingId !== null) {
          return { recordingId: call.recordingId, channels: 2 }
        }
        live(call)
        needDisclosure(call)
        const recordingId = nextId('memrec-')
        recordings.set(recordingId, {
          organizationId: call.organizationId,
          recordingId,
          providerCallId: call.providerCallId,
          ready: false,
        })
        call.recordingId = recordingId
        record('startRecording', call.providerCallId)
        return { recordingId, channels: 2 }
      })
    },
    forkTracks(request: ForkTracksRequest, opts) {
      return run('forkTracks', opts, (): ForkedTracks => {
        checkRef(request)
        checkDestinationUrl(request.destinationUrl, allowPlainSocket)
        const call = find(request.organizationId, request.providerCallId)
        if (call.streamId !== null) {
          return { streamId: call.streamId, tracks: ['rep', 'prospect'] }
        }
        live(call)
        needDisclosure(call, true)
        call.streamId = nextId('memstream-')
        record('forkTracks', call.providerCallId)
        return { streamId: call.streamId, tracks: ['rep', 'prospect'] }
      })
    },
    hangUp(request: HangUpRequest, opts) {
      return run('hangUp', opts, () => {
        checkRef(request)
        if (request.by !== undefined && request.by !== 'rep' && request.by !== 'system') {
          invalid('by')
        }
        const call = find(request.organizationId, request.providerCallId)
        if (call.state === 'ended') {
          return
        }
        record('hangUp', call.providerCallId)
        end(call, request.by ?? 'system')
      })
    },
    fetchRecording(request: RecordingRef, opts) {
      return run('fetchRecording', opts, (): FetchedRecording => {
        checkOrganizationId(request.organizationId)
        checkProviderId(request.recordingId, 'recordingId')
        const found = recordings.get(request.recordingId)
        if (!found || found.organizationId !== request.organizationId) {
          throw new TelephonyError(TELEPHONY_ERROR_CODES.notFound, 'There is no such Recording')
        }
        if (!found.ready) {
          throw new TelephonyError(
            TELEPHONY_ERROR_CODES.recordingNotReady,
            'The Recording is not finished'
          )
        }
        record('fetchRecording', found.providerCallId)
        return {
          body: chunked(audio),
          contentType: 'audio/wav',
          sizeBytes: audio.length,
          channels: 2,
        }
      })
    },
    deleteRecording(request: RecordingRef, opts) {
      return run('deleteRecording', opts, () => {
        checkOrganizationId(request.organizationId)
        checkProviderId(request.recordingId, 'recordingId')
        const found = recordings.get(request.recordingId)
        if (!found || found.organizationId !== request.organizationId) {
          return { existed: false }
        }
        recordings.delete(request.recordingId)
        record('deleteRecording', found.providerCallId)
        return { existed: true }
      })
    },
    verifyWebhook(request: WebhookRequest): boolean {
      if (
        typeof request !== 'object' ||
        request === null ||
        typeof request.url !== 'string' ||
        typeof request.body !== 'string' ||
        typeof request.signature !== 'string' ||
        request.signature.length === 0 ||
        Buffer.byteLength(request.body) > MAX_WEBHOOK_BODY_BYTES
      ) {
        return false
      }
      const expected = Buffer.from(sign(request.url, request.body))
      const got = Buffer.from(request.signature)
      return got.length === expected.length && timingSafeEqual(got, expected)
    },
    mintBrowserToken(request: BrowserTokenRequest, opts) {
      return run('mintBrowserToken', opts, (): SoftphoneToken => {
        checkOrganizationId(request.organizationId)
        checkIdentity(request.identity)
        const ttl = request.ttlSeconds ?? DEFAULT_TTL_SECONDS
        if (!Number.isInteger(ttl) || ttl < 60 || ttl > 3600) {
          invalid('ttlSeconds')
        }
        return {
          token: `memtok.${randomBytes(24).toString('base64url')}`,
          identity: request.identity,
          ttlSeconds: ttl,
          expiresAt: new Date(clock.now().getTime() + ttl * 1000).toISOString(),
        }
      })
    },
    script(number, behaviour) {
      checkNumber(number, 'number')
      scripts.set(number, behaviour)
    },
    receiveInbound(organizationId, from, to) {
      checkOrganizationId(organizationId)
      checkNumber(from, 'from')
      checkNumber(to, 'to')
      const call: Call = {
        organizationId,
        providerCallId: nextId('memcall-'),
        callId: null,
        direction: 'inbound',
        state: 'incoming',
        to,
        from,
        script: { kind: 'answers' },
        disclosure: null,
        bridgedTo: null,
        recordingId: null,
        streamId: null,
        ringing: null,
        agent: false,
        endedBy: null,
      }
      calls.set(call.providerCallId, call)
      emit(call, 'ringing')
      return call.providerCallId
    },
    ring(organizationId, providerCallId) {
      const call = find(organizationId, providerCallId)
      if (call.state === 'ringing') {
        play(call)
      }
    },
    prospectHangsUp(organizationId, providerCallId) {
      const call = find(organizationId, providerCallId)
      if (call.state !== 'ended') {
        record('prospectHangsUp', providerCallId)
        end(call, 'prospect')
      }
    },
    failNext(operation, code, times = 1) {
      const queue = failures.get(operation) ?? []
      for (let i = 0; i < times; i++) {
        queue.push(code)
      }
      failures.set(operation, queue)
    },
    stallNext(operation, times = 1) {
      stalls.set(operation, (stalls.get(operation) ?? 0) + times)
    },
    takeEvents() {
      const fresh = events.slice(taken)
      taken = events.length
      return fresh
    },
    calls(organizationId) {
      return [...calls.values()]
        .filter((call) => organizationId === undefined || call.organizationId === organizationId)
        .map((call) => ({
          organizationId: call.organizationId,
          providerCallId: call.providerCallId,
          callId: call.callId,
          direction: call.direction,
          state: call.state,
          disclosure: call.disclosure,
          bridgedTo: call.bridgedTo,
          recordingId: call.recordingId,
          streamId: call.streamId,
          endedBy: call.endedBy,
        }))
    },
    webhookFor(event) {
      const url = 'https://voice.example.test/webhooks/telephony'
      const body = JSON.stringify(event)
      return { url, body, signature: sign(url, body) }
    },
    sign,
    recordingCount: () => recordings.size,
  }
  return port
}
