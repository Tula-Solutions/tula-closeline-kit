import { organizationIdSchema } from 'tula-closeline-contract'
import { z } from 'zod'
import { AUDIT_ERROR_CODES, AuditError } from './errors'

/** The bounds on an audit entry. */
export const AUDIT_LIMITS = {
  /** Most keys in `metadata`. */
  maxMetadataKeys: 20,
  /** Longest string value in `metadata`, in characters. */
  maxStringChars: 200,
  /** Largest serialised entry, in UTF-8 bytes. */
  maxEntryBytes: 4096,
} as const

/** Metadata keys that are refused in any case, because they would carry content or credentials. */
export const AUDIT_DENIED_METADATA_KEYS = [
  'body',
  'content',
  'text',
  'message',
  'transcript',
  'token',
  'secret',
  'password',
  'email',
] as const

const DENIED = new Set<string>(AUDIT_DENIED_METADATA_KEYS)

/** True when the key, compared without case and without punctuation, is a denied name. */
function isDeniedKey(key: string): boolean {
  return DENIED.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''))
}

const label = z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/)
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/)

const metadataKey = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/)
  .refine((key) => !isDeniedKey(key))

const metadataValue = z.union([
  z.string().max(AUDIT_LIMITS.maxStringChars),
  z.number().finite(),
  z.boolean(),
])

/** Flat metadata of ids and labels: at most 20 keys, strings of at most 200 characters, numbers and booleans. */
export const auditMetadataSchema = z
  .record(metadataKey, metadataValue)
  .refine((record) => Object.keys(record).length <= AUDIT_LIMITS.maxMetadataKeys)

/** Who or what acted. */
export const auditActorSchema = z
  .strictObject({
    kind: z.enum(['member', 'agent', 'api_key', 'system']),
    id: id.optional(),
  })
  .refine((actor) => actor.kind === 'system' || actor.id !== undefined)

/** What the action was done to. */
export const auditSubjectSchema = z.strictObject({ type: label, id })

/** The fields of an audit entry other than its event id and Organization. */
export const auditEventPayloadSchema = z.strictObject({
  actor: auditActorSchema,
  /** `area.verb`, such as `agent.sent_message`. */
  action: z
    .string()
    .regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/)
    .max(64),
  subject: auditSubjectSchema,
  /** The Agent instruction version the action ran under. */
  instructionVersion: z.number().int().positive().optional(),
  requestId: id.optional(),
  /** When it happened, ISO 8601 UTC; the recorder's clock when absent. */
  occurredAt: z.iso.datetime().optional(),
  metadata: auditMetadataSchema.optional(),
})

/** The shape of one audit entry; unknown fields are refused. */
export const auditEntrySchema = auditEventPayloadSchema.extend({
  /** The event id; recording the same id again is a no-op. */
  id,
  organizationId: organizationIdSchema,
})

/** A validated audit entry. */
export type AuditEntry = z.output<typeof auditEntrySchema>

/** What a caller gives {@link AuditRecorder.record}. */
export type AuditEntryInput = z.input<typeof auditEntrySchema>

/** Field paths and issue codes of a failed parse; never a value. */
function issuesOf(error: z.ZodError): string[] {
  return error.issues
    .slice(0, 20)
    .map((issue) => `${issue.path.map(String).join('.')}: ${issue.code}`)
}

/**
 * Validates an entry and checks its serialised size. Throws an AuditError `audit.invalid_entry`
 * or `audit.entry_too_large`; neither holds a value from the entry. O(entry size).
 */
export function parseAuditEntry(input: unknown): AuditEntry {
  const parsed = auditEntrySchema.safeParse(input)
  if (!parsed.success) {
    throw new AuditError(AUDIT_ERROR_CODES.invalidEntry, 'the audit entry is not valid', {
      details: { issues: issuesOf(parsed.error) },
    })
  }
  const bytes = new TextEncoder().encode(JSON.stringify(parsed.data)).length
  if (bytes > AUDIT_LIMITS.maxEntryBytes) {
    throw new AuditError(AUDIT_ERROR_CODES.entryTooLarge, 'the audit entry is too large', {
      details: { bytes, maxBytes: AUDIT_LIMITS.maxEntryBytes },
    })
  }
  return parsed.data
}
