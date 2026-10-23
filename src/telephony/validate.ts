import {
  callIdSchema,
  e164PhoneSchema,
  membershipIdSchema,
  organizationIdSchema,
} from 'tula-closeline-contract'
import { TELEPHONY_ERROR_CODES, TelephonyError } from './errors'
import {
  type DisclosurePlayed,
  MAX_DISCLOSURE_TEXT_LENGTH,
  MAX_RING_LEGS,
  MAX_TELEPHONY_TIMEOUT_MS,
  type TelephonyOptions,
} from './port'

const PROVIDER_ID = /^[A-Za-z0-9._:-]{1,128}$/
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/

/** Refuses with `telephony.invalid_request`; `what` names the field, never its value. */
export function invalid(what: string): never {
  throw new TelephonyError(TELEPHONY_ERROR_CODES.invalidRequest, `${what} is not acceptable`)
}

/** Checks an Organization id. */
export function checkOrganizationId(value: unknown): string {
  return organizationIdSchema.safeParse(value).success
    ? (value as string)
    : invalid('organizationId')
}

/** Checks a Call id. */
export function checkCallId(value: unknown): string {
  return callIdSchema.safeParse(value).success ? (value as string) : invalid('callId')
}

/** Checks a Rep's membership id. */
export function checkIdentity(value: unknown): string {
  return membershipIdSchema.safeParse(value).success ? (value as string) : invalid('identity')
}

/** Checks an E.164 number. The value is never put in the error. */
export function checkNumber(value: unknown, what: string): string {
  return e164PhoneSchema.safeParse(value).success ? (value as string) : invalid(what)
}

/** Checks a provider id, idempotency key or recording id. */
export function checkProviderId(value: unknown, what: string): string {
  return typeof value === 'string' && PROVIDER_ID.test(value) ? value : invalid(what)
}

/** Checks the Disclosure wording version and text. */
export function checkDisclosure(version: unknown, text: unknown, aiAssisted: unknown): void {
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    invalid('wordingVersion')
  }
  if (
    typeof text !== 'string' ||
    text.trim().length === 0 ||
    text.length > MAX_DISCLOSURE_TEXT_LENGTH ||
    CONTROL.test(text)
  ) {
    invalid('text')
  }
  if (typeof aiAssisted !== 'boolean') {
    invalid('aiAssisted')
  }
}

/** Checks the identities to ring: 1 to {@link MAX_RING_LEGS} distinct membership ids. */
export function checkRingIdentities(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_RING_LEGS) {
    invalid('ringIdentities')
  }
  const identities = value.map(checkIdentity)
  return [...new Set(identities)]
}

/** Checks the socket a call's tracks are forked to; `ws:` only where `allowPlain` is true. */
export function checkDestinationUrl(value: unknown, allowPlain: boolean): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    invalid('destinationUrl')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return invalid('destinationUrl')
  }
  const secure = url.protocol === 'wss:'
  if (!(secure || (allowPlain && url.protocol === 'ws:')) || url.username || url.password) {
    invalid('destinationUrl')
  }
  return value
}

/** Resolves the timeout of an operation: the caller's, or the adapter's default. */
export function resolveTimeout(options: TelephonyOptions | undefined, fallback: number): number {
  const value = options?.timeoutMs ?? fallback
  if (!Number.isInteger(value) || value < 1 || value > MAX_TELEPHONY_TIMEOUT_MS) {
    invalid('timeoutMs')
  }
  return value
}

/**
 * The Disclosure rule of ADR 0003 for every adapter: a call whose Disclosure has not played
 * cannot be bridged, recorded or forked (`telephony.disclosure_required`), and forking audio to
 * an AI also needs a Disclosure that said so. Returns the played Disclosure.
 */
export function requireDisclosure(
  played: DisclosurePlayed | null | undefined,
  needsAi = false
): DisclosurePlayed {
  if (!played) {
    throw new TelephonyError(
      TELEPHONY_ERROR_CODES.disclosureRequired,
      'The Disclosure has not played on this call'
    )
  }
  if (needsAi && !played.aiAssisted) {
    throw new TelephonyError(
      TELEPHONY_ERROR_CODES.disclosureRequired,
      'The Disclosure did not say an AI takes part'
    )
  }
  return played
}
