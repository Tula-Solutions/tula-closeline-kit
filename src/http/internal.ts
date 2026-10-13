import { Agent as HttpAgent, request as httpRequest } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { isIPv4 } from 'node:net'
import type { Logger } from '../logger'
import type { Environment } from '../reporting/env'

/** The header that carries a call's idempotency key. */
export const INTERNAL_IDEMPOTENCY_HEADER = 'Idempotency-Key'

/** The default bound on one attempt, connecting to the last byte of the answer. */
export const INTERNAL_DEFAULT_TIMEOUT_MS = 5_000

/** The default most connections one client keeps open to its receiver; calls beyond it queue. */
export const INTERNAL_DEFAULT_MAX_SOCKETS = 32

/** The default most idle connections one client keeps for reuse. */
export const INTERNAL_DEFAULT_MAX_FREE_SOCKETS = 8

/**
 * The default time an idle connection is kept before the client closes it. It is below the 5 s
 * keep-alive timeout of a Node `http` server (and of Bun's, which is 10 s), and far below a load
 * balancer's (60 s on an AWS ALB, 75 s on nginx), so the client, not the server, ends an idle
 * connection and a reused one is rarely dead.
 */
export const INTERNAL_DEFAULT_IDLE_TIMEOUT_MS = 4_000

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
 * Every way {@link InternalClient.request} can reject. `response_invalid` is a 2xx answer whose
 * non-empty body is not JSON (an HTML error or login page); it is never retried.
 * `stale_connection` is a kept connection that the receiver had already closed: the write failed
 * with `ECONNRESET` or `EPIPE` before any byte of an answer. The request may or may not have
 * reached the receiver, so it is retried only like a `connection` failure (a safe method or an
 * idempotency key), at once on a fresh connection; otherwise the caller sees it and decides.
 */
export const INTERNAL_CALL_FAILURES = [
  'connection',
  'stale_connection',
  'timeout',
  'aborted',
  'redirect',
  'response_too_large',
  'response_invalid',
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
  /**
   * The most connections kept open to the receiver at once: an integer of 1 or more; defaults to
   * {@link INTERNAL_DEFAULT_MAX_SOCKETS}. A call beyond it waits for a free one, and the wait
   * counts against its timeout; it never opens another connection.
   */
  maxSockets?: number
  /**
   * The most idle connections kept for reuse: an integer from 1 to `maxSockets` (Bun treats 0 as no limit, so 0 is refused);
   * defaults to {@link INTERNAL_DEFAULT_MAX_FREE_SOCKETS} or `maxSockets` if that is smaller.
   */
  maxFreeSockets?: number
  /** How long an idle connection is kept; defaults to {@link INTERNAL_DEFAULT_IDLE_TIMEOUT_MS}. */
  idleTimeoutMs?: number
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
  /** The parsed body, or `undefined` when it was empty, or not JSON on a non-2xx answer. */
  json: unknown
  /** Attempts made, the first included. */
  attempts: number
  /**
   * The answer's `Retry-After` in milliseconds, when the header was whole seconds (1 to 9 digits;
   * the date form is ignored). It is not capped: the client's own retry cuts it at `retryAfterCapMs`,
   * but this is the server's number, and the caller applies its own cap. Absent when there was no
   * such header. No other header is exposed.
   */
  retryAfterMs?: number
}

/** A client for calls from one Closeline service to another. */
export interface InternalClient {
  /**
   * Sends the call and resolves with any answer that was not a redirect, including 4xx and 5xx.
   * Rejects with {@link InternalCallError} when there is none. Retries only a connection failure,
   * a timeout, 429, 502, 503 and 504, and only when the method is idempotent or a key is given.
   */
  request(call: InternalRequest): Promise<InternalResponse>
  /**
   * Closes every connection this client holds, fails calls in flight or waiting for a connection
   * with `aborted`, and refuses later calls with a `TypeError`. Safe to call more than once. A
   * process need not call it to exit (idle connections do not hold it open), but a test or a
   * graceful shutdown should.
   */
  close(): void
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
 * It uses `node:http` and `node:https` with its own `Agent`, never `fetch`: Bun's `fetch` sends a
 * request to the proxy named by `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` (and their lower-case
 * forms) unless `NO_PROXY` names the host, and the bearer secret would travel with it. The
 * `node:` transport reads no proxy variable, so nothing in the environment can reroute a call.
 * `proxy.test.ts` pins this for the Bun version in use.
 *
 * Connections are reused. The client owns one private keep-alive `Agent` (never the global one,
 * never one passed in; an `Agent` reads no proxy variable either), capped at `maxSockets`
 * connections with `maxFreeSockets` kept idle for `idleTimeoutMs`. The cap is enforced by the
 * client's own queue, so a call waiting for a connection is bounded by its timeout and an aborted
 * one never reaches the wire. Two clients share nothing. A kept connection the receiver closed
 * fails as `stale_connection` (see {@link INTERNAL_CALL_FAILURES}). Call `close()` to end them.
 * Memory is bounded by `maxResponseBytes`. Redirects are never followed. TLS
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
  const maxSockets = options.maxSockets ?? INTERNAL_DEFAULT_MAX_SOCKETS
  if (!Number.isInteger(maxSockets) || maxSockets < 1) {
    throw new TypeError('maxSockets must be an integer of 1 or more')
  }
  const maxFreeSockets =
    options.maxFreeSockets ?? Math.min(INTERNAL_DEFAULT_MAX_FREE_SOCKETS, maxSockets)
  if (!Number.isInteger(maxFreeSockets) || maxFreeSockets < 1 || maxFreeSockets > maxSockets) {
    throw new TypeError('maxFreeSockets must be an integer from 1 to maxSockets')
  }
  const idleTimeoutMs = options.idleTimeoutMs ?? INTERNAL_DEFAULT_IDLE_TIMEOUT_MS
  if (!isPositive(idleTimeoutMs)) {
    throw new TypeError('idleTimeoutMs must be a finite number above zero')
  }
  const sleep = options.sleep ?? timerSleep
  const random = options.random ?? Math.random
  const send = base.secure ? httpsRequest : httpRequest
  // Private to this client. `maxSockets` is also enforced below, so the agent never queues.
  const agent = new (base.secure ? HttpsAgent : HttpAgent)({
    keepAlive: true,
    maxSockets,
    maxFreeSockets,
    timeout: idleTimeoutMs,
    scheduling: 'lifo',
    ...(base.secure ? { rejectUnauthorized: true } : {}),
    ...(options.ca === undefined ? {} : { ca: options.ca }),
  })
  const lifetime = new AbortController()

