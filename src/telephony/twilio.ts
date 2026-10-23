import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { SignJWT } from 'jose'
import type { SoftphoneToken } from 'tula-closeline-contract'
import { type Clock, systemClock } from '../clock'
import { type Sleep, systemSleep } from '../queue/sleep'
import type { Environment } from '../reporting/env'
import { TELEPHONY_ERROR_CODES, TelephonyError } from './errors'
import {
  type AnswerCallRequest,
  type AnsweredCall,
  type BridgeRequest,
  type BrowserTokenRequest,
  DEFAULT_TELEPHONY_TIMEOUT_MS,
  type DisclosurePlayed,
  type FetchedRecording,
  type ForkedTracks,
  type ForkTracksRequest,
  type HangUpRequest,
  MAX_WEBHOOK_BODY_BYTES,
  type PlaceCallRequest,
  type PlacedCall,
  type PlayDisclosureRequest,
  type ProviderCallRef,
  type RecordingRef,
  type StartedRecording,
  type TelephonyOptions,
  type TelephonyPort,
  type WebhookRequest,
} from './port'
import { createTwilioHttp, type TwilioFetch, type TwilioHttp } from './twilio-http'
import {
  checkCallId,
  checkDestinationUrl,
  checkDisclosure,
  checkIdentity,
  checkNumber,
  checkOrganizationId,
  checkProviderId,
  checkRingIdentities,
  invalid,
  requireDisclosure,
  resolveTimeout,
} from './validate'

/** The Twilio regions this adapter knows, as Twilio names them in a host (`api.dublin.ie1.twilio.com`). */
export const TWILIO_REGIONS = ['us1', 'ie1', 'au1'] as const

/** One of {@link TWILIO_REGIONS}. */
export type TwilioRegion = (typeof TWILIO_REGIONS)[number]

/** The edge Twilio serves each region from by default. */
export const TWILIO_DEFAULT_EDGES: Readonly<Record<TwilioRegion, string>> = {
  us1: 'ashburn',
  ie1: 'dublin',
  au1: 'sydney',
}

/** The edge names this adapter accepts: letters, digits and `-`, as in `dublin` or `sao-paulo`. */
const EDGE = /^[a-z][a-z0-9-]{1,30}$/

/** What the adapter remembers about one provider call, since Twilio has no tag to hold it. */
export interface TwilioCallRecord {
  /** The Organization the call belongs to. */
  organizationId: string
  /** Our Call id, when known. */
  callId: string | null
  /** Placed by us, or received. */
  direction: 'outbound' | 'inbound'
  /** The Disclosure that has played on the call, or null. */
  disclosure: DisclosurePlayed | null
  /** The Rep whose browser leg the call is bridged to, or null. */
  bridgedTo: string | null
  /** The Reps the inbound call was meant to ring. */
  ringIdentities: readonly string[]
  /** The Recording started on the call, or null. */
  recordingId: string | null
  /** The stream forked from the call, or null. */
  streamId: string | null
}

/** What the adapter remembers about a placement, to answer a repeated idempotency key. */
export interface TwilioPlacement {
  /** The provider call the key placed. */
  providerCallId: string
  /** A keyed hash of the numbers; a repeat with other numbers is refused. Never the numbers. */
  fingerprint: string
}

/**
 * Where the adapter keeps the Organization of each provider call, the state of its Disclosure and
 * its idempotency keys. Twilio holds none of it, and the port promises that one Organization never
 * reaches another's calls, so a production service must pass a durable store (Postgres, in its own
 * schema). Omitting it (in process memory) is allowed only in the `local` and `dev` environments. A store that has lost
 * a call fails closed: the call is `telephony.not_found`, or its Disclosure counts as not played.
 */
