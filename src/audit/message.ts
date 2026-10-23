import { defineMessage, type EnvelopeOf } from '../queue/envelope'
import { auditEventPayloadSchema } from './entry'

/** The `audit.recorded` message: one audit event. The envelope id is the event id. */
export const auditRecordedMessage = defineMessage({
  type: 'audit.recorded',
  version: 1,
  scope: 'organization',
  payload: auditEventPayloadSchema,
})

/** The envelope of {@link auditRecordedMessage}. */
export type AuditRecordedEnvelope = EnvelopeOf<typeof auditRecordedMessage>
