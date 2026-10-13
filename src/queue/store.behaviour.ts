import { afterEach, describe, expect, test } from 'bun:test'
import type { ConsumedKey, ProcessedStore } from './store'

/** What the store behaviour suite needs from an implementation under test. */
export interface StoreSubject {
  /** The store under test, empty. */
  store: ProcessedStore
  /** Lets `seconds` go by for leases: advances a virtual clock, or really waits. */
  pass(seconds: number): Promise<void>
  /** The store's current time, as `purge` compares it. */
  now(): Date
  /** Releases what the subject created (rows, connections). */
  close(): Promise<void>
}

const key: ConsumedKey = { consumer: 'c', organizationId: 'org_a', messageId: 'm1' }

async function claimed(store: ProcessedStore, k: ConsumedKey, lease = 60): Promise<string> {
  const result = await store.claim(k, lease)
  if (result.status !== 'claimed') {
    throw new Error(`expected a claim, got ${result.status}`)
  }
  return result.token
}

/**
 * The behaviour every {@link ProcessedStore} must show. A service runs it against its Postgres
 * store (`tula-closeline-kit/testing/behaviour`); the memory store runs it in this repo.
 * Leases are 60 seconds, so a subject that really waits should scale them or fake the database clock.
 */
export function processedStoreBehaviour(name: string, make: () => Promise<StoreSubject>): void {
  describe(`ProcessedStore behaviour: ${name}`, () => {
    const open: StoreSubject[] = []
    afterEach(async () => {
      await Promise.all(open.splice(0).map((subject) => subject.close()))
    })
    async function subject(): Promise<StoreSubject> {
      const made = await make()
      open.push(made)
      return made
    }

    test('a live claim is busy for everyone else, and a done message stays done', async () => {
      const { store } = await subject()
      const token = await claimed(store, key)
      expect(await store.claim(key, 60)).toMatchObject({ status: 'busy' })
      expect(await store.complete(key, token)).toBe(true)
      expect(await store.claim(key, 60)).toEqual({ status: 'done' })
    })

    test('busy reports the seconds left on the lease, rounded up, at least one', async () => {
      const { store, pass } = await subject()
      await claimed(store, key)
      await pass(10)
      const busy = await store.claim(key, 60)
      expect(busy.status).toBe('busy')
      if (busy.status === 'busy') {
        expect(busy.retryAfterSeconds).toBeGreaterThanOrEqual(49)
        expect(busy.retryAfterSeconds).toBeLessThanOrEqual(51)
      }
    })

    test('a lapsed claim can be taken again, and the old holder can no longer complete', async () => {
      const { store, pass } = await subject()
      const first = await claimed(store, key)
      await pass(61)
      const second = await claimed(store, key)
      expect(second).not.toBe(first)
      expect(await store.complete(key, first)).toBe(false)
      expect(await store.complete(key, second)).toBe(true)
    })

    test('release frees the claim for the next delivery; a stale token releases nothing', async () => {
      const { store } = await subject()
      const token = await claimed(store, key)
      await store.release(key, 'wrong-token')
      expect(await store.claim(key, 60)).toMatchObject({ status: 'busy' })
      await store.release(key, token)
      expect(await store.claim(key, 60)).toMatchObject({ status: 'claimed' })
    })

    test('the organization, the consumer and a missing organization are all part of the key', async () => {
      const { store } = await subject()
      await claimed(store, key)
      expect(await store.claim({ ...key, organizationId: 'org_b' }, 60)).toMatchObject({
        status: 'claimed',
      })
      expect(await store.claim({ ...key, organizationId: null }, 60)).toMatchObject({
        status: 'claimed',
      })
      expect(await store.claim({ ...key, consumer: 'other' }, 60)).toMatchObject({
        status: 'claimed',
      })
      expect(await store.claim(key, 60)).toMatchObject({ status: 'busy' })
    })

    test('completing a message that was never claimed does nothing', async () => {
      const { store } = await subject()
      expect(await store.complete(key, 'nope')).toBe(false)
    })

    test('renew pushes the lease out, and only for the holder of a live claim', async () => {
      const { store, pass } = await subject()
      const token = await claimed(store, key)
      await pass(50)
      expect(await store.renew(key, token, 60)).toBe(true)
      await pass(50)
      expect(await store.claim(key, 60)).toMatchObject({ status: 'busy' })
      expect(await store.renew(key, 'wrong-token', 60)).toBe(false)
      await pass(20)
      expect(await store.renew(key, token, 60)).toBe(false)
      expect(await store.renew({ ...key, messageId: 'never' }, token, 60)).toBe(false)
    })

    test('a completed claim cannot be renewed', async () => {
      const { store } = await subject()
      const token = await claimed(store, key)
      await store.complete(key, token)
      expect(await store.renew(key, token, 60)).toBe(false)
    })

    test('purge removes old done records and lapsed claims, at most `limit`, and keeps the rest', async () => {
      const { store, pass, now } = await subject()
      for (const id of ['a', 'b', 'c']) {
        const k = { ...key, messageId: id }
        await store.complete(k, await claimed(store, k))
      }
      const live = { ...key, messageId: 'live' }
      await claimed(store, live, 3600)
      await pass(10)
      const cutoff = now()
      expect(await store.purge(cutoff, 2)).toBe(2)
      expect(await store.purge(cutoff, 10)).toBe(1)
      expect(await store.claim({ ...key, messageId: 'a' }, 60)).toMatchObject({ status: 'claimed' })
      expect(await store.claim(live, 60)).toMatchObject({ status: 'busy' })
    })
  })
}
