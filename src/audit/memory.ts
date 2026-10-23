import { type Clock, systemClock } from '../clock'
import type { Logger } from '../logger'
import { type AuditEntry, parseAuditEntry } from './entry'
import type { AuditRecorder } from './port'

/** Options for {@link createMemoryAuditRecorder}. */
export interface MemoryAuditRecorderOptions {
  /** Time source for entries without `occurredAt`. */
  clock?: Clock
  /** Receives one line per entry with ids and counts, never metadata values. */
  logger?: Logger
}

/** An {@link AuditRecorder} that keeps entries in the process, for tests. */
export interface MemoryAuditRecorder extends AuditRecorder {
  /** Copies of the recorded entries, one per event id, in recording order. */
  entries(): AuditEntry[]
}

/** Creates the in-memory recorder. The first entry for an event id is kept; later ones are ignored. */
export function createMemoryAuditRecorder(
  options: MemoryAuditRecorderOptions = {}
): MemoryAuditRecorder {
  const clock = options.clock ?? systemClock
  const stored = new Map<string, AuditEntry>()
  return {
    async record(input) {
      const entry = parseAuditEntry(input, clock)
      const key = `${entry.organizationId}\u0000${entry.id}`
      const duplicate = stored.has(key)
      if (!duplicate) {
        stored.set(key, structuredClone(entry))
      }
      options.logger?.info('audit entry recorded', {
        eventId: entry.id,
        action: entry.action,
        metadataKeys: Object.keys(entry.metadata ?? {}).length,
        duplicate,
      })
    },
    entries: () => [...stored.values()].map((entry) => structuredClone(entry)),
  }
}
