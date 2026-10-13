import { describe, expect, test } from 'bun:test'
import { createMemoryProcessedStore } from './store'
import { processedStoreBehaviour } from './store.behaviour'
import { createVirtualTime } from './testing'

processedStoreBehaviour('memory store', async () => {
  const time = createVirtualTime()
  return {
    store: createMemoryProcessedStore({ clock: time.clock }),
    pass: (seconds) => time.advance(seconds * 1000),
    now: () => time.clock.now(),
    close: async () => undefined,
  }
})

describe('memory processed store specifics', () => {
  test('busy reports the exact remainder', async () => {
    const time = createVirtualTime()
    const store = createMemoryProcessedStore({ clock: time.clock, newToken: () => 't1' })
    const key = { consumer: 'c', organizationId: null, messageId: 'm' }
    await store.claim(key, 60)
    await time.advance(10_500)
    expect(await store.claim(key, 60)).toEqual({ status: 'busy', retryAfterSeconds: 50 })
    await time.advance(49_000)
    expect(await store.claim(key, 60)).toEqual({ status: 'busy', retryAfterSeconds: 1 })
  })
})
