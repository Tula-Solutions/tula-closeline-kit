import { describe, expect, test } from 'bun:test'
import { cutText, scrubText } from './scrub'

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
    ['a pair at the end of the line', 'config token: s3cr3t-value', 's3cr3t-value'],
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
    // An unquoted value runs to the end of the line, so the words after it go too.
    expect(scrubText('login failed password=hunter2 for ann')).toBe(
      'login failed password=[redacted]'
    )
    expect(scrubText('Authorization: Bearer abc.def.ghi')).toBe('Authorization: [redacted]')
    expect(scrubText('bad Bearer abc123 here')).toBe('bad Bearer [redacted] here')
  })

  test('masks every occurrence, not only the first', () => {
    expect(scrubText('password=one\ntoken=two\nsecret=three')).toBe(
      'password=[redacted]\ntoken=[redacted]\nsecret=[redacted]'
    )
    const sameLine = scrubText('password=one token=two secret=three')
    for (const value of ['one', 'two', 'three']) {
      expect(sameLine).not.toContain(value)
    }
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

describe('scrubText: keys beyond the listed words (review F3)', () => {
  test.each([
    ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI'],
    ['aws_secret_access_key: wJalrXUtnFEMI/K7MDENG', 'wJalrXUtnFEMI'],
    ['pass=hunter2x', 'hunter2x'],
    ['pwd=hunter2x', 'hunter2x'],
    ['passwd: hunter2x', 'hunter2x'],
    ['auth=hunter2x', 'hunter2x'],
    ['session_id=abc123def', 'abc123def'],
    ['sessionId: abc123def', 'abc123def'],
    ['PHPSESSID=abc123def', 'abc123def'],
    ['session=abc123def', 'abc123def'],
    ['sid=abc123def', 'abc123def'],
    ['sig=abc123def', 'abc123def'],
    ['X-Amz-Signature=abc123def', 'abc123def'],
    ['signature: abc123def', 'abc123def'],
  ])('%s', (input, secret) => {
    const out = scrubText(input)
    expect(out).not.toContain(secret)
    expect(out).toContain('[redacted]')
  })

  test('URL query parameters with sensitive names are masked and the rest of the URL kept', () => {
    expect(scrubText('GET /f?sig=abc123def&x=1 HTTP/1.1')).toBe(
      'GET /f?sig=[redacted]&x=1 HTTP/1.1'
    )
    expect(
      scrubText(
        'https://b.s3.amazonaws.com/o?X-Amz-Expires=60&X-Amz-Signature=abc123def&X-Amz-Date=20240101'
      )
    ).toBe(
      'https://b.s3.amazonaws.com/o?X-Amz-Expires=60&X-Amz-Signature=[redacted]&X-Amz-Date=20240101'
    )
    expect(scrubText('https://x.test/cb?code=1&session_id=abc123def#top')).toBe(
      'https://x.test/cb?code=1&session_id=[redacted]#top'
    )
  })

  test('a quoted value with a doubled quote is masked whole', () => {
    expect(scrubText("password='it''s' next")).toBe('password=[redacted] next')
    expect(scrubText('password="say ""hi"" now" next')).toBe('password=[redacted] next')
  })

  test.each([
    ['a newline in the password', 'connect postgres://u:pa\nss@h/db failed', ['ss@h', 'pa\n']],
    ['a space in the password', 'connect postgres://u:pa ss@h/db failed', ['ss@h', 'word', 'pa ']],
    ['a plain URL', 'connect postgres://u:pass@h:5432/db?sslmode=require now', ['pass', 'h:5432']],
  ])('a connection string with %s is masked to its end', (_name, input, gone) => {
    const out = scrubText(input)
    for (const part of gone) {
      expect(out).not.toContain(part)
    }
    expect(out.startsWith('connect postgres://[redacted]')).toBe(true)
    expect(out.endsWith('failed') || out.endsWith('now')).toBe(true)
  })

  test('a connection string with no credentials stops at whitespace', () => {
    expect(scrubText('redis://cache:6379 is down')).toBe('redis://[redacted] is down')
  })

  test.each([
    [
      'Detail: Key (email)=(jane@acme.com) already exists.',
      'Detail: Key (email)=([redacted]) already exists.',
    ],
    [
      'Key (organization_id, name)=(org_1, Acme (EU)) already exists.',
      'Key (organization_id, name)=([redacted]) already exists.',
    ],
    [
      'Key (team_id)=(team_9) is not present in table "teams".',
      'Key (team_id)=([redacted]) is not present in table "teams".',
    ],
    ['Key (phone)=(+14155550199)', 'Key (phone)=([redacted])'],
    ['Key (x)=(unterminated value and more', 'Key (x)=([redacted]'],
  ])('a Postgres key detail is masked: %s', (input, expected) => {
    expect(scrubText(input)).toBe(expected)
  })

  test('an unquoted value after a content key runs to the end of the line', () => {
    expect(scrubText('transcript: hello my card is 4111 1111 1111 1111 ok\nnext line')).toBe(
      'transcript: [redacted]\nnext line'
    )
    expect(scrubText('body=Hi Jane, call me\r\nnext')).toBe('body=[redacted]\r\nnext')
  })
})

describe('scrubText: personal data (review F3)', () => {
  test.each([
    ['an email', 'user jane@acme.com not found', 'user [redacted] not found'],
    ['an email with a plus tag', 'sent to jane.doe+crm@sub.acme.co.uk.', 'sent to [redacted].'],
    ['two emails', 'a@b.io and c_d@e-f.com', '[redacted] and [redacted]'],
    ['an E.164 number', 'dial +14155550199 now', 'dial [redacted] now'],
    ['a short E.164 number', 'dial +49301234567', 'dial [redacted]'],
    ['an E.164 number with spaces', 'call +44 20 7946 0958 today', 'call [redacted] today'],
    ['a number with dashes', 'call 415-555-0199 today', 'call [redacted] today'],
    ['a number with dots', 'call 415.555.0199 today', 'call [redacted] today'],
    ['a number with parentheses', 'call (415) 555-0199 today', 'call [redacted] today'],
    ['a number with a country code', 'call +1 (415) 555-0199.', 'call [redacted].'],
    ['a toll-free number', 'call 1-800-555-0199', 'call [redacted]'],
    ['a UK number with spaces', 'call 020 7946 0958', 'call [redacted]'],
    ['a Visa number', 'card 4111111111111111 declined', 'card [redacted] declined'],
    ['an Amex number', 'card 378282246310005 declined', 'card [redacted] declined'],
    ['a card with spaces', 'card 5555 5555 5555 4444 declined', 'card [redacted] declined'],
    ['a card with dashes', 'card 6011-1111-1111-1117 declined', 'card [redacted] declined'],
    ['a 13 digit Visa number', 'card 4222222222222 declined', 'card [redacted] declined'],
    ['a 19 digit number', 'card 6759649826438453003 declined', 'card [redacted] declined'],
  ])('masks %s', (_name, input, expected) => {
    expect(scrubText(input)).toBe(expected)
  })

  test.each([
    'trace 4bf92f3577b34da6a3ce929d0e0e4736 span 00f067aa0ba902b7',
    'id 550e8400-e29b-41d4-a716-446655440000',
    'at 1700000000123 and 1700000000000000 and 1700000000000000000',
    'created_at=1700000000999',
    'order 4111111111111112 not a card',
    'user_4111111111111111 stays',
    'hex deadbeef4111111111111111 stays',
    'order 1234567890',
    'order 123456789012',
    '2024-05-12 10:30:00 started',
    '2024-05-12T10:30:00Z started',
    'peer 192.168.100.200:5432 refused',
    'peer 10.0.1.5 refused',
    'bun@1.4.2 and @sentry/bun@11.6.0',
    'pi is 3.14159265358979',
    'took 12 ms, 5 retries, 2 of 3',
    'GET /v1/teams/team_01 failed with 502 after 3 retries in 45 ms',
    'ratio 0.123456789012',
    'port 5432 pid 123456',
    'user@host and @scope/pkg and a @ b',
  ])('leaves %p alone', (text) => {
    expect(scrubText(text)).toBe(text)
  })

  test('a date before a phone number does not hide the number', () => {
    expect(scrubText('2024-05-12 415-555-0199 called')).toBe('2024-05-12 [redacted] called')
  })

  test('is idempotent on personal data', () => {
    const once = scrubText('jane@acme.com, +14155550199; 4111 1111 1111 1111 / (415) 555-0199')
    expect(once).toBe('[redacted], [redacted]; [redacted] / [redacted]')
    expect(scrubText(once)).toBe(once)
  })

  test('numbers written one after the other are all masked', () => {
    expect(scrubText('+14155550199 4111 1111 1111 1111 (415) 555-0199')).not.toMatch(/\d{4}/)
    expect(scrubText('415-555-0199 415-555-0188')).not.toMatch(/\d{4}/)
  })

  test('a token count is not a secret, and the words after it stay', () => {
    expect(scrubText('used tokens: 1200 of 4000')).toBe('used tokens: 1200 of 4000')
    expect(scrubText('inputTokens=300 outputTokens=20')).toBe('inputTokens=300 outputTokens=20')
    expect(scrubText('tokens: abc123 of 4000')).toBe('tokens: [redacted]')
  })
})

describe('scrubText: stack-frame positions are not keys (review F8)', () => {
  test.each([
    'at verify (/app/src/auth/token:12:3)',
    'at verify (/app/src/auth/token:12:3)\n    at run (/app/src/secret:40:11)',
    'at verify (C:\\app\\password:7:1)',
  ])('%p is unchanged', (text) => {
    expect(scrubText(text)).toBe(text)
  })

  test('a colon pair that is not a frame position is still masked', () => {
    expect(scrubText('password:123:456')).toBe('password:[redacted]')
    expect(scrubText('see /v1/token:abc123')).toContain('[redacted]')
  })

  test('prose after a sensitive key is masked (documented over-masking)', () => {
    expect(scrubText('Invalid token: expired')).toBe('Invalid token: [redacted]')
    expect(scrubText('Request body: invalid JSON')).toBe('Request body: [redacted]')
  })
})

describe('scrubText: the new passes stay linear', () => {
  const LIMIT_MS = 250
  test.each([
    ['many at signs', '@'.repeat(100_000)],
    ['local parts and at signs', `${'a'.repeat(63)}@`.repeat(1_600)],
    ['long domains', `a@${'b'.repeat(250)}`.repeat(400)],
    ['at sign chain', 'a@'.repeat(50_000)],
    ['single digits and dashes', '1-'.repeat(50_000)],
    ['single digits and spaces', '1 '.repeat(50_000)],
    ['digit groups', '12 '.repeat(33_000)],
    ['phone shapes', '(415) 555-0199 '.repeat(7_000)],
    ['plus signs', '+1'.repeat(50_000)],
    ['open parentheses', '(1'.repeat(50_000)],
    ['one long digit run', '4'.repeat(100_000)],
    ['luhn candidates', '4111111111111111 '.repeat(6_000)],
    ['key detail prefixes', 'Key (a)=('.repeat(12_000)],
    ['key detail with long values', `Key (a)=(${'v'.repeat(600)}`.repeat(160)],
    ['connection prefixes with at signs', 'postgres://@ '.repeat(8_000)],
    ['connection prefixes with spaces', 'postgres://u:p '.repeat(7_000)],
    ['query keys', '?sig=&'.repeat(17_000)],
    ['frame positions', '/token:1:2 '.repeat(10_000)],
    ['dates', '2024-05-12 '.repeat(9_000)],
    ['ipv4 chains', '10.0.0.1.'.repeat(11_000)],
  ])('a 100 KB input of %s finishes quickly', (_name, input) => {
    expect(input.length).toBeGreaterThanOrEqual(50_000)
    const start = performance.now()
    scrubText(input)
    expect(performance.now() - start).toBeLessThan(LIMIT_MS)
  })
})

describe('cutText', () => {
  test('returns text that fits as it is', () => {
    expect(cutText('short', 10)).toBe('short')
    expect(cutText('exactly10!', 10)).toBe('exactly10!')
  })

  test('cuts at the limit, drops a trailing partial word and marks the cut', () => {
    expect(cutText('alpha beta gamma', 12)).toBe('alpha beta [truncated]')
    expect(cutText('alpha beta gamma', 11)).toBe('alpha beta [truncated]')
  })

  test('is bounded by the limit, not by the length of the text', () => {
    const start = performance.now()
    const out = cutText('a'.repeat(50_000_000), 8_192)
    expect(performance.now() - start).toBeLessThan(20)
    expect(out).toBe('[truncated]')
  })
})
