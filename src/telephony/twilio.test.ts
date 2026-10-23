import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { jwtVerify } from 'jose'
import { callIdSchema, membershipIdSchema, organizationIdSchema } from 'tula-closeline-contract'
import { createFixedClock } from '../clock'
import { MAX_WEBHOOK_BODY_BYTES } from './port'
import {
  createMemoryTwilioStore,
  createTwilioTelephony,
  estimateSpeechMs,
  signTwilioRequest,
  type TwilioOptions,
  twilioApiHost,
} from './twilio'

const org = organizationIdSchema.parse(`org_${'a'.repeat(32)}`)
const otherOrg = organizationIdSchema.parse(`org_${'b'.repeat(32)}`)
const callId = callIdSchema.parse(`call_${'c'.repeat(32)}`)
const rep = membershipIdSchema.parse(`mem_${'1'.repeat(32)}`)
const otherRep = membershipIdSchema.parse(`mem_${'2'.repeat(32)}`)

const ACCOUNT = `AC${'1'.repeat(32)}`
const KEY = `SK${'2'.repeat(32)}`
const SECRET = 'api-key-secret-0123456789abcdef'
const AUTH_TOKEN = 'auth-token-0123456789abcdef0123'
const APP = `AP${'3'.repeat(32)}`
const CALL_SID = `CA${'4'.repeat(32)}`
const RECORDING_SID = `RE${'5'.repeat(32)}`
const STREAM_SID = `MZ${'6'.repeat(32)}`
const LINE = '+14155550100'
const PROSPECT = '+14155550123'
const wording = {
  wordingVersion: 1,
  text: 'This call is recorded & an AI helps.',
  aiAssisted: true,
}

interface Seen {
  method: string
  url: string
  headers: Record<string, string>
  form: URLSearchParams
}

type Reply = Response | Error | 'hang'

function json(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** A handwritten Twilio: answers by method and path, and records every request. */
function harness(
  handler: (seen: Seen) => Reply | undefined | Promise<Reply | undefined>,
  extra: Partial<TwilioOptions> = {}
) {
  const seen: Seen[] = []
  const sleeps: number[] = []
  const options: TwilioOptions = {
    accountSid: ACCOUNT,
    apiKeySid: KEY,
    apiKeySecret: SECRET,
    authToken: AUTH_TOKEN,
    twimlAppSid: APP,
    store: createMemoryTwilioStore(),
    clock: createFixedClock('2026-01-01T00:00:00.000Z'),
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    fetch: async (input, init) => {
      const headers = (init.headers ?? {}) as Record<string, string>
      const record: Seen = {
        method: init.method ?? 'GET',
        url: input,
        headers,
        form: new URLSearchParams(typeof init.body === 'string' ? init.body : ''),
      }
      seen.push(record)
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
  }
  return { telephony: createTwilioTelephony(options), seen, sleeps, options }
}

/** The happy Twilio: creates things and reports the call in progress. */
function happy(seen: Seen): Reply | undefined {
  const { method, url } = seen
  if (method === 'POST' && url.endsWith('/Calls.json')) {
    return json(201, { sid: CALL_SID, status: 'queued' })
  }
  if (method === 'POST' && url.endsWith(`/Calls/${CALL_SID}.json`)) {
    return json(200, { sid: CALL_SID })
  }
  if (method === 'GET' && url.endsWith(`/Calls/${CALL_SID}.json`)) {
    return json(200, { sid: CALL_SID, status: 'in-progress' })
  }
  if (url.endsWith(`/Calls/${CALL_SID}/Recordings.json`)) {
    return json(201, { sid: RECORDING_SID, status: 'in-progress' })
  }
  if (url.endsWith(`/Calls/${CALL_SID}/Streams.json`)) {
    return json(201, { sid: STREAM_SID, status: 'in-progress' })
  }
  if (method === 'GET' && url.endsWith(`/Recordings/${RECORDING_SID}.json`)) {
    return json(200, { sid: RECORDING_SID, status: 'completed', channels: 2 })
  }
  if (method === 'GET' && url.includes(`/Recordings/${RECORDING_SID}.wav`)) {
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { 'content-type': 'audio/x-wav', 'content-length': '4' },
    })
  }
  if (method === 'DELETE' && url.endsWith(`/Recordings/${RECORDING_SID}.json`)) {
    return new Response(null, { status: 204 })
  }
  return undefined
}

async function placed(h: ReturnType<typeof harness>) {
  const result = await h.telephony.placeCall({
    organizationId: org,
    callId,
    idempotencyKey: 'key-1',
    from: LINE,
    to: PROSPECT,
  })
  return { organizationId: org, providerCallId: result.providerCallId }
}

async function prepared(h: ReturnType<typeof harness>) {
  const ref = await placed(h)
  await h.telephony.playDisclosure({ ...ref, ...wording })
  return ref
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return (error as { code: string }).code
  }
  return 'resolved'
}

