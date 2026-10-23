import type {
  CallId,
  MembershipId,
  OrganizationId,
  SoftphoneToken,
  VoiceCallFailureReason,
} from 'tula-closeline-contract'
import type { ByteStream } from '../storage/port'

/** The default time any telephony operation may take, in milliseconds. */
export const DEFAULT_TELEPHONY_TIMEOUT_MS = 10_000

/** The longest time a caller may allow one telephony operation, in milliseconds. */
export const MAX_TELEPHONY_TIMEOUT_MS = 60_000

/** The longest Disclosure text, in characters. */
export const MAX_DISCLOSURE_TEXT_LENGTH = 1000

/** The most browser legs one inbound call may ring at once. */
export const MAX_RING_LEGS = 50

/** The most bytes of a webhook body {@link TelephonyPort.verifyWebhook} reads; a longer body is refused. */
export const MAX_WEBHOOK_BODY_BYTES = 262_144

/** Options every operation of {@link TelephonyPort} accepts. */
export interface TelephonyOptions {
  /**
   * The most time the operation may take, in ms, 1 to {@link MAX_TELEPHONY_TIMEOUT_MS}; default
   * {@link DEFAULT_TELEPHONY_TIMEOUT_MS}. When it passes the operation throws
   * `telephony.unavailable` and, as far as the adapter can tell, changed nothing.
   */
  timeoutMs?: number
}

/** Which Organization a provider call belongs to and which provider call it is. */
export interface ProviderCallRef {
  /** The Organization. A call or Recording of another Organization is `telephony.not_found`. */
  organizationId: OrganizationId
  /** The provider's id of the call leg to the Prospect: opaque, 1 to 128 of letters, digits, `.`, `_`, `:` and `-`. */
  providerCallId: string
}

/** The call a service asks the provider to place to a Prospect. */
export interface PlaceCallRequest {
  /** The Organization. */
  organizationId: OrganizationId
  /** Our id of the Call, kept by the adapter as a tag on the provider call; it never leaves the provider as speech. */
  callId: CallId
  /**
   * Required. The same key places exactly one provider call: a repeat returns the first one with
   * `created: false`. 1 to 128 of letters, digits, `.`, `_`, `:` and `-`.
   */
  idempotencyKey: string
  /** The Line's number the Prospect sees, in E.164. */
  from: string
  /** The Prospect's number, in E.164. Tenant data: never logged. */
  to: string
}

/** What {@link TelephonyPort.placeCall} reports. */
export interface PlacedCall {
  /** The provider's id of the leg to the Prospect. */
  providerCallId: string
  /** True when this call placed it; false when the same idempotency key had already placed it. */
  created: boolean
}

/** An inbound call the provider has received, to be answered. */
export interface AnswerCallRequest extends ProviderCallRef {
  /** Our id of the Call. */
  callId: CallId
  /** The Reps' browser legs to ring, 1 to {@link MAX_RING_LEGS}; the first to answer is bridged. */
  ringIdentities: MembershipId[]
}

/** What {@link TelephonyPort.answerCall} reports. */
export interface AnsweredCall {
  /** How many browser legs are ringing. */
  ringing: number
}

/** The Disclosure to play to a connected call, before anything else happens on it. */
export interface PlayDisclosureRequest extends ProviderCallRef {
  /** The version of the wording, 1 or more; the Call stores it (ADR 0003). */
  wordingVersion: number
  /** The words spoken, 1 to {@link MAX_DISCLOSURE_TEXT_LENGTH} characters. Never logged. */
  text: string
  /** Whether the wording also says an AI takes part. Forking tracks to an AI needs `true`. */
  aiAssisted: boolean
}

/** What {@link TelephonyPort.playDisclosure} reports once the wording has finished playing. */
export interface DisclosurePlayed {
  /** The wording version that played. */
  wordingVersion: number
  /** Whether it said an AI takes part. */
  aiAssisted: boolean
  /** When it finished playing, as an ISO 8601 UTC time. */
  playedAt: string
}

/** A Rep's browser leg to join to a call. */
export interface BridgeRequest extends ProviderCallRef {
  /** The Rep whose browser leg joins; if another leg is joined, it moves to this one. */
  repIdentity: MembershipId
}

