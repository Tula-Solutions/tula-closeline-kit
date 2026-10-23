import type { ContactCheckId, OrganizationId, ProspectId } from 'tula-closeline-contract'

/** The default overall deadline of one send, retries included, in milliseconds. */
export const DEFAULT_MESSAGING_TIMEOUT_MS = 10_000

/** The longest overall deadline a caller may allow, in milliseconds. */
export const MAX_MESSAGING_TIMEOUT_MS = 60_000

/** The most characters of a text message body (Twilio's limit). */
export const MAX_MESSAGE_BODY_CHARS = 1_600

/** The most variables one template message may carry. */
export const MAX_TEMPLATE_VARIABLES = 20

/** The most characters of one template variable value. */
export const MAX_TEMPLATE_VARIABLE_CHARS = 1_024

/** The most bytes of a webhook body {@link MessagingPort.receive} reads; a longer body is refused. */
export const MAX_MESSAGING_WEBHOOK_BYTES = 262_144

/** The channels a message can be sent on. */
export const MESSAGING_CHANNELS = ['sms', 'whatsapp'] as const

/** One of {@link MESSAGING_CHANNELS}. */
export type MessagingChannel = (typeof MESSAGING_CHANNELS)[number]

/** Why a message is sent; the Contact Check decides on it. A Rep's own message is not sent through this port. */
export const MESSAGING_PURPOSES = ['agent_initiated', 'reply'] as const

/** One of {@link MESSAGING_PURPOSES}. */
export type MessagingPurpose = (typeof MESSAGING_PURPOSES)[number]

/** How an adapter retries a retryable provider error (`messaging.unavailable`). */
export interface MessagingRetryPolicy {
  /** The most retries after the first attempt, 0 to 5; 0 never retries. Default 2. */
  maxRetries?: number
  /** The base of the pause before a retry, in ms, 1 to 60000; doubled each time and jittered. Default 200. */
  baseDelayMs?: number
  /** The longest pause before a retry, in ms, before jitter, at least the base and at most 60000. Default 2000. */
  maxDelayMs?: number
}

/** The retry policy with its defaults filled in. */
export interface ResolvedMessagingRetryPolicy {
  /** The most retries after the first attempt. */
  maxRetries: number
  /** The base pause, in ms. */
  baseDelayMs: number
  /** The longest pause before jitter, in ms. */
  maxDelayMs: number
}

/** The policy used when a request names none: two retries after about 200 ms and 400 ms. */
export const DEFAULT_MESSAGING_RETRY_POLICY: ResolvedMessagingRetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 200,
  maxDelayMs: 2_000,
}

/**
 * The pause before retry `retry` (from 1): the base doubled each time up to the maximum, then
 * scaled by a jitter between 0.5 and 1.5 from `random()` (a number in `[0, 1)`).
 */
export function messagingRetryDelayMs(
  retry: number,
  policy: ResolvedMessagingRetryPolicy,
  random: () => number = Math.random
): number {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (retry - 1))
  return Math.max(1, Math.floor(exponential * (0.5 + random())))
}

/** What a message says: free text, or an approved template (WhatsApp only). */
export type MessageContent =
  | {
      /** Free text. */
      kind: 'text'
      /** The text, 1 to {@link MAX_MESSAGE_BODY_CHARS} characters. Tenant data: never logged. */
      body: string
    }
  | {
      /** An approved template; the only way to start a WhatsApp conversation outside the 24 hour window. */
      kind: 'template'
      /** The template's Twilio Content SID: `HX` and 32 hex digits. */
      templateId: string
      /** The template's variables by name or position, at most {@link MAX_TEMPLATE_VARIABLES}. Tenant data: never logged. */
      variables?: Readonly<Record<string, string>>
    }

/**
 * One message to send. There is no field that skips or replaces the Contact Check: the adapter
 * asks its `ContactGuard` about (`organizationId`, `prospectId`, `channel`, `purpose`) on every
 * call, and an unknown field is refused. `to` must be the number the Prospect gave for this
 * channel, read from the Prospect `prospectId` names; the kit cannot check that they match.
 */
