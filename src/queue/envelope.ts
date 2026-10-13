import { organizationIdSchema as contractOrganizationIdSchema } from 'tula-closeline-contract'
import { z } from 'zod'
import { type Clock, systemClock } from '../clock'
import { QUEUE_ERROR_CODES, QueueError } from './errors'

/** The largest message body SQS accepts, in bytes (256 KiB). Every adapter enforces it. */
export const MAX_MESSAGE_BYTES = 262_144

/** `organization` messages belong to one Organization and carry its id; `global` ones never do. */
export type MessageScope = 'organization' | 'global'

/** What one kind of message is: its name, its current version, its scope and its payload schema. */
export interface MessageDefinition<
  T extends string = string,
  P extends z.ZodType = z.ZodType,
  S extends MessageScope = MessageScope,
> {
  readonly type: T
  readonly version: number
  readonly scope: S
  readonly payload: P
  /** Older versions this consumer still accepts, each upcast to the current payload shape. */
  readonly previous?: readonly PreviousVersion[]
}

/**
 * An older version of a message that is still accepted, so a rolling deploy does not bounce the
 * messages in flight. The payload is validated with `payload` (the old shape), turned into the
 * current shape by `upcast`, and then validated again with the current schema. The handler only
 * ever sees the current shape, and the envelope it gets says the current version.
 */
export interface PreviousVersion {
  /** The older version number; must differ from the definition's own. */
  version: number
  /** The payload schema of that version. */
  payload: z.ZodType
  /** Turns a validated old payload into the current payload's input. A throw makes the message invalid. */
  upcast: (payload: unknown) => unknown
}

/** A definition of any type, for code that accepts every kind. */
export type AnyDefinition = MessageDefinition<string, z.ZodType, MessageScope>

const TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/

/**
 * Declares a message type. `type` looks like `area.event_name` (`core.organization_created`);
 * `version` is a positive integer you raise when the payload changes incompatibly. A consumer
 * accepts its current version and the `previous` versions it lists (each upcast to the current
 * shape); any other version waits in the queue with a growing delay, and reaches the dead-letter
 * queue if no consumer that understands it is deployed in time. Roll out a new version by deploying
 * consumers that list it as current (or the old one as `previous`) before publishers send it.
 */
export function defineMessage<
  const T extends string,
  P extends z.ZodType,
  const S extends MessageScope,
>(definition: {
  type: T
  version: number
  scope: S
  payload: P
  previous?: readonly PreviousVersion[]
}): MessageDefinition<T, P, S> {
  if (!TYPE_PATTERN.test(definition.type)) {
    throw new TypeError(`message type must look like "area.event_name", got "${definition.type}"`)
  }
  if (!Number.isInteger(definition.version) || definition.version < 1) {
    throw new TypeError(`message version must be a positive integer, got ${definition.version}`)
  }
  const seen = new Set<number>([definition.version])
  for (const older of definition.previous ?? []) {
    if (!Number.isInteger(older.version) || older.version < 1 || seen.has(older.version)) {
      throw new TypeError(`previous version ${older.version} is invalid or repeated`)
    }
    seen.add(older.version)
  }
  return Object.freeze({ ...definition })
}

/** The fields every envelope has. */
export interface EnvelopeBase<T extends string, P> {
  /** Unique id of this message; stays the same when the publisher retries, so consumers can dedupe. */
  id: string
  /** The message type, such as `core.organization_created`. */
  type: T
  /** The version of the type's definition this was written with. */
  version: number
  /** When the thing happened, ISO 8601 UTC. */
  occurredAt: string
  /** The request or trace id that caused it, for finding the log lines. */
  traceId: string
  /** The validated payload. */
  payload: P
}

type ScopeField<S> = S extends 'organization'
  ? { organizationId: string }
  : { organizationId?: undefined }

/** The envelope of a definition, or the union of the envelopes of a union of definitions. */
export type EnvelopeOf<D> =
  D extends MessageDefinition<infer T, infer P, infer S>
    ? EnvelopeBase<T, z.output<P>> & ScopeField<S>
    : never

/** The shape every envelope has, whatever its type. */
export interface AnyEnvelope {
  id: string
  type: string
  version: number
  occurredAt: string
  organizationId?: string | undefined
  traceId: string
  payload: unknown
}

