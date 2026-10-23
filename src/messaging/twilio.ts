import { createHash } from 'node:crypto'
import { e164PhoneSchema } from 'tula-closeline-contract'
import { type Clock, systemClock } from '../clock'
import type { ContactGuard } from '../consent/port'
import type { Logger } from '../logger'
import { type Sleep, systemSleep } from '../queue/sleep'
import type { ErrorReporter } from '../reporting/port'
import { type TwilioRegion, twilioApiHost } from '../telephony/twilio'
import type { TwilioFetch } from '../telephony/twilio-http'
import { requireConsent } from './consent'
import { AttemptAborted, raceAbort, startMessagingDeadline, withMessagingRetry } from './deadline'
import { isReportableMessagingError, MESSAGING_ERROR_CODES, MessagingError } from './errors'
import type { MessagingPort, SendMessageRequest, SentMessage } from './port'
import { type CheckedSendRequest, checkSendRequest, invalid } from './validate'
import { verifyAndParseWebhook } from './webhook'

const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/
const SERVICE_SID = /^MG[0-9a-fA-F]{32}$/
const MESSAGE_SID = /^(SM|MM)[0-9a-fA-F]{32}$/
const MAX_RESPONSE_BYTES = 65_536
const DEFAULT_ATTEMPT_TIMEOUT_MS = 5_000
const OPTED_OUT = 21610
const TEMPLATE_REQUIRED = 63016
const QUEUED = new Set(['queued', 'accepted', 'scheduled', 'sending'])
const SENT = new Set(['sent', 'delivered'])