  // The client's own queue for connections: a waiter leaves it when its signal aborts, which
  // Bun's agent queue does not do (an aborted queued request still goes out later).
  let active = 0
  const waiting: Array<() => void> = []
  const acquire = (signal: AbortSignal): Promise<() => void> =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Failure('timeout'))
        return
      }
      const grant = () => {
        active += 1
        let released = false
        resolve(() => {
          if (!released) {
            released = true
            active -= 1
            waiting.shift()?.()
          }
        })
      }
      if (active < maxSockets) {
        grant()
        return
      }
      const turn = () => {
        signal.removeEventListener('abort', leave)
        grant()
      }
      const leave = () => {
        const at = waiting.indexOf(turn)
        if (at !== -1) {
          waiting.splice(at, 1)
        }
        reject(new Failure('timeout'))
      }
      signal.addEventListener('abort', leave, { once: true })
      waiting.push(turn)
    })

  /** One attempt on the wire, once it holds a connection slot. Rejects with the failure kind only. */
  const attempt = async (
    method: string,
    target: string,
    headers: Record<string, string | number>,
    body: string | undefined,
    signal: AbortSignal
  ): Promise<Wire> => {
    const release = await acquire(signal)
    try {
      return await onWire(method, target, headers, body, signal)
    } finally {
      release()
    }
  }

  /** One attempt on the wire. */
  const onWire = (
    method: string,
    target: string,
    headers: Record<string, string | number>,
    body: string | undefined,
    signal: AbortSignal
  ): Promise<Wire> =>
    new Promise((resolve, reject) => {
      let answered = false
      const outgoing = send(
        {
          host: base.host,
          port: base.port,
          path: target,
          method,
          headers,
          agent,
          signal,
          // Explicit, so NODE_TLS_REJECT_UNAUTHORIZED=0 in the environment cannot switch it off.
          ...(base.secure ? { rejectUnauthorized: true } : {}),
          ...(options.ca === undefined ? {} : { ca: options.ca }),
        },
        (response) => {
          answered = true
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
      outgoing.on('error', (error: NodeJS.ErrnoException) => {
        const reset = error.code === 'ECONNRESET' || error.code === 'EPIPE'
        reject(
          new Failure(
            signal.aborted
              ? 'timeout'
              : !answered && outgoing.reusedSocket && reset
                ? 'stale_connection'
                : 'connection'
          )
        )
      })
      outgoing.end(body)
    })

  return {
    close() {
      lifetime.abort()
      agent.destroy()
    },
    async request(call) {
      if (lifetime.signal.aborted) {
        throw new TypeError('the internal client is closed')
      }
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
        const signal = AbortSignal.any(
          call.signal ? [call.signal, timeout, lifetime.signal] : [timeout, lifetime.signal]
        )
        let retryAfter: number | undefined
        let reason: string
        try {
          const wire = await attempt(call.method, target, headers, payload, signal)
          const settled = (): InternalResponse => ({
            status: wire.status,
            json: answerJson(wire),
            attempts,
            ...(wire.retryAfter === undefined ? {} : { retryAfterMs: wire.retryAfter }),
          })
          if (!INTERNAL_RETRY_STATUSES.includes(wire.status)) {
            return settled()
          }
          if (!safeToRepeat || attempts >= maxAttempts) {
            return settled()
          }
          retryAfter = wire.retryAfter
          reason = `HTTP ${wire.status}`
        } catch (caught) {
          if (call.signal?.aborted || lifetime.signal.aborted) {
            throw fail('aborted')
          }
          const failure = caught instanceof Failure ? caught : new Failure('connection')
          const retryable =
            failure.kind === 'connection' ||
            failure.kind === 'stale_connection' ||
            failure.kind === 'timeout'
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
          reason === 'stale_connection'
            ? 0
            : retryAfter === undefined
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

/** The JSON of an answer; a non-empty 2xx body that is not JSON fails without being quoted. */
function answerJson(wire: { status: number; text: string }): unknown {
  const json = parseJson(wire.text)
  if (json === undefined && wire.status >= 200 && wire.status < 300 && wire.text.trim() !== '') {
    throw new Failure('response_invalid', wire.status)
  }
  return json
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
