import { organizationIdSchema } from 'tula-closeline-contract'
import type { OrganizationIdCheck } from './organization'

// Internal: not exported from any entry of the package.

/** The Organization id format of the contract: `org_` and 32 lower-case hex digits. */
export const contractOrganizationIdCheck: OrganizationIdCheck = (value) =>
  organizationIdSchema.safeParse(value).success

// Whatever a caller's check says, an id used to build a key prefix or a namespace name can hold
// only these characters, so it can never carry a separator, a dot, an escape or a wildcard.
const SAFE_ORGANIZATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/**
 * Builds the one function every store uses to accept an Organization id. The id must pass the
 * hard character rule above and the `check` (the contract's format by default), so a store never
 * builds a key or a namespace from a caller's string that was not validated first. Pass a looser
 * `check` only in tests.
 */
export function createOrganizationIdGuard(
  check: OrganizationIdCheck = contractOrganizationIdCheck
): (value: unknown) => value is string {
  return (value): value is string =>
    typeof value === 'string' && SAFE_ORGANIZATION_ID.test(value) && check(value)
}
