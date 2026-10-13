import { describe, expect, test } from 'bun:test'
import { AppError } from '../errors'
import { createMemoryErrorReporter } from './testing'

describe('createMemoryErrorReporter', () => {
  test('records each reported error with its context, in order', () => {
    const reporter = createMemoryErrorReporter()
    const first = new Error('one')
    const second = new TypeError('two')
    reporter.capture(first, { requestId: 'req_1', organizationId: 'org_1', status: 500 })
    reporter.capture(second)
    expect(reporter.captured).toEqual([
      { error: first, context: { requestId: 'req_1', organizationId: 'org_1', status: 500 } },
      { error: second, context: {} },
    ])
  })

  test('does not record an expected AppError, as the real reporter would not send it', () => {
    const reporter = createMemoryErrorReporter()
    reporter.capture(new AppError({ code: 'auth.token_expired', status: 401, message: 'expired' }))
    reporter.capture(new AppError({ code: 'core.down', status: 503, message: 'down' }))
    expect(reporter.captured.map((entry) => (entry.error as AppError).status)).toEqual([503])
  })

  test('keeps a copy of the context, so a later change by the caller does not alter it', () => {
    const reporter = createMemoryErrorReporter()
    const context = { requestId: 'req_1', tags: { a: 'b' } }
    reporter.capture(new Error('x'), context)
    context.requestId = 'changed'
    context.tags.a = 'changed'
    expect(reporter.captured[0]?.context).toEqual({ requestId: 'req_1', tags: { a: 'b' } })
  })

  test('records the timeout of each flush and resolves true', async () => {
    const reporter = createMemoryErrorReporter()
    expect(await reporter.flush(250)).toBe(true)
    expect(await reporter.flush(10)).toBe(true)
    expect(reporter.flushes).toEqual([250, 10])
  })
})
