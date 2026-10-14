import { objectStoreBehaviour } from './behaviour'
import { createMemoryObjectStore } from './memory'

const MAX_OBJECT_BYTES = 2048

objectStoreBehaviour('memory adapter', async () => {
  const store = createMemoryObjectStore({
    maxObjectBytes: MAX_OBJECT_BYTES,
    isOrganizationId: () => true,
  })
  const a = `org_${'a'.repeat(32)}`
  return {
    store,
    organizations: { a, b: `org_${'b'.repeat(32)}`, aExtended: `${a}ff` },
    maxObjectBytes: MAX_OBJECT_BYTES,
    readPresigned: async (url) => (await store.resolvePresigned(url))?.body,
    close: async () => undefined,
  }
})
