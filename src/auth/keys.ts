import { importJWK } from 'jose'
import { z } from 'zod'
import type { Clock } from '../clock'
import type { Logger } from '../logger'

/** The most keys a JWKS may hold; a larger set is refused outright. */
export const MAX_JWKS_KEYS = 20
/** The largest JWKS response body, in bytes, that the remote key set will read. */
export const MAX_JWKS_BYTES = 64 * 1024

/** Where a TokenVerifier finds the public key for a token's `kid`. */
export interface KeySet {
  /** Returns the key for `kid`, or undefined when it is unknown. Never throws. */
  getKey(kid: string): Promise<CryptoKey | undefined>
  /** Whether the set currently holds loaded keys that are not stale. Never throws. */
  available(): boolean
  /**
   * Whether the issuer has answered in full, most recently, without `kid`: only then is a `kid`
   * that getKey did not find a bad token. False means the set cannot tell a forged `kid` from a
   * newly rotated key (no answer yet, the last refresh failed, or one is still running). Call it
   * right after getKey. Never throws.
   */
  confirmsAbsent(kid: string): boolean
}

/** A JSON Web Key Set as published by the auth service. */
export interface Jwks {
  keys: readonly unknown[]
}

const publicJwkSchema = z.object({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  x: z.string().min(1).max(100),
  kid: z.string().min(1).max(128),
  use: z.literal('sig').optional(),
  alg: z.literal('EdDSA').optional(),
  // A private key in a JWKS is a leak: refuse the whole key rather than ignore the field.
  d: z.never().optional(),
})

const jwksSchema = z.object({ keys: z.array(z.unknown()).max(MAX_JWKS_KEYS) })

async function importPublicKey(raw: unknown): Promise<[string, CryptoKey] | undefined> {
  const parsed = publicJwkSchema.safeParse(raw)
  if (!parsed.success) {
    return undefined
  }
  try {
    const { kty, crv, x, kid } = parsed.data
    const key = await importJWK({ kty, crv, x }, 'EdDSA')
    return key instanceof Uint8Array ? undefined : [kid, key]
  } catch {
    return undefined
  }
}

interface ImportedJwks {
  keys: Map<string, CryptoKey>
  /** Entries in the JWKS, usable or not. */
  received: number
  /** Entries that were refused or repeated a kid. */
  skipped: number
  /** Entries that carried private key material (`d`). */
  privateEntries: number
}

function carriesPrivateKey(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && Object.hasOwn(raw, 'd')
}

async function importAll(jwks: unknown): Promise<ImportedJwks | undefined> {
  const parsed = jwksSchema.safeParse(jwks)
  if (!parsed.success) {
    return undefined
  }
  const keys = new Map<string, CryptoKey>()
  let privateEntries = 0
  for (const raw of parsed.data.keys) {
    if (carriesPrivateKey(raw)) {
      privateEntries++
    }
    const entry = await importPublicKey(raw)
    if (entry !== undefined && !keys.has(entry[0])) {
      keys.set(entry[0], entry[1])
    }
  }
  const received = parsed.data.keys.length
  return { keys, received, skipped: received - keys.size, privateEntries }
}

/** Creates a key set from a JWKS given at boot. Throws when any key is not a public Ed25519 key. */
export async function createStaticKeySet(jwks: Jwks): Promise<KeySet> {
  const parsed = jwksSchema.safeParse(jwks)
  if (!parsed.success || parsed.data.keys.length === 0) {
    throw new TypeError(`JWKS must hold 1 to ${MAX_JWKS_KEYS} keys`)
  }
  const keys = new Map<string, CryptoKey>()
  for (const raw of parsed.data.keys) {
    const entry = await importPublicKey(raw)
    if (entry === undefined || keys.has(entry[0])) {
      throw new TypeError('JWKS holds a key that is not a unique public Ed25519 key with a kid')
    }
    keys.set(entry[0], entry[1])
  }
  return {
    getKey: async (kid) => keys.get(kid),
    available: () => true,
    confirmsAbsent: (kid) => !keys.has(kid),
  }
}

