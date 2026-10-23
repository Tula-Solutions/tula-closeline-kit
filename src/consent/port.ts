import {
  type ContactCheckRequest,
  type ContactCheckResult,
  contactCheckRequestSchema,
} from 'tula-closeline-contract'

/**
 * What a calling service gives the guard: the Contact Check body without `caller`, which the
 * guard fills in with the service's own name. There is no field that waives the check (ADR 0003).
 */
export type ContactGuardRequest = Omit<ContactCheckRequest, 'caller'>

/** The answer of a Contact Check: an allowance with its basis, or a denial with a `consent.*` code. */
export type ContactGuardResult = ContactCheckResult

/**
 * The question every channel asks before it contacts a Prospect: may I contact this Prospect, or
 * this address, on this channel now, for this purpose (ADR 0003, ADR 0021)? It never throws and it
 * fails closed: anything but a clear allowance is a denial, and a check that could not be answered
 * is a denial with `consent.unavailable`. Only `allowed: true` permits a contact.
 */
export interface ContactGuard {
  /** Asks the check; resolves with an allowance or a denial and never rejects. */
  check(request: ContactGuardRequest): Promise<ContactGuardResult>
}

/** The denial of a check that was not answered in time, or not at all (no logged check). */
export const CONTACT_UNAVAILABLE: ContactGuardResult = Object.freeze({
  allowed: false,
  checkId: null,
  code: 'consent.unavailable',
  suppressionReason: null,
})

/** Whether `request` is a well-formed Contact Check body once the caller is named. */
export function isContactGuardRequest(request: unknown, caller: string): boolean {
  return contactCheckRequestSchema.safeParse(withCaller(request, caller)).success
}

/** The request as the wire body: the caller added to a copy, never to the caller's object. */
export function withCaller(request: unknown, caller: string): unknown {
  return typeof request === 'object' && request !== null ? { ...request, caller } : request
}
