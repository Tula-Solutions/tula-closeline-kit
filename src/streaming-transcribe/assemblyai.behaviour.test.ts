import { organizationIdSchema } from 'tula-closeline-contract'
import { createMemoryErrorReporter } from '../reporting/testing'
import { createAssemblyAiStreamingTranscribe } from './assemblyai'
import { createFakeAssemblyAi, FAKE_ASSEMBLYAI_KEY } from './assemblyai.fake'
import { streamingTranscribeBehaviour } from './behaviour'
import type { StreamEvent, StreamingTranscribePort } from './port'

streamingTranscribeBehaviour('assemblyai adapter over a fake vendor', async () => {
  const reporter = createMemoryErrorReporter()
  const logs: string[] = []
  const logger = {
    debug: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    info: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    warn: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    error: (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f })),
    child: () => logger,
  }
  const fake = createFakeAssemblyAi()
  const inner = createAssemblyAiStreamingTranscribe({
    apiKey: FAKE_ASSEMBLYAI_KEY,
    socket: fake.socket,
    reporter,
    logger,
    random: () => 0.5,
  })
  // Follows each stream's state from its events so `dropConnection` can wait for it to settle.
  const status = new Map<string, 'open' | 'reconnecting' | 'ended'>()
  const port: StreamingTranscribePort = {
    async open(request, options) {
      let current: 'open' | 'reconnecting' | 'ended' = 'open'
      let id = ''
      const stream = await inner.open(
        {
          ...request,
          onEvent: (event: StreamEvent) => {
            if (event.type === 'reconnecting') {
              current = 'reconnecting'
            } else if (event.type === 'reconnected') {
              current = 'open'
            } else if (event.type === 'failed' || event.type === 'closed') {
              current = 'ended'
            }
            if (id !== '') {
              status.set(id, current)
            }
            request.onEvent(event)
          },
        },
        options
      )
      id = stream.streamId
      status.set(id, current)
      return stream
    },
  }
  // The stream id is the id of its first session; later sessions of the same Call and track are its reconnections.
  const sessionsOf = (streamId: string) => {
    const first = fake.connections.find((c) => c.sessionId === streamId)
    return fake.connections.filter(
      (c) =>
        !c.closed &&
        first !== undefined &&
        c.meta.organizationId === first.meta.organizationId &&
        c.meta.callId === first.meta.callId &&
        c.meta.track === first.meta.track
    )
  }
  return {
    port,
    organizations: {
      a: organizationIdSchema.parse(`org_${'a'.repeat(32)}`),
      b: organizationIdSchema.parse(`org_${'b'.repeat(32)}`),
    },
    reporter,
    logs: () => logs,
    hear: (organizationId, callId, track, turns, bytesPerTurn) =>
      fake.hear(
        organizationId,
        callId,
        track,
        turns.map((turn, index) => ({ text: turn.text, afterBytes: bytesPerTurn * (index + 1) }))
      ),
    dropConnection: async (streamId) => {
      if (status.get(streamId) !== 'open') {
        return
      }
      for (const connection of sessionsOf(streamId)) {
        fake.drop(connection.sessionId)
      }
      const deadline = Date.now() + 5000
      while (status.get(streamId) === 'reconnecting') {
        if (Date.now() > deadline) {
          throw new Error('Timed out waiting for the stream to settle')
        }
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
    },
    failReconnects: (times) => fake.refuseNext(times),
    close: async () => undefined,
  }
})
