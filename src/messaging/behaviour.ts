import { afterEach, describe, expect, test } from 'bun:test'
import { inspect } from 'node:util'
import type { OrganizationId, ProspectId } from 'tula-closeline-contract'
import type { MemoryContactGuard } from '../consent/memory'
import type { MemoryErrorReporter } from '../reporting/testing'
import { MESSAGING_ERROR_CODES, MessagingError } from './errors'
import {
  type InboundEvent,
  InboundMessage,
  type MessageDeliveryStatus,
  type MessagingChannel,
  type MessagingPort,
  type MessagingWebhookRequest,
  type SendMessageRequest,
} from './port'

/** What the behaviour suite needs from an adapter under test. */
export interface MessagingSubject {
  /** The port under test. */
  port: MessagingPort
  /** The Contact Check the port was built with; the suite presets what it allows and denies. */
  guard: MemoryContactGuard
  /** Two unrelated Organization ids the port accepts. */
  organizations: { a: OrganizationId; b: OrganizationId }
  /** A Prospect id to message. */
  prospect: ProspectId
  /** A recipient number, E.164. */
  recipient: string
  /** The number the port sends from, E.164. */
  ourNumber: string
  /** The reporter the port was built with: the suite reads what it was given. */
  reporter: MemoryErrorReporter
  /** Everything the port logged, one JSON or text line per entry. */
  logs(): string[]
  /** How many requests have reached the vendor, a retry counting as its own. */
  vendorCalls(): number
  /** How many vendor requests were aborted while they were still pending. */
  abortedCalls(): number
  /**
   * Arranges that the next `times` vendor requests fail: `retryable` as throttling or a 5xx,
   * `fatal` as refused credentials, `opted_out` as Twilio 21610, `template_required` as 63016 and
   * `bad_response` as an answer the adapter cannot use.
   */
  failNext(
    kind: 'retryable' | 'fatal' | 'opted_out' | 'template_required' | 'bad_response',
    times: number
  ): void
  /** Arranges that the next vendor request never answers, until aborted. */
  hang(): void
  /** A correctly signed webhook for a message the recipient sent. */
  signedInbound(fields: {
    from: string
    to: string
    body: string
    channel?: MessagingChannel
    mediaCount?: number
  }): MessagingWebhookRequest
  /** A correctly signed status webhook. */
  signedStatus(fields: {
    providerMessageId: string
    status: MessageDeliveryStatus
    errorCode?: number
  }): MessagingWebhookRequest
  /** A correctly signed webhook over arbitrary form fields. */
  sign(fields: Readonly<Record<string, string>>): MessagingWebhookRequest
  /** Credentials the port holds; none may appear in a log, a report, an error or a result. */
  secrets(): string[]
  /** Removes what the subject created. */
  close(): Promise<void>
}

const SECRET_TEXT = 'zebra confidential pricing'
const retry = { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 2 }
const TEMPLATE = `HX${'0123456789abcdef'.repeat(2)}`

async function errorOf(run: () => unknown): Promise<MessagingError | null> {
  try {
    await run()
  } catch (error) {
    if (error instanceof MessagingError) {
      return error
    }
    throw error
  }
  return null
}

async function codeOf(run: () => unknown): Promise<string> {
  return (await errorOf(run))?.code ?? 'no error'
}

/**
 * The behaviour every {@link MessagingPort} must show: a send asks the Contact Check first, every
 * time, and the vendor is never called after a denial of any code or when the request is not
 * acceptable (an unknown field cannot skip the check); an allowed send returns the provider's id
 * and the check's id; a retryable vendor error is retried a bounded number of times and the
 * others never; opt-out and template-required are their own codes; the overall deadline and the
 * caller's signal fail with their own codes and abort the vendor request; a webhook is accepted
 * only with a valid signature and parses into a message or a status event, with the STOP keywords
 * classified; and neither the text, the numbers nor the credentials reach a log, the error
 * reporter, an error, or the string, JSON or inspect form of anything the port returns. Run it
 * against the memory adapter and the Twilio adapter over a stubbed `fetch`.
 */