export interface SendMessageRequest {
  /** The Organization the message is sent for. */
  organizationId: OrganizationId
  /** The Prospect the message is for; the Contact Check is about this Prospect. */
  prospectId: ProspectId
  /** SMS or WhatsApp. */
  channel: MessagingChannel
  /** Why it is sent. */
  purpose: MessagingPurpose
  /** The recipient's number, E.164. Never logged. */
  to: string
  /** What to say. */
  content: MessageContent
  /**
   * Makes a retry, or a repeat of this call, send one message only: 1 to 200 characters of
   * `A-Z a-z 0-9 _ . : -`, unique per message you mean to send. The Twilio adapter sends a keyed
   * hash of it (with the Organization) as `I-Twilio-Idempotency-Token`; the memory adapter
   * returns the first result for a repeat and refuses the same key with other content.
   */
  idempotencyKey: string
  /** The most time the whole send may take, retries included, in ms, 1 to 60000; default 10000. */
  timeoutMs?: number
  /** Retries of `messaging.unavailable`; the defaults when absent. */
  retry?: MessagingRetryPolicy
  /** The caller's own cancellation. When it fires the provider request is aborted and the send fails with `messaging.aborted`. */
  signal?: AbortSignal
}

/** What a send returns: the provider accepted the message. Delivery is reported later as a status event. */
export interface SentMessage {
  /** The id of the Contact Check that allowed this message: the proof of consent (ADR 0003). */
  consentCheckId: ContactCheckId
  /** The provider's id for the message; a status event names the same id. */
  providerMessageId: string
  /** The channel it went on. */
  channel: MessagingChannel
  /** `queued` when the provider has taken it, `sent` when it has already left the provider. */
  status: 'queued' | 'sent'
  /** The key the send was made with. */
  idempotencyKey: string
}

/** What a recipient's text means to the sender, from Twilio's standard English keywords. */
export type MessageIntent = 'stop' | 'start' | 'help' | 'message'

/** The fields of an {@link InboundMessage}. */
export interface InboundMessageFields {
  /** The channel it arrived on. */
  channel: MessagingChannel
  /** The sender's number, E.164 (any `whatsapp:` prefix removed). */
  from: string
  /** Our number, E.164. */
  to: string
  /** The provider's id for the message. */
  providerMessageId: string
  /** The text. May be empty when only media was sent. */
  body: string
  /** When the adapter received it, ISO 8601. */
  receivedAt: string
  /** What the text means; see {@link classifyMessageIntent}. */
  intent: MessageIntent
  /** How many media items came with it (they are not fetched). */
  mediaCount: number
}

const INSPECT = Symbol.for('nodejs.util.inspect.custom')

/**
 * A message the recipient sent. Its `body`, `from` and `to` are tenant data: they are read
 * properties of the class (not own enumerable ones), so `String()`, `JSON.stringify`, a spread
 * and `util.inspect` show the channel, intent and id, and the length of the text, never the text
 * or the numbers.
 */
export class InboundMessage {
  readonly kind = 'message' as const
  readonly channel: MessagingChannel
  readonly providerMessageId: string
  readonly receivedAt: string
  readonly intent: MessageIntent
  readonly mediaCount: number
  readonly #from: string
  readonly #to: string
  readonly #body: string

  constructor(fields: InboundMessageFields) {
    this.channel = fields.channel
    this.providerMessageId = fields.providerMessageId
    this.receivedAt = fields.receivedAt
    this.intent = fields.intent
    this.mediaCount = fields.mediaCount
    this.#from = fields.from
    this.#to = fields.to
    this.#body = fields.body
  }

  /** The sender's number, E.164. */
  get from(): string {
    return this.#from
  }

  /** Our number, E.164. */
  get to(): string {
    return this.#to
  }

  /** The text the recipient sent. */
  get body(): string {
    return this.#body
  }