describe('twilio telephony: placeCall', () => {
  test('posts a call with basic auth, a hold TwiML and a tagged status callback', async () => {
    const h = harness(happy, { statusCallbackUrl: 'https://voice.example.test/hooks/status' })
    const result = await h.telephony.placeCall({
      organizationId: org,
      callId,
      idempotencyKey: 'key-1',
      from: LINE,
      to: PROSPECT,
    })
    expect(result).toEqual({ providerCallId: CALL_SID, created: true })
    const request = h.seen[0]
    expect(request?.method).toBe('POST')
    expect(request?.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Calls.json`)
    expect(request?.headers.Authorization).toBe(
      `Basic ${Buffer.from(`${KEY}:${SECRET}`).toString('base64')}`
    )
    expect(request?.form.get('To')).toBe(PROSPECT)
    expect(request?.form.get('From')).toBe(LINE)
    expect(request?.form.get('Twiml')).toContain('<Pause')
    expect(request?.form.get('Twiml')).not.toContain('<Say')
    const callback = new URL(request?.form.get('StatusCallback') ?? '')
    expect(callback.searchParams.get('organizationId')).toBe(org)
    expect(callback.searchParams.get('callId')).toBe(callId)
    expect(request?.form.getAll('StatusCallbackEvent')).toEqual([
      'initiated',
      'ringing',
      'answered',
      'completed',
    ])
    expect(request?.headers['I-Twilio-Idempotency-Token']).toMatch(/^[0-9a-f]{64}$/)
  })

  test('the same key places one call; other numbers with the same key are refused', async () => {
    const h = harness(happy)
    const first = await placed(h)
    const again = await h.telephony.placeCall({
      organizationId: org,
      callId,
      idempotencyKey: 'key-1',
      from: LINE,
      to: PROSPECT,
    })
    expect(again).toEqual({ providerCallId: first.providerCallId, created: false })
    expect(h.seen.filter((s) => s.method === 'POST')).toHaveLength(1)
    expect(
      await code(
        h.telephony.placeCall({
          organizationId: org,
          callId,
          idempotencyKey: 'key-1',
          from: LINE,
          to: '+14155550199',
        })
      )
    ).toBe('telephony.invalid_request')
    // the same key in another Organization is a different call
    const other = await h.telephony.placeCall({
      organizationId: otherOrg,
      callId,
      idempotencyKey: 'key-1',
      from: LINE,
      to: PROSPECT,
    })
    expect(other.created).toBe(true)
  })

  test('refuses bad input before any request', async () => {
    const h = harness(happy)
    const base = { organizationId: org, callId, idempotencyKey: 'k', from: LINE, to: PROSPECT }
    for (const bad of [
      { ...base, to: '4155550123' },
      { ...base, from: 'not a number' },
      { ...base, idempotencyKey: '' },
      { ...base, organizationId: 'nope' },
    ]) {
      expect(await code(h.telephony.placeCall(bad as never))).toBe('telephony.invalid_request')
    }
    expect(await code(h.telephony.placeCall(base, { timeoutMs: 0 }))).toBe(
      'telephony.invalid_request'
    )
    expect(h.seen).toHaveLength(0)
  })

  test('a Twilio answer without a call SID is bad_response', async () => {
    const h = harness(() => json(201, { sid: 'nope' }))
    expect(await code(placed(h))).toBe('telephony.bad_response')
  })
})

describe('twilio telephony: inbound, Disclosure, bridge, record, fork, hang up', () => {
  test('answerCall holds the call, claims it for the Organization and is idempotent', async () => {
    const h = harness(happy)
    const request = {
      organizationId: org,
      providerCallId: CALL_SID,
      callId,
      ringIdentities: [rep, otherRep, rep],
    }
    expect(await h.telephony.answerCall(request)).toEqual({ ringing: 2 })
    expect(await h.telephony.answerCall(request)).toEqual({ ringing: 2 })
    expect(h.seen.filter((s) => s.method === 'POST')).toHaveLength(2)
    expect(await code(h.telephony.answerCall({ ...request, organizationId: otherOrg }))).toBe(
      'telephony.not_found'
    )
  })

  test('answerCall on a call that is not up is call_ended', async () => {
    const h = harness((s) =>
      s.method === 'GET' ? json(200, { sid: CALL_SID, status: 'completed' }) : happy(s)
    )
    expect(
      await code(
        h.telephony.answerCall({
          organizationId: org,
          providerCallId: CALL_SID,
          callId,
          ringIdentities: [rep],
        })
      )
    ).toBe('telephony.call_ended')
  })

  test('playDisclosure says the escaped text, waits, confirms the call and reports once per version', async () => {
    const h = harness(happy, { disclosureLanguage: 'en-GB' })
    const ref = await placed(h)
    const played = await h.telephony.playDisclosure({ ...ref, ...wording })
    expect(played).toEqual({
      wordingVersion: 1,
      aiAssisted: true,
      playedAt: '2026-01-01T00:00:00.000Z',
    })
    const twiml = h.seen.find((s) => s.form.get('Twiml')?.includes('<Say'))?.form.get('Twiml')
    expect(twiml).toContain('<Say language="en-GB">This call is recorded &amp; an AI helps.</Say>')
    expect(h.sleeps).toContain(estimateSpeechMs(wording.text))
    const posts = h.seen.filter((s) => s.method === 'POST').length
    expect(await h.telephony.playDisclosure({ ...ref, ...wording })).toEqual(played)
    expect(h.seen.filter((s) => s.method === 'POST')).toHaveLength(posts)
    // a later version plays again and replaces the earlier one
    const later = await h.telephony.playDisclosure({
      ...ref,
      ...wording,
      wordingVersion: 2,
      aiAssisted: false,
    })
    expect(later.aiAssisted).toBe(false)
    expect(
      await code(h.telephony.forkTracks({ ...ref, destinationUrl: 'wss://a.example/s' }))
    ).toBe('telephony.disclosure_required')
  })

  test('a Disclosure that cannot finish in the timeout is unavailable and plays nothing', async () => {
    const h = harness(happy)
    const ref = await placed(h)
    const posts = h.seen.filter((s) => s.method === 'POST').length
    const long = { ...wording, text: 'word '.repeat(200) }
    expect(await code(h.telephony.playDisclosure({ ...ref, ...long }, { timeoutMs: 5000 }))).toBe(
      'telephony.unavailable'
    )
    expect(h.seen.filter((s) => s.method === 'POST')).toHaveLength(posts)
  })

  test('the disclosureDone hook replaces the estimate', async () => {
    const waits: string[] = []
    const h = harness(happy, {
      disclosureDone: async (wait) => {
        waits.push(wait.providerCallId)
      },
    })
    const ref = await placed(h)
    await h.telephony.playDisclosure({ ...ref, ...wording })
    expect(waits).toEqual([CALL_SID])
    expect(h.sleeps).toEqual([])
  })

  test('a call the Prospect left during the Disclosure is call_ended and not recorded as played', async () => {
    let up = true
    const h = harness((s) =>
      s.method === 'GET' && s.url.endsWith(`/Calls/${CALL_SID}.json`)
        ? json(200, { status: up ? 'in-progress' : 'completed' })
        : happy(s)
    )
    const ref = await placed(h)
    up = false
    expect(await code(h.telephony.playDisclosure({ ...ref, ...wording }))).toBe(
      'telephony.call_ended'
    )
    expect(await code(h.telephony.bridge({ ...ref, repIdentity: rep }))).toBe(
      'telephony.disclosure_required'
    )
  })

  test('bridge, record and fork are refused before the Disclosure, with no request to Twilio', async () => {
    const h = harness(happy)
    const ref = await placed(h)
    const posts = h.seen.length
    expect(await code(h.telephony.bridge({ ...ref, repIdentity: rep }))).toBe(
      'telephony.disclosure_required'
    )
    expect(await code(h.telephony.startRecording(ref))).toBe('telephony.disclosure_required')
    expect(
      await code(h.telephony.forkTracks({ ...ref, destinationUrl: 'wss://copilot.example/s' }))
    ).toBe('telephony.disclosure_required')
    expect(h.seen).toHaveLength(posts)
  })

  test('forking needs a Disclosure that said an AI takes part', async () => {
    const h = harness(happy)
    const ref = await placed(h)
    await h.telephony.playDisclosure({ ...ref, ...wording, aiAssisted: false })
    expect(
      await code(h.telephony.forkTracks({ ...ref, destinationUrl: 'wss://copilot.example/s' }))
    ).toBe('telephony.disclosure_required')
  })

  test('bridge dials the Rep client once and moves to another Rep', async () => {
    const h = harness(happy)
    const ref = await prepared(h)
    await h.telephony.bridge({ ...ref, repIdentity: rep })
    const dials = () => h.seen.filter((s) => s.form.get('Twiml')?.includes('<Dial'))
    expect(dials()).toHaveLength(1)
    expect(dials()[0]?.form.get('Twiml')).toContain(`<Identity>${rep}</Identity>`)
    expect(dials()[0]?.form.get('Twiml')).toContain('answerOnBridge="true"')
    await h.telephony.bridge({ ...ref, repIdentity: rep })
    expect(dials()).toHaveLength(1)
    await h.telephony.bridge({ ...ref, repIdentity: otherRep })
    expect(dials()).toHaveLength(2)
  })

  test('startRecording is always dual-channel and returns the first Recording again', async () => {
    const h = harness(happy, {
      recordingStatusCallbackUrl: 'https://voice.example.test/hooks/recording',
    })
    const ref = await prepared(h)
    const first = await h.telephony.startRecording(ref)
    expect(first).toEqual({ recordingId: RECORDING_SID, channels: 2 })
    expect(await h.telephony.startRecording(ref)).toEqual(first)
    const posts = h.seen.filter((s) => s.url.endsWith('/Recordings.json'))
    expect(posts).toHaveLength(1)
    expect(posts[0]?.form.get('RecordingChannels')).toBe('dual')
    expect(posts[0]?.form.get('RecordingTrack')).toBe('both')
    const callback = new URL(posts[0]?.form.get('RecordingStatusCallback') ?? '')
    expect(callback.searchParams.get('organizationId')).toBe(org)
  })

  test('forkTracks streams both tracks to a wss URL, once', async () => {
    const h = harness(happy)
    const ref = await prepared(h)
    const forked = await h.telephony.forkTracks({
      ...ref,
      destinationUrl: 'wss://copilot.example/s',
    })
    expect(forked).toEqual({ streamId: STREAM_SID, tracks: ['rep', 'prospect'] })
    expect(
      await h.telephony.forkTracks({ ...ref, destinationUrl: 'wss://copilot.example/s' })
    ).toEqual(forked)
    const posts = h.seen.filter((s) => s.url.endsWith('/Streams.json'))
    expect(posts).toHaveLength(1)
    expect(posts[0]?.form.get('Track')).toBe('both_tracks')
    expect(posts[0]?.form.get('Url')).toBe('wss://copilot.example/s')
    for (const bad of [
      'ws://copilot.example/s',
      'https://x.example',
      'wss://u:p@x.example/s',
      '',
    ]) {
      expect(await code(h.telephony.forkTracks({ ...ref, destinationUrl: bad }))).toBe(
        'telephony.invalid_request'
      )
    }
  })

  test('a ws fork URL is accepted only when the adapter runs in local', async () => {
    const h = harness(happy, { environment: 'local' })
    const ref = await prepared(h)
    expect(
      (await h.telephony.forkTracks({ ...ref, destinationUrl: 'ws://127.0.0.1:9/s' })).streamId
    ).toBe(STREAM_SID)
  })

  test('hangUp completes the call, swallows call_ended and refuses another Organization', async () => {
    let ended = false
    const h = harness((s) =>
      ended && s.method === 'POST' && s.url.endsWith(`/Calls/${CALL_SID}.json`)
        ? json(400, { code: 21220, message: 'Call is not in-progress' })
        : happy(s)
    )
    const ref = await placed(h)
    await h.telephony.hangUp({ ...ref, by: 'rep' })
    expect(h.seen.at(-1)?.form.get('Status')).toBe('completed')
    ended = true
    await h.telephony.hangUp(ref)
    expect(await code(h.telephony.hangUp({ ...ref, organizationId: otherOrg }))).toBe(
      'telephony.not_found'
    )
    expect(
      await code(h.telephony.hangUp({ organizationId: org, providerCallId: `CA${'9'.repeat(32)}` }))
    ).toBe('telephony.not_found')
  })

  test('another Organization reaches none of a call', async () => {
    const h = harness(happy)
    const ref = await prepared(h)
    const foreign = { ...ref, organizationId: otherOrg }
    expect(await code(h.telephony.playDisclosure({ ...foreign, ...wording }))).toBe(
      'telephony.not_found'
    )
    expect(await code(h.telephony.bridge({ ...foreign, repIdentity: rep }))).toBe(
      'telephony.not_found'
    )
    expect(await code(h.telephony.startRecording(foreign))).toBe('telephony.not_found')
    expect(
      await code(h.telephony.forkTracks({ ...foreign, destinationUrl: 'wss://copilot.example/s' }))
    ).toBe('telephony.not_found')
  })
})

describe('twilio telephony: recordings', () => {
  test('fetchRecording opens a two-channel wav as a stream', async () => {
    const h = harness(happy)
    const ref = await prepared(h)
    const { recordingId } = await h.telephony.startRecording(ref)
    const fetched = await h.telephony.fetchRecording({ organizationId: org, recordingId })
    expect(fetched.channels).toBe(2)
    expect(fetched.contentType).toBe('audio/x-wav')
    expect(fetched.sizeBytes).toBe(4)
    const bytes: number[] = []
    for await (const chunk of fetched.body as AsyncIterable<Uint8Array>) {
      bytes.push(...chunk)
    }
    expect(bytes).toEqual([1, 2, 3, 4])
    expect(h.seen.at(-1)?.url).toContain('RequestedChannels=2')
  })

  test('a Recording that is still going is recording_not_ready; one that is gone is not_found', async () => {
    let status = 'in-progress'
    const h = harness((s) =>
      s.method === 'GET' && s.url.endsWith(`/Recordings/${RECORDING_SID}.json`)
        ? json(200, { status, channels: 2 })
        : happy(s)
    )
    const ref = await prepared(h)
    const { recordingId } = await h.telephony.startRecording(ref)
    const request = { organizationId: org, recordingId }
    expect(await code(h.telephony.fetchRecording(request))).toBe('telephony.recording_not_ready')
    status = 'absent'
    expect(await code(h.telephony.fetchRecording(request))).toBe('telephony.not_found')
  })

  test('a Recording with one channel is bad_response', async () => {
    const h = harness((s) =>
      s.method === 'GET' && s.url.endsWith(`/Recordings/${RECORDING_SID}.json`)
        ? json(200, { status: 'completed', channels: 1 })
        : happy(s)
    )
    const ref = await prepared(h)
    const { recordingId } = await h.telephony.startRecording(ref)
    expect(await code(h.telephony.fetchRecording({ organizationId: org, recordingId }))).toBe(
      'telephony.bad_response'
    )
  })

  test('another Organization cannot fetch or delete a Recording', async () => {
    const h = harness(happy)
    const ref = await prepared(h)
    const { recordingId } = await h.telephony.startRecording(ref)
    expect(await code(h.telephony.fetchRecording({ organizationId: otherOrg, recordingId }))).toBe(
      'telephony.not_found'
    )
    const requests = h.seen.length
    expect(await h.telephony.deleteRecording({ organizationId: otherOrg, recordingId })).toEqual({
      existed: false,
    })
    expect(h.seen).toHaveLength(requests)
  })

  test('deleteRecording reports existed, then false for a 404 or an unknown id', async () => {
    let gone = false
    const h = harness((s) =>
      gone && s.method === 'DELETE' ? json(404, { code: 20404 }) : happy(s)
    )
    const ref = await prepared(h)
    const { recordingId } = await h.telephony.startRecording(ref)
    const request = { organizationId: org, recordingId }
    expect(await h.telephony.deleteRecording(request)).toEqual({ existed: true })
    gone = true
    expect(await h.telephony.deleteRecording(request)).toEqual({ existed: false })
    expect(
      await h.telephony.deleteRecording({ organizationId: org, recordingId: 'RE-never' })
    ).toEqual({ existed: false })
  })
})

describe('twilio telephony: retries, timeouts and errors', () => {
  test('a 5xx and a network error are retried with jittered backoff, then succeed', async () => {
    let calls = 0
    const h = harness(
      (s) => {
        if (s.method === 'POST' && s.url.endsWith('/Calls.json')) {
          calls++
          if (calls === 1) {
            return json(503, { code: 20503 })
          }
          if (calls === 2) {
            return new Error('connect ECONNRESET 10.0.0.1')
          }
        }
        return happy(s)
      },
      { random: () => 0 }
    )
    expect((await placed(h)).providerCallId).toBe(CALL_SID)
    expect(calls).toBe(3)
    // jitter at random 0 is half the base: 100 -> 50, 200 -> 100
    expect(h.sleeps).toEqual([50, 100])
  })

  test('jitter stays between half and one and a half of the base', async () => {
    const pauses: number[] = []
    for (const r of [0, 0.5, 0.999]) {
      const h = harness(() => json(500, {}), { random: () => r, maxAttempts: 2 })
      await code(placed(h))
      pauses.push(...h.sleeps)
    }
    expect(pauses).toEqual([50, 100, 149])
  })

  test('retries stop at the bounded number of attempts and map to unavailable', async () => {
    const h = harness(() => json(502, { code: 20502 }))
    expect(await code(placed(h))).toBe('telephony.unavailable')
    expect(h.seen).toHaveLength(3)
    const limited = harness(() => json(429, {}), { maxAttempts: 2 })
    expect(await code(placed(limited))).toBe('telephony.unavailable')
    expect(limited.seen).toHaveLength(2)
  })

  test('a 4xx is never retried', async () => {
    for (const [status, expected] of [
      [400, 'telephony.rejected'],
      [401, 'telephony.rejected'],
      [403, 'telephony.rejected'],
      [404, 'telephony.not_found'],
      [409, 'telephony.rejected'],
    ] as const) {
      const h = harness(() => json(status, { code: 21211, message: 'The To number is invalid' }))
      expect(await code(placed(h))).toBe(expected)
      expect(h.seen).toHaveLength(1)
    }
  })

  test('Twilio call-not-in-progress maps to call_ended', async () => {
    const h = harness((s) =>
      s.method === 'POST' && s.url.endsWith(`/Calls/${CALL_SID}.json`)
        ? json(400, { code: 21220 })
        : happy(s)
    )
    const ref = await placed(h)
    expect(await code(h.telephony.playDisclosure({ ...ref, ...wording }))).toBe(
      'telephony.call_ended'
    )
  })

  test('a stalled request gives unavailable at the timeout and is not retried', async () => {
    const h = harness(() => 'hang')
    const started = Date.now()
    expect(
      await code(
        h.telephony.placeCall(
          { organizationId: org, callId, idempotencyKey: 'k', from: LINE, to: PROSPECT },
          { timeoutMs: 30 }
        )
      )
    ).toBe('telephony.unavailable')
    expect(Date.now() - started).toBeLessThan(1000)
    expect(h.seen).toHaveLength(1)
  })

  test('every operation gives unavailable when Twilio stalls, and recovers', async () => {
    let stall = false
    const h = harness((s) => (stall ? 'hang' : happy(s)))
    const ref = await prepared(h)
    const { recordingId } = await h.telephony.startRecording(ref)
    const t = { timeoutMs: 20 }
    stall = true
    const calls: (() => Promise<unknown>)[] = [
      () =>
        h.telephony.placeCall(
          { organizationId: org, callId, idempotencyKey: 'k2', from: LINE, to: PROSPECT },
          t
        ),
      () =>
        h.telephony.answerCall(
          {
            organizationId: org,
            providerCallId: `CA${'8'.repeat(32)}`,
            callId,
            ringIdentities: [rep],
          },
          t
        ),
      () => h.telephony.playDisclosure({ ...ref, ...wording, wordingVersion: 9 }, t),
      () => h.telephony.bridge({ ...ref, repIdentity: rep }, t),
      () => h.telephony.hangUp(ref, t),
      () => h.telephony.fetchRecording({ organizationId: org, recordingId }, t),
      () => h.telephony.deleteRecording({ organizationId: org, recordingId }, t),
    ]
    for (const call of calls) {
      expect(await code(call())).toBe('telephony.unavailable')
    }
    stall = false
    await h.telephony.hangUp(ref)
  })

  test('a non-JSON or oversized success answer is bad_response', async () => {
    const text = harness(() => new Response('<html>oops</html>', { status: 201 }))
    expect(await code(placed(text))).toBe('telephony.bad_response')
    const redirect = harness(
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })
    )
    expect(await code(placed(redirect))).toBe('telephony.bad_response')
    const big = harness(
      () => new Response('{"sid":"'.concat('x'.repeat(1_100_000), '"}'), { status: 201 })
    )
    expect(await code(placed(big))).toBe('telephony.bad_response')
  })

  test('the Ireland region calls the Dublin edge host', async () => {
    expect(twilioApiHost()).toBe('api.twilio.com')
    expect(twilioApiHost('ie1')).toBe('api.dublin.ie1.twilio.com')
    expect(twilioApiHost('ie1', 'dublin')).toBe('api.dublin.ie1.twilio.com')
    expect(twilioApiHost('us1')).toBe('api.ashburn.us1.twilio.com')
    expect(() => twilioApiHost('ie1', 'evil.example/x')).toThrow(TypeError)
    expect(() => twilioApiHost(undefined, 'dublin')).toThrow(TypeError)
    const h = harness(happy, { region: 'ie1' })
    await placed(h)
    expect(h.seen[0]?.url.startsWith('https://api.dublin.ie1.twilio.com/')).toBe(true)
  })

  test('construction refuses bad options without echoing them', () => {
    const good = harness(happy).options
    for (const bad of [
      { accountSid: 'AC-nope-secret-value' },
      { apiKeySid: 'nope' },
      { apiKeySecret: 'short' },
      { twimlAppSid: 'nope' },
      { authToken: 'short' },
      { disclosureLanguage: 'en US; drop' },
      { statusCallbackUrl: 'http://insecure.example/x' },
      { defaultTimeoutMs: 0 },
      { maxAttempts: 0 },
    ]) {
      let message = ''
      try {
        createTwilioTelephony({ ...good, ...bad })
      } catch (error) {
        message = (error as Error).message
      }
      expect(message).not.toBe('')
      expect(message).not.toContain('secret-value')
      expect(message).not.toContain('insecure')
    }
  })
})

describe('twilio telephony: verifyWebhook', () => {
  const url = 'https://voice.example.test/hooks/status?organizationId=o1'
  const params = { CallSid: CALL_SID, CallStatus: 'completed', To: '+14155550123', Alpha: 'b a' }
  const body = new URLSearchParams(params).toString()
  const { telephony } = harness(happy)

  test('accepts a genuine signature over the URL and sorted parameters', () => {
    const signature = signTwilioRequest(AUTH_TOKEN, url, params)
    expect(telephony.verifyWebhook({ url, body, signature })).toBe(true)
  })

  test('matches a known HMAC-SHA1 vector', () => {
    // Twilio's documentation example (token 12345, URL https://mycompany.com/myapp.php?foo=1&bar=2)
    const vector = signTwilioRequest('12345', 'https://mycompany.com/myapp.php?foo=1&bar=2', {
      Digits: '1234',
      To: '+18005551212',
      From: '+14158675310',
      Caller: '+14158675310',
      CallSid: 'CA1234567890ABCDE',
    })
    expect(vector).toBe('GvWf1cFY/Q7PnoempGyD5oXAezc=')
  })

  test('accepts the URL with or without the default port', () => {
    const portless = 'https://voice.example.test/hooks/status'
    const signature = signTwilioRequest(
      AUTH_TOKEN,
      `${portless.replace('.test/', '.test:443/')}`,
      params
    )
    expect(telephony.verifyWebhook({ url: portless, body, signature })).toBe(true)
  })

  test('refuses every wrong, missing, short or long signature and never throws', () => {
    const good = signTwilioRequest(AUTH_TOKEN, url, params)
    const other = signTwilioRequest('another-auth-token-0123456789', url, params)
    for (const signature of [
      other,
      good.slice(1),
      `${good}A`,
      '',
      null,
      undefined,
      'x'.repeat(1000),
      good.toLowerCase() === good ? good.toUpperCase() : good.toLowerCase(),
    ]) {
      expect(telephony.verifyWebhook({ url, body, signature })).toBe(false)
    }
    expect(telephony.verifyWebhook({ url, body: `${body}&Extra=1`, signature: good })).toBe(false)
    expect(telephony.verifyWebhook({ url: `${url}&x=1`, body, signature: good })).toBe(false)
    for (const garbage of [null, undefined, 42, {}, { url: 1, body: 2, signature: 3 }]) {
      expect(telephony.verifyWebhook(garbage as never)).toBe(false)
    }
  })

  test('refuses an oversize body even with a valid signature', () => {
    const huge = `A=${'x'.repeat(MAX_WEBHOOK_BODY_BYTES)}`
    const signature = signTwilioRequest(AUTH_TOKEN, url, { A: 'x'.repeat(MAX_WEBHOOK_BODY_BYTES) })
    expect(telephony.verifyWebhook({ url, body: huge, signature })).toBe(false)
  })

  test('a JSON webhook is checked by the body hash in the URL', () => {
    const payload = '{"a":1}'
    const hash = createHash('sha256').update(payload).digest('hex')
    const jsonUrl = `https://voice.example.test/hooks/recording?bodySHA256=${hash}`
    const signature = signTwilioRequest(AUTH_TOKEN, jsonUrl)
    expect(telephony.verifyWebhook({ url: jsonUrl, body: payload, signature })).toBe(true)
    expect(telephony.verifyWebhook({ url: jsonUrl, body: '{"a":2}', signature })).toBe(false)
  })

  test('without an Auth Token every webhook is refused', () => {
    const { options } = harness(happy)
    const bare = createTwilioTelephony({ ...options, authToken: undefined })
    const signature = signTwilioRequest(AUTH_TOKEN, url, params)
    expect(bare.verifyWebhook({ url, body, signature })).toBe(false)
  })
})

describe('twilio telephony: mintBrowserToken', () => {
  test('mints a Voice SDK access token whose grants carry the identity and the Organization', async () => {
    const h = harness(happy)
    const minted = await h.telephony.mintBrowserToken({ organizationId: org, identity: rep })
    expect(minted.identity).toBe(rep)
    expect(minted.ttlSeconds).toBe(900)
    expect(minted.expiresAt).toBe('2026-01-01T00:15:00.000Z')
    expect(minted.token).not.toContain(org)
    expect(minted.token).not.toContain(rep)
    const { payload, protectedHeader } = await jwtVerify(
      minted.token,
      new TextEncoder().encode(SECRET),
      { currentDate: new Date('2026-01-01T00:00:30.000Z') }
    )
    expect(protectedHeader).toMatchObject({ alg: 'HS256', cty: 'twilio-fpa;v=1' })
    expect(payload.iss).toBe(KEY)
    expect(payload.sub).toBe(ACCOUNT)
    expect(payload.exp).toBe(Math.floor(Date.parse('2026-01-01T00:15:00.000Z') / 1000))
    expect(payload.grants).toEqual({
      identity: rep,
      voice: {
        incoming: { allow: true },
        outgoing: { application_sid: APP, params: { organizationId: org } },
      },
    })
    expect(h.seen).toHaveLength(0)
  })

  test('each token differs and the lifetime is bounded', async () => {
    const h = harness(happy)
    const request = { organizationId: org, identity: rep }
    const a = await h.telephony.mintBrowserToken(request)
    const b = await h.telephony.mintBrowserToken(request)
    expect(a.token).not.toBe(b.token)
    expect((await h.telephony.mintBrowserToken({ ...request, ttlSeconds: 60 })).ttlSeconds).toBe(60)
    for (const ttlSeconds of [59, 3601, 1.5, Number.NaN]) {
      expect(await code(h.telephony.mintBrowserToken({ ...request, ttlSeconds }))).toBe(
        'telephony.invalid_request'
      )
    }
    expect(await code(h.telephony.mintBrowserToken(request, { timeoutMs: 0 }))).toBe(
      'telephony.invalid_request'
    )
    expect(
      await code(h.telephony.mintBrowserToken({ organizationId: 'x' as never, identity: rep }))
    ).toBe('telephony.invalid_request')
  })
})

describe('twilio telephony: nothing sensitive leaks', () => {
  test('no error message or detail carries a number, secret, token, text or recording URL', async () => {
    const secrets = [
      SECRET,
      AUTH_TOKEN,
      KEY,
      PROSPECT,
      LINE,
      wording.text,
      'https://api.twilio.com',
      'media.twiliocdn.example',
    ]
    const leaky = (status: number) =>
      json(status, {
        code: 21211,
        message: `The number ${PROSPECT} is invalid for ${LINE} ${SECRET} ${wording.text}`,
        more_info: 'https://media.twiliocdn.example/rec.wav',
      })
    const errors: unknown[] = []
    const collect = async (promise: Promise<unknown>) => {
      try {
        await promise
      } catch (error) {
        errors.push(error)
      }
    }
    for (const reply of [
      () => leaky(400),
      () => leaky(401),
      () => leaky(404),
      () => leaky(500),
      () => new Error(`connect failed for ${PROSPECT} with ${SECRET}`),
    ]) {
      const h = harness(() => reply())
      await collect(placed(h))
    }
    const h = harness(happy)
    const ref = await placed(h)
    await collect(h.telephony.bridge({ ...ref, repIdentity: rep }))
    await collect(
      h.telephony.placeCall({
        organizationId: org,
        callId,
        idempotencyKey: 'bad key with spaces',
        from: LINE,
        to: PROSPECT,
      })
    )
    await collect(
      h.telephony.mintBrowserToken({ organizationId: org, identity: rep, ttlSeconds: 1 })
    )
    expect(errors.length).toBeGreaterThanOrEqual(8)
    for (const error of errors) {
      const e = error as Error & { cause?: unknown; details?: unknown }
      const text = JSON.stringify({
        name: e.name,
        message: e.message,
        details: e.details,
        cause: e.cause,
        stack: e.stack,
      })
      for (const secret of secrets) {
        expect(text).not.toContain(secret)
      }
      expect(e.cause).toBeUndefined()
    }
  })

  test('the adapter source never logs and never reads the environment', () => {
    for (const file of ['twilio.ts', 'twilio-http.ts']) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
      expect(source).not.toMatch(/console\./)
      expect(source).not.toMatch(/process\.env/)
      expect(source).not.toMatch(/\blogger\b|\blog\(/)
    }
  })

  test('the default store keeps no number', async () => {
    const store = createMemoryTwilioStore()
    const h = harness(happy, { store })
    await placed(h)
    const placement = await store.getPlacement(org, 'key-1')
    expect(JSON.stringify(placement)).not.toContain(PROSPECT)
    expect(JSON.stringify(placement)).not.toContain(LINE)
  })
})

describe('twilio telephony: review round 1 regressions', () => {
  test('a Disclosure in unspaced text is estimated by its length, erring long', () => {
    expect(estimateSpeechMs('x'.repeat(200))).toBeGreaterThanOrEqual(15_000)
    expect(estimateSpeechMs('\u65e5'.repeat(200))).toBeGreaterThanOrEqual(15_000)
  })

  test('playDisclosure waits the length-based estimate before it counts as played', async () => {
    const h = harness(happy)
    const ref = await placed(h)
    const text = 'x'.repeat(200)
    await h.telephony.playDisclosure({ ...ref, ...wording, text }, { timeoutMs: 60_000 })
    expect(h.sleeps).toContain(estimateSpeechMs(text))
  })

  test('without a durable store only local and dev may start', () => {
    const { store: _store, ...rest } = harness(happy).options
    for (const environment of [undefined, 'prod', 'staging'] as const) {
      expect(() =>
        createTwilioTelephony({ ...rest, ...(environment ? { environment } : {}) })
      ).toThrow(TypeError)
    }
    for (const environment of ['local', 'dev'] as const) {
      expect(() => createTwilioTelephony({ ...rest, environment })).not.toThrow()
    }
  })

  test('two Organizations answering the same record-less call: only one claims it', async () => {
    const h = harness(happy)
    const base = { providerCallId: CALL_SID, callId, ringIdentities: [rep] }
    const results = await Promise.allSettled([
      h.telephony.answerCall({ ...base, organizationId: org }),
      h.telephony.answerCall({ ...base, organizationId: otherOrg }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect((failed.reason as { code: string }).code).toBe('telephony.not_found')
  })

  test('a Recording download that stalls after the headers is cut off at the deadline', async () => {
    const h = harness((s) => {
      if (s.method === 'GET' && s.url.includes(`/Recordings/${RECORDING_SID}.wav`)) {
        return new Response(new ReadableStream<Uint8Array>({ start: () => undefined }), {
          status: 200,
          headers: { 'content-type': 'audio/x-wav' },
        })
      }
      return happy(s)
    })
    const ref = await prepared(h)
    const { recordingId } = await h.telephony.startRecording(ref)
    const fetched = await h.telephony.fetchRecording(
      { organizationId: org, recordingId },
      { timeoutMs: 50 }
    )
    const reader = (fetched.body as ReadableStream<Uint8Array>).getReader()
    const outcome = await Promise.race([
      reader.read().then(
        () => 'read',
        () => 'rejected'
      ),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 1000)),
    ])
    expect(outcome).toBe('rejected')
  })

  test('a new Disclosure version drops the Rep leg, so the next bridge dials again', async () => {
    const h = harness(happy)
    const ref = await prepared(h)
    await h.telephony.bridge({ ...ref, repIdentity: rep })
    await h.telephony.playDisclosure({ ...ref, ...wording, wordingVersion: 2 })
    await h.telephony.bridge({ ...ref, repIdentity: rep })
    expect(h.seen.filter((s) => s.form.get('Twiml')?.includes('<Dial'))).toHaveLength(2)
  })

  test('concurrent startRecording and forkTracks keep both ids with a slow store', async () => {
    const inner = createMemoryTwilioStore()
    const store = {
      ...inner,
      getCall: async (id: string) => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return inner.getCall(id)
      },
    }
    const h = harness(happy, { store })
    const ref = await prepared(h)
    await Promise.all([
      h.telephony.startRecording(ref),
      h.telephony.forkTracks({ ...ref, destinationUrl: 'wss://copilot.example/s' }),
    ])
    const record = await inner.getCall(CALL_SID)
    expect(record?.recordingId).toBe(RECORDING_SID)
    expect(record?.streamId).toBe(STREAM_SID)
  })

  test('a signature for the default port is not accepted for another port', () => {
    const { telephony } = harness(happy)
    const signature = signTwilioRequest(AUTH_TOKEN, 'https://h.example/p', { A: '1' })
    expect(telephony.verifyWebhook({ url: 'https://h.example/p', body: 'A=1', signature })).toBe(
      true
    )
    expect(
      telephony.verifyWebhook({ url: 'https://h.example:8443/p', body: 'A=1', signature })
    ).toBe(false)
  })
})

describe('twilio telephony: answerCall retry', () => {
  const request = { organizationId: org, providerCallId: CALL_SID, callId, ringIdentities: [rep] }
  const isHold = (s: Seen) => s.method === 'POST' && s.url.endsWith(`/Calls/${CALL_SID}.json`)

  test('a retry after a failed hold update re-sends the hold', async () => {
    let fail = true
    const h = harness(
      (s) => {
        if (isHold(s) && fail) {
          return json(400, { code: 21220, message: 'bad' })
        }
        return happy(s)
      },
      { defaultTimeoutMs: 5000 }
    )
    await expect(h.telephony.answerCall(request)).rejects.toThrow()
    fail = false
    expect(await h.telephony.answerCall(request)).toEqual({ ringing: 1 })
    expect(h.seen.filter((s) => isHold(s) && s.form.get('Twiml')?.includes('<Pause'))).toHaveLength(
      2
    )
  })

  test('a retry after the Disclosure played does not replace the call TwiML', async () => {
    const h = harness(happy)
    await h.telephony.answerCall(request)
    await h.telephony.playDisclosure({ organizationId: org, providerCallId: CALL_SID, ...wording })
    const before = h.seen.filter(isHold).length
    await h.telephony.answerCall(request)
    expect(h.seen.filter(isHold)).toHaveLength(before)
  })

  test('a retry while the Disclosure is being spoken does not cut it off', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = harness(happy, { disclosureDone: () => gate })
    await h.telephony.answerCall(request)
    const playing = h.telephony.playDisclosure({
      organizationId: org,
      providerCallId: CALL_SID,
      ...wording,
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const before = h.seen.filter(isHold).length
    await h.telephony.answerCall(request)
    expect(h.seen.filter(isHold)).toHaveLength(before)
    release()
    await playing
  })

  test('a retry on a call we placed, or with another call id, sends no hold', async () => {
    const h = harness(happy)
    const ref = await placed(h)
    const before = h.seen.filter(isHold).length
    await h.telephony.answerCall({ ...request, organizationId: ref.organizationId })
    expect(h.seen.filter(isHold)).toHaveLength(before)
    const inbound = harness(happy)
    await inbound.telephony.answerCall(request)
    const held = inbound.seen.filter(isHold).length
    await inbound.telephony.answerCall({
      ...request,
      callId: callIdSchema.parse(`call_${'d'.repeat(32)}`),
    })
    expect(inbound.seen.filter(isHold)).toHaveLength(held)
  })

  test('a hold gated in flight can never land after the Disclosure Say', async () => {
    let gated = false
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const landed: string[] = []
    const h = harness(async (s) => {
      const twiml = s.form.get('Twiml')
      if (isHold(s) && twiml) {
        const kind = twiml.includes('<Say') ? 'say' : 'hold'
        if (kind === 'hold' && gated) {
          await gate
        }
        landed.push(kind)
      }
      return happy(s)
    })
    await h.telephony.answerCall(request)
    landed.length = 0
    gated = true
    const retry = h.telephony.answerCall(request)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const playing = h.telephony.playDisclosure({
      organizationId: org,
      providerCallId: CALL_SID,
      ...wording,
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    release()
    await Promise.all([retry, playing])
    expect(landed.at(-1)).toBe('say')
  })

  test('the first answerCall hold, in flight, can never land after the Disclosure Say', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const landed: string[] = []
    const h = harness(async (s) => {
      const twiml = s.form.get('Twiml')
      if (isHold(s) && twiml) {
        const kind = twiml.includes('<Say') ? 'say' : 'hold'
        if (kind === 'hold') {
          await gate
        }
        landed.push(kind)
      }
      return happy(s)
    })
    const first = h.telephony.answerCall(request)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const playing = h.telephony.playDisclosure({
      organizationId: org,
      providerCallId: CALL_SID,
      ...wording,
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    release()
    await Promise.all([first, playing])
    expect(landed.at(-1)).toBe('say')
  })
})
