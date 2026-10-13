import { queueBehaviour } from './behaviour'
import { createMemoryQueue } from './memory'
import { createTestRegistry, createVirtualTime } from './testing'

queueBehaviour('memory adapter', async () => {
  const time = createVirtualTime()
  const registry = createTestRegistry({ clock: time.clock })
  const queue = createMemoryQueue({
    registry,
    clock: time.clock,
    sleep: time.sleep,
    maxReceiveCount: 3,
  })
  return {
    queue,
    registry,
    visibilitySeconds: 5,
    maxReceiveCount: 3,
    pass: (seconds) => time.advance(seconds * 1000),
    injectRaw: async (body) => queue.publishRaw(body),
    deadLetterIds: async () =>
      queue
        .deadLetters()
        .map((letter) => letter.messageId)
        .filter((id): id is string => id !== undefined),
    close: async () => undefined,
  }
})
