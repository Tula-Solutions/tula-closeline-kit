import { e164PhoneSchema } from 'tula-closeline-contract'
import type { Clock } from '../clock'
import { verifyTwilioFormSignature } from '../twilio-signature'
import { MESSAGING_ERROR_CODES, MessagingError } from './errors'
import {
  type InboundEvent,
  InboundMessage,
  MAX_MESSAGING_WEBHOOK_BYTES,
  type MessageDeliveryStatus,
  type MessageIntent,
  type MessagingChannel,
  type MessagingWebhookRequest,
} from './port'

const STOP = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'])
const START = new Set(['START', 'UNSTOP', 'YES'])
const HELP = new Set(['HELP', 'INFO'])
const MESSAGE_SID = /^(SM|MM)[0-9a-fA-F]{32}$/
const FORM = /^application\/x-www-form-urlencoded(\s*;.*)?$/i
const MAX_INBOUND_BODY_CHARS = 4_096
const MAX_MEDIA = 10

const STATUS: Record<string, MessageDeliveryStatus> = {
  queued: 'queued',
  accepted: 'queued',
  scheduled: 'queued',
  sending: 'queued',
  sent: 'sent',
  delivered: 'delivered',
  undelivered: 'undelivered',
  failed: 'failed',
  canceled: 'failed',
  read: 'read',
}

const NOT_LETTER = /[^\p{L}\p{N}]+/gu

/**
 * What a recipient's text means, from Twilio's standard English keywords: the whole text, ignoring
 * case, spaces, punctuation, emoji and invisible characters, so "Stop.", "stop!" and "STOP ALL"
 * all opt out. STOP, STOPALL, UNSUBSCRIBE, CANCEL, END and QUIT opt out; START, UNSTOP and YES opt
 * back in; HELP and INFO ask for help. A sentence that merely contains one is a message. It fails
 * toward opting out. `start` is only a hint: it must never re-grant consent without the consent
 * flow, and only plain ASCII letters count for it and for `help`.
 */
export function classifyMessageIntent(body: string): MessageIntent {
  const letters = body.replace(NOT_LETTER, '')
  const word = letters.toUpperCase()
  if (STOP.has(word)) {
    return 'stop'
  }
  const ascii = /^[A-Za-z]+$/.test(letters)
  if (ascii && START.has(word)) {
    return 'start'
  }
  if (ascii && HELP.has(word)) {
    return 'help'
  }
  return 'message'
}

function bad(reason: string): never {
  throw new MessagingError(MESSAGING_ERROR_CODES.webhookInvalid, 'The webhook is not valid', {
    details: { reason },
  })
}

function address(value: string | undefined): { channel: MessagingChannel; number: string } {
  if (value === undefined) {
    return bad('address')
  }
  const whatsapp = value.startsWith('whatsapp:')
  const number = whatsapp ? value.slice('whatsapp:'.length) : value
  if (!e164PhoneSchema.safeParse(number).success) {
    return bad('address')
  }
  return { channel: whatsapp ? 'whatsapp' : 'sms', number }
}

/**
 * Verifies a Twilio webhook (HMAC-SHA1 over the URL and form fields, constant time) and parses
 * it into a message or a status event. Without an `authToken` it always fails. Every failure is
 * `messaging.webhook_invalid` with a reason code and nothing from the request.
 */
export function verifyAndParseWebhook(
  request: MessagingWebhookRequest,
  authToken: string | undefined,
  clock: Clock
): InboundEvent {
  if (typeof request !== 'object' || request === null) {
    return bad('request')
  }
  if (authToken === undefined || authToken === '') {
    return bad('unconfigured')
  }
  if (typeof request.body !== 'string' || typeof request.url !== 'string') {
    return bad('request')
  }
  if (Buffer.byteLength(request.body, 'utf8') > MAX_MESSAGING_WEBHOOK_BYTES) {
    return bad('body_too_large')
  }
  if (
    request.contentType !== undefined &&
    request.contentType !== null &&
    !FORM.test(request.contentType)
  ) {
    return bad('content_type')
  }
  const signature = request.signature
  if (typeof signature !== 'string' || signature === '' || signature.length > 200) {
    return bad('signature')
  }
  const fields = [...new URLSearchParams(request.body)]
  if (!verifyTwilioFormSignature(authToken, request.url, fields, signature)) {
    return bad('signature')
  }
  const first = new Map<string, string>()
  for (const [name, value] of fields) {
    if (!first.has(name)) {
      first.set(name, value)
    }
  }
  const sid = first.get('MessageSid') ?? first.get('SmsSid')
  if (sid === undefined || !MESSAGE_SID.test(sid)) {
    return bad('message_sid')
  }
  const body = first.get('Body')
  if (body !== undefined) {
    const from = address(first.get('From'))
    const to = address(first.get('To'))
    if (body.length > MAX_INBOUND_BODY_CHARS) {
      return bad('body')
    }
    const media = Number(first.get('NumMedia') ?? '0')
    if (!Number.isInteger(media) || media < 0 || media > MAX_MEDIA) {
      return bad('num_media')
    }
    return new InboundMessage({
      channel: from.channel,
      from: from.number,
      to: to.number,
      providerMessageId: sid,
      body,
      receivedAt: clock.now().toISOString(),
      intent: classifyMessageIntent(body),
      mediaCount: media,
    })
  }
  const state = STATUS[(first.get('MessageStatus') ?? first.get('SmsStatus') ?? '').toLowerCase()]
  if (state === undefined) {
    return bad('status')
  }
  const rawCode = first.get('ErrorCode')
  if (rawCode === undefined || rawCode === '') {
    return { kind: 'status', providerMessageId: sid, status: state }
  }
  const errorCode = Number(rawCode)
  if (!Number.isInteger(errorCode) || errorCode < 0 || errorCode > 99_999) {
    return bad('error_code')
  }
  return { kind: 'status', providerMessageId: sid, status: state, errorCode }
}
