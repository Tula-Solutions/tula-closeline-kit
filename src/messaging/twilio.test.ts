import { describe, expect, test } from 'bun:test'
import { inspect } from 'node:util'
import { formatId, organizationIdSchema, type ProspectId } from 'tula-closeline-contract'
import { MESSAGING_ERROR_CODES, MessagingError } from './errors'
import { InboundMessage, type SendMessageRequest } from './port'
import { createTwilioMessaging } from './twilio'
import {
  ACCOUNT,
  AUTH_TOKEN,
  HOOK_URL,
  json,
  OUR_NUMBER,
  queued,
  RECIPIENT,
  SERVICE,
  signedHook,
  twilioHarness,
} from './twilio.harness'

const org = organizationIdSchema.parse(`org_${'a'.repeat(32)}`)
const prospect = formatId('prs', '1'.repeat(32)) as ProspectId
const TEMPLATE = `HX${'0123456789abcdef'.repeat(2)}`
const retry = { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 1000 }

function req(over: Partial<SendMessageRequest> = {}): SendMessageRequest {
  return {
    organizationId: org,
    prospectId: prospect,
    channel: 'sms',
    purpose: 'agent_initiated',
    to: RECIPIENT,
    content: { kind: 'text', body: 'Hi Ada, a quote for you' },
    idempotencyKey: 'order-1',
    retry,
    ...over,
  }
}

function allowed(h: ReturnType<typeof twilioHarness>, channel: 'sms' | 'whatsapp' = 'sms') {
  h.guard.allow({ organizationId: org, prospectId: prospect, phone: RECIPIENT }, channel)
}

async function fails(run: () => Promise<unknown>): Promise<MessagingError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof MessagingError) {
      return error
    }
    throw error
  }
  throw new Error('expected a MessagingError')
}

