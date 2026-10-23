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

/**
 * Who a preset is about: an Organization and a Prospect id, an address, or a Prospect id with one
 * of its addresses. The last form also records the address as one of the Prospect's identities;
 * consent is kept on the Prospect and a suppression on the address alone.
 */
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

function addressKey(target: ContactTarget): string | undefined {
  return target.email !== undefined
    ? `email:${target.email}`
    : target.phone !== undefined
      ? `phone:${target.phone}`
      : target.linkedinUrl !== undefined
        ? `linkedin:${target.linkedinUrl}`
        : undefined
}

function key(target: ContactTarget, channel: string): string {
  const who = target.prospectId !== undefined ? `prospect:${target.prospectId}` : addressKey(target)
  return JSON.stringify([target.organizationId, who, channel])
}

function identityKey(organizationId: string, prospectId: string): string {
  return JSON.stringify([organizationId, prospectId])
}

function addressOnly(target: ContactTarget): ContactTarget {
  const { prospectId: _prospectId, ...rest } = target
  return rest
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
  // A Prospect's stored identities: `[organization, prospect]` to the address keys it owns.
  const identities = new Map<string, Set<string>>()
  let unavailable = false

  function register(target: ContactTarget): void {
    const address = addressKey(target)
    if (target.prospectId !== undefined && address !== undefined) {
      const id = identityKey(target.organizationId, target.prospectId)
      identities.set(id, (identities.get(id) ?? new Set()).add(address))
    }
  }

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
      const missing: ContactGuardResult = {
        allowed: false,
        checkId: checkId(),
        code: 'consent.missing',
        suppressionReason: null,
      }
      const address = addressKey(request)
      if (request.prospectId !== undefined && address !== undefined) {
        // A Prospect with an address: the address must be one of its identities, suppression is
        // read on the address, and consent from the Prospect's own ledger.
        const owned = identities.get(identityKey(request.organizationId, request.prospectId))
        if (!owned?.has(address)) {
          return missing
        }
        const suppressed = presets.get(key({ ...addressOnly(request) }, request.channel))
        if (suppressed !== undefined && !suppressed.allowed) {
          return suppressed
        }
        return (
          presets.get(
            key(
              { organizationId: request.organizationId, prospectId: request.prospectId },
              request.channel
            )
          ) ?? missing
        )
      }
      return presets.get(key(request, request.channel)) ?? missing
    },
    allow(target, channel, basis = 'consent_granted') {
      register(target)
      presets.set(key(target, channel), { allowed: true, checkId: checkId(), basis })
      return guard
    },
    deny(target, channel, code = 'consent.missing', suppressionReason) {
      register(target)
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