export interface TwilioStore {
  /** Returns the record of a provider call, or null. */
  getCall(providerCallId: string): Promise<TwilioCallRecord | null>
  /** Creates or replaces the record of a provider call. */
  putCall(providerCallId: string, record: TwilioCallRecord): Promise<void>
  /**
   * Atomically creates the record when none exists and returns the record that now stands, which
   * is the caller's own when it won and the earlier one when it lost.
   */
  claimCall(providerCallId: string, record: TwilioCallRecord): Promise<TwilioCallRecord>
  /** Returns the provider call a Recording belongs to, or null. */
  getRecording(recordingId: string): Promise<{ providerCallId: string } | null>
  /** Remembers which provider call a Recording belongs to. */
  putRecording(recordingId: string, providerCallId: string): Promise<void>
  /** Returns the placement an idempotency key made, or null. */
  getPlacement(organizationId: string, key: string): Promise<TwilioPlacement | null>
  /** Remembers a placement. */
  putPlacement(organizationId: string, key: string, placement: TwilioPlacement): Promise<void>
}

/** Creates the in-process {@link TwilioStore}, for tests and local runs. */
export function createMemoryTwilioStore(): TwilioStore {
  const calls = new Map<string, TwilioCallRecord>()
  const recordings = new Map<string, string>()
  const placements = new Map<string, TwilioPlacement>()
  return {
    getCall: async (id) => calls.get(id) ?? null,
    putCall: async (id, record) => {
      calls.set(id, record)
    },
    claimCall: async (id, record) => {
      const existing = calls.get(id)
      if (existing) {
        return existing
      }
      calls.set(id, record)
      return record
    },
    getRecording: async (id) => {
      const providerCallId = recordings.get(id)
      return providerCallId === undefined ? null : { providerCallId }
    },
    putRecording: async (id, providerCallId) => {
      recordings.set(id, providerCallId)
    },
    getPlacement: async (org, key) => placements.get(`${org}\u0000${key}`) ?? null,
    putPlacement: async (org, key, placement) => {
      placements.set(`${org}\u0000${key}`, placement)
    },
  }
}

/** What {@link TwilioOptions.disclosureDone} is told about the Disclosure it waits for. */
export interface DisclosureWait {
  /** The Organization. */
  organizationId: string
  /** The provider call. */
  providerCallId: string
  /** When the wait must give up, as ms since the epoch. */
  deadline: number
}

/** Options for {@link createTwilioTelephony}. */
export interface TwilioOptions {
  /** The Account SID (`AC` and 32 hex digits). */
  accountSid: string
  /** An API key's SID (`SK` and 32 hex digits): signs requests and Softphone tokens. */
  apiKeySid: string
  /** The API key's secret. A credential: never logged or put in an error. */
  apiKeySecret: string
  /**
   * The Auth Token, used only to check webhook signatures. Twilio signs webhooks with it and not
   * with an API key's secret. Without it `verifyWebhook` is always false.
   */
  authToken?: string
  /** The TwiML App's SID (`AP` and 32 hex digits) the Softphone dials out through. */
  twimlAppSid: string
  /**
   * The Twilio region, such as `ie1` for Ireland. Needs API keys made in that region. Default is
   * the US default host `api.twilio.com`.
   */
  region?: TwilioRegion
  /** The edge, such as `dublin`; default is the region's own edge. Needs `region`. */
  edge?: string
  /** The `ENVIRONMENT`; a `ws:` fork destination is accepted only in `local`; default `prod`. */
  environment?: Environment
  /** Where Twilio reports call progress; the adapter adds `organizationId` and `callId` to the query. */
  statusCallbackUrl?: string
  /** Where Twilio reports a finished Recording; the adapter adds `organizationId` and `callId`. */
  recordingStatusCallbackUrl?: string
  /** The store of per-call state; required outside `local` and `dev`, where it is in memory. */
  store?: TwilioStore
  /** The `fetch` to use; the global one by default. */
  fetch?: TwilioFetch
  /** Waits between retries; real time by default. */
  sleep?: Sleep
  /** A number in `[0, 1)` for retry jitter; `Math.random` by default. */
  random?: () => number
  /** The clock for token and Disclosure times; the system clock by default. */
  clock?: Clock
  /** The wall clock in ms for deadlines; `Date.now` by default. */
  nowMs?: () => number
  /** The timeout of an operation that names none, in ms; default {@link DEFAULT_TELEPHONY_TIMEOUT_MS}. */
  defaultTimeoutMs?: number
  /** The most attempts per request, the first included; default 3. */
  maxAttempts?: number
  /** The language the Disclosure is spoken in, such as `en-US`; default `en-US`. */
  disclosureLanguage?: string
  /**
   * Resolves when the Disclosure has finished playing. Twilio has no "finished speaking" event on
   * a REST update, so by default the adapter waits for an estimate of how long the wording takes
   * (see {@link estimateSpeechMs}). A service with a webhook for it passes a hook that waits for
   * that instead; the hook must throw `telephony.unavailable` if the deadline passes.
   */
  disclosureDone?: (wait: DisclosureWait) => Promise<void>
}

