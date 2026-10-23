import type { Sleep } from '../queue/sleep'
import { TELEPHONY_ERROR_CODES, TelephonyError, type TelephonyErrorCode } from './errors'

/** The most attempts one Twilio request is given, the first included. */
export const TWILIO_MAX_ATTEMPTS = 3

/** The base of the pause before a retry, in ms; doubled each time and jittered. */
export const TWILIO_RETRY_BASE_MS = 100

/** The longest pause before a retry, in ms, before jitter. */
export const TWILIO_RETRY_MAX_MS = 1_000

/** The most bytes of a Twilio JSON answer that are read; a longer answer is `telephony.bad_response`. */
export const TWILIO_MAX_RESPONSE_BYTES = 1_048_576

/** Twilio's error codes that mean the call is not in progress (so it has ended or never connected). */
const CALL_ENDED_CODES: ReadonlySet<number> = new Set([21220, 21221, 21222, 21224])

/** The HTTP client the adapter uses: `fetch`, injected for tests. */
export type TwilioFetch = (input: string, init: RequestInit) => Promise<Response>

/** What one Twilio request asks for. */
export interface TwilioRequest {
  /** The HTTP method. */
  method: 'GET' | 'POST' | 'DELETE'
  /** The path below the API host, starting with `/`. May carry a query. */
  path: string
  /** Form fields of a POST. Tenant data lives here, so it is never put in an error. */
  form?: Record<string, string | readonly string[]>
  /** Sent as `I-Twilio-Idempotency-Token`, so a retry of a POST that was already processed is safe. */
  idempotencyToken?: string
  /** The wall-clock time (ms since the epoch) by which the whole operation must have finished. */
  deadline: number
}

/** What a Twilio request answered. */
export interface TwilioAnswer {
  /** The HTTP status. */
  status: number
  /** The parsed JSON body, or null when it had none. */
  json: Record<string, unknown> | null
  /** The raw response, with its body unread, when `stream` was asked for. */
  response?: Response
}

/** Options for {@link createTwilioHttp}. */
export interface TwilioHttpOptions {
  /** The scheme and host, such as `https://api.twilio.com`. */
  baseUrl: string
  /** The value of the `Authorization` header. A credential: never put in an error. */
  authorization: string
  /** The `fetch` to use. */
  fetch: TwilioFetch
  /** Pauses between attempts. */
  sleep: Sleep
  /** A number in `[0, 1)` for the jitter. */
  random: () => number
  /** The wall clock in ms since the epoch. */
  now: () => number
  /** The most attempts, 1 or more; default {@link TWILIO_MAX_ATTEMPTS}. */
  maxAttempts?: number
}

/** The part of Twilio's answer the adapter reads when a request fails. */
interface TwilioFailureBody {
  /** Twilio's own numeric error code, such as 21220. Not a secret. */
  code?: number
}

/** A Twilio request client with a deadline on every attempt and bounded, jittered retries. */
export interface TwilioHttp {
  /** Sends a request and returns Twilio's JSON answer; a non-2xx answer throws a TelephonyError. */
  json(request: TwilioRequest, options?: { allow?: readonly number[] }): Promise<TwilioAnswer>
  /** Like {@link json} but returns the response with its body unread; the caller must read or cancel it. */
  stream(request: TwilioRequest): Promise<TwilioAnswer>
}

function unavailable(reason: string, details?: Record<string, unknown>): TelephonyError {
  return new TelephonyError(
    TELEPHONY_ERROR_CODES.unavailable,
    `The provider did not answer: ${reason}`,
    details === undefined ? {} : { details }
  )
}

/**
 * Maps a failing Twilio answer to a TelephonyError. The message is fixed text; the details hold
 * only the HTTP status and Twilio's numeric error code, never its message (which can quote a
 * number) or any part of the request.
 */
export function mapTwilioFailure(status: number, body: TwilioFailureBody | null): TelephonyError {
  const twilioCode = typeof body?.code === 'number' ? body.code : undefined
  const details: Record<string, unknown> = {
    status,
    ...(twilioCode === undefined ? {} : { twilioCode }),
  }
  const fail = (code: TelephonyErrorCode, message: string) =>
    new TelephonyError(code, message, { details })
  if (twilioCode !== undefined && CALL_ENDED_CODES.has(twilioCode)) {
    return fail(TELEPHONY_ERROR_CODES.callEnded, 'The call is not in progress')
  }
  if (status === 404) {
    return fail(TELEPHONY_ERROR_CODES.notFound, 'The provider has no such resource')
  }
  if (status === 429 || status >= 500) {
    return fail(TELEPHONY_ERROR_CODES.unavailable, 'The provider is unavailable')
  }
  if (status === 401 || status === 403) {
    return fail(TELEPHONY_ERROR_CODES.rejected, 'The provider refused the credentials')
  }
  return fail(TELEPHONY_ERROR_CODES.rejected, 'The provider refused the request')
}