/** Options for createRemoteKeySet. */
export interface RemoteKeySetOptions {
  /** The issuer's JWKS URL; must be https, carry no credentials, and not be http unless allowed. */
  url: string
  /** Allows an http URL when the host is localhost or 127.0.0.1; defaults to false. Local only. */
  allowInsecureLocalhost?: boolean
  /** Time source for the cooldown and cache age. */
  clock: Clock
  /** Receives a warning when a refresh fails. Never receives token content. */
  logger?: Logger
  /** Fetch implementation; defaults to the global one. */
  fetch?: typeof fetch
  /** Per-attempt timeout; defaults to 3000. */
  timeoutMs?: number
  /** Retries after a network error, timeout or 5xx within one refresh; defaults to 1. */
  retries?: number
  /** Minimum gap between refresh attempts, successful or not; defaults to 30000. */
  cooldownMs?: number
  /** Age after which a cached key set is refreshed in the background; defaults to 3600000. */
  maxAgeMs?: number
  /**
   * Age after which the cached keys are dropped if no refresh has succeeded; defaults to 86400000.
   * Must exceed `maxAgeMs`. Lookups then find nothing and `available()` is false.
   */
  maxStaleMs?: number
  /** The longest one lookup waits for a refresh before giving up; defaults to 5000. */
  lookupDeadlineMs?: number
  /** Waits before a retry; defaults to a timer. Tests inject a no-op. */
  sleep?: (ms: number) => Promise<void>
  /** Source of jitter in [0, 1); defaults to Math.random. */
  random?: () => number
}

/** A KeySet that fetches and caches the issuer's JWKS. */
export interface RemoteKeySet extends KeySet {
  /** Fetches the JWKS now, ignoring the cooldown, so the first request needn't pay for it. */
  warm(): Promise<void>
}

class RetryableFetchError extends Error {}

