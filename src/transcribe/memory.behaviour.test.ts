import { transcriberBehaviour } from './behaviour'
import { createMemoryTranscriber } from './memory'

transcriberBehaviour('memory adapter', async () => {
  const a = `org_${'a'.repeat(32)}`
  return {
    transcriber: createMemoryTranscriber({ isOrganizationId: () => true }),
    organizations: { a, b: `org_${'b'.repeat(32)}`, aExtended: `${a}ff` },
    close: async () => undefined,
  }
})
