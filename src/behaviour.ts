// The `tula-closeline-kit/testing/behaviour` entry: the behaviour suites a Queue adapter, a
// ProcessedStore, an ObjectStore, a VectorStore, a StreamingTranscribePort, an LlmPort, a CalendarPort and a TelephonyPort
// must pass. They import `bun:test`, so they have their own path and stay out of the main bundle.
// A service runs `processedStoreBehaviour` against its Postgres store.
export * from './calendar/behaviour'
export * from './consent/behaviour'
export * from './llm/behaviour'
export * from './queue/behaviour'
export * from './queue/store.behaviour'
export * from './storage/behaviour'
export * from './streaming-transcribe/behaviour'
export * from './telephony/behaviour'
export * from './transcribe/behaviour'
export * from './vector/behaviour'
