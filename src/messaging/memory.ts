import { createHash, randomBytes } from 'node:crypto'
import type { OrganizationId } from 'tula-closeline-contract'
import { type Clock, systemClock } from '../clock'
import type { ContactGuard } from '../consent/port'
import type { Logger } from '../logger'
import { type Sleep, systemSleep } from '../queue/sleep'
import type { ErrorReporter } from '../reporting/port'
import { signTwilioRequest } from '../twilio-signature'
import { requireConsent } from './consent'
import { AttemptAborted, raceAbort, startMessagingDeadline, withMessagingRetry } from './deadline'
import { isReportableMessagingError, MessagingError } from './errors'
import type {
  InboundEvent,
  MessageDeliveryStatus,
  MessagingChannel,
  MessagingPort,
  MessagingWebhookRequest,
  SendMessageRequest,
  SentMessage,
} from './port'
import { checkSendRequest, invalid } from './validate'
import { verifyAndParseWebhook } from './webhook'

/** The Auth Token the memory adapter signs and verifies webhooks with. Public, for tests only. */
export const MEMORY_MESSAGING_AUTH_TOKEN = 'memory-messaging-auth-token-0123456789'

/** The URL the memory adapter's webhook builders sign for. */
export const MEMORY_MESSAGING_WEBHOOK_URL = 'https://messaging.memory.test/webhooks/messaging'

/** The codes the vendor can be made to fail with. */
export type ScriptedMessagingFailure =
  | 'messaging.unavailable'
  | 'messaging.rejected'
  | 'messaging.bad_response'
  | 'messaging.recipient_opted_out'
  | 'messaging.template_required'

/** What a test sees of one vendor request (never the text, the number or the template variables). */
export interface MemoryMessagingRequestView {
  /** The Organization. */
  organizationId: OrganizationId
  /** The channel. */
  channel: MessagingChannel
  /** Text or template. */
  contentKind: 'text' | 'template'
  /** The characters of a text body; 0 for a template. */
  bodyChars: number
  /** True once the request's AbortSignal fired while it was still pending. */
  aborted: boolean
  /** How it ended. */
  outcome: 'pending' | 'ok' | 'failed' | 'aborted'
}

/** Options for {@link createMemoryMessaging}. */
export interface MemoryMessagingOptions {
  /** The Contact Check every send asks first. Required: there is no adapter without one (ADR 0003). */
  guard: ContactGuard
  /** Receives the errors that mean the vendor failed; nothing if absent. */
  reporter?: ErrorReporter
  /** Where retries are noted (metadata only); nothing if absent. */
  logger?: Logger
  /** The time source for `receivedAt`; the system clock by default. */
  clock?: Clock
  /** Pauses between retries; real time by default. */
  sleep?: Sleep
  /** A number in `[0, 1)` for the jitter; `Math.random` by default. */
  random?: () => number
}

/** The fields of a message the memory adapter builds a signed webhook for. */
export interface MemoryInboundFields {
  /** The sender's number, E.164. */
  from: string
  /** Our number, E.164. */
  to: string
  /** The text. */
  body: string
  /** SMS unless said otherwise. */
  channel?: MessagingChannel
  /** How many media items came with it; default 0. */
  mediaCount?: number
  /** The provider message id; a new one by default. */
  providerMessageId?: string
}

/** A {@link MessagingPort} that keeps everything in the process, for tests. Not for production. */
export interface MemoryMessaging extends MessagingPort {
  /** Makes the next `times` (default 1) vendor requests fail with `code`. */
  failNext(code: ScriptedMessagingFailure, times?: number): void
  /** Makes the next vendor request never answer; it ends only when aborted or timed out. */
  hangNext(times?: number): void
  /** Every vendor request so far, in order; a retry is a request of its own. Metadata only. */
  requests(): MemoryMessagingRequestView[]
  /** The text bodies of the messages sent so far, in order. For asserting content in a test only. */
  sentBodies(): string[]
  /** A valid, signed inbound message webhook. */
  inbound(fields: MemoryInboundFields): MessagingWebhookRequest
  /** A valid, signed status webhook. */
  status(fields: {
    providerMessageId: string
    status: MessageDeliveryStatus
    errorCode?: number
  }): MessagingWebhookRequest
  /** A signed webhook over arbitrary form fields. */
  signedWebhook(fields: Readonly<Record<string, string>>): MessagingWebhookRequest
}

interface Stored {
  fingerprint: string
  result: Promise<SentMessage>
}

function newSid(prefix: 'SM' | 'MM'): string {
  return `${prefix}${randomBytes(16).toString('hex')}`
}

function failure(code: ScriptedMessagingFailure): MessagingError {
  switch (code) {
    case 'messaging.unavailable':
      return new MessagingError(code, 'The messaging provider is unavailable', {
        details: { status: 503 },
      })
    case 'messaging.rejected':
      return new MessagingError(code, 'The messaging provider refused the request', {
        details: { status: 400 },
      })
    case 'messaging.bad_response':
      return new MessagingError(code, 'The messaging provider sent an unusable answer')
    case 'messaging.recipient_opted_out':
      return new MessagingError(code, 'The recipient has opted out of this sender', {
        details: { twilioCode: 21610 },
      })
    case 'messaging.template_required':
      return new MessagingError(code, 'Only a template can start this conversation', {
        details: { twilioCode: 63016 },
      })
  }
}

/**
 * Creates the in-process {@link MessagingPort}. It checks consent through `guard` exactly as the
 * Twilio adapter does, dedupes on the idempotency key per Organization, and keeps message text
 * only for `sentBodies()`; no log line, report, error or inspect form holds it. Not for production.
 */