/** What {@link TelephonyPort.startRecording} reports. */
export interface StartedRecording {
  /** The provider's id of the Recording: opaque, same shape as a provider call id. */
  recordingId: string
  /** Always 2: channel 0 is the Prospect, channel 1 is the Rep. */
  channels: 2
}

/** Where to fork the two audio tracks of a call. */
export interface ForkTracksRequest extends ProviderCallRef {
  /** A `wss:` URL (`ws:` only for an adapter in `local`) the provider streams to; built by the service, never from a user. */
  destinationUrl: string
}

/** What {@link TelephonyPort.forkTracks} reports. */
export interface ForkedTracks {
  /** The provider's id of the stream. */
  streamId: string
  /** The two tracks sent: the Rep's and the Prospect's, separately. */
  tracks: readonly ['rep', 'prospect']
}

/** Who asks to hang up. */
export interface HangUpRequest extends ProviderCallRef {
  /** Who ends the call, for the event that follows; default `system`. */
  by?: 'rep' | 'system'
}

/** Names a provider-side Recording. */
export interface RecordingRef {
  /** The Organization. */
  organizationId: OrganizationId
  /** The provider's id of the Recording, from {@link StartedRecording.recordingId}. */
  recordingId: string
}

/** A provider-side Recording, opened for reading. */
export interface FetchedRecording {
  /** The audio, two channels. The caller must read or cancel it. */
  body: ByteStream
  /** The media type, such as `audio/wav`. */
  contentType: string
  /** The size in bytes when the provider says it, otherwise null. */
  sizeBytes: number | null
  /** Always 2. */
  channels: 2
}

/** A webhook request as the provider sent it, to be checked before anything is read from it. */
export interface WebhookRequest {
  /** The full URL the provider called, as the provider saw it. */
  url: string
  /** The raw body, unparsed, at most {@link MAX_WEBHOOK_BODY_BYTES} bytes. */
  body: string
  /** The signature header, or null/undefined when the request had none. */
  signature: string | null | undefined
}

/** What {@link TelephonyPort.mintBrowserToken} is asked for. */
export interface BrowserTokenRequest {
  /** The Organization. */
  organizationId: OrganizationId
  /** The Rep the token is for: the only identity it carries besides the Organization. */
  identity: MembershipId
  /** How long it lives, in seconds, 60 to 3600; default 900. */
  ttlSeconds?: number
}

/** What a provider tells us about a call, in the shape every adapter's webhooks are turned into. */
export type TelephonyEventType =
  /** The Prospect's phone is ringing. */
  | 'ringing'
  /** The Prospect answered. */
  | 'answered'
  /** The Prospect did not answer. */
  | 'no_answer'
  /** The Prospect's line was busy. */
  | 'busy'
  /** The carrier or provider failed the call; `failureReason` says how. */
  | 'failed'
  /** The call ended after it was answered; `endedBy` says who. */
  | 'completed'
  /** The Recording is finished and can be fetched. */
  | 'recording_ready'

/** One thing that happened on a provider call. Carries no number, text or audio. */
export interface TelephonyEvent {
  /** The provider's id of this event: webhooks are idempotent by it. */
  eventId: string
  /** The Organization. */
  organizationId: OrganizationId
  /** The provider call. */
  providerCallId: string
  /** What happened. */
  type: TelephonyEventType
  /** When, as an ISO 8601 UTC time. */
  at: string
  /** With `failed` (and `no_answer`, `busy`): why, as the contract names it. */
  failureReason?: VoiceCallFailureReason
  /** With `completed`: who hung up. */
  endedBy?: 'rep' | 'prospect' | 'system'
  /** With `recording_ready`: the Recording. */
  recordingId?: string
}

/**
 * Telephony behind a vendor (Twilio first, ADR to follow), scoped by Organization. Every call
 * carries the Organization and reaches only that Organization's provider calls and Recordings; a
 * real adapter must tag each provider call with it. Every operation is bounded by a timeout
 * ({@link TelephonyOptions.timeoutMs}), every outbound request an adapter makes has its own
 * timeout and a bounded, jittered retry, and only `telephony.unavailable` is worth retrying after
 * that. Mutating operations are idempotent: repeating one leaves the same result.
 *
 * **The Disclosure cannot be skipped (ADR 0003).** There is no option, flag or setting that
 * skips the Disclosure or the Recording. An adapter refuses `bridge`, `startRecording` and
 * `forkTracks` on a call whose Disclosure has not played, with `telephony.disclosure_required`,
 * and `forkTracks` (audio to an AI) also needs a Disclosure that said so (`aiAssisted: true`).
 * Every recording has two channels. These checks are the adapter's second line of defence; the
 * voice service's state machine is the first.
 *
 * Nothing here logs, returns in an error or reports a phone number, a Disclosure text, a token, a
 * signature, a secret or audio. Provider events arrive as webhooks the service verifies with
 * {@link TelephonyPort.verifyWebhook} and turns into {@link TelephonyEvent}s.
 */
