import { e164PhoneSchema, organizationIdSchema, prospectIdSchema } from 'tula-closeline-contract'
import { MESSAGING_ERROR_CODES, MessagingError } from './errors'
import {
  DEFAULT_MESSAGING_RETRY_POLICY,
  DEFAULT_MESSAGING_TIMEOUT_MS,
  MAX_MESSAGE_BODY_CHARS,
  MAX_MESSAGING_TIMEOUT_MS,
  MAX_TEMPLATE_VARIABLE_CHARS,
  MAX_TEMPLATE_VARIABLES,
  MESSAGING_CHANNELS,
  MESSAGING_PURPOSES,
  type MessageContent,
  type MessagingChannel,
  type MessagingPurpose,
  type MessagingRetryPolicy,
  type ResolvedMessagingRetryPolicy,
  type SendMessageRequest,
} from './port'

const KEY = /^[A-Za-z0-9_.:-]{1,200}$/
const TEMPLATE_ID = /^HX[0-9a-fA-F]{32}$/
const VARIABLE_NAME = /^[A-Za-z0-9_]{1,64}$/
const REQUEST_KEYS = new Set([
  'organizationId',
  'prospectId',
  'channel',
  'purpose',
  'to',
  'content',
  'idempotencyKey',
  'timeoutMs',
  'retry',
  'signal',
])

/** Refuses with `messaging.invalid_request`; `what` names the field, never its value. */
export function invalid(what: string): never {
  throw new MessagingError(MESSAGING_ERROR_CODES.invalidRequest, `${what} is not acceptable`, {
    details: { field: what },
  })
}

function integerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Fills in the defaults of a retry policy and refuses a value out of range. */
export function resolveMessagingRetryPolicy(
  policy: MessagingRetryPolicy | undefined
): ResolvedMessagingRetryPolicy {
  if (policy !== undefined && !isRecord(policy)) {
    invalid('retry')
  }
  const maxRetries = policy?.maxRetries ?? DEFAULT_MESSAGING_RETRY_POLICY.maxRetries
  const baseDelayMs = policy?.baseDelayMs ?? DEFAULT_MESSAGING_RETRY_POLICY.baseDelayMs
  const maxDelayMs = policy?.maxDelayMs ?? DEFAULT_MESSAGING_RETRY_POLICY.maxDelayMs
  if (!integerIn(maxRetries, 0, 5)) {
    invalid('retry.maxRetries')
  }
  if (!integerIn(baseDelayMs, 1, 60_000)) {
    invalid('retry.baseDelayMs')
  }
  if (!integerIn(maxDelayMs, baseDelayMs, 60_000)) {
    invalid('retry.maxDelayMs')
  }
  return { maxRetries, baseDelayMs, maxDelayMs }
}

function checkContent(value: unknown, channel: MessagingChannel): MessageContent {
  if (!isRecord(value)) {
    return invalid('content')
  }
  const extra = (allowed: readonly string[]) => Object.keys(value).some((k) => !allowed.includes(k))
  if (value.kind === 'text') {
    if (extra(['kind', 'body'])) {
      invalid('content')
    }
    const body = value.body
    if (typeof body !== 'string' || body.length < 1 || body.length > MAX_MESSAGE_BODY_CHARS) {
      invalid('content.body')
    }
    if (body.trim().length === 0) {
      invalid('content.body')
    }
    return { kind: 'text', body }
  }
  if (value.kind === 'template') {
    if (extra(['kind', 'templateId', 'variables'])) {
      invalid('content')
    }
    if (channel !== 'whatsapp') {
      invalid('content.kind')
    }
    const templateId = value.templateId
    if (typeof templateId !== 'string' || !TEMPLATE_ID.test(templateId)) {
      invalid('content.templateId')
    }
    if (value.variables === undefined) {
      return { kind: 'template', templateId }
    }
    if (!isRecord(value.variables)) {
      return invalid('content.variables')
    }
    const entries = Object.entries(value.variables)
    if (entries.length > MAX_TEMPLATE_VARIABLES) {
      invalid('content.variables')
    }
    const variables: Record<string, string> = {}
    for (const [name, text] of entries) {
      if (
        !VARIABLE_NAME.test(name) ||
        typeof text !== 'string' ||
        text.length > MAX_TEMPLATE_VARIABLE_CHARS
      ) {
        invalid('content.variables')
      }
      variables[name] = text
    }
    return { kind: 'template', templateId, variables }
  }
  return invalid('content.kind')
}

/** A send request that passed every check, with its defaults filled in. */
export type CheckedSendRequest = Required<Omit<SendMessageRequest, 'signal' | 'retry'>> & {
  /** The resolved retry policy. */
  retry: ResolvedMessagingRetryPolicy
  /** The caller's signal, if any. */
  signal: AbortSignal | undefined
}

/**
 * Checks a send request and fills in its defaults. Unknown fields are refused, so no option can
 * stand in for or skip the Contact Check. Throws `messaging.invalid_request`; nothing has gone to
 * the vendor and the guard has not been asked.
 */
export function checkSendRequest(request: SendMessageRequest): CheckedSendRequest {
  if (!isRecord(request)) {
    return invalid('request')
  }
  for (const key of Object.keys(request)) {
    if (!REQUEST_KEYS.has(key)) {
      invalid('request')
    }
  }
  const organization = organizationIdSchema.safeParse(request.organizationId)
  if (!organization.success) {
    return invalid('organizationId')
  }
  const prospect = prospectIdSchema.safeParse(request.prospectId)
  if (!prospect.success) {
    return invalid('prospectId')
  }
  const channel = MESSAGING_CHANNELS.find((c) => c === request.channel)
  if (channel === undefined) {
    return invalid('channel')
  }
  const purpose: MessagingPurpose | undefined = MESSAGING_PURPOSES.find(
    (p) => p === request.purpose
  )
  if (purpose === undefined) {
    return invalid('purpose')
  }
  if (!e164PhoneSchema.safeParse(request.to).success || typeof request.to !== 'string') {
    return invalid('to')
  }
  if (typeof request.idempotencyKey !== 'string' || !KEY.test(request.idempotencyKey)) {
    return invalid('idempotencyKey')
  }
  const timeoutMs = request.timeoutMs ?? DEFAULT_MESSAGING_TIMEOUT_MS
  if (!integerIn(timeoutMs, 1, MAX_MESSAGING_TIMEOUT_MS)) {
    return invalid('timeoutMs')
  }
  if (request.signal !== undefined && !(request.signal instanceof AbortSignal)) {
    return invalid('signal')
  }
  return {
    organizationId: organization.data,
    prospectId: prospect.data,
    channel,
    purpose,
    to: request.to,
    content: checkContent(request.content, channel),
    idempotencyKey: request.idempotencyKey,
    timeoutMs,
    retry: resolveMessagingRetryPolicy(request.retry),
    signal: request.signal,
  }
}
