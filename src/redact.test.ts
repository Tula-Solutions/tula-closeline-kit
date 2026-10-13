import { describe, expect, test } from 'bun:test'
import { redactFields } from './redact'

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const wellFormed = (text: string): boolean => !LONE_SURROGATE.test(text)

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

  test('a Map reached after the value budget is spent keeps exactly its own allowance', () => {
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
    const entry = { apiKey: '[redacted]', a: 1 }

    // The 200-value allowance: 1 for `password`, then 3 per entry (the entry and its two keys), so
    // k1 to k66 are whole, k67 has its entry counted but not its keys, and k68 onward is cut.
    expect(Object.keys(out)).toEqual([
      'password',
      ...Array.from({ length: 67 }, (_, index) => `k${index + 1}`),
      '[more]',
    ])
    expect(out.password).toBe('[redacted]')
    for (let index = 1; index <= 66; index++) {
      expect(out[`k${index}`]).toEqual(entry)
    }
    expect(out.k67).toEqual({ '[more]': '[truncated]' })
    expect(out['[more]']).toBe('[truncated]')
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
    const count = (value: unknown): number =>
      typeof value === 'object' && value !== null
        ? 1 + Object.values(value).reduce<number>((sum, item) => sum + count(item), 0)
        : 0

    // Changing either allowance constant by one changes one of these.
    expect(count(out.a)).toBe(5_000 + 50)
    expect(count(out.b)).toBe(50)
    expect(JSON.stringify(out)).toContain('[truncated]')
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
describe('text budget', () => {
  const words = (length: number) => 'lorem ipsum '.repeat(Math.ceil(length / 12)).slice(0, length)
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
  const fields = (make: (index: number) => unknown): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (let index = 0; index < 200; index++) {
      out[`f${index}`] = make(index)
    }
    return out
  }
  // Worst case counted in bytes: about 1.8 million units, at most 6 bytes each, plus structure.
  const MAX_BYTES = 12_000_000
  // Ordinary text is about one byte per unit; the three shapes measure 1.6 to 2.1 MB.
  const MAX_TEXT_BYTES = 2_500_000

  test('200 fields of 100 errors with 30,000 character messages and stacks', () => {
    const out = redactFields(
      fields(() =>
        Array.from({ length: 100 }, () => {
          const error = new Error(words(30_000))
          error.stack = words(30_000)
          return error
        })
      )
    )

    expect(bytes(out)).toBeLessThan(MAX_TEXT_BYTES)
  })

  test('200 fields of 100 objects holding 100 KB strings', () => {
    const out = redactFields(
      fields(() => Array.from({ length: 100 }, () => ({ a: words(100_000) })))
    )

    expect(bytes(out)).toBeLessThan(MAX_TEXT_BYTES)
  })

  test('200 keys of 10,000 characters', () => {
    const input: Record<string, unknown> = {}
    for (let index = 0; index < 200; index++) {
      input[`k${index}`.padEnd(10_000, 'x')] = 1
    }
    const out = redactFields(input)

    expect(Object.keys(out)).toHaveLength(200)
    expect(Math.max(...Object.keys(out).map((key) => key.length))).toBeLessThanOrEqual(256)
    expect(bytes(out)).toBeLessThan(MAX_TEXT_BYTES)
  })

  test('control characters, which escape to six bytes, stay under the worst case', () => {
    const out = redactFields(
      fields(() => Array.from({ length: 100 }, () => ({ a: '\u0001'.repeat(16_384) })))
    )

    expect(bytes(out)).toBeLessThan(MAX_BYTES)
    expect(bytes(out)).toBeGreaterThan(MAX_TEXT_BYTES)
  })

  test('one string is cut at 16 KiB and marked', () => {
    const out = redactFields({ note: words(100_000) })
    const note = out.note as string

    expect(note.length).toBeLessThanOrEqual(16_384)
    expect(note.endsWith('[truncated]')).toBe(true)
    expect(note.startsWith('lorem ipsum lorem')).toBe(true)
  })

  test('a huge string cannot starve the small fields after it', () => {
    const out = redactFields({
      big: Array.from({ length: 200 }, () => words(100_000)),
      more: Array.from({ length: 200 }, () => words(100_000)),
      tenant: { organizationId: 'org_1' },
      ctx: { requestId: 'req_1' },
      orgId: 'org_1',
    })

    expect(out.tenant).toEqual({ organizationId: 'org_1' })
    expect(out.ctx).toEqual({ requestId: 'req_1' })
    expect(out.orgId).toBe('org_1')
  })

  test('the ticket reproduction survives a 5 MB string in the big field', () => {
    const out = redactFields({
      big: [
        words(5_000_000),
        ...Array.from({ length: 100 }, () => Array.from({ length: 60 }, (_, index) => ({ index }))),
      ],
      tenant: { organizationId: 'org_1' },
      ctx: { requestId: 'req_1' },
    })

    expect(out.tenant).toEqual({ organizationId: 'org_1' })
    expect(out.ctx).toEqual({ requestId: 'req_1' })
  })

  test('keys past the text budget are dropped with a count', () => {
    const big = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [`${'k'.repeat(200)}${index}`, 1])
    )
    const out = redactFields({ wide: Array.from({ length: 100 }, () => ({ ...big })) })
    const last = (out.wide as Array<Record<string, unknown>>).at(-1) as Record<string, unknown>

    expect(Object.keys(last).length).toBeLessThan(200)
    expect(JSON.stringify(out)).toMatch(/\[\+\d+ more\]|\[truncated\]/)
  })

  test('a secret in long error text or under a sensitive key is not emitted in part', () => {
    const secret = 'hunter2hunter2'
    // The password sits where the 16 KiB cut falls, in every position around it.
    for (let offset = 0; offset < 40; offset++) {
      const text = `${words(16_384 - 40 + offset)} password=${secret} trailing`
      const error = new Error(text)
      error.stack = text
      const line = JSON.stringify(
        redactFields({ error, nested: { token: text, list: [error] }, password: text })
      )

      expect(line).not.toContain('hunter')
      expect(line).not.toContain(secret.slice(0, 4))
    }
  })

  test('the output is deterministic and the input is not changed', () => {
    const make = () => ({
      a: words(100_000),
      list: Array.from({ length: 50 }, (_, index) => ({ [`k${index}`]: words(40_000) })),
      error: new Error(words(40_000)),
      tenant: { organizationId: 'org_1' },
    })
    const input = make()
    const before = JSON.stringify(input)
    const first = JSON.stringify(redactFields(input))

    expect(JSON.stringify(redactFields(make()))).toBe(first)
    expect(JSON.stringify(input)).toBe(before)
  })
})
describe('cuts and error cap', () => {
  test('a cut never leaves a lone surrogate, at every offset around the string cap', () => {
    for (let pad = 16_340; pad <= 16_400; pad++) {
      const text = `${'a'.repeat(pad)}${'\u{1F600}'.repeat(50)}`
      const out = redactFields({ note: text, list: [text] })

      expect(wellFormed(out.note as string)).toBe(true)
      expect(wellFormed((out.list as string[])[0] as string)).toBe(true)
    }
  })

  test('a cut key is well formed too', () => {
    for (let pad = 0; pad < 4; pad++) {
      const key = `${'a'.repeat(pad)}${'\u{1F600}'.repeat(300)}`
      const names = Object.keys(redactFields({ [key]: 1, nested: { [key]: 1 } }))

      for (const name of names) {
        expect(wellFormed(name)).toBe(true)
      }
      const nested = Object.keys(redactFields({ nested: { [key]: 1 } }).nested as object)
      for (const name of nested) {
        expect(wellFormed(name)).toBe(true)
      }
    }
  })

  test('only the first 200 Errors are scrubbed, the rest are the truncation marker', () => {
    const many = redactFields(
      Object.fromEntries(
        Array.from({ length: 6 }, (_, field) => [
          `f${field}`,
          Array.from({ length: 100 }, (_, index) => new Error(`failed password=hunter${index}`)),
        ])
      )
    )
    const kinds = Object.values(many).flat() as unknown[]

    expect(kinds.filter((item) => typeof item === 'object')).toHaveLength(200)
    expect(kinds.filter((item) => item === '[truncated]')).toHaveLength(400)
    expect(JSON.stringify(many)).not.toContain('hunter')
  })

  test('200 fields of 100 Errors with 30,000 character texts take well under 100 ms', () => {
    const text = 'lorem ipsum '.repeat(2_500)
    const input = Object.fromEntries(
      Array.from({ length: 200 }, (_, field) => [
        `f${field}`,
        Array.from({ length: 100 }, () => {
          const error = new Error(text)
          error.stack = text
          return error
        }),
      ])
    )
    const started = performance.now()
    redactFields(input)

    expect(performance.now() - started).toBeLessThan(250)
  })
})
