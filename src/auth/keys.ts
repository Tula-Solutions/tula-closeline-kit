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

async function importAll(jwks: unknown): Promise<Map<string, CryptoKey> | undefined> {
  const parsed = jwksSchema.safeParse(jwks)
  if (!parsed.success) {
    return undefined
  }
  const keys = new Map<string, CryptoKey>()
  for (const raw of parsed.data.keys) {
    const entry = await importPublicKey(raw)
    if (entry !== undefined && !keys.has(entry[0])) {
      keys.set(entry[0], entry[1])
    }
  }
  return keys
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
  return { getKey: async (kid) => keys.get(kid) }
}

/** Options for createRemoteKeySet. */
export interface RemoteKeySetOptions {
  /** The issuer's JWKS URL; must be https unless it points at localhost. */
  url: string
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

function assertUrl(raw: string): URL {
  const url = new URL(raw)
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new TypeError('The JWKS URL must be https')
  }
  return url
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
 * unknown `kid` triggers at most one refresh per cooldown window, shared by concurrent callers;
 * a failed refresh keeps serving the last good keys.
 */
export function createRemoteKeySet(options: RemoteKeySetOptions): RemoteKeySet {
  const url = assertUrl(options.url)
  const doFetch = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 3_000
  const retries = options.retries ?? 1
  const cooldownMs = options.cooldownMs ?? 30_000
  const maxAgeMs = options.maxAgeMs ?? 3_600_000
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const random = options.random ?? Math.random

  let keys: ReadonlyMap<string, CryptoKey> = new Map()
  let loadedAt: number | undefined
  let lastAttemptAt: number | undefined
  let inflight: Promise<void> | undefined

  const now = () => options.clock.now().getTime()

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
      if (fresh === undefined || fresh.size === 0) {
        throw new Error('JWKS held no usable key')
      }
      keys = fresh
      loadedAt = now()
    } catch (error) {
      options.logger?.warn('jwks refresh failed', {
        reason: error instanceof Error ? error.message : 'unknown',
        keysServed: keys.size,
      })
    }
  }

  function startRefresh(): Promise<void> {
    lastAttemptAt = now()
    const run = refresh().finally(() => {
      if (inflight === run) {
        inflight = undefined
      }
    })
    inflight = run
    return run
  }

  function cooldownElapsed(): boolean {
    return lastAttemptAt === undefined || now() - lastAttemptAt >= cooldownMs
  }

  return {
    async getKey(kid) {
      const cached = keys.get(kid)
      if (cached !== undefined) {
        // Serve the cached key; pick up rotations and revocations without blocking this request.
        if (
          loadedAt !== undefined &&
          now() - loadedAt >= maxAgeMs &&
          !inflight &&
          cooldownElapsed()
        ) {
          void startRefresh()
        }
        return cached
      }
      if (inflight) {
        await inflight
      } else if (cooldownElapsed()) {
        await startRefresh()
      }
      return keys.get(kid)
    },
    warm() {
      return inflight ?? startRefresh()
    },
  }
}
