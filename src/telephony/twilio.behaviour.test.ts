import { describe, test } from 'bun:test'
import { organizationIdSchema } from 'tula-closeline-contract'
import { type ProspectScenario, type TelephonySubject, telephonyBehaviour } from './behaviour'
import type { SignedWebhook, TelephonyOperation } from './memory'
import type { TelephonyEvent, TelephonyPort } from './port'
import {
  createMemoryTwilioStore,
  createTwilioTelephony,
  signTwilioRequest,
  type TwilioOptions,
  type TwilioRegion,
} from './twilio'

/**
 * The shared behaviour suite against real Twilio. It runs only when these variables are set in the
 * environment (it is the one place the kit reads `process.env`); otherwise it is skipped, and the
 * skip names what is missing. Every call it places is billed to the Twilio account.
 */
const REQUIRED = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_API_KEY_SID',
  'TWILIO_API_KEY_SECRET',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_TWIML_APP_SID',
  'TWILIO_FROM_NUMBER',
  'TWILIO_TEST_NUMBER_ANSWERS',
  'TWILIO_TEST_NUMBER_NO_ANSWER',
  'TWILIO_TEST_NUMBER_BUSY',
  'TWILIO_TEST_NUMBER_HANGS_UP',
  'TWILIO_TEST_NUMBER_CARRIER_FAILURE',
  'TWILIO_TEST_CALLER_NUMBER',
] as const

const env = process.env
const missing = REQUIRED.filter((name) => !env[name])

