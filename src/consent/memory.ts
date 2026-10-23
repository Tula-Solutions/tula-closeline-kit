import {
  type ContactCheckResult,
  type ContactDenialCode,
  formatId,
  type SuppressionReason,
} from 'tula-closeline-contract'
import {
  CONTACT_UNAVAILABLE,
  type ContactGuard,
  type ContactGuardRequest,
  type ContactGuardResult,
  isContactGuardRequest,
} from './port'

type Basis = Extract<ContactCheckResult, { allowed: true }>['basis']

/** The caller name the memory guard checks requests under. */
const MEMORY_CALLER = 'memory'

/** Who a preset is about: an Organization and exactly one of a Prospect id or an address. */
export type ContactTarget = Pick<
  ContactGuardRequest,
  'organizationId' | 'prospectId' | 'email' | 'phone' | 'linkedinUrl'
>

/** A {@link ContactGuard} that tests configure, and that records what it was asked. */
export interface MemoryContactGuard extends ContactGuard {
  /** Every valid request the guard answered, in order. */
  readonly calls: readonly ContactGuardRequest[]
  /** Allows contact with `target` on `channel` for any purpose. */
  allow(
    target: ContactTarget,
    channel: ContactGuardRequest['channel'],
    basis?: Basis
  ): MemoryContactGuard
  /** Denies contact with `target` on `channel` with `code`; a suppressed denial needs a reason. */
  deny(
    target: ContactTarget,
    channel: ContactGuardRequest['channel'],
    code?: Exclude<ContactDenialCode, 'consent.unavailable'>,
    suppressionReason?: SuppressionReason
  ): MemoryContactGuard
  /** Makes every check answer as if core could not be reached (or, with `false`, restores it). */
  setUnavailable(unavailable?: boolean): MemoryContactGuard
  /** Forgets every preset and call. */
  reset(): void
}

function key(target: ContactTarget, channel: string): string {
  const who =
    target.prospectId !== undefined
      ? `prospect:${target.prospectId}`
      : target.email !== undefined
        ? `email:${target.email}`
        : target.phone !== undefined
          ? `phone:${target.phone}`
          : `linkedin:${target.linkedinUrl}`
  return JSON.stringify([target.organizationId, who, channel])
}

let counter = 0
function checkId() {
  counter += 1
  return formatId('chk', counter.toString(16).padStart(32, '0'))
}

/**
 * Builds a {@link ContactGuard} for tests. A target nobody presets is denied with
 * `consent.missing`, as core denies an unknown Prospect. It validates requests as the HTTP guard
 * does: an invalid one is denied with `consent.unavailable` and is not recorded. Not for production.
 */
export function createMemoryContactGuard(): MemoryContactGuard {
  const presets = new Map<string, ContactGuardResult>()
  const calls: ContactGuardRequest[] = []
  let unavailable = false

  const guard: MemoryContactGuard = {
    calls,
    async check(request) {
      if (!isContactGuardRequest(request, MEMORY_CALLER)) {
        return CONTACT_UNAVAILABLE
      }
      calls.push({ ...request })
      if (unavailable) {
        return CONTACT_UNAVAILABLE
      }
      return (
        presets.get(key(request, request.channel)) ?? {
          allowed: false,
          checkId: checkId(),
          code: 'consent.missing',
          suppressionReason: null,
        }
      )
    },
    allow(target, channel, basis = 'consent_granted') {
      presets.set(key(target, channel), { allowed: true, checkId: checkId(), basis })
      return guard
    },
    deny(target, channel, code = 'consent.missing', suppressionReason) {
      const reason = code === 'consent.suppressed' ? (suppressionReason ?? 'manual') : null
      presets.set(key(target, channel), {
        allowed: false,
        checkId: checkId(),
        code,
        suppressionReason: reason,
      })
      return guard
    },
    setUnavailable(value = true) {
      unavailable = value
      return guard
    },
    reset() {
      presets.clear()
      calls.length = 0
      unavailable = false
    },
  }
  return guard
}