describe('twilio messaging send', () => {
  test('SMS posts the right form and headers', async () => {
    const h = twilioHarness(() => queued())
    allowed(h)
    const sent = await h.port.send(req())
    expect(sent.status).toBe('queued')
    const call = h.seen[0]
    expect(call?.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Messages.json`)
    expect(call?.method).toBe('POST')
    expect(call?.form.get('To')).toBe(RECIPIENT)
    expect(call?.form.get('MessagingServiceSid')).toBe(SERVICE)
    expect(call?.form.get('Body')).toBe('Hi Ada, a quote for you')
    expect(call?.form.get('StatusCallback')).toBe('https://hooks.example.test/status')
    expect(call?.headers.authorization).toBe(
      `Basic ${Buffer.from(`${ACCOUNT}:${AUTH_TOKEN}`).toString('base64')}`
    )
    expect(call?.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(call?.headers['i-twilio-idempotency-token']).toMatch(/^[0-9a-f]{64}$/)
    expect(call?.headers['i-twilio-idempotency-token']).not.toContain('order-1')
  })

  test('the idempotency token is stable per key and differs per key', async () => {
    const h = twilioHarness(() => queued())
    allowed(h)
    await h.port.send(req())
    await h.port.send(req())
    await h.port.send(req({ idempotencyKey: 'order-2' }))
    const tokens = h.seen.map((s) => s.headers['i-twilio-idempotency-token'])
    expect(tokens[0]).toBe(tokens[1])
    expect(tokens[2]).not.toBe(tokens[0])
  })

  test('WhatsApp template posts ContentSid and ContentVariables with prefixed numbers', async () => {
    const h = twilioHarness(() => queued())
    allowed(h, 'whatsapp')
    await h.port.send(
      req({
        channel: 'whatsapp',
        content: { kind: 'template', templateId: TEMPLATE, variables: { '1': 'Ada' } },
      })
    )
    const form = h.seen[0]?.form
    expect(form?.get('To')).toBe(`whatsapp:${RECIPIENT}`)
    expect(form?.get('From')).toBe(`whatsapp:${OUR_NUMBER}`)
    expect(form?.get('ContentSid')).toBe(TEMPLATE)
    expect(form?.get('ContentVariables')).toBe('{"1":"Ada"}')
    expect(form?.get('Body')).toBeNull()
    expect(form?.get('MessagingServiceSid')).toBeNull()
  })

  test('a number sender is used when there is no Messaging Service', async () => {
    const h = twilioHarness(() => queued(), {
      messagingServiceSid: undefined,
      fromNumber: OUR_NUMBER,
    })
    allowed(h)
    await h.port.send(req())
    expect(h.seen[0]?.form.get('From')).toBe(OUR_NUMBER)
  })

  test('WhatsApp without any sender is invalid and never reaches Twilio', async () => {
    const h = twilioHarness(() => queued(), {
      whatsappFrom: undefined,
      messagingServiceSid: undefined,
      fromNumber: OUR_NUMBER,
    })
    allowed(h, 'whatsapp')
    const error = await fails(() => h.port.send(req({ channel: 'whatsapp' })))
    expect(error.code).toBe(MESSAGING_ERROR_CODES.invalidRequest)
    expect(h.seen.length).toBe(0)
  })

  test('a regional host is used', async () => {
    const h = twilioHarness(() => queued(), { region: 'au1', edge: 'sydney' })
    allowed(h)
    await h.port.send(req())
    expect(h.seen[0]?.url).toContain('api.sydney.au1.twilio.com')
  })

  test('statuses delivered and sent map to sent; unknown states are bad_response', async () => {
    const h = twilioHarness(() => queued(undefined, 'delivered'))
    allowed(h)
    expect((await h.port.send(req())).status).toBe('sent')
    const g = twilioHarness(() => queued(undefined, 'failed'))
    allowed(g)
    expect((await fails(() => g.port.send(req()))).code).toBe(MESSAGING_ERROR_CODES.badResponse)
  })

  test('a 503 is retried with jittered backoff, then succeeds', async () => {
    let n = 0
    const h = twilioHarness(() => (++n < 3 ? json(503, { code: 20500 }) : queued()))
    allowed(h)
    await h.port.send(req())
    expect(h.seen.length).toBe(3)
    expect(h.sleeps.length).toBe(2)
    expect(h.sleeps.every((ms) => ms > 0 && ms <= 1000)).toBe(true)
    expect(h.seen[0]?.headers['i-twilio-idempotency-token']).toBe(
      h.seen[2]?.headers['i-twilio-idempotency-token']
    )
    expect(h.reporter.captured).toEqual([])
  })

  test('429 is retryable', async () => {
    let n = 0
    const h = twilioHarness(() => (++n < 2 ? json(429, { code: 20429 }) : queued()))
    allowed(h)
    await h.port.send(req())
    expect(h.seen.length).toBe(2)
  })

  test('exhausted retries fail unavailable and are reported once', async () => {
    const h = twilioHarness(() => json(500, {}))
    allowed(h)
    const error = await fails(() => h.port.send(req()))
    expect(error.code).toBe(MESSAGING_ERROR_CODES.unavailable)
    expect(h.seen.length).toBe(3)
    expect(h.reporter.captured.length).toBe(1)
  })

  test('a network error is retryable and carries no cause', async () => {
    const h = twilioHarness(() => new Error(`connect to ${RECIPIENT} ${AUTH_TOKEN} failed`))
    allowed(h)
    const error = await fails(() => h.port.send(req({ retry: { maxRetries: 0 } })))
    expect(error.code).toBe(MESSAGING_ERROR_CODES.unavailable)
    expect(error.cause).toBeUndefined()
    expect(inspect(error, { depth: 6 })).not.toContain(AUTH_TOKEN)
    expect(h.seen.length).toBe(1)
  })

  test('an attempt that outlives attemptTimeoutMs is retried as unavailable', async () => {
    const h = twilioHarness(() => 'hang', { attemptTimeoutMs: 15 })
    allowed(h)
    const error = await fails(() => h.port.send(req({ retry: { maxRetries: 1 } })))
    expect(error.code).toBe(MESSAGING_ERROR_CODES.unavailable)
    expect(error.details).toMatchObject({ phase: 'attempt_timeout' })
    expect(h.seen.length).toBe(2)
    expect(h.seen.every((s) => s.aborted)).toBe(true)
  })

  test('the overall deadline gives timeout; the caller signal gives aborted', async () => {
    const h = twilioHarness(() => 'hang')
    allowed(h)
    expect((await fails(() => h.port.send(req({ timeoutMs: 20 })))).code).toBe(
      MESSAGING_ERROR_CODES.timeout
    )
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 10)
    expect((await fails(() => h.port.send(req({ signal: controller.signal })))).code).toBe(
      MESSAGING_ERROR_CODES.aborted
    )
  })

  test('4xx is rejected, not retried, with status and Twilio code only', async () => {
    const h = twilioHarness(() => json(400, { code: 21211, message: `bad number ${RECIPIENT}` }))
    allowed(h)
    const error = await fails(() => h.port.send(req()))
    expect(error.code).toBe(MESSAGING_ERROR_CODES.rejected)
    expect(error.details).toEqual({ status: 400, twilioCode: 21211 })
    expect(JSON.stringify(error.details)).not.toContain(RECIPIENT)
    expect(h.seen.length).toBe(1)
    expect(h.reporter.captured.length).toBe(1)
  })

  test('21610 is recipient_opted_out and 63016 is template_required; neither is reported', async () => {
    const a = twilioHarness(() => json(400, { code: 21610 }))
    allowed(a)
    expect((await fails(() => a.port.send(req()))).code).toBe(
      MESSAGING_ERROR_CODES.recipientOptedOut
    )
    const b = twilioHarness(() => json(400, { code: 63016 }))
    allowed(b, 'whatsapp')
    expect((await fails(() => b.port.send(req({ channel: 'whatsapp' })))).code).toBe(
      MESSAGING_ERROR_CODES.templateRequired
    )
    expect(a.reporter.captured.length + b.reporter.captured.length).toBe(0)
  })

  test('bad responses: not JSON, no sid, oversized, odd status', async () => {
    const bodies = [
      () => new Response('<html>', { status: 201 }),
      () => json(201, { status: 'queued' }),
      () => json(201, { sid: 'nope', status: 'queued' }),
      () => new Response('x'.repeat(200_000), { status: 201 }),
      () => json(302, {}),
    ]
    for (const body of bodies) {
      const h = twilioHarness(body)
      allowed(h)
      const error = await fails(() => h.port.send(req()))
      expect(error.code).toBe(MESSAGING_ERROR_CODES.badResponse)
      expect(h.seen.length).toBe(1)
    }
  })

  test('denied consent never calls fetch', async () => {
    const h = twilioHarness(() => queued())
    const error = await fails(() => h.port.send(req()))
    expect(error.code).toBe(MESSAGING_ERROR_CODES.consentDenied)
    expect(h.seen.length).toBe(0)
  })

  test('nothing sensitive reaches logs, reports, errors or inspect output', async () => {
    const h = twilioHarness(() => json(503, { message: `${RECIPIENT} ${AUTH_TOKEN}` }))
    allowed(h)
    const error = await fails(() => h.port.send(req()))
    const text = [
      error.message,
      JSON.stringify(error.details),
      inspect(error, { depth: 8 }),
      h.logs.join('\n'),
      JSON.stringify(h.reporter.captured),
      inspect(h.reporter.captured, { depth: 8 }),
    ].join('\n')
    for (const secret of [AUTH_TOKEN, RECIPIENT, 'Hi Ada', ACCOUNT]) {
      expect(text).not.toContain(secret)
    }
  })
})

describe('twilio messaging receive', () => {
  test('a valid inbound parses and stays redacted in every form', async () => {
    const h = twilioHarness(() => queued())
    const event = await h.port.receive(
      signedHook({
        MessageSid: `SM${'cd'.repeat(16)}`,
        From: RECIPIENT,
        To: OUR_NUMBER,
        Body: 'STOP',
        NumMedia: '0',
      })
    )
    expect(event).toBeInstanceOf(InboundMessage)
    const message = event as InboundMessage
    expect(message.intent).toBe('stop')
    expect(message.receivedAt).toBe('2026-01-01T00:00:00.000Z')
    const forms = [String(message), JSON.stringify(message), inspect(message, { depth: 6 })].join(
      ' '
    )
    expect(forms).not.toContain(RECIPIENT)
    expect(forms).not.toContain('STOP')
  })

  test('a signature over the default-port form of the URL is accepted', async () => {
    const h = twilioHarness(() => queued())
    const fields = { MessageSid: `SM${'cd'.repeat(16)}`, MessageStatus: 'delivered' }
    const signed = signedHook(fields, 'https://hooks.example.test:443/messaging')
    expect(await h.port.receive({ ...signed, url: HOOK_URL })).toMatchObject({ kind: 'status' })
  })

  test('tampered fields, wrong token, wrong URL and a missing signature are refused', async () => {
    const h = twilioHarness(() => queued())
    const good = signedHook({
      MessageSid: `SM${'cd'.repeat(16)}`,
      From: RECIPIENT,
      To: OUR_NUMBER,
      Body: 'hello',
    })
    const other = twilioHarness(() => queued(), { authToken: 'another-token-0123456789abcdef' })
    for (const attempt of [
      { ...good, body: good.body.replace('hello', 'hullo') },
      { ...good, url: 'https://evil.example.test/messaging' },
      { ...good, signature: '' },
      { ...good, signature: null },
    ]) {
      const error = await fails(() => h.port.receive(attempt))
      expect(error.code).toBe(MESSAGING_ERROR_CODES.webhookInvalid)
    }
    expect((await fails(() => other.port.receive(good))).code).toBe(
      MESSAGING_ERROR_CODES.webhookInvalid
    )
  })

  test('status events map accepted to queued and canceled to failed', async () => {
    const h = twilioHarness(() => queued())
    const sid = `SM${'cd'.repeat(16)}`
    expect(
      await h.port.receive(signedHook({ MessageSid: sid, MessageStatus: 'accepted' }))
    ).toEqual({
      kind: 'status',
      providerMessageId: sid,
      status: 'queued',
    })
    expect(await h.port.receive(signedHook({ SmsSid: sid, SmsStatus: 'canceled' }))).toMatchObject({
      status: 'failed',
    })
  })
})

describe('twilio messaging construction', () => {
  const base = { accountSid: ACCOUNT, authToken: AUTH_TOKEN, messagingServiceSid: SERVICE }
  const guard = twilioHarness(() => queued()).guard
  const cases: [string, Record<string, unknown>][] = [
    ['accountSid', { accountSid: 'AC123' }],
    ['authToken', { authToken: 'short' }],
    ['guard', { guard: undefined }],
    ['messagingServiceSid', { messagingServiceSid: 'MG1' }],
    ['both senders', { fromNumber: OUR_NUMBER }],
    ['fromNumber', { messagingServiceSid: undefined, fromNumber: '555' }],
    ['whatsappFrom', { whatsappFrom: 'whatsapp:+1' }],
    ['statusCallbackUrl http', { statusCallbackUrl: 'http://x.test/s' }],
    ['statusCallbackUrl credentials', { statusCallbackUrl: 'https://u:p@x.test/s' }],
    ['attemptTimeoutMs', { attemptTimeoutMs: 0 }],
  ]
  for (const [name, over] of cases) {
    test(`a bad ${name} is a TypeError that does not echo the value`, () => {
      try {
        createTwilioMessaging({ ...base, guard, ...over } as never)
        throw new Error('no error')
      } catch (error) {
        expect(error).toBeInstanceOf(TypeError)
        expect((error as Error).message).not.toContain(AUTH_TOKEN)
        expect((error as Error).message).not.toContain('555')
      }
    })
  }
  test('a sender is required for neither channel only when none is given', () => {
    expect(() => createTwilioMessaging({ ...base, guard } as never)).not.toThrow()
  })
})