export interface TelephonyPort {
  /**
   * Places a call from a Line's number to a Prospect and returns at once with the provider's id;
   * progress arrives as events. Idempotent by `(organizationId, idempotencyKey)`; the same key
   * with another `to` or `from` is `telephony.invalid_request`. O(1).
   */
  placeCall(request: PlaceCallRequest, options?: TelephonyOptions): Promise<PlacedCall>
  /**
   * Answers an inbound call and rings the given browser legs. Repeating it for a call already
   * answered returns the same count. O(legs).
   */
  answerCall(request: AnswerCallRequest, options?: TelephonyOptions): Promise<AnsweredCall>
  /**
   * Plays the Disclosure into a connected call and resolves when it has finished playing. Nobody
   * else hears the call meanwhile. A call the Prospect has left is `telephony.call_ended`. Idempotent
   * per wording version: a Disclosure that has already played is reported again, not replayed. A
   * later version plays again and replaces the earlier one, including its `aiAssisted`.
   */
  playDisclosure(
    request: PlayDisclosureRequest,
    options?: TelephonyOptions
  ): Promise<DisclosurePlayed>
  /**
   * Joins a Rep's browser leg to the call, or moves the call to another Rep's leg. Needs a played
   * Disclosure. Repeating it for the same Rep changes nothing.
   */
  bridge(request: BridgeRequest, options?: TelephonyOptions): Promise<void>
  /**
   * Starts the dual-channel Recording (Prospect and Rep apart). Needs a played Disclosure. There is
   * no single-channel or unrecorded mode. Repeating it returns the first Recording.
   */
  startRecording(request: ProviderCallRef, options?: TelephonyOptions): Promise<StartedRecording>
  /**
   * Forks the call's two audio tracks, the Rep's and the Prospect's separately, to a socket
   * (used by the Copilot). Needs a played Disclosure that said an AI takes part. Repeating it
   * returns the first stream.
   */
  forkTracks(request: ForkTracksRequest, options?: TelephonyOptions): Promise<ForkedTracks>
  /** Ends the call. Idempotent: a call that has ended already resolves without error. */
  hangUp(request: HangUpRequest, options?: TelephonyOptions): Promise<void>
  /**
   * Opens the provider's copy of a Recording as a stream, once the call has ended and the Recording
   * is finished (before that, `telephony.recording_not_ready`). The timeout covers opening it. A
   * Recording deleted or never made is `telephony.not_found`. O(1) to open.
   */
  fetchRecording(request: RecordingRef, options?: TelephonyOptions): Promise<FetchedRecording>
  /**
   * Deletes the provider's copy of a Recording and resolves with whether it existed. Idempotent:
   * deleting again, or an id never issued, resolves with `existed: false`.
   */
  deleteRecording(request: RecordingRef, options?: TelephonyOptions): Promise<{ existed: boolean }>
  /**
   * Whether `request` really came from the provider, by its signature, compared in constant time.
   * A missing, malformed, wrong-length or wrong signature, or a body over
   * {@link MAX_WEBHOOK_BODY_BYTES}, is `false`; it never throws. It does no I/O (a local
   * computation on the body), so it needs no timeout and runs inside a webhook's budget. Check it
   * before reading anything from the body.
   */
  verifyWebhook(request: WebhookRequest): boolean
  /**
   * Mints a short-lived token the browser registers the Softphone with. It is issued for the Rep's
   * identity in the Organization (a real adapter binds both at the provider; the token text need
   * not show them), expires at `expiresAt`, and is a credential: never logged or
   * stored.
   */
  mintBrowserToken(
    request: BrowserTokenRequest,
    options?: TelephonyOptions
  ): Promise<SoftphoneToken>
}
