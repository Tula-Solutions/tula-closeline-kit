import { describe, expect, test } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import { createMemoryContactGuard } from './memory'

const org = formatId('org', 'a'.repeat(32))
const prospectId = formatId('prs', '1'.repeat(32))
const request = {
  organizationId: org,
  prospectId,
  channel: 'phone',
  purpose: 'rep_initiated',
} as const

describe('the memory ContactGuard', () => {
  test('records each valid call in order', async () => {
    const guard = createMemoryContactGuard()
    await guard.check(request)
    await guard.check({ ...request, channel: 'sms' })
    expect(guard.calls.map((c) => c.channel)).toEqual(['phone', 'sms'])
  })

  test('a suppressed preset carries a reason', async () => {
    const guard = createMemoryContactGuard().deny(
      { organizationId: org, prospectId },
      'phone',
      'consent.suppressed'
    )
    expect(await guard.check(request)).toMatchObject({ suppressionReason: 'manual' })
  })

  test('reset forgets presets, calls and unavailability', async () => {
    const guard = createMemoryContactGuard()
      .allow({ organizationId: org, prospectId }, 'phone')
      .setUnavailable()
    guard.reset()
    expect((await guard.check(request)).allowed).toBe(false)
    expect(guard.calls).toHaveLength(1)
    expect(await guard.check(request)).toMatchObject({ code: 'consent.missing' })
  })

  test('has no way to switch the check off', () => {
    expect(Object.keys(createMemoryContactGuard()).sort()).toEqual(
      ['allow', 'calls', 'check', 'deny', 'reset', 'setUnavailable'].sort()
    )
  })
})
