import { transcriberBehaviour } from './behaviour'
import { createMemoryTranscriber } from './memory'

transcriberBehaviour('memory adapter', async () => {
  const a = `org_${'a'.repeat(32)}`
  const transcriber = createMemoryTranscriber({ isOrganizationId: () => true })
  return {
    transcriber,
    // The stand-in keeps its state in the instance, so reopening returns the same store.
    reopen: async () => transcriber,
    organizations: { a, b: `org_${'b'.repeat(32)}`, aExtended: `${a}ff` },
    close: async () => undefined,
  }
})
