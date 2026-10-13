import { describe, expect, test } from 'bun:test'
import { AppError, isAppError, toErrorBody } from './errors'

describe('AppError', () => {
  test('carries code, status, message and details', () => {
    const error = new AppError({
      code: 'auth.token_expired',
      status: 401,
      message: 'The token has expired',
      details: { expiredAt: '2026-01-01T00:00:00.000Z' },
    })
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('AppError')
    expect(error.code).toBe('auth.token_expired')
    expect(error.status).toBe(401)
    expect(error.message).toBe('The token has expired')
    expect(error.details).toEqual({ expiredAt: '2026-01-01T00:00:00.000Z' })
  })

  test.each([
    'token_expired',
    'Auth.token_expired',
    'auth.Token',
    'auth.',
    '.reason',
    'auth.token.expired',
    'auth.token-expired',
    '1auth.reason',
    'auth.1reason',
    '',
    'auth.reason\n',
  ])('rejects the malformed code %p', (code) => {
    expect(() => new AppError({ code, status: 400, message: 'x' })).toThrow()
  })

  test.each(['auth.token_expired', 'a.b', 'billing.plan_limit_2'])(
    'accepts the code %p',
    (code) => {
      expect(new AppError({ code, status: 400, message: 'x' }).code).toBe(code)
    }
  )

  test.each([0, 99, 600, 200.5, Number.NaN])('rejects the status %p', (status) => {
    expect(() => new AppError({ code: 'a.b', status, message: 'x' })).toThrow()
  })
})

describe('isAppError', () => {
  test('is true for an AppError', () => {
    expect(isAppError(new AppError({ code: 'a.b', status: 400, message: 'x' }))).toBe(true)
  })

  test('is false for a plain Error and for non-errors', () => {
    expect(isAppError(new Error('x'))).toBe(false)
    expect(isAppError({ code: 'a.b', status: 400, message: 'x' })).toBe(false)
    expect(isAppError(null)).toBe(false)
    expect(isAppError('a.b')).toBe(false)
  })
})

describe('toErrorBody', () => {
  test('omits details when absent', () => {
    const body = toErrorBody(new AppError({ code: 'a.b', status: 404, message: 'missing' }))
    expect(body).toEqual({ error: { code: 'a.b', message: 'missing' } })
    expect('details' in body.error).toBe(false)
  })

  test('includes details when present', () => {
    const body = toErrorBody(
      new AppError({ code: 'a.b', status: 422, message: 'bad', details: { field: 'email' } })
    )
    expect(body).toEqual({ error: { code: 'a.b', message: 'bad', details: { field: 'email' } } })
  })
})
