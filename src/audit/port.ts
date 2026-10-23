import type { AuditEntryInput } from './entry'

export type { AuditEntry, AuditEntryInput } from './entry'

/**
 * Records one audit event: who or what did what to which subject. An entry holds ids, labels and
 * an action code, never a message body, transcript, secret or address. Core consumes the events
 * (`audit.recorded`) and writes the log.
 */
export interface AuditRecorder {
  /**
   * Records the entry. Idempotent per `entry.id`: recording the same id again changes nothing. Throws
   * an AuditError: `audit.invalid_entry`, `audit.entry_too_large` or, for the queue adapter,
   * `audit.unavailable` (retry with the same id). O(entry size), at most 4 KiB.
   */
  record(entry: AuditEntryInput): Promise<void>
}
