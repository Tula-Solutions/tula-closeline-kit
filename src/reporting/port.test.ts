import { describe, expect, test } from 'bun:test'
import { AppError } from '../errors'
import { shouldReportError } from './port'

function appError(status: number): AppError {
  return new AppError({ code: 'area.reason', status, message: 'm' })
}

describe('shouldReportError', () => {
  test.each([400, 401, 403, 404, 409, 422, 429, 499])(
    'an AppError with status %i is expected',
    (status) => {
      expect(shouldReportError(appError(status))).toBe(false)
    }
  )

  test.each([500, 502, 503, 504, 599])('an AppError with status %i is reported', (status) => {
    expect(shouldReportError(appError(status))).toBe(true)
  })

  test.each([
    ['an Error', new Error('boom')],
    ['a TypeError', new TypeError('boom')],
    ['a string', 'boom'],
    ['null', null],
    ['undefined', undefined],
    ['a plain object', { status: 404 }],
    [
      'an object with a throwing getter',
      Object.defineProperty({}, 'name', {
        get: () => {
          throw new Error('x')
        },
      }),
    ],
  ])('an unknown error (%s) is reported', (_name, error) => {
    expect(shouldReportError(error)).toBe(true)
  })

  test('an AppError from another copy of the kit is recognised by its shape', () => {
    const foreign = Object.assign(new Error('m'), { name: 'AppError', status: 404, code: 'a.b' })
    expect(shouldReportError(foreign)).toBe(false)
    expect(shouldReportError(Object.assign(foreign, { status: 502 }))).toBe(true)
  })

  test('an Error that only carries a 4xx status is still unknown, so it is reported', () => {
    expect(shouldReportError(Object.assign(new Error('m'), { status: 404 }))).toBe(true)
  })
})
