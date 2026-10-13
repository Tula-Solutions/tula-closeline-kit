import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIPv4 } from 'node:net'
import type { Logger } from '../logger'
import type { Environment } from '../reporting/env'

/** The header that carries a call's idempotency key. */
export const INTERNAL_IDEMPOTENCY_HEADER = 'Idempotency-Key'

/** The default bound on one attempt, connecting to the last byte of the answer. */
export const INTERNAL_DEFAULT_TIMEOUT_MS = 5_000

/** The default largest answer that is read; a longer one fails the call, it is not truncated. */
export const INTERNAL_DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024

/** The largest request body the client will send. */
export const INTERNAL_MAX_REQUEST_BYTES = 1024 * 1024

/** The default retry policy of {@link createInternalClient}. */
export const INTERNAL_DEFAULT_RETRY = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 2_000,
  retryAfterCapMs: 5_000,
} as const

/** The statuses an idempotent call is retried on. Other statuses are answers, not faults. */
export const INTERNAL_RETRY_STATUSES: readonly number[] = [429, 502, 503, 504]

/** HTTP methods that may be sent twice with the same effect, so a retry is safe without a key. */
const IDEMPOTENT_METHODS: readonly string[] = ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']

/** Headers a caller may not set: the client owns them. */
const FORBIDDEN_HEADERS = new Set([
  'authorization',
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'proxy-authorization',
])

/**
 * Every way {@link InternalClient.request} can reject. A body that is empty or not JSON is not
 * one of them: `json` is `undefined` and the caller's schema check decides.
 */
export const INTERNAL_CALL_FAILURES = [
  'connection',
  'timeout',
  'aborted',
  'redirect',
  'response_too_large',
] as const

/** The most attempts a call may be given, the first included. */
export const INTERNAL_MAX_ATTEMPTS = 10

/** The HTTP methods the client sends. */
export type InternalMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** Why an internal call produced no usable answer. */
export type InternalCallFailure = (typeof INTERNAL_CALL_FAILURES)[number]

/**
 * An internal call that produced no answer. The message is fixed text plus the method, path (no
 * query), status and attempt count; the secret, the request body, the response body and the
 * underlying error are never kept, so nothing here can leak them into a log.
 */
export class InternalCallError extends Error {
  readonly failure: InternalCallFailure
  readonly method: string
  readonly path: string
  readonly status: number | undefined
  readonly attempts: number

  constructor(init: {
    failure: InternalCallFailure
    method: string
    path: string
    status?: number
    attempts: number
  }) {
    const status = init.status === undefined ? '' : `, HTTP ${init.status}`
    super(
      `internal call ${init.method} ${init.path} failed (${init.failure}${status}, ` +
        `${init.attempts} attempt${init.attempts === 1 ? '' : 's'})`
    )
    this.name = 'InternalCallError'
    this.failure = init.failure
    this.method = init.method
    this.path = init.path
    this.status = init.status
    this.attempts = init.attempts
  }
}

/** How a call is retried. Every field has a default in {@link INTERNAL_DEFAULT_RETRY}. */
export type InternalRetryPolicy = {
  /** Attempts in all, the first included: an integer from 1 to {@link INTERNAL_MAX_ATTEMPTS}. */
  maxAttempts?: number
  /** The first pause's ceiling; each later pause doubles it, up to `maxDelayMs`. */
  baseDelayMs?: number
  /** The largest ceiling of a jittered pause. */
  maxDelayMs?: number
  /** The longest a `Retry-After` of seconds is honoured; a larger one is cut to this. */
  retryAfterCapMs?: number
}

/** Options for {@link createInternalClient}. */
export type InternalClientOptions = {
  /** The receiver's origin, `http` or `https`, with no userinfo, query or fragment. */
  baseUrl: string
  /** The shared secret sent as `Authorization: Bearer`. Never logged or put in an error. */
  secret: string
  /** Where this deployment runs; plain `http` to a non-loopback host is allowed only in `local`. */
  environment: Environment
  /** The caller's name, sent as `User-Agent`. */
  userAgent?: string
  /** One attempt's bound; defaults to {@link INTERNAL_DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number
  /** The largest answer read; defaults to {@link INTERNAL_DEFAULT_MAX_RESPONSE_BYTES}. */
  maxResponseBytes?: number
  /** The retry policy; see {@link InternalRetryPolicy}. */
  retry?: InternalRetryPolicy
  /** Extra certificate authority (PEM) to trust besides the system's. Verification stays on. */
  ca?: string
  /** Where a retry is noted: fixed words, a status or failure kind and an attempt number only. */
  logger?: Pick<Logger, 'warn'>
  /** Injected for tests; defaults to a timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Injected for tests; a number in `[0, 1)`; defaults to `Math.random`. */
  random?: () => number
}

