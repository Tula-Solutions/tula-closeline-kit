import type { Clock } from '../clock'

/** Identifies one message for one consumer: what "already processed" is recorded against. */
export interface ConsumedKey {
  /** The consumer's name, so two consumers of different queues in one service do not collide. */
  consumer: string
  /** The Organization the message belongs to, or null for a global message. Part of the key on purpose. */
  organizationId: string | null
  /** The envelope id. */
  messageId: string
}

/** What {@link ProcessedStore.claim} answers. */
export type ClaimResult =
  | { status: 'claimed'; token: string }
  | { status: 'done' }
  | { status: 'busy' }

/**
 * Where an idempotent consumer records which messages are done. In production it is a Postgres
 * table in the service's own schema (see the README), never process memory, so any instance can be
 * stopped and a redelivery to another instance is still recognised.
 */
export interface ProcessedStore {
  /**
   * Tries to take the message for `leaseSeconds`. `claimed` returns a token that the claimant
   * must pass to `complete` or `release`; `done` means it was completed before; `busy` means
   * another claim is live. A claim whose lease ran out can be taken again, so a consumer that
   * died mid-handler does not block the message forever. Must be atomic (one statement).
   */
  claim(key: ConsumedKey, leaseSeconds: number): Promise<ClaimResult>
  /** Marks the message done. Returns false if the claim was lost (its lease ran out and another took it). */
  complete(key: ConsumedKey, token: string): Promise<boolean>
  /** Gives up a claim without completing, so the next delivery can take it. A lost claim is ignored. */
  release(key: ConsumedKey, token: string): Promise<void>
  /**
   * Deletes completed records older than `before` and lapsed claims, at most `limit` rows, and
   * returns how many. Call it from a periodic job. `before` must be older than the queue's message
   * retention (14 days at most), or a very late redelivery would run twice.
   */
  purge(before: Date, limit: number): Promise<number>
}

interface Row {
  state: 'claimed' | 'done'
  token: string
  /** Lease end for a claim, completion time for a done record, in epoch milliseconds. */
  at: number
}

function keyOf(key: ConsumedKey): string {
  return JSON.stringify([key.consumer, key.organizationId, key.messageId])
}

/** A {@link ProcessedStore} in process memory, for tests and local runs of one instance. */
export function createMemoryProcessedStore(options: {
  clock: Clock
  newToken?: () => string
}): ProcessedStore {
  const records = new Map<string, Row>()
  const newToken = options.newToken ?? (() => crypto.randomUUID())
  const now = () => options.clock.now().getTime()
  return {
    async claim(key, leaseSeconds) {
      const id = keyOf(key)
      const existing = records.get(id)
      if (existing?.state === 'done') {
        return { status: 'done' }
      }
      if (existing !== undefined && existing.at > now()) {
        return { status: 'busy' }
      }
      const token = newToken()
      records.set(id, { state: 'claimed', token, at: now() + leaseSeconds * 1000 })
      return { status: 'claimed', token }
    },
    async complete(key, token) {
      const id = keyOf(key)
      const existing = records.get(id)
      if (existing?.state !== 'claimed' || existing.token !== token) {
        return false
      }
      records.set(id, { state: 'done', token, at: now() })
      return true
    },
    async release(key, token) {
      const id = keyOf(key)
      const existing = records.get(id)
      if (existing?.state === 'claimed' && existing.token === token) {
        records.delete(id)
      }
    },
    async purge(before, limit) {
      let removed = 0
      for (const [id, record] of records) {
        if (removed >= limit) {
          break
        }
        const stale = record.state === 'done' ? record.at < before.getTime() : record.at <= now()
        if (stale) {
          records.delete(id)
          removed += 1
        }
      }
      return removed
    },
  }
}
