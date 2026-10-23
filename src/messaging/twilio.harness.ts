import { randomBytes } from 'node:crypto'
import { createFixedClock } from '../clock'
import { createMemoryContactGuard } from '../consent/memory'
import { createMemoryErrorReporter } from '../reporting/testing'
import { signTwilioRequest } from '../twilio-signature'
import { createTwilioMessaging, type TwilioMessagingOptions } from './twilio'

/** Test-only: Twilio credentials and a stubbed `fetch` for the Twilio messaging adapter. */
export const ACCOUNT = `AC${'0123456789abcdef'.repeat(2)}`
/** Test-only Auth Token. */
export const AUTH_TOKEN = 'auth-token-0123456789abcdef0123'
/** Test-only Messaging Service SID. */
export const SERVICE = `MG${'fedcba9876543210'.repeat(2)}`
/** Test-only webhook URL. */
export const HOOK_URL = 'https://hooks.example.test/messaging'
/** Test-only sender. */
export const OUR_NUMBER = '+14155550199'
/** Test-only recipient. */
export const RECIPIENT = '+14155550142'

/** What the stub saw of one request. */
export interface Seen {
  url: string
  method: string
  headers: Record<string, string>
  form: URLSearchParams
  aborted: boolean
}

/** What a stubbed reply can be. */
export type Reply = Response | Error | 'hang'

/** A JSON response. */
export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** A queued-message answer from Twilio. */
export function queued(sid = `SM${randomBytes(16).toString('hex')}`, status = 'queued'): Response {
  return json(201, { sid, status })
}

/** Builds the adapter over a stubbed fetch. */
export function twilioHarness(
  handler: (seen: Seen) => Reply | undefined | Promise<Reply | undefined>,
  extra: Partial<TwilioMessagingOptions> = {}
) {
  const seen: Seen[] = []
  const sleeps: number[] = []
  const logs: string[] = []
  const logger = {
    debug: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    info: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    warn: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    error: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    child: () => logger,
  }
  const reporter = createMemoryErrorReporter()
  const guard = createMemoryContactGuard()
  const port = createTwilioMessaging({
    accountSid: ACCOUNT,
    authToken: AUTH_TOKEN,
    guard,
    messagingServiceSid: SERVICE,
    whatsappFrom: OUR_NUMBER,
    statusCallbackUrl: 'https://hooks.example.test/status',
    reporter,
    logger,
    clock: createFixedClock('2026-01-01T00:00:00.000Z'),
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    fetch: async (input, init) => {
      const record: Seen = {
        url: input,
        method: init.method ?? 'GET',
        headers: (init.headers ?? {}) as Record<string, string>,
        form: new URLSearchParams(typeof init.body === 'string' ? init.body : ''),
        aborted: false,
      }
      seen.push(record)
      init.signal?.addEventListener('abort', () => {
        record.aborted = true
      })
      const reply = await handler(record)
      if (reply === 'hang') {
        return new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
      }
      if (reply instanceof Error) {
        throw reply
      }
      return reply ?? json(404, { code: 20404, message: 'not found' })
    },
    ...extra,
  })
  return { port, guard, reporter, seen, sleeps, logs }
}

/** A correctly signed webhook over `fields`. */
export function signedHook(fields: Record<string, string>, url = HOOK_URL) {
  return {
    url,
    signature: signTwilioRequest(AUTH_TOKEN, url, fields),
    body: new URLSearchParams(fields).toString(),
    contentType: 'application/x-www-form-urlencoded',
  }
}