  /** The metadata for `JSON.stringify`: no text and no numbers. */
  toJSON(): Record<string, unknown> {
    return {
      kind: this.kind,
      channel: this.channel,
      providerMessageId: this.providerMessageId,
      receivedAt: this.receivedAt,
      intent: this.intent,
      mediaCount: this.mediaCount,
      bodyChars: this.#body.length,
    }
  }

  /** A readable label without the text or the numbers. */
  toString(): string {
    return `InboundMessage(${this.channel}, ${this.intent}, ${this.#body.length} chars)`
  }

  /** The console and `util.inspect` form, without the text or the numbers. */
  [INSPECT](): string {
    return this.toString()
  }
}

/** The state of a message the provider reports on. */
export type MessageDeliveryStatus =
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'undelivered'
  | 'failed'
  | 'read'

/** The provider reporting how a message it took is doing. Carries no text and no numbers. */
export interface StatusEvent {
  /** Tells a status event from a message. */
  kind: 'status'
  /** The id a send returned. */
  providerMessageId: string
  /** The state. */
  status: MessageDeliveryStatus
  /** The provider's numeric error code, present on `failed` and `undelivered`. */
  errorCode?: number
}

/** What a verified webhook carries: a message from a recipient, or a status report. */
export type InboundEvent = InboundMessage | StatusEvent

/** A webhook as the HTTP route received it. */
export interface MessagingWebhookRequest {
  /** The full URL the provider called, as the provider saw it (a proxy may have rewritten it). */
  url: string
  /** The `X-Twilio-Signature` header, or null/undefined when the request had none. */
  signature: string | null | undefined
  /** The raw form body, unparsed, at most {@link MAX_MESSAGING_WEBHOOK_BYTES} bytes. */
  body: string
  /** The `Content-Type` header, when known; if given it must be a form. */
  contentType?: string | null | undefined
}

/**
 * SMS and WhatsApp messaging behind a vendor (Twilio first), with the consent proof built in.
 *
 * **Consent (ADR 0003).** Every adapter is built with a `ContactGuard` and has no way to run
 * without one. `send` asks it first, every time; only `allowed: true` lets a request reach the
 * vendor. Any denial, including `consent.unavailable`, throws `messaging.consent_denied` with the
 * `consent.*` code in `details.code`, and the vendor is not called. A sent message returns the
 * check's id as `consentCheckId`.
 *
 * **STOP.** `receive` reports a recipient's STOP as an `InboundMessage` with `intent: 'stop'`
 * (the whole text, trimmed and case-insensitive, is one of Twilio's keywords). The port does not
 * revoke consent, because the kit has no way to write to core: the consumer must withdraw the
 * Prospect's consent through core when it sees `intent: 'stop'`. Twilio also blocks further sends
 * to that number by itself, which shows as `messaging.recipient_opted_out`.
 *
 * Every send has an overall deadline that aborts the vendor request. `messaging.unavailable` is
 * retried with a bounded, jittered pause and the same idempotency key, so a retry never texts
 * twice. `rejected`, `unavailable` and `bad_response` are also given to the ErrorReporter
 * (metadata only). The message text, the numbers and the credentials are tenant data or secrets:
 * they are never logged, reported or put in an error.
 *
 * Webhooks can arrive more than once: the consumer must handle them idempotently, keyed on
 * `providerMessageId` (with the status for a status event).
 */
export interface MessagingPort {
  /**
   * Sends one message once the Contact Check allows it. An unacceptable request throws
   * `messaging.invalid_request` and a denial `messaging.consent_denied`; neither reaches the vendor.
   */
  send(request: SendMessageRequest): Promise<SentMessage>
  /**
   * Verifies a webhook by its signature, in constant time, and parses it. A missing or wrong
   * signature, a body over {@link MAX_MESSAGING_WEBHOOK_BYTES}, a body that is not a form or not a
   * message or status event, is `messaging.webhook_invalid`. Verify before using anything in it.
   */
  receive(request: MessagingWebhookRequest): Promise<InboundEvent>
}
