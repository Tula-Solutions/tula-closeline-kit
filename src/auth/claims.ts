import {
  API_KEY_SCOPES,
  type ApiKeyId,
  type ApiKeyScope,
  apiKeyIdSchema,
  apiKeyScopeSchema,
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

/** The claims of a member's access token, besides the registered `iss`, `aud`, `exp`. It has no `act`. */
export const accessTokenClaimsSchema = z.object({
  /** Absent: a token that names an actor is not a member's. */
  act: z.undefined().optional(),
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

/** The `act` claim of a token minted for an API key. */
export const API_KEY_ACTOR = 'api_key'

/** The claims of an API key's access token: no `role`, and a closed, non-empty list of scopes. */
export const apiKeyTokenClaimsSchema = z.object({
  /** The actor: an API key, not a signed-in user. */
  act: z.literal(API_KEY_ACTOR),
  /** The API key. */
  sub: apiKeyIdSchema,
  /** The Organization the key belongs to. */
  org: organizationIdSchema,
  /** A key has no Membership, so a token that carries a role is not one auth minted. */
  role: z.undefined().optional(),
  /** The Region the Organization lives in. */
  region: regionSchema,
  /** What the key may do: one or more scopes from the contract's closed list. */
  scp: z.array(apiKeyScopeSchema).min(1).max(API_KEY_SCOPES.length),
  /** When the token was issued, in seconds since the epoch. */
  iat: z.number().finite(),
  /** When the token expires, in seconds since the epoch. */
  exp: z.number().finite(),
})

/** The identity a verified member's access token proves. */
export interface VerifiedToken {
  /** A signed-in user acting through a Membership. */
  actor: 'member'
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
  /** Never present: a member's token has no scopes. */
  scopes?: never
  /** Never present: a member's token is not an API key's. */
  apiKeyId?: never
}

/** The identity a verified API key token proves. It has no user and never a role. */
export interface VerifiedApiKeyToken {
  /** An API key acting for an Organization. */
  actor: 'api_key'
  /** The API key. */
  apiKeyId: ApiKeyId
  /** What the key may do; `write` does not include `read`. */
  scopes: readonly ApiKeyScope[]
  /** The Organization every query for this request must be scoped to. */
  organizationId: OrganizationId
  /** The Region the Organization lives in. */
  region: Region
  /** When the token was issued. */
  issuedAt: Date
  /** When the token stops being valid. */
  expiresAt: Date
  /** Never present: an API key has no Membership. */
  role?: never
  /** Never present: an API key is not a user. */
  userId?: never
}

/** What a verified access token proves: a member, or an API key; branch on `actor`. */
export type VerifiedIdentity = VerifiedToken | VerifiedApiKeyToken
