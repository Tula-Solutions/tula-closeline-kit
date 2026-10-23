import { contactGuardBehaviour } from './behaviour'
import { createMemoryContactGuard } from './memory'

contactGuardBehaviour('memory adapter', async () => {
  const guard = createMemoryContactGuard()
  return {
    guard,
    allow: (target, channel) => void guard.allow(target, channel),
    deny: (target, channel, code, reason) => void guard.deny(target, channel, code, reason),
    makeUnavailable: () => void guard.setUnavailable(),
    reached: () => guard.calls,
    close: async () => undefined,
  }
})