/** One call. */
export type InternalRequest = {
  method: InternalMethod
  /** Starts with `/`; it is appended to the base URL. A query string is allowed. */
  path: string
  /** Sent as JSON. Not allowed on `GET` and `HEAD`. */
  body?: unknown
  /** Extra headers; `Authorization`, `Host` and the like are the client's and are refused. */
  headers?: Record<string, string>
  /** Sent as `Idempotency-Key`, and makes a `POST` or `PATCH` safe to retry. */
  idempotencyKey?: string
  /** This call's attempt bound instead of the client's. */
  timeoutMs?: number
  /** Stops the call, retries and pauses included. */
  signal?: AbortSignal
}

/** What came back: the status, and the body parsed as JSON when it was JSON. */
export type InternalResponse = {
  status: number
  /** The parsed body, or `undefined` when it was empty or not JSON, whatever its content type. */
  json: unknown
  /** Attempts made, the first included. */
  attempts: number
}

/** A client for calls from one Closeline service to another. */
export interface InternalClient {
  /**
   * Sends the call and resolves with any answer that was not a redirect, including 4xx and 5xx.
   * Rejects with {@link InternalCallError} when there is none. Retries only a connection failure,
   * a timeout, 429, 502, 503 and 504, and only when the method is idempotent or a key is given.
   */
  request(call: InternalRequest): Promise<InternalResponse>
}

/** Whether `host` (as in a URL, brackets kept for IPv6) is a literal loopback address. */
function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '')
  return (isIPv4(bare) && bare.startsWith('127.')) || bare === '::1'
}

/** Validates the base URL and splits it into what `node:http` needs. */
function parseBase(baseUrl: string, environment: Environment) {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new TypeError('the internal base URL is not a URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('the internal base URL must use http or https')
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('the internal base URL must not carry a user name or password')
  }
  if (url.search !== '' || url.hash !== '' || baseUrl.includes('?') || baseUrl.includes('#')) {
    throw new TypeError('the internal base URL must not have a query or a fragment')
  }
  if (url.hostname === '') {
    throw new TypeError('the internal base URL has no host')
  }
  if (url.protocol === 'http:' && environment !== 'local' && !isLoopbackHost(url.hostname)) {
    throw new TypeError(
      'the internal base URL must use https outside the local environment and loopback'
    )
  }
  return {
    secure: url.protocol === 'https:',
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port),
    prefix: url.pathname.replace(/\/+$/, ''),
  }
}