const SID = {
  account: /^AC[0-9a-f]{32}$/,
  apiKey: /^SK[0-9a-f]{32}$/,
  app: /^AP[0-9a-f]{32}$/,
} as const
const LANGUAGE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/
const HOLD_SECONDS = 3600

/**
 * How long a Disclosure takes to speak, in ms: 0.4 s a word, a quarter more for safety, and a
 * second for the call to start speaking. It deliberately errs long: waiting too long delays the
 * Rep a moment, but bridging too early would let the Rep talk over the Disclosure.
 */
export function estimateSpeechMs(text: string): number {
  const words = text.trim().split(/\s+/).length
  // Unspaced scripts (Japanese, Chinese, Thai) count as one word, so the length bounds them too.
  return Math.ceil(Math.max(words * 400 * 1.25, text.length * 90)) + 1000
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function hold(): string {
  return `<Response><Pause length="${HOLD_SECONDS}"/></Response>`
}

function badResponse(what: string): TelephonyError {
  return new TelephonyError(
    TELEPHONY_ERROR_CODES.badResponse,
    `The provider answered without a usable ${what}`
  )
}

function unavailable(): TelephonyError {
  return new TelephonyError(
    TELEPHONY_ERROR_CODES.unavailable,
    'The provider did not answer in time'
  )
}

function notFound(): TelephonyError {
  return new TelephonyError(TELEPHONY_ERROR_CODES.notFound, 'There is no such call or Recording')
}

function sid(json: Record<string, unknown> | null, prefix: string): string {
  const value = json?.sid
  if (typeof value !== 'string' || !new RegExp(`^${prefix}[0-9a-zA-Z]{32}$`).test(value)) {
    throw badResponse('id')
  }
  return value
}

function withTag(url: string, organizationId: string, callId: string | null): string {
  const tagged = new URL(url)
  tagged.searchParams.set('organizationId', organizationId)
  if (callId !== null) {
    tagged.searchParams.set('callId', callId)
  }
  return tagged.toString()
}

/** The host Twilio's REST API is called on for a region and edge. */
export function twilioApiHost(region?: TwilioRegion, edge?: string): string {
  if (region === undefined) {
    if (edge !== undefined) {
      throw new TypeError('edge needs a region')
    }
    return 'api.twilio.com'
  }
  if (!TWILIO_REGIONS.includes(region)) {
    throw new TypeError('region is not one of us1, ie1, au1')
  }
  const chosen = edge ?? TWILIO_DEFAULT_EDGES[region]
  if (!EDGE.test(chosen)) {
    throw new TypeError('edge is not acceptable')
  }
  return `api.${chosen}.${region}.twilio.com`
}

/**
 * Signs a webhook the way Twilio does (`X-Twilio-Signature`): HMAC-SHA1 with the Auth Token over
 * the URL followed by each form field's name and value in sorted order, in base64. For tests and
 * for simulating Twilio; the adapter itself only verifies.
 */
export function signTwilioRequest(
  authToken: string,
  url: string,
  params: Readonly<Record<string, string>> | readonly (readonly [string, string])[] = {}
): string {
  const pairs = Array.isArray(params) ? [...params] : Object.entries(params)
  const text = pairs
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .reduce((acc, [name, value]) => acc + name + value, url)
  return createHmac('sha1', authToken).update(text, 'utf8').digest('base64')
}

function urlVariants(url: string): string[] {
  const variants = [url]
  try {
    const parsed = new URL(url)
    if (parsed.username || parsed.password) {
      return variants
    }
    const standard = parsed.protocol === 'https:' ? '443' : parsed.protocol === 'http:' ? '80' : ''
    // An explicit non-default port is part of the signed URL; only a default port may be added or dropped.
    if (standard === '' || (parsed.port !== '' && parsed.port !== standard)) {
      return variants
    }
    const rest = `${parsed.pathname}${parsed.search}`
    const bare = `${parsed.protocol}//${parsed.hostname}${rest}`
    const withPort = `${parsed.protocol}//${parsed.hostname}:${standard}${rest}`
    for (const variant of [bare, withPort]) {
      if (!variants.includes(variant)) {
        variants.push(variant)
      }
    }
  } catch {
    // an unparseable URL is only ever compared as given
  }
  return variants
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Creates the {@link TelephonyPort} on Twilio: Programmable Voice over REST and TwiML, a Voice SDK
 * access token, dual-channel Recordings and a Media Streams fork. Every request has a timeout and
 * a bounded, jittered retry on network errors, 429 and 5xx (never on another 4xx); an operation
 * as a whole is bounded by its `timeoutMs`. Nothing is logged, and no number, Disclosure text,
 * token, signature, secret or Recording URL is put in an error.
 *
 * The Disclosure rules are the shared ones (`requireDisclosure`): the adapter refuses to bridge,
 * record or fork a call whose Disclosure it has not seen play. The Disclosure state lives in the
 * {@link TwilioStore}.
 */
export function createTwilioTelephony(options: TwilioOptions): TelephonyPort {
  if (!SID.account.test(options.accountSid)) {
    throw new TypeError('accountSid is not an Account SID')
  }
  if (!SID.apiKey.test(options.apiKeySid)) {
    throw new TypeError('apiKeySid is not an API key SID')
  }
  if (typeof options.apiKeySecret !== 'string' || options.apiKeySecret.length < 16) {
    throw new TypeError('apiKeySecret must be at least 16 characters')
  }
  if (!SID.app.test(options.twimlAppSid)) {
    throw new TypeError('twimlAppSid is not a TwiML App SID')
  }
  if (
    options.authToken !== undefined &&
    (typeof options.authToken !== 'string' || options.authToken.length < 16)
  ) {
    throw new TypeError('authToken must be at least 16 characters')
  }
  const language = options.disclosureLanguage ?? 'en-US'
  if (!LANGUAGE.test(language)) {
    throw new TypeError('disclosureLanguage is not a language tag')
  }
  for (const url of [options.statusCallbackUrl, options.recordingStatusCallbackUrl]) {
    if (url !== undefined) {
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        throw new TypeError('a callback URL is not a URL')
      }
      const plainOk = options.environment === 'local' && parsed.protocol === 'http:'
      if ((parsed.protocol !== 'https:' && !plainOk) || parsed.username || parsed.password) {
        throw new TypeError('a callback URL must be https without credentials')
      }
    }
  }
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TELEPHONY_TIMEOUT_MS
  resolveTimeout(undefined, defaultTimeoutMs)

  const { accountSid, apiKeySid, apiKeySecret, twimlAppSid } = options
  const environment = options.environment ?? 'prod'
  const clock = options.clock ?? systemClock
  const nowMs = options.nowMs ?? Date.now
  const sleep = options.sleep ?? systemSleep
  const random = options.random ?? Math.random
  if (options.store === undefined && environment !== 'local' && environment !== 'dev') {
    throw new TypeError('a durable store is required outside the local and dev environments')
  }
  const store = options.store ?? createMemoryTwilioStore()
  const authToken = options.authToken
  const base = `/2010-04-01/Accounts/${accountSid}`
  const http: TwilioHttp = createTwilioHttp({
    baseUrl: `https://${twilioApiHost(options.region, options.edge)}`,
    authorization: `Basic ${Buffer.from(`${apiKeySid}:${apiKeySecret}`).toString('base64')}`,
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    sleep,
    random,
    now: nowMs,
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
  })

  function deadlineFor(opts: TelephonyOptions | undefined): number {
    return nowMs() + resolveTimeout(opts, defaultTimeoutMs)
  }

  function token(...parts: string[]): string {
    return createHash('sha256')
      .update([accountSid, ...parts].join('\u0000'))
      .digest('hex')
  }

  const patching = new Map<string, Promise<unknown>>()
  /**
   * Writes only the changed fields onto the freshest record, one patch at a time per call in this
   * process, so concurrent steps keep each other's ids. Across instances a durable store should
   * make the read and write one transaction.
   */
  async function patchCall(
    providerCallId: string,
    patch: Partial<TwilioCallRecord>
  ): Promise<void> {
    const run = async () => {
      const current = await store.getCall(providerCallId)
      if (current === null) {
        throw notFound()
      }
      await store.putCall(providerCallId, { ...current, ...patch })
    }
    const previous = patching.get(providerCallId) ?? Promise.resolve()
    const next = previous.then(run, run)
    patching.set(providerCallId, next)
    try {
      await next
    } finally {
      if (patching.get(providerCallId) === next) {
        patching.delete(providerCallId)
      }
    }
  }

  async function ownedCall(
    organizationId: string,
    providerCallId: string
  ): Promise<TwilioCallRecord> {
    const record = await store.getCall(providerCallId)
    if (!record || record.organizationId !== organizationId) {
      throw notFound()
    }
    return record
  }

  function refOf(request: ProviderCallRef): { organizationId: string; providerCallId: string } {
    return {
      organizationId: checkOrganizationId(request.organizationId),
      providerCallId: checkProviderId(request.providerCallId, 'providerCallId'),
    }
  }

  async function updateCall(
    providerCallId: string,
    form: Record<string, string>,
    deadline: number
  ): Promise<void> {
    await http.json({
      method: 'POST',
      path: `${base}/Calls/${providerCallId}.json`,
      form,
      deadline,
    })
  }

  async function callIsUp(providerCallId: string, deadline: number): Promise<boolean> {
    const { json } = await http.json({
      method: 'GET',
      path: `${base}/Calls/${providerCallId}.json`,
      deadline,
    })
    const status = json?.status
    if (typeof status !== 'string') {
      throw badResponse('status')
    }
    return status === 'in-progress'
  }

  function callEnded(): TelephonyError {
    return new TelephonyError(TELEPHONY_ERROR_CODES.callEnded, 'The call is not in progress')
  }

  return {
    async placeCall(request: PlaceCallRequest, opts?: TelephonyOptions): Promise<PlacedCall> {
      const organizationId = checkOrganizationId(request.organizationId)
      const callId = checkCallId(request.callId)
      const key = checkProviderId(request.idempotencyKey, 'idempotencyKey')
      const from = checkNumber(request.from, 'from')
      const to = checkNumber(request.to, 'to')
      const deadline = deadlineFor(opts)
      const fingerprint = createHmac('sha256', apiKeySecret)
        .update(`${from}\u0000${to}`)
        .digest('hex')
      const earlier = await store.getPlacement(organizationId, key)
      if (earlier) {
        if (earlier.fingerprint !== fingerprint) {
          invalid('idempotencyKey')
        }
        return { providerCallId: earlier.providerCallId, created: false }
      }
      const form: Record<string, string | string[]> = { To: to, From: from, Twiml: hold() }
      if (options.statusCallbackUrl !== undefined) {
        form.StatusCallback = withTag(options.statusCallbackUrl, organizationId, callId)
        form.StatusCallbackMethod = 'POST'
        form.StatusCallbackEvent = ['initiated', 'ringing', 'answered', 'completed']
      }
      const { json } = await http.json({
        method: 'POST',
        path: `${base}/Calls.json`,
        form,
        idempotencyToken: token('call', organizationId, key),
        deadline,
      })
      const providerCallId = sid(json, 'CA')
      await store.putCall(providerCallId, {
        organizationId,
        callId,
        direction: 'outbound',
        disclosure: null,
        bridgedTo: null,
        ringIdentities: [],
        recordingId: null,
        streamId: null,
      })
      await store.putPlacement(organizationId, key, { providerCallId, fingerprint })
      return { providerCallId, created: true }
    },

    async answerCall(request: AnswerCallRequest, opts?: TelephonyOptions): Promise<AnsweredCall> {
      const { organizationId, providerCallId } = refOf(request)
      const callId = checkCallId(request.callId)
      const identities = checkRingIdentities(request.ringIdentities)
      const deadline = deadlineFor(opts)
      const known = await store.getCall(providerCallId)
      if (known) {
        if (known.organizationId !== organizationId) {
          throw notFound()
        }
        return { ringing: known.ringIdentities.length }
      }
      if (!(await callIsUp(providerCallId, deadline))) {
        throw callEnded()
      }
      // The claim is atomic, so two Organizations naming one call cannot both win. Binding a
      // never-registered inbound call to the right Organization stays with the voice service,
      // which only answers calls that arrived on a number it resolved to that Organization. The
      // Reps are rung at bridge, once the Disclosure has played; this only holds the caller.
      const claimed = await store.claimCall(providerCallId, {
        organizationId,
        callId,
        direction: 'inbound',
        disclosure: null,
        bridgedTo: null,
        ringIdentities: identities,
        recordingId: null,
        streamId: null,
      })
      if (claimed.organizationId !== organizationId) {
        throw notFound()
      }
      await updateCall(providerCallId, { Twiml: hold() }, deadline)
      return { ringing: claimed.ringIdentities.length }
    },

    async playDisclosure(
      request: PlayDisclosureRequest,
      opts?: TelephonyOptions
    ): Promise<DisclosurePlayed> {
      const { organizationId, providerCallId } = refOf(request)
      checkDisclosure(request.wordingVersion, request.text, request.aiAssisted)
      const deadline = deadlineFor(opts)
      const record = await ownedCall(organizationId, providerCallId)
      const earlier = record.disclosure
      if (earlier && earlier.wordingVersion === request.wordingVersion) {
        return earlier
      }
      const waitMs = estimateSpeechMs(request.text)
      if (options.disclosureDone === undefined && nowMs() + waitMs > deadline) {
        throw unavailable()
      }
      await updateCall(
        providerCallId,
        {
          Twiml: `<Response><Say language="${language}">${escapeXml(request.text)}</Say><Pause length="${HOLD_SECONDS}"/></Response>`,
        },
        deadline
      )
      if (options.disclosureDone) {
        await options.disclosureDone({ organizationId, providerCallId, deadline })
      } else {
        await sleep(waitMs)
      }
      if (nowMs() > deadline) {
        throw unavailable()
      }
      if (!(await callIsUp(providerCallId, deadline))) {
        throw callEnded()
      }
      const played: DisclosurePlayed = {
        wordingVersion: request.wordingVersion,
        aiAssisted: request.aiAssisted,
        playedAt: clock.now().toISOString(),
      }
      await patchCall(providerCallId, { disclosure: played, bridgedTo: null })
      return played
    },

    async bridge(request: BridgeRequest, opts?: TelephonyOptions): Promise<void> {
      const { organizationId, providerCallId } = refOf(request)
      const rep = checkIdentity(request.repIdentity)
      const deadline = deadlineFor(opts)
      const record = await ownedCall(organizationId, providerCallId)
      requireDisclosure(record.disclosure)
      if (record.bridgedTo === rep) {
        return
      }
      await updateCall(
        providerCallId,
        {
          Twiml: `<Response><Dial answerOnBridge="true"><Client><Identity>${escapeXml(rep)}</Identity><Parameter name="organizationId" value="${escapeXml(organizationId)}"/></Client></Dial></Response>`,
        },
        deadline
      )
      await patchCall(providerCallId, { bridgedTo: rep })
    },

    async startRecording(
      request: ProviderCallRef,
      opts?: TelephonyOptions
    ): Promise<StartedRecording> {
      const { organizationId, providerCallId } = refOf(request)
      const deadline = deadlineFor(opts)
      const record = await ownedCall(organizationId, providerCallId)
      requireDisclosure(record.disclosure)
      if (record.recordingId !== null) {
        return { recordingId: record.recordingId, channels: 2 }
      }
      // Always dual-channel, both legs: there is no option for anything else.
      const form: Record<string, string | string[]> = {
        RecordingChannels: 'dual',
        RecordingTrack: 'both',
      }
      if (options.recordingStatusCallbackUrl !== undefined) {
        form.RecordingStatusCallback = withTag(
          options.recordingStatusCallbackUrl,
          organizationId,
          record.callId
        )
        form.RecordingStatusCallbackMethod = 'POST'
        form.RecordingStatusCallbackEvent = ['completed']
      }
      const { json } = await http.json({
        method: 'POST',
        path: `${base}/Calls/${providerCallId}/Recordings.json`,
        form,
        idempotencyToken: token('recording', providerCallId),
        deadline,
      })
      const recordingId = sid(json, 'RE')
      await store.putRecording(recordingId, providerCallId)
      await patchCall(providerCallId, { recordingId })
      return { recordingId, channels: 2 }
    },

    async forkTracks(request: ForkTracksRequest, opts?: TelephonyOptions): Promise<ForkedTracks> {
      const { organizationId, providerCallId } = refOf(request)
      const destination = checkDestinationUrl(request.destinationUrl, environment === 'local')
      const deadline = deadlineFor(opts)
      const record = await ownedCall(organizationId, providerCallId)
      requireDisclosure(record.disclosure, true)
      if (record.streamId !== null) {
        return { streamId: record.streamId, tracks: ['rep', 'prospect'] }
      }
      const { json } = await http.json({
        method: 'POST',
        path: `${base}/Calls/${providerCallId}/Streams.json`,
        form: { Url: destination, Track: 'both_tracks' },
        idempotencyToken: token('stream', providerCallId),
        deadline,
      })
      const streamId = sid(json, 'MZ')
      await patchCall(providerCallId, { streamId })
      return { streamId, tracks: ['rep', 'prospect'] }
    },

    async hangUp(request: HangUpRequest, opts?: TelephonyOptions): Promise<void> {
      const { organizationId, providerCallId } = refOf(request)
      if (request.by !== undefined && request.by !== 'rep' && request.by !== 'system') {
        invalid('by')
      }
      const deadline = deadlineFor(opts)
      await ownedCall(organizationId, providerCallId)
      try {
        await updateCall(providerCallId, { Status: 'completed' }, deadline)
      } catch (error) {
        if (error instanceof TelephonyError && error.code === TELEPHONY_ERROR_CODES.callEnded) {
          return
        }
        throw error
      }
    },

    async fetchRecording(
      request: RecordingRef,
      opts?: TelephonyOptions
    ): Promise<FetchedRecording> {
      const organizationId = checkOrganizationId(request.organizationId)
      const recordingId = checkProviderId(request.recordingId, 'recordingId')
      const deadline = deadlineFor(opts)
      const owner = await store.getRecording(recordingId)
      if (!owner) {
        throw notFound()
      }
      await ownedCall(organizationId, owner.providerCallId)
      const { json } = await http.json({
        method: 'GET',
        path: `${base}/Recordings/${recordingId}.json`,
        deadline,
      })
      const status = json?.status
      if (status === 'in-progress' || status === 'paused' || status === 'processing') {
        throw new TelephonyError(
          TELEPHONY_ERROR_CODES.recordingNotReady,
          'The Recording is not finished yet'
        )
      }
      if (status !== 'completed') {
        throw notFound()
      }
      if (json?.channels !== 2) {
        throw badResponse('channel count')
      }
      const { response } = await http.stream({
        method: 'GET',
        path: `${base}/Recordings/${recordingId}.wav?RequestedChannels=2`,
        deadline,
      })
      if (!response?.body) {
        throw badResponse('body')
      }
      const length = Number(response.headers.get('content-length'))
      return {
        body: response.body,
        contentType: response.headers.get('content-type')?.split(';')[0]?.trim() || 'audio/wav',
        sizeBytes: Number.isSafeInteger(length) && length > 0 ? length : null,
        channels: 2,
      }
    },

    async deleteRecording(
      request: RecordingRef,
      opts?: TelephonyOptions
    ): Promise<{ existed: boolean }> {
      const organizationId = checkOrganizationId(request.organizationId)
      const recordingId = checkProviderId(request.recordingId, 'recordingId')
      const deadline = deadlineFor(opts)
      const owner = await store.getRecording(recordingId)
      if (!owner) {
        return { existed: false }
      }
      const record = await store.getCall(owner.providerCallId)
      if (!record || record.organizationId !== organizationId) {
        return { existed: false }
      }
      const answer = await http.json(
        { method: 'DELETE', path: `${base}/Recordings/${recordingId}.json`, deadline },
        { allow: [404] }
      )
      return { existed: answer.status !== 404 }
    },

    verifyWebhook(request: WebhookRequest): boolean {
      try {
        if (
          authToken === undefined ||
          typeof request?.url !== 'string' ||
          typeof request.body !== 'string' ||
          typeof request.signature !== 'string' ||
          request.signature.length === 0 ||
          request.signature.length > 256 ||
          Buffer.byteLength(request.body, 'utf8') > MAX_WEBHOOK_BODY_BYTES
        ) {
          return false
        }
        let entries: [string, string][] = []
        let hashed: string | null = null
        try {
          hashed = new URL(request.url).searchParams.get('bodySHA256')
        } catch {
          return false
        }
        if (hashed !== null) {
          // A JSON body: the signature covers only the URL, and the URL carries the body's hash.
          const actual = createHash('sha256').update(request.body, 'utf8').digest('hex')
          if (!sameText(actual, hashed.toLowerCase())) {
            return false
          }
        } else if (request.body.length > 0) {
          entries = [...new URLSearchParams(request.body).entries()]
        }
        let matched = false
        for (const url of urlVariants(request.url)) {
          const expected = signTwilioRequest(authToken, url, entries)
          matched = sameText(expected, request.signature) || matched
        }
        return matched
      } catch {
        return false
      }
    },

    async mintBrowserToken(
      request: BrowserTokenRequest,
      opts?: TelephonyOptions
    ): Promise<SoftphoneToken> {
      resolveTimeout(opts, defaultTimeoutMs)
      const organizationId = checkOrganizationId(request.organizationId)
      const identity = checkIdentity(request.identity)
      const ttl = request.ttlSeconds ?? 900
      if (!Number.isInteger(ttl) || ttl < 60 || ttl > 3600) {
        invalid('ttlSeconds')
      }
      const issuedAt = Math.floor(clock.now().getTime() / 1000)
      const jwt = await new SignJWT({
        grants: {
          identity,
          voice: {
            incoming: { allow: true },
            outgoing: { application_sid: twimlAppSid, params: { organizationId } },
          },
        },
      })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT', cty: 'twilio-fpa;v=1' })
        .setIssuer(apiKeySid)
        .setSubject(accountSid)
        .setJti(`${apiKeySid}-${randomBytes(12).toString('hex')}`)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + ttl)
        .sign(new TextEncoder().encode(apiKeySecret))
      return {
        token: jwt,
        identity: request.identity,
        ttlSeconds: ttl,
        expiresAt: new Date((issuedAt + ttl) * 1000).toISOString(),
      }
    },
  }
}
