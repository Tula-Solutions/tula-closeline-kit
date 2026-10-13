import { describe, expect, test } from 'bun:test'
import { type ConsumedKey, createMemoryProcessedStore } from './store'
import { createVirtualTime } from './testing'

const key: ConsumedKey = { consumer: 'c', organizationId: 'org_a', messageId: 'm1' }

function setup() {
  const time = createVirtualTime()
  let counter = 0
  const store = createMemoryProcessedStore({ clock: time.clock, newToken: () => `t${++counter}` })
  return { time, store }
}

describe('memory processed store', () => {
  test('a live claim is busy for everyone else, and a done message stays done', async () => {
    const { store } = setup()
    expect(await store.claim(key, 60)).toEqual({ status: 'claimed', token: 't1' })
    expect(await store.claim(key, 60)).toEqual({ status: 'busy' })
    expect(await store.complete(key, 't1')).toBe(true)
    expect(await store.claim(key, 60)).toEqual({ status: 'done' })
  })

  test('a lapsed claim can be taken again, and the old holder can no longer complete', async () => {
    const { time, store } = setup()
    await store.claim(key, 60)
    await time.advance(60_000)
    expect(await store.claim(key, 60)).toEqual({ status: 'claimed', token: 't2' })
    expect(await store.complete(key, 't1')).toBe(false)
    expect(await store.complete(key, 't2')).toBe(true)
  })

  test('release frees the claim for the next delivery; a stale token releases nothing', async () => {
    const { store } = setup()
    await store.claim(key, 60)
    await store.release(key, 'wrong')
    expect(await store.claim(key, 60)).toEqual({ status: 'busy' })
    await store.release(key, 't1')
    expect(await store.claim(key, 60)).toMatchObject({ status: 'claimed' })
  })

  test('the organization and the consumer are part of the key', async () => {
    const { store } = setup()
    await store.claim(key, 60)
    expect(await store.claim({ ...key, organizationId: 'org_b' }, 60)).toMatchObject({
      status: 'claimed',
    })
    expect(await store.claim({ ...key, organizationId: null }, 60)).toMatchObject({
      status: 'claimed',
    })
    expect(await store.claim({ ...key, consumer: 'other' }, 60)).toMatchObject({
      status: 'claimed',
    })
  })

  test('completing a message that was never claimed does nothing', async () => {
    const { store } = setup()
    expect(await store.complete(key, 'nope')).toBe(false)
  })

  test('purge removes old done records and lapsed claims, at most `limit`, and keeps the rest', async () => {
    const { time, store } = setup()
    for (const id of ['a', 'b', 'c']) {
      await store.claim({ ...key, messageId: id }, 60)
      await store.complete({ ...key, messageId: id }, `t${id === 'a' ? 1 : id === 'b' ? 2 : 3}`)
    }
    await store.claim({ ...key, messageId: 'live' }, 3600)
    await time.advance(10_000)
    const cutoff = time.clock.now()
    expect(await store.purge(cutoff, 2)).toBe(2)
    expect(await store.purge(cutoff, 10)).toBe(1)
    expect(await store.claim({ ...key, messageId: 'a' }, 60)).toMatchObject({ status: 'claimed' })
    expect(await store.claim({ ...key, messageId: 'live' }, 60)).toEqual({ status: 'busy' })
  })
})