if (missing.length > 0) {
  describe('Telephony behaviour: twilio adapter', () => {
    test.skip(`skipped: set ${missing.join(', ')} to run it against Twilio`, () => undefined)
  })
} else {
  const value = (name: (typeof REQUIRED)[number]): string => env[name] ?? ''
  const region = env.TWILIO_REGION as TwilioRegion | undefined
  const orgA = organizationIdSchema.parse(`org_${'a'.repeat(32)}`)
  const orgB = organizationIdSchema.parse(`org_${'b'.repeat(32)}`)
  const numbers: Record<ProspectScenario, string> = {
    answers: value('TWILIO_TEST_NUMBER_ANSWERS'),
    no_answer: value('TWILIO_TEST_NUMBER_NO_ANSWER'),
    busy: value('TWILIO_TEST_NUMBER_BUSY'),
    hangs_up_during_disclosure: value('TWILIO_TEST_NUMBER_HANGS_UP'),
    carrier_failure: value('TWILIO_TEST_NUMBER_CARRIER_FAILURE'),
  }

  telephonyBehaviour('twilio adapter', async () => {
    const stalls = new Set<TelephonyOperation>()
    const failures = new Set<TelephonyOperation>()
    const tracked = new Map<string, { organizationId: string; last: string }>()
    const events: TelephonyEvent[] = []
    let current: TelephonyOperation | null = null
    const options: TwilioOptions = {
      accountSid: value('TWILIO_ACCOUNT_SID'),
      apiKeySid: value('TWILIO_API_KEY_SID'),
      apiKeySecret: value('TWILIO_API_KEY_SECRET'),
      authToken: value('TWILIO_AUTH_TOKEN'),
      twimlAppSid: value('TWILIO_TWIML_APP_SID'),
      ...(region === undefined ? {} : { region }),
      environment: 'dev',
      store: createMemoryTwilioStore(),
      fetch: async (input, init) => {
        // A fault is injected for the next call of one operation only.
        if (current !== null && failures.delete(current)) {
          return new Response('{}', { status: 503 })
        }
        if (current !== null && stalls.delete(current)) {
          return new Promise<Response>((_, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          })
        }
        return fetch(input, init)
      },
    }
    const real = createTwilioTelephony(options)
    const auth = `Basic ${Buffer.from(`${options.apiKeySid}:${options.apiKeySecret}`).toString('base64')}`
    const callsUrl = `https://api.twilio.com/2010-04-01/Accounts/${options.accountSid}/Calls`
    const rest = async (method: string, url: string, form?: Record<string, string>) =>
      fetch(url, {
        method,
        headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
        ...(form === undefined ? {} : { body: new URLSearchParams(form).toString() }),
      })

    /** Wraps every method so a fault can be aimed at one operation and each call is tracked. */
    const telephony = new Proxy(real, {
      get(target, property: string) {
        const member = (target as unknown as Record<string, unknown>)[property]
        if (typeof member !== 'function') {
          return member
        }
        return async (...args: unknown[]) => {
          current = property as TelephonyOperation
          try {
            const result = await (member as (...a: unknown[]) => Promise<unknown>).apply(
              target,
              args
            )
            const sid = (result as { providerCallId?: string } | null)?.providerCallId
            const request = args[0] as { organizationId?: string; providerCallId?: string }
            const id = sid ?? request.providerCallId
            if (id !== undefined && request.organizationId !== undefined && !tracked.has(id)) {
              tracked.set(id, { organizationId: request.organizationId, last: 'new' })
            }
            return result
          } finally {
            current = null
          }
        }
      },
    }) as TelephonyPort

    const poll = async (): Promise<void> => {
      for (const [sid, entry] of tracked) {
        const answer = await rest('GET', `${callsUrl}/${sid}.json`)
        const body = (await answer.json()) as { status?: string }
        const status = body.status ?? 'unknown'
        if (status === entry.last) {
          continue
        }
        entry.last = status
        const base = {
          eventId: `${sid}-${status}`,
          organizationId: organizationIdSchema.parse(entry.organizationId),
          providerCallId: sid,
          at: new Date().toISOString(),
        }
        if (status === 'ringing') {
          events.push({ ...base, type: 'ringing' })
        } else if (status === 'in-progress') {
          events.push({ ...base, type: 'answered' })
        } else if (status === 'busy') {
          events.push({ ...base, type: 'busy', failureReason: 'busy' })
        } else if (status === 'no-answer') {
          events.push({ ...base, type: 'no_answer', failureReason: 'no_answer' })
        } else if (status === 'failed') {
          events.push({ ...base, type: 'failed', failureReason: 'carrier_dropped' })
        } else if (status === 'completed') {
          events.push({ ...base, type: 'completed', endedBy: 'prospect' })
        }
      }
    }

    const subject: TelephonySubject = {
      telephony,
      organizations: { a: orgA, b: orgB },
      numberFor: (scenario) => numbers[scenario],
      // The Line's Voice URL must answer with a long hold TwiML (see the README).
      receiveInbound: async () => {
        const created = await rest('POST', `${callsUrl}.json`, {
          To: value('TWILIO_FROM_NUMBER'),
          From: value('TWILIO_TEST_CALLER_NUMBER'),
          Twiml: '<Response><Pause length="3600"/></Response>',
        })
        const { sid } = (await created.json()) as { sid: string }
        const listing = await rest(
          'GET',
          `${callsUrl}.json?To=${encodeURIComponent(value('TWILIO_FROM_NUMBER'))}&PageSize=5`
        )
        const { calls } = (await listing.json()) as {
          calls: { sid: string; direction: string; parent_call_sid: string | null }[]
        }
        const inbound = calls.find((c) => c.direction === 'inbound' && c.parent_call_sid === sid)
        return inbound?.sid ?? sid
      },
      prospectHangsUp: async (_organizationId, providerCallId) => {
        await rest('POST', `${callsUrl}/${providerCallId}.json`, { Status: 'completed' })
      },
      stallNext: (operation) => {
        stalls.add(operation)
      },
      failNext: (operation) => {
        failures.add(operation)
      },
      takeEvents: async () => {
        await poll()
        return events.splice(0)
      },
      signedWebhook: (event): SignedWebhook => {
        const url = 'https://voice.example.test/webhooks/telephony'
        const body = JSON.stringify(event)
        const hash = new Bun.CryptoHasher('sha256').update(body).digest('hex')
        const signed = `${url}?bodySHA256=${hash}`
        return {
          url: signed,
          body,
          signature: signTwilioRequest(value('TWILIO_AUTH_TOKEN'), signed),
        }
      },
      close: async () => {
        for (const sid of tracked.keys()) {
          await rest('POST', `${callsUrl}/${sid}.json`, { Status: 'completed' }).catch(
            () => undefined
          )
        }
        tracked.clear()
      },
    }
    return subject
  })
}
