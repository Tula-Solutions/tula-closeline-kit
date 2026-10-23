import { afterEach, describe, expect, test } from 'bun:test'
import { type ContactDenialCode, formatId, type SuppressionReason } from 'tula-closeline-contract'
import type { ContactTarget } from './memory'
import type { ContactGuard, ContactGuardRequest } from './port'

/** What the behaviour suite needs from a {@link ContactGuard} under test. */
export interface ContactGuardSubject {
  /** The guard under test, with nothing preset: an unknown target is denied. */
  guard: ContactGuard
  /** Makes the check answer allowed for `target` on `channel`. */
  allow(target: ContactTarget, channel: ContactGuardRequest['channel']): void
  /** Makes the check answer denied with `code` for `target` on `channel`. */
  deny(
    target: ContactTarget,
    channel: ContactGuardRequest['channel'],
    code: Exclude<ContactDenialCode, 'consent.unavailable'>,
    suppressionReason?: SuppressionReason
  ): void
  /** Makes the check unreachable, as if core did not answer. */
  makeUnavailable(): void
  /** The requests that reached the check, in order. */
  reached(): readonly ContactGuardRequest[]
  /** Removes what the subject created. */
  close(): Promise<void>
}

/**
 * The behaviour every {@link ContactGuard} must show: it answers what the check answers, an
 * unknown target is denied, and anything that is not a clear answer is a denial with
 * `consent.unavailable`; it never throws and never allows by default. Run it against the memory
 * adapter and the HTTP adapter.
 */
export function contactGuardBehaviour(
  name: string,
  make: () => Promise<ContactGuardSubject>
): void {
  describe(`ContactGuard behaviour: ${name}`, () => {
    const open: ContactGuardSubject[] = []
    afterEach(async () => {
      await Promise.all(open.splice(0).map((subject) => subject.close()))
    })
    async function subject(): Promise<ContactGuardSubject> {
      const made = await make()
      open.push(made)
      return made
    }
    const org = formatId('org', 'a'.repeat(32))
    const otherOrg = formatId('org', 'b'.repeat(32))
    const prospectId = formatId('prs', '1'.repeat(32))
    const target = { organizationId: org, prospectId } as const
    const request = {
      ...target,
      channel: 'sms',
      purpose: 'agent_initiated',
    } as const

    test('a target nobody allowed is denied as missing', async () => {
      const s = await subject()
      const result = await s.guard.check(request)
      expect(result.allowed).toBe(false)
      expect(result).toMatchObject({ code: 'consent.missing', suppressionReason: null })
    })

    test('an allowed target is allowed with a basis and a check id', async () => {
      const s = await subject()
      s.allow(target, 'sms')
      const result = await s.guard.check(request)
      expect(result).toMatchObject({ allowed: true, basis: 'consent_granted' })
      expect(result.checkId).not.toBeNull()
    })

    test('an allowance holds for one channel and not another', async () => {
      const s = await subject()
      s.allow(target, 'sms')
      expect((await s.guard.check({ ...request, channel: 'phone' })).allowed).toBe(false)
      expect((await s.guard.check({ ...request, channel: 'sms' })).allowed).toBe(true)
    })

    test('an allowance for one Organization does not reach another', async () => {
      const s = await subject()
      s.allow(target, 'sms')
      const result = await s.guard.check({ ...request, organizationId: otherOrg })
      expect(result.allowed).toBe(false)
    })

    test.each([
      ['consent.missing', undefined],
      ['consent.withdrawn', undefined],
      ['consent.suppressed', 'unsubscribe'],
    ] as const)('a %s denial is passed through as core gave it', async (code, reason) => {
      const s = await subject()
      s.deny(target, 'sms', code, reason)
      const result = await s.guard.check(request)
      expect(result).toMatchObject({
        allowed: false,
        code,
        suppressionReason: reason ?? null,
      })
    })

    test('an address can be checked as well as a Prospect', async () => {
      const s = await subject()
      const email = { organizationId: org, email: 'pat@example.com' }
      s.allow(email, 'email')
      const result = await s.guard.check({ ...email, channel: 'email', purpose: 'agent_initiated' })
      expect(result.allowed).toBe(true)
    })

    describe('a Prospect with one of its own addresses', () => {
      const phone = '+14155550142'
      const own = { organizationId: org, prospectId, phone } as const
      const combined = { ...own, channel: 'sms', purpose: 'agent_initiated' } as const

      test("is allowed when the address is the Prospect's and the Prospect consented", async () => {
        const s = await subject()
        s.allow(own, 'sms')
        expect((await s.guard.check(combined)).allowed).toBe(true)
        expect(s.reached()).toEqual([combined])
      })

      test("is denied as missing for another Prospect's address", async () => {
        const s = await subject()
        s.allow(own, 'sms')
        const result = await s.guard.check({ ...combined, phone: '+14155550177' })
        expect(result).toMatchObject({ allowed: false, code: 'consent.missing' })
      })

      test('is denied as missing when the Prospect has no such identity', async () => {
        const s = await subject()
        s.allow({ organizationId: org, prospectId }, 'sms')
        const result = await s.guard.check(combined)
        expect(result).toMatchObject({ allowed: false, code: 'consent.missing' })
      })

      test('is denied as suppressed when the address is suppressed, though the Prospect is not', async () => {
        const s = await subject()
        s.allow(own, 'sms')
        s.deny({ organizationId: org, phone }, 'sms', 'consent.suppressed', 'unsubscribe')
        const result = await s.guard.check(combined)
        expect(result).toMatchObject({
          allowed: false,
          code: 'consent.suppressed',
          suppressionReason: 'unsubscribe',
        })
      })

      test('is denied in a second Organization', async () => {
        const s = await subject()
        s.allow(own, 'sms')
        const result = await s.guard.check({ ...combined, organizationId: otherOrg })
        expect(result.allowed).toBe(false)
      })
    })

    test('the channel and purpose reach the check', async () => {
      const s = await subject()
      await s.guard.check({ ...request, channel: 'whatsapp', purpose: 'reply' })
      expect(s.reached()).toHaveLength(1)
      expect(s.reached()[0]).toMatchObject({
        organizationId: org,
        prospectId,
        channel: 'whatsapp',
        purpose: 'reply',
      })
    })

    test('a check that cannot be answered is denied as unavailable, never allowed', async () => {
      const s = await subject()
      s.allow(target, 'sms')
      s.makeUnavailable()
      const result = await s.guard.check(request)
      expect(result).toEqual({
        allowed: false,
        checkId: null,
        code: 'consent.unavailable',
        suppressionReason: null,
      })
    })

    test('a request naming two addresses is denied as unavailable and asks nothing', async () => {
      const s = await subject()
      s.allow(target, 'sms')
      const result = await s.guard.check({
        ...request,
        email: 'pat@example.com',
        phone: '+14155550142',
      })
      expect(result).toMatchObject({ allowed: false, code: 'consent.unavailable' })
      expect(s.reached()).toHaveLength(0)
    })

    test('a request with no target is denied as unavailable', async () => {
      const s = await subject()
      const result = await s.guard.check({
        organizationId: org,
        channel: 'sms',
        purpose: 'agent_initiated',
      })
      expect(result).toMatchObject({ allowed: false, code: 'consent.unavailable' })
    })
  })
}
