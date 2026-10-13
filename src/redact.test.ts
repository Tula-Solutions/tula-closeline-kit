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

  test('a Map reached after the value budget is spent keeps only its own allowance', () => {
    const rows = Array.from({ length: 101 }, () =>
      Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`k${index}`, index]))
    )
    const late = new Map<string, unknown>(
      Array.from({ length: 150 }, (_, index) => [
        index === 0 ? 'password' : `k${index}`,
        { apiKey: 'hunter2', a: 1 },
      ])
    )
    const out = redactFields({ rows, late }).late as Record<string, unknown>

    expect(out.password).toBe('[redacted]')
    expect(JSON.stringify(out)).toContain('[truncated]')
    expect(JSON.stringify(out)).not.toContain('hunter2')
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

describe('small objects after a large field', () => {
  // 100 arrays of 60 objects spend the 5,000-object budget before any later field is reached.
  const big = () =>
    Array.from({ length: 100 }, () => Array.from({ length: 60 }, (_, index) => ({ index })))

  test('a small object field after a large one stays intact', () => {
    const out = redactFields({
      big: big(),
      tenant: { organizationId: 'org_1' },
      ctx: { requestId: 'req_1', nested: { user: { id: 'usr_1' } } },
    })

    expect(out.tenant).toEqual({ organizationId: 'org_1' })
    expect(out.ctx).toEqual({ requestId: 'req_1', nested: { user: { id: 'usr_1' } } })
  })

  test('the outcome does not depend on key order', () => {
    const tenant = { organizationId: 'org_1' }
    expect(redactFields({ tenant, big: big() }).tenant).toEqual(tenant)
    expect(redactFields({ big: big(), tenant }).tenant).toEqual(tenant)
  })

  test('a field kept by the allowance is still redacted and scrubbed', () => {
    const out = redactFields({
      big: big(),
      ctx: { password: 'hunter2', err: new Error('password=hunter3') },
    })
    const line = JSON.stringify(out)

    expect(line).not.toContain('hunter2')
    expect(line).not.toContain('hunter3')
    expect((out.ctx as Record<string, unknown>).password).toBe('[redacted]')
  })

  test('a large field cannot take another field allowance, but is itself cut', () => {
    const out = redactFields({ a: big(), b: big() })
    const line = JSON.stringify(out)

    expect(line).toContain('[truncated]')
    expect(line.length).toBeLessThan(3_000_000)
  })

  test('the worst case stays within the stated bound', () => {
    // 200 keys, each a wide array of wide objects: shared 5,000 objects plus 50 per field.
    const fields: Record<string, unknown> = {}
    for (let k = 0; k < 250; k++) {
      fields[`f${k}`] = Array.from({ length: 100 }, () =>
        Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`k${index}`, index]))
      )
    }
    const started = performance.now()
    const out = redactFields(fields)
    const elapsed = performance.now() - started
    let objects = 0
    let values = 0
    const walk = (value: unknown): void => {
      if (typeof value !== 'object' || value === null) {
        values++
        return
      }
      objects++
      for (const item of Object.values(value)) {
        walk(item)
      }
    }
    for (const value of Object.values(out)) {
      walk(value)
    }

    expect(objects).toBeLessThanOrEqual(5_000 + 200 * 50 + 200)
    expect(values).toBeLessThanOrEqual(20_000 + 200 * 200 + 200 * 100 + 5_000)
    expect(elapsed).toBeLessThan(1_000)
  })
})