function assertUrl(raw: string, allowInsecureLocalhost: boolean): URL {
  const url = new URL(raw)
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('The JWKS URL must not carry credentials')
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && allowInsecureLocalhost)) {
    throw new TypeError('The JWKS URL must be https')
  }
  return url
}

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number`)
  }
}

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_JWKS_BYTES) {
    throw new Error('JWKS response too large')
  }
  const reader = response.body?.getReader()
  if (reader === undefined) {
    return ''
  }
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      return text + decoder.decode()
    }
    total += value.byteLength
    if (total > MAX_JWKS_BYTES) {
      await reader.cancel()
      throw new Error('JWKS response too large')
    }
    text += decoder.decode(value, { stream: true })
  }
}

/**
 * Creates a key set backed by the issuer's JWKS URL. Lookups of a cached `kid` do no I/O. An
 * unknown `kid` triggers at most one refresh per cooldown window, shared by concurrent callers,
 * and no lookup waits longer than the deadline. A failed refresh keeps serving the last good keys
 * until they are `maxStaleMs` old, after which they are dropped and `available()` is false.
 * `confirmsAbsent(kid)` is true only when the most recent refresh succeeded and lacked `kid`.
 */
export function createRemoteKeySet(options: RemoteKeySetOptions): RemoteKeySet {
  const url = assertUrl(options.url, options.allowInsecureLocalhost === true)
  const doFetch = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 3_000
  const retries = options.retries ?? 1
  const cooldownMs = options.cooldownMs ?? 30_000
  const maxAgeMs = options.maxAgeMs ?? 3_600_000
  const maxStaleMs = options.maxStaleMs ?? 86_400_000
  const lookupDeadlineMs = options.lookupDeadlineMs ?? 5_000
  assertPositive('maxStaleMs', maxStaleMs)
  assertPositive('lookupDeadlineMs', lookupDeadlineMs)
  if (maxStaleMs <= maxAgeMs) {
    throw new TypeError('maxStaleMs must be greater than maxAgeMs')
  }
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const random = options.random ?? Math.random

  let keys: ReadonlyMap<string, CryptoKey> = new Map()
  let loadedAt: number | undefined
  let lastAttemptAt: number | undefined
  // Whether the most recent attempt, the one that started the current cooldown, ended in a JWKS.
  let lastAttemptSucceeded = false
  let inflight: Promise<void> | undefined

  const now = () => options.clock.now().getTime()

  // A logger that throws must never break a key lookup or leave a background refresh rejected.
  function log(level: 'warn' | 'error', message: string, fields: Record<string, unknown>): void {
    try {
      options.logger?.[level](message, fields)
    } catch {
      // Nothing useful can be done about a broken logger here.
    }
  }

  // A clock that stepped backwards makes the elapsed time negative: count that as elapsed.
  const hasElapsed = (since: number, ms: number) => {
    const elapsed = now() - since
    return elapsed < 0 || elapsed >= ms
  }

  function isStale(): boolean {
    return loadedAt !== undefined && Math.max(0, now() - loadedAt) >= maxStaleMs
  }

  async function fetchOnce(): Promise<unknown> {
    let response: Response
    try {
      response = await doFetch(url, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      throw new RetryableFetchError('JWKS request failed')
    }
    if (response.status >= 500 || response.status === 429) {
      await response.body?.cancel()
      throw new RetryableFetchError('JWKS request failed')
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`JWKS request returned ${response.status}`)
    }
    return JSON.parse(await readBounded(response))
  }

  async function fetchWithRetry(): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fetchOnce()
      } catch (error) {
        if (!(error instanceof RetryableFetchError) || attempt >= retries) {
          throw error
        }
        await sleep(100 + Math.floor(random() * 100))
      }
    }
  }

  async function refresh(): Promise<void> {
    try {
      const fresh = await importAll(await fetchWithRetry())
      if (fresh === undefined) {
        throw new Error('JWKS was not well-formed')
      }
      if (fresh.privateEntries > 0) {
        log('error', 'jwks entry carries private key material', {
          privateEntries: fresh.privateEntries,
        })
      }
      // A JWKS that is empty on purpose withdraws every key; one whose entries are all unusable
      // is more likely a broken publisher, so the last good keys stay.
      if (fresh.keys.size === 0 && fresh.received > 0) {
        throw new Error('JWKS held no usable key')
      }
      if (fresh.skipped > 0) {
        log('warn', 'jwks entries skipped', { skipped: fresh.skipped, received: fresh.received })
      }
      keys = fresh.keys
      loadedAt = now()
      lastAttemptSucceeded = true
    } catch (error) {
      lastAttemptSucceeded = false
      log('warn', 'jwks refresh failed', {
        reason: error instanceof Error ? error.message : 'unknown',
        keysServed: keys.size,
      })
    }
  }

  function startRefresh(): Promise<void> {
    lastAttemptAt = now()
    // Not an answer yet: a lookup cut off at its deadline must not read the previous one.
    lastAttemptSucceeded = false
    const run = refresh().finally(() => {
      if (inflight === run) {
        inflight = undefined
      }
    })
    inflight = run
    return run
  }

  function cooldownElapsed(): boolean {
    return lastAttemptAt === undefined || hasElapsed(lastAttemptAt, cooldownMs)
  }

  function dropIfStale(): void {
    if (isStale()) {
      keys = new Map()
      loadedAt = undefined
      log('error', 'jwks keys dropped as stale', { maxStaleMs })
    }
  }

  // The refresh itself keeps running for other callers; only this lookup stops waiting for it.
  async function waitForRefresh(run: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<'deadline'>((resolve) => {
      timer = setTimeout(() => resolve('deadline'), lookupDeadlineMs)
    })
    try {
      if ((await Promise.race([run, deadline])) === 'deadline') {
        log('warn', 'jwks lookup deadline exceeded', { lookupDeadlineMs })
      }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async getKey(kid) {
      dropIfStale()
      const cached = keys.get(kid)
      if (cached !== undefined) {
        // Serve the cached key; pick up rotations and revocations without blocking this request.
        if (
          loadedAt !== undefined &&
          hasElapsed(loadedAt, maxAgeMs) &&
          !inflight &&
          cooldownElapsed()
        ) {
          void startRefresh()
        }
        return cached
      }
      const pending = inflight ?? (cooldownElapsed() ? startRefresh() : undefined)
      if (pending !== undefined) {
        await waitForRefresh(pending)
      }
      return keys.get(kid)
    },
    available() {
      dropIfStale()
      return loadedAt !== undefined
    },
    confirmsAbsent(kid) {
      dropIfStale()
      return loadedAt !== undefined && lastAttemptSucceeded && !inflight && !keys.has(kid)
    },
    warm() {
      return inflight ?? startRefresh()
    },
  }
}