/** The path without its query, for errors and logs. */
function pathOnly(path: string): string {
  const cut = path.search(/[?#]/)
  return cut === -1 ? path : path.slice(0, cut)
}

/** Throws unless `path` is a plain absolute path of this origin. */
function checkPath(path: string): void {
  if (!path.startsWith('/') || path.startsWith('//') || /[\s#\\]/.test(path)) {
    throw new TypeError('an internal call path must start with a single "/" and hold no spaces')
  }
}

/** Parses delta-seconds from a `Retry-After` header; the date form is ignored. */
function retryAfterMs(value: string | string[] | undefined): number | undefined {
  const text = Array.isArray(value) ? value[0] : value
  if (text === undefined || !/^\d{1,9}$/.test(text.trim())) {
    return undefined
  }
  return Number(text.trim()) * 1000
}

/** Parses JSON without looking at the content type; `undefined` when it is not JSON. */
function parseJson(text: string): unknown {
  if (text.trim() === '') {
    return undefined
  }
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

type Wire = {
  status: number
  text: string
  retryAfter: number | undefined
}

/**
 * Builds the client for calls from this service to one other service (ADR 0013).
 *
 * It uses `node:http` and `node:https` with `agent: false`, never `fetch`: Bun's `fetch` sends a
 * request to the proxy named by `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` (and their lower-case
 * forms) unless `NO_PROXY` names the host, and the bearer secret would travel with it. The
 * `node:` transport reads no proxy variable, so nothing in the environment can reroute a call.
 * `proxy.test.ts` pins this for the Bun version in use.
 *
 * Cost per call: one new connection (plus one TLS handshake for https), one request, no
 * keep-alive; memory is bounded by `maxResponseBytes`. Redirects are never followed. TLS
 * certificates are verified: every https request sets `rejectUnauthorized: true` itself, so
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` has no effect on it, and the client is not built at all
 * while that variable is `0` outside `local`. `NODE_EXTRA_CA_CERTS` still adds trusted
 * authorities, as it does for every process; that is an operator's choice, not a way to skip checks.
 */
export function createInternalClient(options: InternalClientOptions): InternalClient {
  const base = parseBase(options.baseUrl, options.environment)
  if (!/^[\x21-\x7e]+$/.test(options.secret)) {
    throw new TypeError('the internal secret must be a non-empty string of printable characters')
  }
  const authorization = `Bearer ${options.secret}`
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' && options.environment !== 'local') {
    throw new TypeError(
      'NODE_TLS_REJECT_UNAUTHORIZED=0 turns off certificate checks; unset it outside local'
    )
  }
  const retry = { ...INTERNAL_DEFAULT_RETRY, ...options.retry }
  const maxAttempts = retry.maxAttempts
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > INTERNAL_MAX_ATTEMPTS) {
    throw new TypeError(`retry.maxAttempts must be an integer from 1 to ${INTERNAL_MAX_ATTEMPTS}`)
  }
  for (const name of ['baseDelayMs', 'maxDelayMs', 'retryAfterCapMs'] as const) {
    if (!isNonNegative(retry[name])) {
      throw new TypeError(`retry.${name} must be a finite number, zero or more`)
    }
  }
  const timeoutMs = options.timeoutMs ?? INTERNAL_DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxResponseBytes ?? INTERNAL_DEFAULT_MAX_RESPONSE_BYTES
  if (!isPositive(timeoutMs) || !isPositive(maxBytes)) {
    throw new TypeError('timeoutMs and maxResponseBytes must be finite numbers above zero')
  }
  const sleep = options.sleep ?? timerSleep
  const random = options.random ?? Math.random
  const send = base.secure ? httpsRequest : httpRequest

  /** One attempt on the wire. Rejects with the failure kind only. */
  const attempt = (
    method: string,
    target: string,
    headers: Record<string, string | number>,
    body: string | undefined,
    signal: AbortSignal
  ): Promise<Wire> =>
    new Promise((resolve, reject) => {
      const outgoing = send(
        {
          host: base.host,
          port: base.port,
          path: target,
          method,
          headers,
          agent: false,
          signal,
          // Explicit, so NODE_TLS_REJECT_UNAUTHORIZED=0 in the environment cannot switch it off.
          ...(base.secure ? { rejectUnauthorized: true } : {}),
          ...(options.ca === undefined ? {} : { ca: options.ca }),
        },
        (response) => {
          const status = response.statusCode ?? 0
          const retryAfter = retryAfterMs(response.headers['retry-after'])
          if (status >= 300 && status < 400) {
            reject(new Failure('redirect', status))
            response.destroy()
            return
          }
          const declared = Number(response.headers['content-length'])
          if (Number.isFinite(declared) && declared > maxBytes) {
            reject(new Failure('response_too_large', status))
            response.destroy()
            return
          }
          const chunks: Buffer[] = []
          let bytes = 0
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.byteLength
            if (bytes > maxBytes) {
              reject(new Failure('response_too_large', status))
              response.destroy()
              return
            }
            chunks.push(chunk)
          })
          response.on('end', () => {
            resolve({ status, text: Buffer.concat(chunks).toString('utf8'), retryAfter })
          })
          const broken = () => reject(new Failure(signal.aborted ? 'timeout' : 'connection'))
          response.on('error', broken)
          response.on('aborted', broken)
        }
      )
      outgoing.on('error', () => reject(new Failure(signal.aborted ? 'timeout' : 'connection')))
      outgoing.end(body)
    })

  return {
    async request(call) {
      checkPath(call.path)
      if (call.body !== undefined && (call.method === 'GET' || call.method === 'HEAD')) {
        throw new TypeError('a GET or HEAD internal call has no body')
      }
      const extra: Record<string, string> = {}
      for (const [name, value] of Object.entries(call.headers ?? {})) {
        if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
          throw new TypeError(`the header ${name} is set by the client and cannot be passed`)
        }
        if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
          throw new TypeError('a header holds a line break')
        }
        extra[name] = value
      }
      if (call.idempotencyKey !== undefined) {
        if (!/^[\x21-\x7e]{1,255}$/.test(call.idempotencyKey)) {
          throw new TypeError('the idempotency key must be 1 to 255 printable characters')
        }
        extra[INTERNAL_IDEMPOTENCY_HEADER] = call.idempotencyKey
      }
      const payload = call.body === undefined ? undefined : JSON.stringify(call.body)
      if (payload !== undefined && Buffer.byteLength(payload) > INTERNAL_MAX_REQUEST_BYTES) {
        throw new TypeError('the internal call body is too large')
      }
      const headers: Record<string, string | number> = {
        accept: 'application/json',
        'user-agent': options.userAgent ?? 'closeline-internal',
        ...(payload === undefined
          ? {}
          : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        ...extra,
        authorization,
      }
      const target = `${base.prefix}${call.path}`
      const path = pathOnly(call.path)
      const safeToRepeat =
        IDEMPOTENT_METHODS.includes(call.method) || call.idempotencyKey !== undefined
      const perAttempt = call.timeoutMs ?? timeoutMs
      if (!isPositive(perAttempt)) {
        throw new TypeError('timeoutMs must be a finite number above zero')
      }

      for (let attempts = 1; ; attempts += 1) {
        const fail = (failure: InternalCallFailure, status?: number) =>
          new InternalCallError({ failure, method: call.method, path, status, attempts })
        if (call.signal?.aborted) {
          throw fail('aborted')
        }
        const timeout = AbortSignal.timeout(perAttempt)
        const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout
        let retryAfter: number | undefined
        let reason: string
        try {
          const wire = await attempt(call.method, target, headers, payload, signal)
          if (!INTERNAL_RETRY_STATUSES.includes(wire.status)) {
            return { status: wire.status, json: parseJson(wire.text), attempts }
          }
          if (!safeToRepeat || attempts >= maxAttempts) {
            return { status: wire.status, json: parseJson(wire.text), attempts }
          }
          retryAfter = wire.retryAfter
          reason = `HTTP ${wire.status}`
        } catch (caught) {
          if (call.signal?.aborted) {
            throw fail('aborted')
          }
          const failure = caught instanceof Failure ? caught : new Failure('connection')
          const retryable = failure.kind === 'connection' || failure.kind === 'timeout'
          if (!retryable) {
            throw fail(failure.kind, failure.status)
          }
          if (!safeToRepeat || attempts >= maxAttempts) {
            throw fail(failure.kind)
          }
          reason = failure.kind
        }
        const ceiling = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempts - 1))
        const delay =
          retryAfter === undefined
            ? Math.floor(random() * ceiling)
            : Math.min(retryAfter, retry.retryAfterCapMs)
        options.logger?.warn('internal call failed, retrying', {
          method: call.method,
          path,
          reason,
          attempt: attempts,
          delayMs: delay,
        })
        await pauseOrAbort(sleep, delay, call.signal)
      }
    },
  }
}

/** An internal marker for how one attempt failed; carries no message. */
class Failure {
  constructor(
    readonly kind: InternalCallFailure,
    readonly status?: number
  ) {}
}

/** Whether `value` is a finite number above zero. */
function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** Whether `value` is a finite number, zero or more. */
function isNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** The default pause: a timer that is cleared when `signal` aborts, and a listener that is dropped. */
function timerSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

/**
 * Pauses for `ms`, or returns at once when the caller's signal aborts. The listener on the
 * caller's signal is removed, and the pause itself is told to stop, on every path.
 */
async function pauseOrAbort(
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  ms: number,
  signal: AbortSignal | undefined
): Promise<void> {
  if (signal === undefined) {
    await sleep(ms)
    return
  }
  const stop = new AbortController()
  let onAbort: (() => void) | undefined
  try {
    await Promise.race([
      sleep(ms, stop.signal),
      new Promise<void>((resolve) => {
        onAbort = () => resolve()
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener('abort', onAbort)
    }
    stop.abort()
  }
}