export function createMemoryMessaging(options: MemoryMessagingOptions): MemoryMessaging {
  const sleep = options.sleep ?? systemSleep
  const clock = options.clock ?? systemClock
  const views: MemoryMessagingRequestView[] = []
  const bodies: string[] = []
  const script: ({ kind: 'fail'; code: ScriptedMessagingFailure } | { kind: 'hang' })[] = []
  const stored = new Map<string, Stored>()

  function report(error: unknown, organizationId: OrganizationId): void {
    if (!isReportableMessagingError(error)) {
      return
    }
    try {
      options.reporter?.capture(error, { organizationId, tags: { feature: 'messaging' } })
    } catch {
      // reporting must never change the outcome of a send
    }
  }

  async function vendor(
    request: ReturnType<typeof checkSendRequest>,
    signal: AbortSignal
  ): Promise<{ providerMessageId: string }> {
    const view: MemoryMessagingRequestView = {
      organizationId: request.organizationId,
      channel: request.channel,
      contentKind: request.content.kind,
      bodyChars: request.content.kind === 'text' ? request.content.body.length : 0,
      aborted: false,
      outcome: 'pending',
    }
    views.push(view)
    const next = script.shift()
    try {
      if (next?.kind === 'hang') {
        await raceAbort(new Promise<never>(() => undefined), signal)
      }
      if (next?.kind === 'fail') {
        throw failure(next.code)
      }
      if (signal.aborted) {
        throw new AttemptAborted()
      }
      view.outcome = 'ok'
      if (request.content.kind === 'text') {
        bodies.push(request.content.body)
      }
      return { providerMessageId: newSid('SM') }
    } catch (error) {
      if (error instanceof AttemptAborted) {
        view.aborted = true
        view.outcome = 'aborted'
      } else {
        view.outcome = 'failed'
      }
      throw error
    }
  }

  return {
    failNext(code, times = 1) {
      for (let i = 0; i < times; i++) {
        script.push({ kind: 'fail', code })
      }
    },
    hangNext(times = 1) {
      for (let i = 0; i < times; i++) {
        script.push({ kind: 'hang' })
      }
    },
    requests() {
      return views.map((view) => ({ ...view }))
    },
    sentBodies() {
      return [...bodies]
    },
    inbound(fields) {
      const channel = fields.channel ?? 'sms'
      const prefix = channel === 'whatsapp' ? 'whatsapp:' : ''
      return this.signedWebhook({
        MessageSid: fields.providerMessageId ?? newSid('SM'),
        From: `${prefix}${fields.from}`,
        To: `${prefix}${fields.to}`,
        Body: fields.body,
        NumMedia: String(fields.mediaCount ?? 0),
      })
    },
    status(fields) {
      return this.signedWebhook({
        MessageSid: fields.providerMessageId,
        MessageStatus: fields.status,
        ...(fields.errorCode === undefined ? {} : { ErrorCode: String(fields.errorCode) }),
      })
    },
    signedWebhook(fields) {
      const body = new URLSearchParams(fields).toString()
      return {
        url: MEMORY_MESSAGING_WEBHOOK_URL,
        signature: signTwilioRequest(
          MEMORY_MESSAGING_AUTH_TOKEN,
          MEMORY_MESSAGING_WEBHOOK_URL,
          fields
        ),
        body,
        contentType: 'application/x-www-form-urlencoded',
      }
    },
    async receive(request): Promise<InboundEvent> {
      return verifyAndParseWebhook(request, MEMORY_MESSAGING_AUTH_TOKEN, clock)
    },
    async send(request: SendMessageRequest): Promise<SentMessage> {
      const checked = checkSendRequest(request)
      const deadline = startMessagingDeadline(checked.timeoutMs, checked.signal)
      try {
        const { consentCheckId, numberConsentCheckId } = await requireConsent(
          options.guard,
          checked,
          deadline
        )
        const fingerprint = createHash('sha256')
          .update(
            JSON.stringify([
              checked.prospectId,
              checked.channel,
              checked.purpose,
              checked.to,
              checked.content,
            ])
          )
          .digest('hex')
        const key = `${checked.organizationId}|${checked.idempotencyKey}`
        const existing = stored.get(key)
        if (existing !== undefined) {
          if (existing.fingerprint !== fingerprint) {
            return invalid('idempotencyKey')
          }
          return existing.result
        }
        const result = (async (): Promise<SentMessage> => {
          try {
            const answer = await withMessagingRetry(
              async () => {
                try {
                  return await vendor(checked, deadline.signal)
                } catch (error) {
                  if (error instanceof AttemptAborted) {
                    deadline.check()
                  }
                  throw error
                }
              },
              {
                policy: checked.retry,
                deadline,
                sleep,
                ...(options.random === undefined ? {} : { random: options.random }),
                onRetry: (retry, delayMs) =>
                  options.logger?.warn('Messaging send retried', {
                    feature: 'messaging',
                    channel: checked.channel,
                    retry,
                    delayMs,
                  }),
              }
            )
            return {
              consentCheckId,
              numberConsentCheckId,
              providerMessageId: answer.providerMessageId,
              channel: checked.channel,
              status: 'queued',
              idempotencyKey: checked.idempotencyKey,
            }
          } catch (error) {
            report(error, checked.organizationId)
            throw error
          }
        })()
        stored.set(key, { fingerprint, result })
        try {
          return await result
        } catch (error) {
          stored.delete(key)
          throw error
        }
      } finally {
        deadline.stop()
      }
    },
  }
}
