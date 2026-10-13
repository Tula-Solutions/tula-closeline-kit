import { describe, expect, test } from 'bun:test'
import { redactFields } from './redact'

describe('message bodies', () => {
  test.each([
    'body',
    'bodies',
    'requestBody',
    'response_body',
    'rawBody',
    'messageBodies',
    'email-body',
  ])('%s is redacted', (key) => {
    expect(redactFields({ [key]: ['hello'] })).toEqual({ [key]: '[redacted]' })
  })

  test.each(['bodyLength', 'bodySize', 'body_bytes', 'hasBody2'])('%s is kept', (key) => {
    expect(redactFields({ [key]: 12 })).toEqual({ [key]: 12 })
  })
})

describe('language-model token counts', () => {
  test.each([
    'inputTokens',
    'outputTokens',
    'total_tokens',
    'maxTokens',
    'prompt-tokens',
    'tokens',
  ])('a numeric %s is a usage figure and is kept', (key) => {
    expect(redactFields({ [key]: 1200 })).toEqual({ [key]: 1200 })
  })

  test.each([
    ['tokens', 'abc'],
    ['tokens', ['abc']],
    ['sessionTokens', { a: 'abc' }],
    ['token', 1200],
    ['passwords', 1234],
    ['secrets', 42],
    ['apiKeys', 7],
  ])('%s holding %p is still redacted', (key, value) => {
    expect(redactFields({ [key]: value })).toEqual({ [key]: '[redacted]' })
  })

  test('a token count is kept inside nested objects and Maps', () => {
    const usage = new Map<string, unknown>([
      ['outputTokens', 80],
      ['refreshTokens', 'abc'],
    ])
    expect(redactFields({ call: { inputTokens: 1200, accessTokens: 'abc' }, usage })).toEqual({
      call: { inputTokens: 1200, accessTokens: '[redacted]' },
      usage: { outputTokens: 80, refreshTokens: '[redacted]' },
    })
  })
})

describe('total output', () => {
  // 5,000 objects is the node budget; without a cap on plain values this writes a million of them.
  const wide = () =>
    Array.from({ length: 50 }, () =>
      Array.from({ length: 100 }, () =>
        Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`k${index}`, index]))
      )
    )

  test('many small objects cannot add up to a huge entry', () => {
    const started = performance.now()
    const line = JSON.stringify(redactFields({ orgId: 'org_1', pages: wide(), requestId: 'req_1' }))

    expect(performance.now() - started).toBeLessThan(500)
    expect(line.length).toBeLessThan(500_000)
    expect(line).toContain('[truncated]')
  })

  test('top-level fields survive after the value budget is spent', () => {
    const out = redactFields({ pages: wide(), orgId: 'org_1', requestId: 'req_1', token: 'abc' })

    expect(out.orgId).toBe('org_1')
    expect(out.requestId).toBe('req_1')
    expect(out.token).toBe('[redacted]')
  })

  test('a Map reached after the value budget is spent is cut off', () => {
    const rows = Array.from({ length: 101 }, () =>
      Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`k${index}`, index]))
    )
    const late = new Map<string, unknown>([
      ['password', 'hunter2'],
      ['a', 1],
    ])

    expect(redactFields({ rows, late }).late).toEqual({ '[more]': '[truncated]' })
  })

  test('a sensitive key is never written once the value budget is spent', () => {
    const rows = Array.from({ length: 100 }, () =>
      Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`k${index}`, index]))
    )
    const line = JSON.stringify(
      redactFields({ a: rows, b: rows.map((row) => ({ ...row })), late: { password: 'hunter2' } })
    )

    expect(line).not.toContain('hunter2')
  })
})