export function messagingBehaviour(
  name: string,
  make: () => Promise<MessagingSubject>,
  skip = false
): void {
  const run = skip ? describe.skip : describe
  run(`Messaging behaviour: ${name}`, () => {
    const made: MessagingSubject[] = []
    afterEach(async () => {
      await Promise.all(made.splice(0).map((subject) => subject.close()))
    })
    async function subject(): Promise<MessagingSubject> {
      const next = await make()
      made.push(next)
      return next
    }

    function allow(s: MessagingSubject, channel: MessagingChannel, org = s.organizations.a): void {
      s.guard.allow({ organizationId: org, prospectId: s.prospect }, channel)
      s.guard.allow({ organizationId: org, phone: s.recipient }, channel)
    }

    let counter = 0
    function request(s: MessagingSubject, overrides: Partial<SendMessageRequest> = {}) {
      counter += 1
      return {
        organizationId: s.organizations.a,
        prospectId: s.prospect,
        channel: 'sms',
        purpose: 'agent_initiated',
        to: s.recipient,
        content: { kind: 'text', body: SECRET_TEXT },
        idempotencyKey: `key-${counter}`,
        retry,
        ...overrides,
      } satisfies SendMessageRequest
    }

    test('an allowed SMS is sent once and returns the provider id and the consent check id', async () => {
      const s = await subject()
      allow(s, 'sms')
      const sent = await s.port.send(request(s, { idempotencyKey: 'order-1' }))
      expect(sent.providerMessageId).toMatch(/^(SM|MM)[0-9a-fA-F]{32}$/)
      expect(sent.consentCheckId).toMatch(/^chk_/)
      expect(sent.channel).toBe('sms')
      expect(sent.status).toBe('queued')
      expect(sent.idempotencyKey).toBe('order-1')
      expect(s.vendorCalls()).toBe(1)
      expect(sent.numberConsentCheckId).toMatch(/^chk_/)
      expect(sent.numberConsentCheckId).not.toBe(sent.consentCheckId)
      expect(s.guard.calls).toEqual([
        {
          organizationId: s.organizations.a,
          prospectId: s.prospect,
          channel: 'sms',
          purpose: 'agent_initiated',
        },
        {
          organizationId: s.organizations.a,
          phone: s.recipient,
          channel: 'sms',
          purpose: 'agent_initiated',
        },
      ])
    })

    test('a WhatsApp template with variables is sent; a reply is checked as a reply', async () => {
      const s = await subject()
      allow(s, 'whatsapp')
      const sent = await s.port.send(
        request(s, {
          channel: 'whatsapp',
          purpose: 'reply',
          content: {
            kind: 'template',
            templateId: TEMPLATE,
            variables: { '1': 'Ada', '2': 'Tue' },
          },
        })
      )
      expect(sent.channel).toBe('whatsapp')
      expect(s.guard.calls[0]?.channel).toBe('whatsapp')
      expect(s.guard.calls[0]?.purpose).toBe('reply')
    })

    test('a template over SMS is refused before the check and the vendor', async () => {
      const s = await subject()
      allow(s, 'sms')
      const code = await codeOf(() =>
        s.port.send(request(s, { content: { kind: 'template', templateId: TEMPLATE } }))
      )
      expect(code).toBe(MESSAGING_ERROR_CODES.invalidRequest)
      expect(s.vendorCalls()).toBe(0)
    })

    for (const denial of ['consent.missing', 'consent.withdrawn', 'consent.suppressed'] as const) {
      test(`a denial with ${denial} fails with messaging.consent_denied and never reaches the vendor`, async () => {
        const s = await subject()
        s.guard.deny({ organizationId: s.organizations.a, prospectId: s.prospect }, 'sms', denial)
        const error = await errorOf(() => s.port.send(request(s)))
        expect(error?.code).toBe(MESSAGING_ERROR_CODES.consentDenied)
        expect(error?.details).toEqual({ code: denial })
        expect(s.vendorCalls()).toBe(0)
        expect(s.reporter.captured).toEqual([])
      })
    }

    test('a Prospect nobody preset is denied as missing and never reaches the vendor', async () => {
      const s = await subject()
      const error = await errorOf(() => s.port.send(request(s)))
      expect(error?.code).toBe(MESSAGING_ERROR_CODES.consentDenied)
      expect(error?.details).toEqual({ code: 'consent.missing' })
      expect(s.vendorCalls()).toBe(0)
    })

    test('a check that is unavailable denies with consent.unavailable and never reaches the vendor', async () => {
      const s = await subject()
      allow(s, 'sms')
      s.guard.setUnavailable()
      const error = await errorOf(() => s.port.send(request(s)))
      expect(error?.code).toBe(MESSAGING_ERROR_CODES.consentDenied)
      expect(error?.details).toEqual({ code: 'consent.unavailable' })
      expect(s.vendorCalls()).toBe(0)
    })

    for (const code of ['consent.missing', 'consent.withdrawn', 'consent.suppressed'] as const) {
      test(`a number denied with ${code} blocks the send though the Prospect is allowed`, async () => {
        const s = await subject()
        allow(s, 'sms')
        s.guard.deny({ organizationId: s.organizations.a, phone: s.recipient }, 'sms', code)
        const error = await errorOf(() => s.port.send(request(s)))
        expect(error?.code).toBe(MESSAGING_ERROR_CODES.consentDenied)
        expect(error?.details).toEqual({ code })
        expect(s.vendorCalls()).toBe(0)
      })
    }

    test('a number nobody preset is denied though the Prospect is allowed', async () => {
      const s = await subject()
      s.guard.allow({ organizationId: s.organizations.a, prospectId: s.prospect }, 'sms')
      const error = await errorOf(() => s.port.send(request(s)))
      expect(error?.code).toBe(MESSAGING_ERROR_CODES.consentDenied)
      expect(s.vendorCalls()).toBe(0)
    })

    test('a Contact Check that never answers fails with messaging.timeout at the deadline', async () => {
      const s = await subject()
      allow(s, 'sms')
      s.guard.check = () => new Promise(() => undefined)
      const started = Date.now()
      expect(await codeOf(() => s.port.send(request(s, { timeoutMs: 50 })))).toBe(
        MESSAGING_ERROR_CODES.timeout
      )
      expect(Date.now() - started).toBeLessThan(500)
      expect(s.vendorCalls()).toBe(0)
    })

    test('the caller signal ends a Contact Check that never answers with messaging.aborted', async () => {
      const s = await subject()
      allow(s, 'sms')
      s.guard.check = () => new Promise(() => undefined)
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 20)
      expect(await codeOf(() => s.port.send(request(s, { signal: controller.signal })))).toBe(
        MESSAGING_ERROR_CODES.aborted
      )
      expect(s.vendorCalls()).toBe(0)
    })

    test('consent for SMS does not cover WhatsApp, and the check is asked on every call', async () => {
      const s = await subject()
      allow(s, 'sms')
      await s.port.send(request(s))
      expect(
        await codeOf(() =>
          s.port.send(
            request(s, { channel: 'whatsapp', content: { kind: 'template', templateId: TEMPLATE } })
          )
        )
      ).toBe(MESSAGING_ERROR_CODES.consentDenied)
      s.guard.deny(
        { organizationId: s.organizations.a, prospectId: s.prospect },
        'sms',
        'consent.withdrawn'
      )
      expect(await codeOf(() => s.port.send(request(s)))).toBe(MESSAGING_ERROR_CODES.consentDenied)
      expect(s.guard.calls.length).toBe(4)
      expect(s.vendorCalls()).toBe(1)
    })

    test('consent in one Organization does not let a second Organization send', async () => {
      const s = await subject()
      allow(s, 'sms', s.organizations.a)
      const error = await errorOf(() =>
        s.port.send(request(s, { organizationId: s.organizations.b }))
      )
      expect(error?.code).toBe(MESSAGING_ERROR_CODES.consentDenied)
      expect(s.vendorCalls()).toBe(0)
    })

    test('the same idempotency key in two Organizations is two messages', async () => {
      const s = await subject()
      allow(s, 'sms', s.organizations.a)
      allow(s, 'sms', s.organizations.b)
      const first = await s.port.send(request(s, { idempotencyKey: 'same' }))
      const second = await s.port.send(
        request(s, { idempotencyKey: 'same', organizationId: s.organizations.b })
      )
      expect(first.providerMessageId).not.toBe(second.providerMessageId)
      expect(s.vendorCalls()).toBe(2)
    })

    test('no field or option can skip the check', async () => {
      const s = await subject()
      for (const extra of [
        { skipConsent: true },
        { consent: false },
        { consentCheckId: 'chk_00000000000000000000000000000000' },
        { guard: { check: async () => ({ allowed: true }) } },
        { force: true },
        { override: 'consent' },
      ]) {
        const code = await codeOf(() => s.port.send({ ...request(s), ...extra } as never))
        expect(code).toBe(MESSAGING_ERROR_CODES.invalidRequest)
      }
      expect(s.vendorCalls()).toBe(0)
      expect(s.guard.calls).toEqual([])
    })

    test('an unacceptable request is refused before the check and the vendor', async () => {
      const s = await subject()
      allow(s, 'sms')
      const bad: Partial<SendMessageRequest>[] = [
        { organizationId: 'org_nope' as OrganizationId },
        { prospectId: 'prs_nope' as ProspectId },
        { channel: 'email' as never },
        { purpose: 'rep_initiated' as never },
        { to: '5551234' },
        { to: `whatsapp:${s.recipient}` },
        { content: { kind: 'text', body: '' } },
        { content: { kind: 'text', body: ' '.repeat(5) } },
        { content: { kind: 'text', body: 'x'.repeat(1601) } },
        { content: { kind: 'voice' } as never },
        { content: { kind: 'text', body: 'hi', extra: 1 } as never },
        { idempotencyKey: '' },
        { idempotencyKey: 'has space' },
        { idempotencyKey: 'k'.repeat(201) },
        { timeoutMs: 0 },
        { timeoutMs: 60_001 },
        { retry: { maxRetries: 6 } },
        { retry: { baseDelayMs: 0 } },
        { signal: {} as never },
      ]
      for (const overrides of bad) {
        expect(await codeOf(() => s.port.send(request(s, overrides)))).toBe(
          MESSAGING_ERROR_CODES.invalidRequest
        )
      }
      const whatsapp: Partial<SendMessageRequest>[] = [
        { content: { kind: 'template', templateId: 'HX123' } },
        { content: { kind: 'template', templateId: TEMPLATE, variables: { 'bad name': 'x' } } },
        {
          content: {
            kind: 'template',
            templateId: TEMPLATE,
            variables: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`v${i}`, 'x'])),
          },
        },
        { content: { kind: 'template', templateId: TEMPLATE, variables: { a: 'x'.repeat(1025) } } },
      ]
      for (const overrides of whatsapp) {
        expect(
          await codeOf(() => s.port.send(request(s, { channel: 'whatsapp', ...overrides })))
        ).toBe(MESSAGING_ERROR_CODES.invalidRequest)
      }
      expect(await codeOf(() => s.port.send(null as never))).toBe(
        MESSAGING_ERROR_CODES.invalidRequest
      )
      expect(s.vendorCalls()).toBe(0)
      expect(s.guard.calls).toEqual([])
    })

    test('a retryable vendor error is retried and then succeeds', async () => {
      const s = await subject()
      allow(s, 'sms')
      s.failNext('retryable', 1)
      const sent = await s.port.send(request(s))
      expect(sent.providerMessageId).toMatch(/^(SM|MM)/)
      expect(s.vendorCalls()).toBe(2)
      expect(s.reporter.captured).toEqual([])
    })

    test('retries are bounded: exhausting them fails with messaging.unavailable and is reported', async () => {
      const s = await subject()
      allow(s, 'sms')
      s.failNext('retryable', 5)
      expect(await codeOf(() => s.port.send(request(s)))).toBe(MESSAGING_ERROR_CODES.unavailable)
      expect(s.vendorCalls()).toBe(2)
      expect(s.reporter.captured.length).toBe(1)
    })

    test('maxRetries 0 never retries', async () => {
      const s = await subject()
      allow(s, 'sms')
      s.failNext('retryable', 1)
      expect(await codeOf(() => s.port.send(request(s, { retry: { maxRetries: 0 } })))).toBe(
        MESSAGING_ERROR_CODES.unavailable
      )
      expect(s.vendorCalls()).toBe(1)
    })

    test('a refusal is not retried and is reported', async () => {
      const s = await subject()
      allow(s, 'sms')
      s.failNext('fatal', 1)
      expect(await codeOf(() => s.port.send(request(s)))).toBe(MESSAGING_ERROR_CODES.rejected)
      expect(s.vendorCalls()).toBe(1)
      expect(s.reporter.captured.length).toBe(1)
    })

    test('a recipient who opted out is its own code, not retried and not reported', async () => {
      const s = await subject()
      allow(s, 'sms')
      s.failNext('opted_out', 1)
      expect(await codeOf(() => s.port.send(request(s)))).toBe(
        MESSAGING_ERROR_CODES.recipientOptedOut
      )
      expect(s.vendorCalls()).toBe(1)
      expect(s.reporter.captured).toEqual([])
    })

    test('a WhatsApp free-form message outside the window needs a template, not retried or reported', async () => {
      const s = await subject()
      allow(s, 'whatsapp')
      s.failNext('template_required', 1)
      expect(await codeOf(() => s.port.send(request(s, { channel: 'whatsapp' })))).toBe(
        MESSAGING_ERROR_CODES.templateRequired
      )
      expect(s.vendorCalls()).toBe(1)
      expect(s.reporter.captured).toEqual([])
    })

    test('an unusable answer is messaging.bad_response, not retried, and reported', async () => {
      const s = await subject()
      allow(s, 'sms')
      s.failNext('bad_response', 1)
      expect(await codeOf(() => s.port.send(request(s)))).toBe(MESSAGING_ERROR_CODES.badResponse)
      expect(s.vendorCalls()).toBe(1)
      expect(s.reporter.captured.length).toBe(1)
    })

    test('the overall deadline fails with messaging.timeout and aborts the vendor request', async () => {
      const s = await subject()
      allow(s, 'sms')
      s.hang()
      expect(await codeOf(() => s.port.send(request(s, { timeoutMs: 30 })))).toBe(
        MESSAGING_ERROR_CODES.timeout
      )
      expect(s.abortedCalls()).toBe(1)
      expect(s.vendorCalls()).toBe(1)
    })

    test('the caller signal fails with messaging.aborted and aborts the vendor request', async () => {
      const s = await subject()
      allow(s, 'sms')
      s.hang()
      const controller = new AbortController()
      const sending = errorOf(() => s.port.send(request(s, { signal: controller.signal })))
      setTimeout(() => controller.abort(), 20)
      expect((await sending)?.code).toBe(MESSAGING_ERROR_CODES.aborted)
      expect(s.abortedCalls()).toBe(1)
    })

    test('a signal that is already aborted never reaches the vendor', async () => {
      const s = await subject()
      allow(s, 'sms')
      expect(await codeOf(() => s.port.send(request(s, { signal: AbortSignal.abort() })))).toBe(
        MESSAGING_ERROR_CODES.aborted
      )
      expect(s.vendorCalls()).toBe(0)
    })

    describe('webhooks', () => {
      function asMessage(event: InboundEvent): InboundMessage {
        if (!(event instanceof InboundMessage)) {
          throw new Error('expected a message')
        }
        return event
      }

      test('a signed inbound SMS parses with its numbers, text and a fresh timestamp', async () => {
        const s = await subject()
        const message = asMessage(
          await s.port.receive(
            s.signedInbound({
              from: s.recipient,
              to: s.ourNumber,
              body: 'Yes, call me',
              mediaCount: 2,
            })
          )
        )
        expect(message.channel).toBe('sms')
        expect(message.from).toBe(s.recipient)
        expect(message.to).toBe(s.ourNumber)
        expect(message.body).toBe('Yes, call me')
        expect(message.intent).toBe('message')
        expect(message.mediaCount).toBe(2)
        expect(message.providerMessageId).toMatch(/^(SM|MM)[0-9a-fA-F]{32}$/)
        expect(Number.isNaN(Date.parse(message.receivedAt))).toBe(false)
      })

      test('a WhatsApp message loses its prefix and sets the channel', async () => {
        const s = await subject()
        const message = asMessage(
          await s.port.receive(
            s.signedInbound({
              from: s.recipient,
              to: s.ourNumber,
              body: 'hello',
              channel: 'whatsapp',
            })
          )
        )
        expect(message.channel).toBe('whatsapp')
        expect(message.from).toBe(s.recipient)
        expect(message.to).toBe(s.ourNumber)
      })

      const intents: [string, string][] = [
        ['STOP', 'stop'],
        [' stop ', 'stop'],
        ['Stop', 'stop'],
        ['STOPALL', 'stop'],
        ['unsubscribe', 'stop'],
        ['Cancel', 'stop'],
        ['END', 'stop'],
        ['quit', 'stop'],
        ['START', 'start'],
        ['unstop', 'start'],
        ['Yes', 'start'],
        ['HELP', 'help'],
        ['info', 'help'],
        ['Stop.', 'stop'],
        ['stop!', 'stop'],
        ['  "STOP"  ', 'stop'],
        ['STOP ALL', 'stop'],
        ['stop all.', 'stop'],
        ['stop\u200b', 'stop'],
        ['\u200bSTOP\u2060', 'stop'],
        ['STOP \u{1F44D}', 'stop'],
        ['Start.', 'start'],
        ['help!', 'help'],
        ['\u017Ftart', 'message'],
        ['\u212Aind', 'message'],
        ['please stop texting me', 'message'],
        ['stopping by tomorrow', 'message'],
        ['no thanks', 'message'],
        ['', 'message'],
      ]
      for (const [text, intent] of intents) {
        test(`the text ${JSON.stringify(text)} means ${intent}`, async () => {
          const s = await subject()
          const message = asMessage(
            await s.port.receive(
              s.signedInbound({ from: s.recipient, to: s.ourNumber, body: text })
            )
          )
          expect(message.intent).toBe(intent as never)
        })
      }

      test('a signed status webhook parses into a status event', async () => {
        const s = await subject()
        const id = `SM${'ab'.repeat(16)}`
        expect(
          await s.port.receive(s.signedStatus({ providerMessageId: id, status: 'delivered' }))
        ).toEqual({ kind: 'status', providerMessageId: id, status: 'delivered' })
        expect(
          await s.port.receive(
            s.signedStatus({ providerMessageId: id, status: 'undelivered', errorCode: 30003 })
          )
        ).toEqual({
          kind: 'status',
          providerMessageId: id,
          status: 'undelivered',
          errorCode: 30003,
        })
      })

      test('a tampered body, a tampered URL, a wrong or missing signature are webhook_invalid', async () => {
        const s = await subject()
        const good = s.signedInbound({ from: s.recipient, to: s.ourNumber, body: 'hello' })
        const attempts: MessagingWebhookRequest[] = [
          { ...good, body: good.body.replace('hello', 'jello') },
          { ...good, url: `${good.url}/other` },
          { ...good, signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
          { ...good, signature: `${good.signature}x` },
          { ...good, signature: '' },
          { ...good, signature: null },
          { ...good, signature: undefined },
        ]
        for (const attempt of attempts) {
          expect(await codeOf(() => s.port.receive(attempt))).toBe(
            MESSAGING_ERROR_CODES.webhookInvalid
          )
        }
        expect(await codeOf(() => s.port.receive(null as never))).toBe(
          MESSAGING_ERROR_CODES.webhookInvalid
        )
      })

      test('a body over the limit and a body that is not a form are webhook_invalid', async () => {
        const s = await subject()
        const big = s.sign({ MessageSid: `SM${'ab'.repeat(16)}`, Body: 'x'.repeat(300_000) })
        expect(await codeOf(() => s.port.receive(big))).toBe(MESSAGING_ERROR_CODES.webhookInvalid)
        const good = s.signedInbound({ from: s.recipient, to: s.ourNumber, body: 'hi' })
        expect(
          await codeOf(() => s.port.receive({ ...good, contentType: 'application/json' }))
        ).toBe(MESSAGING_ERROR_CODES.webhookInvalid)
      })

      test('a correctly signed body that is neither a message nor a status is webhook_invalid', async () => {
        const s = await subject()
        const sid = `SM${'ab'.repeat(16)}`
        const bodies: Record<string, string>[] = [
          { Foo: 'bar' },
          { MessageSid: 'nope', Body: 'hi', From: s.recipient, To: s.ourNumber },
          { MessageSid: sid, Body: 'hi', From: 'not a number', To: s.ourNumber },
          { MessageSid: sid, Body: 'hi', From: s.recipient, To: s.ourNumber, NumMedia: '99' },
          { MessageSid: sid, MessageStatus: 'teleported' },
        ]
        for (const fields of bodies) {
          expect(await codeOf(() => s.port.receive(s.sign(fields)))).toBe(
            MESSAGING_ERROR_CODES.webhookInvalid
          )
        }
      })
    })

    test('the text, the numbers and the credentials reach no log, report, error or result form', async () => {
      const s = await subject()
      allow(s, 'sms')
      const seen: string[] = []
      const note = (value: unknown) => {
        seen.push(String(value), inspect(value, { depth: 6 }))
        try {
          seen.push(JSON.stringify(value))
        } catch {
          // not serialisable
        }
      }
      note(await s.port.send(request(s)))
      s.failNext('retryable', 1)
      await s.port.send(request(s))
      for (const kind of ['retryable', 'fatal', 'opted_out', 'bad_response'] as const) {
        s.failNext(kind, 2)
        const error = await errorOf(() => s.port.send(request(s)))
        note(error)
        seen.push(error?.message ?? '', JSON.stringify(error?.details ?? {}))
      }
      s.guard.deny({ organizationId: s.organizations.a, prospectId: s.prospect }, 'sms')
      const denied = await errorOf(() => s.port.send(request(s)))
      note(denied)
      allow(s, 'sms')
      s.hang()
      const timeout = await errorOf(() => s.port.send(request(s, { timeoutMs: 20 })))
      note(timeout)
      const event = await s.port.receive(
        s.signedInbound({ from: s.recipient, to: s.ourNumber, body: SECRET_TEXT })
      )
      note(event)
      note({ ...event })
      const bad = await errorOf(() =>
        s.port.receive({
          ...s.signedInbound({ from: s.recipient, to: s.ourNumber, body: SECRET_TEXT }),
          signature: 'wrong',
        })
      )
      note(bad)
      seen.push(
        ...s.logs(),
        JSON.stringify(s.reporter.captured),
        inspect(s.reporter.captured, { depth: 6 })
      )
      for (const captured of s.reporter.captured) {
        note(captured.error)
      }
      const everything = seen.join('\n')
      for (const secret of [SECRET_TEXT, s.recipient, s.ourNumber, ...s.secrets()]) {
        expect(everything).not.toContain(secret)
      }
    })
  })
}
