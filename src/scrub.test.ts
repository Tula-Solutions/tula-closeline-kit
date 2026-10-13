import { describe, expect, test } from 'bun:test'
import { scrubText } from './scrub'

const JWT =
  'eyJhbGciOiJFZERTQSIsImtpZCI6ImsxIn0.eyJzdWIiOiJ1c3JfMSIsIm9yZyI6Im9yZ18xIn0.c2lnbmF0dXJlLWJ5dGVz'

describe('scrubText masks secrets inside free text', () => {
  test.each([
    ['a bearer token', 'request failed with Bearer abc123.def-456_ghi', 'abc123'],
    ['a lowercase bearer token', 'sent bearer abc123def456', 'abc123def456'],
    ['a JWT', `bad token ${JWT} was rejected`, 'c2lnbmF0dXJl'],
    ['a JWT before a full stop', `rejected ${JWT}.`, 'c2lnbmF0dXJl'],
    ['a JWT after an equals sign', `jwt=${JWT}`, 'c2lnbmF0dXJl'],
    ['a password pair', 'login failed password=hunter2 for ann', 'hunter2'],
    ['a colon pair', 'config token: s3cr3t-value ok', 's3cr3t-value'],
    ['a quoted pair', `got {"apiKey":"abc 123 def"} back`, 'abc 123 def'],
    ['a single-quoted pair', "client_secret = 'a b c'", 'a b c'],
    ['an escaped quote in a quoted value', String.raw`password="ab\"cd" next`, 'cd'],
    ['a query string pair', 'GET /cb?code=1&access_token=zzz999&x=2', 'zzz999'],
    ['a pair nested in another pair', 'data=password=abc999', 'abc999'],
    ['an authorization header line', 'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpw'],
    ['a cookie header line', 'Cookie: sid=abc999; theme=dark', 'abc999'],
    ['a Set-Cookie line', 'set-cookie: sid=abc999; HttpOnly', 'abc999'],
    ['url credentials', 'could not reach https://ann:pa55word@api.example.com/v1', 'pa55word'],
    ['url credentials with no user', 'redis://:pa55word@cache:6379', 'pa55word'],
    [
      'a postgres connection string',
      'connect postgres://app:pa55@db.internal:5432/closeline',
      'pa55',
    ],
    [
      'a connection string host',
      'connect postgresql://app@db.internal:5432/closeline',
      'db.internal',
    ],
    [
      'a mongodb srv string',
      'mongodb+srv://u:p4ss@cluster0.example.net/db?retryWrites=true',
      'p4ss',
    ],
    ['an ADO-style connection string', 'Server=db;User Id=sa;Password=pa55;Database=x', 'pa55'],
    ['an AWS access key id', 'key AKIAIOSFODNN7EXAMPLE leaked', 'AKIAIOSFODNN7EXAMPLE'],
    ['a GitHub token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789 used', 'ghp_abcdefghij'],
    ['a Stripe-style key', 'using sk_live_abcdefghijklmnop now', 'sk_live_abcdefgh'],
    ['an Anthropic-style key', 'using sk-ant-api03-abcdefghijklmnop now', 'sk-ant-api03'],
    ['a Slack token', 'xoxb-1234567890-abcdefghij posted', 'xoxb-1234567890'],
  ])('%s', (_name, input, secret) => {
    const out = scrubText(input)
    expect(out).not.toContain(secret)
    expect(out).toContain('[redacted]')
  })

  test('keeps the surrounding words and the key name', () => {
    expect(scrubText('login failed password=hunter2 for ann')).toBe(
      'login failed password=[redacted] for ann'
    )
    expect(scrubText('Authorization: Bearer abc.def.ghi')).toBe('Authorization: [redacted]')
    expect(scrubText('bad Bearer abc123 here')).toBe('bad Bearer [redacted] here')
  })

  test('masks every occurrence, not only the first', () => {
    const out = scrubText('password=one token=two secret=three')
    expect(out).toBe('password=[redacted] token=[redacted] secret=[redacted]')
  })

  test('masks a secret that contains an equals sign', () => {
    expect(scrubText('token=abc==')).not.toContain('abc')
  })

  test('masks an unterminated quoted value to the end of the text', () => {
    const out = scrubText('password="never closed and secret')
    expect(out).not.toContain('secret')
    expect(out.startsWith('password=')).toBe(true)
  })

  test('is idempotent', () => {
    const once = scrubText(`password=hunter2 Bearer abc123 ${JWT}`)
    expect(scrubText(once)).toBe(once)
  })
})