/** Options for {@link createTwilioMessaging}. The kit takes options, not environment variables. */
export interface TwilioMessagingOptions {
  /** The Account SID (`AC` and 32 hex digits). */
  accountSid: string
  /** The Auth Token, at least 16 characters: signs the REST calls and verifies webhooks. Never logged. */
  authToken: string
  /** The Contact Check every send asks first. Required: there is no adapter without one (ADR 0003). */
  guard: ContactGuard
  /** The Messaging Service SID (`MG` and 32 hex digits) SMS goes through; or give `fromNumber`, not both. */
  messagingServiceSid?: string
  /** The number SMS is sent from, E.164; or give `messagingServiceSid`, not both. */
  fromNumber?: string
  /** The approved WhatsApp sender, E.164 without the `whatsapp:` prefix. WhatsApp falls back to `messagingServiceSid`. */
  whatsappFrom?: string
  /** An https URL Twilio reports delivery status to, without credentials. */
  statusCallbackUrl?: string
  /** Twilio region for data residency; the global host if absent. */
  region?: TwilioRegion
  /** Twilio edge, with `region`. */
  edge?: string
  /** The HTTP client; the global `fetch` by default. For tests. */
  fetch?: TwilioFetch
  /** The time limit of one HTTP attempt, in ms, 1 to 60000; default 5000. The send's own deadline still applies. */
  attemptTimeoutMs?: number
  /** Receives the errors that mean the provider failed; nothing if absent. */
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

function unavailable(phase: string, status?: number): MessagingError {
  return new MessagingError(
    MESSAGING_ERROR_CODES.unavailable,
    'The messaging provider is unavailable',
    {
      details: { phase, ...(status === undefined ? {} : { status }) },
    }
  )
}

function badResponse(reason: string, status?: number): MessagingError {
  return new MessagingError(
    MESSAGING_ERROR_CODES.badResponse,
    'The messaging provider sent an unusable answer',
    { details: { reason, ...(status === undefined ? {} : { status }) } }
  )
}

async function readBounded(response: Response): Promise<string> {
  const body = response.body
  if (body === null) {
    return ''
  }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    total += value.byteLength
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw badResponse('too_large')
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function fail4xx(status: number, json: Record<string, unknown> | null): MessagingError {
  const rawCode = json?.code
  const twilioCode = typeof rawCode === 'number' && Number.isInteger(rawCode) ? rawCode : undefined
  if (twilioCode === OPTED_OUT) {
    return new MessagingError(
      MESSAGING_ERROR_CODES.recipientOptedOut,
      'The recipient has opted out of this sender',
      { details: { status, twilioCode } }
    )
  }
  if (twilioCode === TEMPLATE_REQUIRED) {
    return new MessagingError(
      MESSAGING_ERROR_CODES.templateRequired,
      'Only a template can start this conversation',
      { details: { status, twilioCode } }
    )
  }
  return new MessagingError(
    MESSAGING_ERROR_CODES.rejected,
    'The messaging provider refused the request',
    { details: { status, ...(twilioCode === undefined ? {} : { twilioCode }) } }
  )
}

/**
 * Creates the {@link MessagingPort} on Twilio's Programmable Messaging REST API (SMS and WhatsApp).
 *
 * Every send asks the `guard` first and reaches Twilio only when it allows. Each attempt has its
 * own time limit and the whole send an overall deadline that aborts the request; a network error,
 * 429 and 5xx are retried a bounded number of times with jitter and the same
 * `I-Twilio-Idempotency-Token`, any other 4xx never. Twilio's 21610 (the recipient texted STOP) is
 * `messaging.recipient_opted_out` and 63016 (a WhatsApp free-form message outside the 24 hour
 * window) `messaging.template_required`. Nothing is logged but retry metadata, and no message
 * text, number, URL, signature or credential is put in an error, a log line or a report.
 */
export function createTwilioMessaging(options: TwilioMessagingOptions): MessagingPort {
  if (typeof options.accountSid !== 'string' || !ACCOUNT_SID.test(options.accountSid)) {
    throw new TypeError('accountSid is not an Account SID')
  }
  if (typeof options.authToken !== 'string' || options.authToken.length < 16) {
    throw new TypeError('authToken must be at least 16 characters')
  }
  if (options.guard === undefined || typeof options.guard.check !== 'function') {
    throw new TypeError('a ContactGuard is required')
  }
  if (options.messagingServiceSid !== undefined && !SERVICE_SID.test(options.messagingServiceSid)) {
    throw new TypeError('messagingServiceSid is not a Messaging Service SID')
  }
  for (const number of [options.fromNumber, options.whatsappFrom]) {
    if (number !== undefined && !e164PhoneSchema.safeParse(number).success) {
      throw new TypeError('a sender number is not E.164')
    }
  }
  if (options.messagingServiceSid !== undefined && options.fromNumber !== undefined) {
    throw new TypeError('give messagingServiceSid or fromNumber, not both')
  }
  if (options.statusCallbackUrl !== undefined) {
    let parsed: URL
    try {
      parsed = new URL(options.statusCallbackUrl)
    } catch {
      throw new TypeError('statusCallbackUrl is not a URL')
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      throw new TypeError('statusCallbackUrl must be https without credentials')
    }
  }
  const attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS
  if (!Number.isInteger(attemptTimeoutMs) || attemptTimeoutMs < 1 || attemptTimeoutMs > 60_000) {
    throw new TypeError('attemptTimeoutMs must be 1 to 60000')
  }

  const { accountSid, authToken, guard } = options
  const clock = options.clock ?? systemClock
  const sleep = options.sleep ?? systemSleep
  const doFetch: TwilioFetch = options.fetch ?? ((input, init) => fetch(input, init))
  const url = `https://${twilioApiHost(options.region, options.edge)}/2010-04-01/Accounts/${accountSid}/Messages.json`
  const authorization = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`

  function form(request: CheckedSendRequest): URLSearchParams {
    const whatsapp = request.channel === 'whatsapp'
    const params = new URLSearchParams()
    params.set('To', whatsapp ? `whatsapp:${request.to}` : request.to)
    if (whatsapp && options.whatsappFrom !== undefined) {
      params.set('From', `whatsapp:${options.whatsappFrom}`)
    } else if (options.messagingServiceSid !== undefined) {
      params.set('MessagingServiceSid', options.messagingServiceSid)
    } else if (!whatsapp && options.fromNumber !== undefined) {
      params.set('From', options.fromNumber)
    } else {
      invalid('channel')
    }
    if (request.content.kind === 'text') {
      params.set('Body', request.content.body)
    } else {
      params.set('ContentSid', request.content.templateId)
      if (request.content.variables !== undefined) {
        params.set('ContentVariables', JSON.stringify(request.content.variables))
      }
    }
    if (options.statusCallbackUrl !== undefined) {
      params.set('StatusCallback', options.statusCallbackUrl)
    }
    return params
  }

  function idempotencyToken(request: CheckedSendRequest): string {
    return createHash('sha256')
      .update([accountSid, request.organizationId, request.idempotencyKey].join('\u0000'))
      .digest('hex')
  }

  async function attempt(
    params: string,
    token: string,
    overall: AbortSignal
  ): Promise<{ providerMessageId: string; status: 'queued' | 'sent' }> {
    const own = new AbortController()
    let attemptTimedOut = false
    const timer = setTimeout(() => {
      attemptTimedOut = true
      own.abort()
    }, attemptTimeoutMs)
    timer.unref?.()
    const signal = AbortSignal.any([overall, own.signal])
    try {
      const response = await raceAbort(
        doFetch(url, {
          method: 'POST',
          redirect: 'manual',
          signal,
          headers: {
            authorization,
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
            'i-twilio-idempotency-token': token,
          },
          body: params,
        }),
        signal
      )
      const status = response.status
      const text = await raceAbort(readBounded(response), signal)
      if (status === 429 || status >= 500) {
        throw unavailable('http', status)
      }
      if (status >= 400) {
        throw fail4xx(status, parseJson(text))
      }
      if (status < 200 || status >= 300) {
        throw badResponse('status', status)
      }
      const json = parseJson(text)
      const sid = json?.sid
      const state = json?.status
      if (typeof sid !== 'string' || !MESSAGE_SID.test(sid) || typeof state !== 'string') {
        throw badResponse('shape', status)
      }
      if (QUEUED.has(state)) {
        return { providerMessageId: sid, status: 'queued' }
      }
      if (SENT.has(state)) {
        return { providerMessageId: sid, status: 'sent' }
      }
      throw badResponse('state', status)
    } catch (error) {
      if (error instanceof MessagingError) {
        throw error
      }
      if (error instanceof AttemptAborted && !attemptTimedOut) {
        // the overall deadline or the caller; the retry loop's check turns this into timeout/aborted
        throw error
      }
      throw unavailable(attemptTimedOut ? 'attempt_timeout' : 'network')
    } finally {
      clearTimeout(timer)
    }
  }

  function report(error: unknown, request: CheckedSendRequest): void {
    if (!isReportableMessagingError(error)) {
      return
    }
    try {
      options.reporter?.capture(error, {
        organizationId: request.organizationId,
        tags: { feature: 'messaging' },
      })
    } catch {
      // reporting must never change the outcome of a send
    }
  }

  return {
    async send(request: SendMessageRequest): Promise<SentMessage> {
      const checked = checkSendRequest(request)
      const body = form(checked)
      const consentCheckId = await requireConsent(guard, checked)
      const token = idempotencyToken(checked)
      const text = body.toString()
      const deadline = startMessagingDeadline(checked.timeoutMs, checked.signal)
      try {
        const answer = await withMessagingRetry(
          async () => {
            try {
              return await attempt(text, token, deadline.signal)
            } catch (error) {
              if (error instanceof AttemptAborted) {
                deadline.check()
                throw unavailable('attempt_timeout')
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
          providerMessageId: answer.providerMessageId,
          channel: checked.channel,
          status: answer.status,
          idempotencyKey: checked.idempotencyKey,
        }
      } catch (error) {
        report(error, checked)
        throw error
      } finally {
        deadline.stop()
      }
    },
    async receive(request) {
      return verifyAndParseWebhook(request, authToken, clock)
    },
  }
}
