import { describe, expect, test } from 'bun:test'
import { createFixedClock, systemClock } from './clock'

const START = '2026-01-01T00:00:00.000Z'

describe('systemClock', () => {
  test('returns the current time', () => {
    const before = Date.now()
    const now = systemClock.now().getTime()
    expect(now).toBeGreaterThanOrEqual(before)
    expect(now).toBeLessThanOrEqual(Date.now())
  })
})

describe('createFixedClock', () => {
  test('starts at the given string or Date', () => {
    expect(createFixedClock(START).now()).toEqual(new Date(START))
    expect(createFixedClock(new Date(START)).now()).toEqual(new Date(START))
  })

  test('does not move on its own', () => {
    const clock = createFixedClock(START)
    expect(clock.now()).toEqual(clock.now())
  })

  test.each([
    ['500ms', 500],
    ['30s', 30_000],
    ['10m', 600_000],
    ['2h', 7_200_000],
    ['1d', 86_400_000],
  ])('advances by %s', (duration, ms) => {
    const clock = createFixedClock(START)
    clock.advance(duration)
    expect(clock.now()).toEqual(new Date(Date.parse(START) + ms))
  })

  test('advances accumulate', () => {
    const clock = createFixedClock(START)
    clock.advance('1h')
    clock.advance('30m')
    expect(clock.now()).toEqual(new Date('2026-01-01T01:30:00.000Z'))
  })

  test.each(['10 minutes', '', '10', 'm', '-5s', '1.5h', ' 5s', '5s ', '5w'])(
    'throws on the invalid duration %p',
    (duration) => {
      const clock = createFixedClock(START)
      expect(() => clock.advance(duration)).toThrow()
      expect(clock.now()).toEqual(new Date(START))
    }
  )

  test('throws on an invalid start', () => {
    expect(() => createFixedClock('not a date')).toThrow()
  })

  test('mutating a returned Date does not change the clock', () => {
    const clock = createFixedClock(START)
    const first = clock.now()
    first.setFullYear(1999)
    expect(clock.now()).toEqual(new Date(START))
    expect(clock.now()).not.toBe(clock.now())
  })

  test('mutating the start Date does not change the clock', () => {
    const start = new Date(START)
    const clock = createFixedClock(start)
    start.setFullYear(1999)
    expect(clock.now()).toEqual(new Date(START))
  })
})
