import { type Clock, systemClock } from '../clock'
import type { Logger } from '../logger'
import type { Queue } from '../queue/port'
import { parseAuditEntry } from './entry'
import { AUDIT_ERROR_CODES, AuditError } from './errors'
import { type AuditRecordedEnvelope, auditRecordedMessage } from './message'
import type { AuditRecorder } from './port'

/** Options for {@link createQueueAuditRecorder}. */
export interface QueueAuditRecorderOptions {
  /** Where `audit.recorded` is published; a queue that accepts that message type. */
  queue: Pick<Queue<AuditRecordedEnvelope>, 'publish'>
  /** Time source for entries without `occurredAt`. */
  clock?: Clock
  /** Receives one line per entry with ids and counts, never metadata values. */
  logger?: Logger
}

/**
 * Creates the recorder that publishes `audit.recorded`. The event id is the envelope id, so a
 * retry or a second call sends a message the consumer drops as a duplicate. O(entry size) and one
 * queue call.
 */
export function createQueueAuditRecorder(options: QueueAuditRecorderOptions): AuditRecorder {
  const clock = options.clock ?? systemClock
  return {
    async record(input) {
      const { id, organizationId, ...payload } = parseAuditEntry(input)
      const occurredAt = payload.occurredAt ?? clock.now().toISOString()
      const envelope: AuditRecordedEnvelope = {
        id,
        type: auditRecordedMessage.type,
        version: auditRecordedMessage.version,
        occurredAt,
        organizationId,
        traceId: payload.requestId ?? id,
        payload: { ...payload, occurredAt },
      }
      try {
        await options.queue.publish(envelope)
      } catch (cause) {
        throw new AuditError(AUDIT_ERROR_CODES.unavailable, 'the audit event could not be queued', {
          cause,
        })
      }
      options.logger?.info('audit entry recorded', {
        eventId: id,
        action: payload.action,
        metadataKeys: Object.keys(payload.metadata ?? {}).length,
      })
    },
  }
}
