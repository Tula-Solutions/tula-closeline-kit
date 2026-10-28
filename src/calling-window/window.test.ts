import { describe, expect, test } from 'bun:test'
import { checkCallingWindow, timeZoneForNumber } from './index'

const NY = '+12125550100'
const LA = '+13105550100'
const at = (iso: string) => new Date(iso)

describe('timeZoneForNumber', () => {
  test('NANP area codes', () => {
    expect(timeZoneForNumber(NY)).toBe('America/New_York')
    expect(timeZoneForNumber('+13125550100')).toBe('America/Chicago')
    expect(timeZoneForNumber('+13035550100')).toBe('America/Denver')
    expect(timeZoneForNumber(LA)).toBe('America/Los_Angeles')
    expect(timeZoneForNumber('+16025550100')).toBe('America/Phoenix')
    expect(timeZoneForNumber('+18085550100')).toBe('Pacific/Honolulu')
    expect(timeZoneForNumber('+16715550100')).toBe('Pacific/Guam')
  })
  test('one-zone countries, three-digit and two-digit codes', () => {
    expect(timeZoneForNumber('+442071234567')).toBe('Europe/London')
    expect(timeZoneForNumber('+353871234567')).toBe('Europe/Dublin')
    expect(timeZoneForNumber('+819012345678')).toBe('Asia/Tokyo')
  })
  test('zone cannot be fixed gives undefined', () => {
    for (const n of [
      '+18505550100', // area code spanning two zones
      '+19075550100', // Alaska, Aleutians differ
      '+12005550100', // unassigned code
      '+14165550', // short NANP
      '+61412345678', // Australia, many zones
      '+5215512345678', // Mexico, many zones
      '+74951234567', // Russia
      '+342071234567', // Spain, Canary Islands
      '12125550100', // no plus
      '+1abc5550100',
      '',
    ]) {
      expect(timeZoneForNumber(n)).toBeUndefined()
    }
  })
  test('area codes spanning zones are refused', () => {
    for (const code of '541 458 775 306 474 639 423 208 928 906 850 270 574 812 219 605 701 308 785 915 709 250 807 907'.split(
      ' '
    )) {
      expect(timeZoneForNumber(`+1${code}5550100`)).toBeUndefined()
    }
  })
  test('override wins, and a bad override is unknown, not the number zone', () => {
    expect(timeZoneForNumber(NY, 'Asia/Kolkata')).toBe('Asia/Kolkata')
    expect(timeZoneForNumber(NY, 'Mars/Olympus')).toBeUndefined()
    expect(timeZoneForNumber('+61412345678', 'Australia/Sydney')).toBe('Australia/Sydney')
  })
})