describe('scrubText leaves ordinary text alone', () => {
  test.each([
    'user signed in',
    'Invalid input: expected string, received undefined',
    'GET /v1/teams/team_01 failed with 502',
    'connect https://api.example.com/v1/teams?limit=20',
    'trace_id=4bf92f3577b34da6a3ce929d0e0e4736 span=00f067aa0ba902b7',
    'at Object.run (/app/dist/index.js:12:5)',
    'used tokens: 1200 of 4000',
    'inputTokens=300',
    'retry in 5 s',
    '',
  ])('%p is unchanged', (text) => {
    expect(scrubText(text)).toBe(text)
  })

  test('a non-numeric value under a token-count key is still masked', () => {
    expect(scrubText('tokens=abc123')).toBe('tokens=[redacted]')
  })

  test('a key that merely contains a sensitive word is kept', () => {
    expect(scrubText('tokenizer=fast bodyLength=12 recordingUrl=x')).toBe(
      'tokenizer=fast bodyLength=12 recordingUrl=x'
    )
  })
})

describe('scrubText is bounded and never throws', () => {
  const LIMIT_MS = 250

  test('caps the length of its output and marks the cut', () => {
    const out = scrubText('word '.repeat(100_000))
    expect(out.length).toBeLessThan(40_000)
    expect(out.endsWith('[truncated]')).toBe(true)
  })

  test('never leaves a cut-off secret at the end of truncated text', () => {
    const out = scrubText(`${'a '.repeat(16_380)}Bearer ${'k'.repeat(200)}`)
    expect(out).not.toContain('kkkk')
  })

  test('does not leak a secret that starts past the cap', () => {
    const out = scrubText(`${' '.repeat(40_000)}password=hunter2`)
    expect(out).not.toContain('hunter2')
  })

  test.each([
    ['one long word', 'a'.repeat(100_000)],
    ['one long run of spaces', `x${' '.repeat(100_000)}y`],
    ['repeated bearer', 'Bearer '.repeat(14_000)],
    ['bearer then spaces', `Bearer${' '.repeat(100_000)}`],
    ['repeated key and equals', 'password='.repeat(10_000)],
    ['repeated short pairs', 'a=b '.repeat(25_000)],
    ['equals chain', 'a='.repeat(50_000)],
    ['repeated unterminated quotes', 'password="'.repeat(10_000)],
    ['repeated mixed quotes', `password='x password="y `.repeat(3_000)],
    ['repeated jwt prefix', 'eyJ'.repeat(33_000)],
    ['dotted segments', 'eyJ.a'.repeat(20_000)],
    ['repeated scheme separators', 'http://'.repeat(14_000)],
    ['repeated credentials without at sign', 'http://user:pass'.repeat(6_000)],
    ['repeated connection prefix', 'postgres://'.repeat(9_000)],
    ['key separator spaces', `password:${' '.repeat(100_000)}`],
    ['dots and dashes', 'a.-'.repeat(33_000)],
    ['long key', `${'k'.repeat(100_000)}=v`],
    ['at signs', '://@'.repeat(25_000)],
  ])('a 100 KB input of %s finishes quickly', (_name, input) => {
    expect(input.length).toBeGreaterThanOrEqual(50_000)
    const start = performance.now()
    const out = scrubText(input)
    const elapsed = performance.now() - start
    expect(typeof out).toBe('string')
    expect(elapsed).toBeLessThan(LIMIT_MS)
  })

  test('work grows in proportion to the input, not its square', () => {
    const shapes = ['password="', 'Bearer ', 'a=', 'eyJ.a', 'http://u:']
    for (const shape of shapes) {
      const small = shape.repeat(Math.ceil(8_000 / shape.length))
      const large = shape.repeat(Math.ceil(32_000 / shape.length))
      scrubText(large)
      const time = (input: string) => {
        const start = performance.now()
        for (let i = 0; i < 5; i++) {
          scrubText(input)
        }
        return performance.now() - start
      }
      // 4x the input should cost about 4x; a quadratic scan would cost 16x.
      expect(time(large)).toBeLessThan(Math.max(time(small) * 10, 20))
    }
  })

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an object', { a: 1 }],
    ['a symbol', Symbol('s')],
  ])('does not throw for %s', (_name, value) => {
    expect(() => scrubText(value as unknown as string)).not.toThrow()
    expect(typeof scrubText(value as unknown as string)).toBe('string')
  })

  test('does not throw when the input cannot be turned into a string', () => {
    const hostile = {
      toString() {
        throw new Error('no')
      },
    }
    expect(() => scrubText(hostile as unknown as string)).not.toThrow()
  })
})