function retryable(status: number): boolean {
  return status === 429 || status >= 500
}

/**
 * Builds the request client. Every attempt is cut off at the operation's deadline; a network
 * error, a 429 or a 5xx is tried again after a pause of between half and one and a half of an
 * exponentially growing delay (at most {@link TWILIO_MAX_ATTEMPTS} attempts, all inside the
 * deadline); a timeout is final; a 4xx is an answer and is never retried. The request body, the
 * URL and the credentials never reach an error message.
 */
export function createTwilioHttp(options: TwilioHttpOptions): TwilioHttp {
  const maxAttempts = options.maxAttempts ?? TWILIO_MAX_ATTEMPTS
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new TypeError('maxAttempts must be an integer from 1 to 10')
  }

  async function send(
    request: TwilioRequest,
    mode: 'json' | 'stream',
    allow: readonly number[]
  ): Promise<TwilioAnswer> {
    const headers: Record<string, string> = {
      Authorization: options.authorization,
      Accept: mode === 'json' ? 'application/json' : '*/*',
    }
    let body: string | undefined
    if (request.form !== undefined) {
      const params = new URLSearchParams()
      for (const [name, value] of Object.entries(request.form)) {
        for (const item of typeof value === 'string' ? [value] : value) {
          params.append(name, item)
        }
      }
      body = params.toString()
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
    }
    if (request.idempotencyToken !== undefined) {
      headers['I-Twilio-Idempotency-Token'] = request.idempotencyToken
    }
    let last: TelephonyError | undefined
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const remaining = request.deadline - options.now()
      if (remaining <= 0) {
        throw last ?? unavailable('timed out')
      }
      const controller = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, remaining)
      try {
        const response = await options.fetch(`${options.baseUrl}${request.path}`, {
          method: request.method,
          headers,
          ...(body === undefined ? {} : { body }),
          redirect: mode === 'stream' ? 'follow' : 'manual',
          signal: controller.signal,
        })
        const ok = response.status >= 200 && response.status < 300
        if (ok && mode === 'stream') {
          return { status: response.status, json: null, response }
        }
        const json = await readJson(response, ok || allow.includes(response.status))
        if (ok || allow.includes(response.status)) {
          return { status: response.status, json }
        }
        void response.body?.cancel().catch(() => undefined)
        const failure = mapTwilioFailure(response.status, json as TwilioFailureBody | null)
        if (!retryable(response.status)) {
          throw failure
        }
        last = failure
      } catch (error) {
        if (error instanceof TelephonyError && error !== last) {
          throw error
        }
        if (timedOut) {
          throw unavailable('timed out')
        }
        if (!(error instanceof TelephonyError)) {
          last = unavailable('the request failed')
        }
      } finally {
        clearTimeout(timer)
      }
      if (attempt < maxAttempts) {
        const base = Math.min(TWILIO_RETRY_MAX_MS, TWILIO_RETRY_BASE_MS * 2 ** (attempt - 1))
        const pause = Math.min(
          Math.floor(base * (0.5 + options.random())),
          Math.max(0, request.deadline - options.now())
        )
        await options.sleep(pause)
      }
    }
    throw last ?? unavailable('the request failed')
  }

  return {
    json: (request, opts) => send(request, 'json', opts?.allow ?? []),
    stream: (request) => send(request, 'stream', []),
  }
}

async function readJson(
  response: Response,
  mustParse: boolean
): Promise<Record<string, unknown> | null> {
  if (response.status >= 300 && response.status < 400) {
    throw new TelephonyError(
      TELEPHONY_ERROR_CODES.badResponse,
      'The provider answered with a redirect',
      { details: { status: response.status } }
    )
  }
  let text: string
  try {
    text = await readBounded(response)
  } catch (error) {
    if (error instanceof TelephonyError) {
      throw error
    }
    throw unavailable('the answer could not be read')
  }
  if (text.length === 0) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    if (mustParse && response.status !== 204) {
      throw new TelephonyError(
        TELEPHONY_ERROR_CODES.badResponse,
        'The provider answered with something that is not JSON',
        { details: { status: response.status } }
      )
    }
    return null
  }
}

async function readBounded(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) {
    return ''
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    total += value.length
    if (total > TWILIO_MAX_RESPONSE_BYTES) {
      void reader.cancel().catch(() => undefined)
      throw new TelephonyError(
        TELEPHONY_ERROR_CODES.badResponse,
        'The provider answered with more than this adapter reads'
      )
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}
