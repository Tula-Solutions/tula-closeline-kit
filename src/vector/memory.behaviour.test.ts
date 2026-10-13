import { vectorStoreBehaviour } from './behaviour'
import { createMemoryVectorStore } from './memory'

vectorStoreBehaviour('memory adapter', async () => {
  const store = createMemoryVectorStore({ dimensions: 8, isOrganizationId: () => true })
  const a = `org_${'a'.repeat(32)}`
  return {
    store,
    organizations: { a, b: `org_${'b'.repeat(32)}`, aExtended: `${a}ff` },
    close: async () => undefined,
  }
})