describe('checkCallingWindow', () => {
  const check = (iso: string, e164 = NY, narrow?: { startMinute?: number; endMinute?: number }) =>
    checkCallingWindow({ e164, now: at(iso), narrow })

  test('08:00 is open, 07:59:59 is closed', () => {
    expect(check('2026-01-15T13:00:00Z').allowed).toBe(true) // 08:00 EST
    expect(check('2026-01-15T12:59:59Z').allowed).toBe(false)
  })
  test('21:00 is closed, 20:59:59 is open', () => {
    expect(check('2026-01-16T01:59:59Z').allowed).toBe(true)
    expect(check('2026-01-16T02:00:00Z').allowed).toBe(false)
  })
  test('unknown zone refuses with no default', () => {
    expect(check('2026-01-15T15:00:00Z', '+18505550100')).toEqual({
      allowed: false,
      reason: 'timezone_unknown',
    })
  })
  test('next opening before the window is the same day, after it is the next day', () => {
    const early = check('2026-01-15T10:00:00Z')
    expect(early).toMatchObject({ reason: 'outside_hours' })
    expect(
      early.allowed === false && 'nextOpening' in early && early.nextOpening?.toISOString()
    ).toBe('2026-01-15T13:00:00.000Z')
    const late = check('2026-01-16T03:00:00Z')
    expect(late.allowed === false && 'nextOpening' in late && late.nextOpening?.toISOString()).toBe(
      '2026-01-16T13:00:00.000Z'
    )
  })
  test('the same instant is a different local time across zones (date line)', () => {
    const now = '2026-01-15T20:00:00Z' // 15:00 NY, 10:00 Honolulu, 05:00 Tokyo next day
    expect(check(now).allowed).toBe(true)
    expect(check(now, '+18085550100').allowed).toBe(true)
    expect(check(now, '+819012345678').allowed).toBe(false)
    const tokyo = check(now, '+819012345678')
    expect(
      tokyo.allowed === false && 'nextOpening' in tokyo && tokyo.nextOpening?.toISOString()
    ).toBe(
      '2026-01-15T23:00:00.000Z' // 08:00 JST
    )
  })
  test('DST spring forward: the opening instant uses the new offset', () => {
    // US clocks jump on 2026-03-08. At 06:00 EST the next opening is 08:00 EDT = 12:00Z.
    const r = check('2026-03-08T11:00:00Z')
    expect(r.allowed).toBe(false)
    expect(r.allowed === false && 'nextOpening' in r && r.nextOpening?.toISOString()).toBe(
      '2026-03-08T12:00:00.000Z'
    )
    // Evening before: 22:00 EST on the 7th, next opening 08:00 EDT on the 8th.
    const eve = check('2026-03-08T03:00:00Z')
    expect(eve.allowed === false && 'nextOpening' in eve && eve.nextOpening?.toISOString()).toBe(
      '2026-03-08T12:00:00.000Z'
    )
    expect(check('2026-03-08T12:00:00Z').allowed).toBe(true) // 08:00 EDT
    expect(check('2026-03-08T11:59:59Z').allowed).toBe(false) // 07:59 EDT
  })
  test('DST fall back: 08:00 and 21:00 follow the new offset', () => {
    // US clocks return on 2026-11-01.
    expect(check('2026-11-01T13:00:00Z').allowed).toBe(true) // 08:00 EST
    expect(check('2026-11-01T12:59:59Z').allowed).toBe(false)
    expect(check('2026-11-02T01:59:59Z').allowed).toBe(true) // 20:59 EST
    expect(check('2026-11-02T02:00:00Z').allowed).toBe(false)
    const r = check('2026-11-01T03:00:00Z') // 23:00 EDT on the 31st
    expect(r.allowed === false && 'nextOpening' in r && r.nextOpening?.toISOString()).toBe(
      '2026-11-01T13:00:00.000Z'
    )
  })
  test('Phoenix has no DST', () => {
    expect(check('2026-07-15T15:00:00Z', '+16025550100').allowed).toBe(true) // 08:00 MST
    expect(check('2026-07-15T14:59:59Z', '+16025550100').allowed).toBe(false)
  })
  test('a narrowed window applies', () => {
    const narrow = { startMinute: 10 * 60, endMinute: 18 * 60 }
    expect(check('2026-01-15T14:59:59Z', NY, narrow).allowed).toBe(false) // 09:59
    expect(check('2026-01-15T15:00:00Z', NY, narrow).allowed).toBe(true)
    expect(check('2026-01-15T22:59:59Z', NY, narrow).allowed).toBe(true) // 17:59
    expect(check('2026-01-15T23:00:00Z', NY, narrow).allowed).toBe(false)
    const r = check('2026-01-15T14:00:00Z', NY, narrow)
    expect(r.allowed === false && 'nextOpening' in r && r.nextOpening?.toISOString()).toBe(
      '2026-01-15T15:00:00.000Z'
    )
  })
  test('a window that tries to widen is ignored', () => {
    const wide = { startMinute: 0, endMinute: 24 * 60 }
    expect(check('2026-01-15T12:59:59Z', NY, wide).allowed).toBe(false)
    expect(check('2026-01-16T02:00:00Z', NY, wide).allowed).toBe(false)
    expect(check('2026-01-15T13:00:00Z', NY, wide).allowed).toBe(true)
  })
  test('an empty, inverted or NaN narrowing closes the window', () => {
    for (const narrow of [
      { startMinute: 12 * 60, endMinute: 12 * 60 },
      { startMinute: 18 * 60, endMinute: 10 * 60 },
      { startMinute: Number.NaN },
      { endMinute: Number.NaN },
    ]) {
      const r = check('2026-01-15T17:00:00Z', NY, narrow)
      expect(r).toMatchObject({ allowed: false, reason: 'outside_hours' })
      expect('nextOpening' in r).toBe(false)
    }
  })
  test('override zone is used for the window', () => {
    const r = checkCallingWindow({
      e164: NY,
      now: at('2026-01-15T13:00:00Z'),
      timeZoneOverride: 'America/Los_Angeles',
    })
    expect(r.allowed).toBe(false) // 05:00 in LA
  })
})