/** What a publisher gives {@link MessageRegistry.create}; the registry adds the id and time. */
export type CreateInput<D> =
  D extends MessageDefinition<infer T, infer P, infer S>
    ? {
        type: T
        payload: z.input<P>
        traceId: string
        /** Keep a fixed id across retries of one logical event; defaults to a new UUID. */
        id?: string
        /** Defaults to the registry clock's now. */
        occurredAt?: Date
      } & ScopeField<S>
    : never

/** Why a received body is not a message this registry accepts. */
export const INVALID_REASONS = [
  'malformed',
  'unknown_type',
  'unsupported_version',
  'invalid_scope',
  'invalid_payload',
] as const

/** One of {@link INVALID_REASONS}. */
export type InvalidReason = (typeof INVALID_REASONS)[number]

/** The outcome of {@link MessageRegistry.decode}. `issues` are field paths and codes, never values. */
export type DecodeResult<E> =
  | { ok: true; envelope: E }
  | { ok: false; reason: InvalidReason; issues: string[]; messageId?: string }

/** Knows every message type a service handles; builds, encodes and decodes envelopes. */
export interface MessageRegistry<D extends AnyDefinition> {
  /** The definitions, by type. */
  readonly definitions: ReadonlyMap<string, D>
  /** Builds a validated envelope. Throws a ZodError when the payload does not fit its schema. */
  create(input: CreateInput<D>): EnvelopeOf<D>
  /**
   * Validates an envelope and turns it into the JSON body to send. Throws a QueueError with code
   * `queue.invalid_message` for an unknown type, a wrong version or scope, or a bad payload.
   * Complexity O(body size).
   */
  encode(envelope: EnvelopeOf<D>): string
  /**
   * Parses and validates a received body. Never throws: a body that is not an accepted message
   * comes back as `ok: false` so the caller decides what happens to it. O(body size).
   */
  decode(body: string): DecodeResult<EnvelopeOf<D>>
}

/** Options for {@link createMessageRegistry}. */
export interface MessageRegistryOptions {
  /** Time source for `occurredAt`; defaults to the system clock. */
  clock?: Clock
  /** Id source; defaults to `crypto.randomUUID`. */
  newId?: () => string
  /**
   * The shape of an Organization id, checked for `organization` messages on the way in and out.
   * Defaults to the contract's `organizationIdSchema` (`org_` and 32 lower-case hex digits).
   */
  organizationIdSchema?: z.ZodType<string>
}

/** The pattern ids and trace ids on the wire must match: they are written to logs, so no free text. */
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/
const SEGMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/

const envelopeSchema = z.object({
  id: z.string().regex(ID_PATTERN),
  type: z.string().min(1).max(128),
  version: z.number().int().min(1),
  occurredAt: z.iso.datetime(),
  organizationId: z.string().min(1).max(128).optional(),
  traceId: z.string().regex(ID_PATTERN),
  payload: z.unknown(),
})

/**
 * Field paths and codes of a ZodError, with no values. A path segment is kept only if it looks like
 * a field name; a record key, an array index or anything else (an email, a name) becomes `*`.
 */
function issuesOf(error: z.ZodError): string[] {
  return error.issues.slice(0, 20).map((issue) => {
    const path = issue.path
      .map((segment) =>
        typeof segment === 'string' && SEGMENT_PATTERN.test(segment) ? segment : '*'
      )
      .join('.')
    return `${path || '(root)'}: ${issue.code}`
  })
}

function invalid(reason: string, issues: string[]): QueueError {
  return new QueueError(QUEUE_ERROR_CODES.invalidMessage, `message is not valid: ${reason}`, {
    details: { reason, issues },
  })
}

/**
 * Builds a registry from the message definitions a service knows. Two definitions with the same
 * type are a mistake and throw.
 */
