import {
  type OrganizationId,
  organizationIdSchema,
  type Region,
  type Role,
  regionSchema,
  roleSchema,
  type UserId,
  userIdSchema,
} from 'tula-closeline-contract'
import { z } from 'zod'

/** The longest access token, in characters, that verification will look at. */
export const MAX_TOKEN_LENGTH = 4096

/** The claims every Closeline access token carries, besides the registered `iss`, `aud`, `exp`. */
export const accessTokenClaimsSchema = z.object({
  /** The signed-in user. */
  sub: userIdSchema,
  /** The Organization the token is scoped to, stamped in by the auth service (ADR 0005). */
  org: organizationIdSchema,
  /** The user's role in that Organization, stamped in by the auth service. */
  role: roleSchema,
  /** The Region the Organization lives in. */
  region: regionSchema,
  /** When the token was issued, in seconds since the epoch. */
  iat: z.number().finite(),
  /** When the token expires, in seconds since the epoch. */
  exp: z.number().finite(),
})

/** The identity a verified access token proves. */
export interface VerifiedToken {
  /** The signed-in user. */
  userId: UserId
  /** The Organization every query for this request must be scoped to. */
  organizationId: OrganizationId
  /** The user's role in that Organization. */
  role: Role
  /** The Region the Organization lives in. */
  region: Region
  /** When the token was issued. */
  issuedAt: Date
  /** When the token stops being valid. */
  expiresAt: Date
}
