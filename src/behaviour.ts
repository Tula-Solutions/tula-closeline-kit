// The `tula-closeline-kit/testing/behaviour` entry: the behaviour suites a Queue adapter, a
// ProcessedStore, an ObjectStore and a VectorStore must pass. They import `bun:test`, so they have
// their own path and stay out of the main bundle. A service runs `processedStoreBehaviour` against
// its Postgres store.
export * from './queue/behaviour'
export * from './queue/store.behaviour'
export * from './storage/behaviour'
export * from './vector/behaviour'