export function createMessageRegistry<const D extends AnyDefinition>(
  definitions: readonly D[],
  options: MessageRegistryOptions = {}
): MessageRegistry<D> {
  const byType = new Map<string, D>()
  for (const definition of definitions) {
    if (byType.has(definition.type)) {
      throw new TypeError(`message type ${definition.type} is defined twice`)
    }
    byType.set(definition.type, definition)
  }
  const clock = options.clock ?? systemClock
  const newId = options.newId ?? (() => crypto.randomUUID())
  const orgSchema: z.ZodType<string> = options.organizationIdSchema ?? contractOrganizationIdSchema

  function check(candidate: unknown): DecodeResult<EnvelopeOf<D>> {
    const shape = envelopeSchema.safeParse(candidate)
    if (!shape.success) {
      const id =
        typeof candidate === 'object' && candidate !== null && 'id' in candidate
          ? (candidate as { id: unknown }).id
          : undefined
      return {
        ok: false,
        reason: 'malformed',
        issues: issuesOf(shape.error),
        ...(typeof id === 'string' && ID_PATTERN.test(id) ? { messageId: id } : {}),
      }
    }
    const value = shape.data
    const base = { messageId: value.id }
    const definition = byType.get(value.type)
    if (definition === undefined) {
      return {
        ok: false,
        reason: 'unknown_type',
        issues: [`type: unknown, ${value.type.length} characters`],
        ...base,
      }
    }
    const older =
      value.version === definition.version
        ? undefined
        : definition.previous?.find((entry) => entry.version === value.version)
    if (value.version !== definition.version && older === undefined) {
      return {
        ok: false,
        reason: 'unsupported_version',
        issues: [`version: ${value.version}, accepted ${definition.version}`],
        ...base,
      }
    }
    if (definition.scope === 'organization') {
      if (value.organizationId === undefined) {
        return { ok: false, reason: 'invalid_scope', issues: ['organizationId: required'], ...base }
      }
      if (!orgSchema.safeParse(value.organizationId).success) {
        return { ok: false, reason: 'invalid_scope', issues: ['organizationId: invalid'], ...base }
      }
    } else if (value.organizationId !== undefined) {
      return {
        ok: false,
        reason: 'invalid_scope',
        issues: ['organizationId: not allowed'],
        ...base,
      }
    }
    const payload = (older?.payload ?? definition.payload).safeParse(value.payload)
    if (!payload.success) {
      return { ok: false, reason: 'invalid_payload', issues: issuesOf(payload.error), ...base }
    }
    let current: z.ZodSafeParseResult<unknown> = payload
    if (older !== undefined) {
      try {
        current = definition.payload.safeParse(older.upcast(payload.data))
      } catch {
        return { ok: false, reason: 'invalid_payload', issues: ['upcast: failed'], ...base }
      }
      if (!current.success) {
        return { ok: false, reason: 'invalid_payload', issues: issuesOf(current.error), ...base }
      }
    }
    const envelope: AnyEnvelope = {
      id: value.id,
      type: value.type,
      version: definition.version,
      occurredAt: value.occurredAt,
      traceId: value.traceId,
      payload: current.data,
    }
    if (value.organizationId !== undefined) {
      envelope.organizationId = value.organizationId
    }
    return { ok: true, envelope: envelope as EnvelopeOf<D> }
  }

  return {
    definitions: byType,
    create(input) {
      const request = input as CreateInput<AnyDefinition> & { organizationId?: string }
      const definition = byType.get(request.type)
      if (definition === undefined) {
        throw invalid('unknown_type', [`type: ${String(request.type).slice(0, 64)}`])
      }
      const envelope: AnyEnvelope = {
        id: request.id ?? newId(),
        type: definition.type,
        version: definition.version,
        occurredAt: (request.occurredAt ?? clock.now()).toISOString(),
        traceId: request.traceId,
        payload: definition.payload.parse(request.payload),
      }
      if (request.organizationId !== undefined) {
        envelope.organizationId = request.organizationId
      }
      const result = check(envelope)
      if (!result.ok) {
        throw invalid(result.reason, result.issues)
      }
      return result.envelope
    },
    encode(envelope) {
      const result = check(envelope)
      if (!result.ok) {
        throw invalid(result.reason, result.issues)
      }
      return JSON.stringify(result.envelope)
    },
    decode(body) {
      if (body.length > MAX_MESSAGE_BYTES) {
        return { ok: false, reason: 'malformed', issues: ['body: too large'] }
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(body)
      } catch {
        return { ok: false, reason: 'malformed', issues: ['body: not JSON'] }
      }
      return check(parsed)
    },
  }
}
