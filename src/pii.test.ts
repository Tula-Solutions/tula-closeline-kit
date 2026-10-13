import { describe, expect, test } from 'bun:test'
import { scrubText } from './scrub'

// Telephone and card numbers in free text (round 4, N2): numbers written with the `00` international
// prefix are masked as the `+` form is, and the padded counters that made `00` a bad trunk zero
// (`0042-0017-0231`) are still left alone. The generated cases come from a fixed seed.

const MASK = '[redacted]'

const NUMBERS: Array<[string, string]> = [
  ['UK plus, spaces', '+44 20 7946 0958'],
  ['UK plus, dashes', '+44-20-7946-0958'],
  ['UK plus, dots', '+44.20.7946.0958'],
  ['UK plus, trunk zero in parentheses', '+44 (0)20 7946 0958'],
  ['UK 00, spaces', '0044 20 7946 0958'],
  ['UK 00, dashes', '0044-20-7946-0958'],
  ['UK 00, dots', '0044.20.7946.0958'],
  ['UK 00, split prefix', '00 44 20 7946 0958'],
  ['UK 00, parentheses', '0044 (0)20 7946 0958'],
  ['US plus, parentheses', '+1 (415) 555-0100'],
  ['US plus, dashes', '+1-415-555-0100'],
  ['US plus, dots', '+1.415.555.0100'],
  ['US 00, spaces', '001 415 555 0100'],
  ['US 00, dashes', '001-415-555-0100'],
  ['US 00, dots', '001.415.555.0100'],
  ['US 00, parentheses', '001 (415) 555-0100'],
  ['US 00, split prefix', '00 1 415 555 0100'],
  ['German plus', '+49 30 12345678'],
  ['German plus, dashes', '+49-30-12345678'],
  ['German 00', '0049 30 12345678'],
  ['German 00, dashes', '0049-30-12345678'],
  ['German 00, dots', '0049.30.12345678'],
  ['Indian plus', '+91 98765 43210'],
  ['Indian plus, dashes', '+91-98765-43210'],
  ['Indian 00', '0091 98765 43210'],
  ['Indian 00, dashes', '0091-98765-43210'],
  ['Indian 00, dots', '0091.98765.43210'],
  ['Australian plus', '+61 2 9876 5432'],
  ['Australian plus, mobile', '+61 412 345 678'],
  ['Australian 00', '0061 2 9876 5432'],
  ['Australian 00, dashes', '0061-2-9876-5432'],
  ['Australian 00, mobile', '0061 412 345 678'],
  ['French 00', '0033 6 12 34 56 78'],
  ['French 00, split prefix', '00 33 6 12 34 56 78'],
  ['Irish 00, three-digit code', '00353 1 234 5678'],
]

const CONTEXTS: Array<[string, (n: string) => string, (n: string) => string]> = [
  ['alone', (n) => n, () => MASK],
  ['in a sentence', (n) => `please call ${n} today`, () => `please call ${MASK} today`],
  ['at the start', (n) => `${n} is the number`, () => `${MASK} is the number`],
  ['at the end', (n) => `the number is ${n}`, () => `the number is ${MASK}`],
  ['before a full stop', (n) => `call ${n}.`, () => `call ${MASK}.`],
  ['before a comma', (n) => `call ${n}, then wait`, () => `call ${MASK}, then wait`],
  ['in quotes', (n) => `phone "${n}" failed`, () => `phone "${MASK}" failed`],
  ['after a colon', (n) => `tel:${n}`, () => `tel:${MASK}`],
  ['after a dotted label', (n) => `Tel.${n}`, () => `Tel.${MASK}`],
  ['in square brackets', (n) => `[${n}]`, () => `[${MASK}]`],
  ['before a semicolon', (n) => `${n}; next`, () => `${MASK}; next`],
]

describe('scrubText masks international numbers, written with + or 00', () => {
  for (const [contextName, wrap, expected] of CONTEXTS) {
    test.each(NUMBERS)(`%s, ${contextName}`, (_name, number) => {
      expect(scrubText(wrap(number))).toBe(expected(number))
    })
  }

  test('two 00 numbers one after the other are both masked', () => {
    expect(scrubText('0044 20 7946 0958 0049 30 12345678')).not.toMatch(/\d{3}/)
  })
})

describe('scrubText leaves what only looks like a number alone', () => {
  test.each([
    ['groups led by 00', 'invoice 0012-3456-7890'],
    ['a zero-padded counter', 'order 0042 0017 0231'],
    ['a padded counter whose prefix is a country code', 'order 0044 0017 0231'],
    ['a padded counter, dashes', 'id=0020-0021-0022'],
    ['four zero-padded groups', 'seq 0001 0002 0003 0004'],
    ['two-digit groups led by 00', 'rows 00 11 22 33 44'],
    ['a list of ones led by 00', 'rows 00 1 2 3 4 5 6 7 8'],
    ['an ISO date', 'on 2026-10-13 ok'],
    ['an ISO timestamp', 'at 2026-10-13T00:44:20.109Z'],
    ['a time with an offset', 'at 10:30:00.44-0800 ok'],
    ['an amount', 'paid $1,000.00 and 100.00 USD'],
    ['a version', 'release 2026.10.25.564 and 1.2.3'],
    ['an IPv4 address', 'from 10.0.0.44'],
    ['a UUID', 'req ae506499-d871-4815-9301-322b14037713'],
    ['a digits-only UUID', 'req 00441234-1234-4234-8234-123456789012'],
    ['a prefixed id', 'org_00441234123442348234123456789012 gone'],
    ['an epoch', 'ts 1700000000123 end'],
  ])('%s', (_name, text) => {
    expect(scrubText(text)).toBe(text)
  })
})

// A seeded generator (mulberry32).
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('adversarial pass: generated numbers are all masked', () => {
  const rand = seeded(20261013)
  const int = (min: number, max: number): number => min + Math.floor(rand() * (max - min + 1))
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)] as T
  const digits = (length: number, first = 0): string => {
    let out = ''
    for (let i = 0; i < length; i++) {
      out += String(i === 0 && first > 0 ? int(first, 9) : int(0, 9))
    }
    return out
  }

  // Country code and the national number as groups, for the countries named in the brief.
  const national: Array<() => [string, string[]]> = [
    () => ['44', ['20', digits(4, 1), digits(4)]],
    () => ['44', [`7${digits(3)}`, digits(6)]],
    () => ['1', [`${int(2, 9)}${digits(2)}`, `${int(2, 9)}${digits(2)}`, digits(4)]],
    () => ['49', [`${int(30, 89)}`, digits(int(7, 8), 1)]],
    () => ['91', [`${int(6, 9)}${digits(4)}`, digits(5)]],
    () => ['61', [`${int(2, 4)}`, digits(4, 1), digits(4)]],
    () => ['61', [`4${digits(2)}`, digits(3), digits(3)]],
  ]
  const seps = [' ', '-', '.']

  function phone(): string {
    const [code, groups] = pick(national)()
    const sep = pick(seps)
    const lead = pick(['+', '00', '00 ', '+'])
    const glued = lead === '00' ? `00${code}` : lead === '00 ' ? `00 ${code}` : `+${code}`
    // A parenthesised area code only where the national number opens with a three-digit group.
    const body =
      code === '1' && rand() < 0.5
        ? `(${groups[0]}) ${groups[1]}${sep === ' ' ? '-' : sep}${groups[2]}`
        : groups.join(sep)
    return `${glued}${code === '1' && body.startsWith('(') ? ' ' : sep}${body}`
  }

  function luhnComplete(prefix: string, length: number): string {
    let body = prefix
    while (body.length < length - 1) {
      body += String(int(0, 9))
    }
    let sum = 0
    for (let i = 0; i < body.length; i++) {
      let n = Number(body[body.length - 1 - i])
      if (i % 2 === 0) {
        n = n * 2 > 9 ? n * 2 - 9 : n * 2
      }
      sum += n
    }
    return body + String((10 - (sum % 10)) % 10)
  }

  function card(): string {
    const style = int(0, 4)
    if (style === 4) {
      const raw = luhnComplete(pick(['34', '37']), 15)
      return `${raw.slice(0, 4)}${pick([' ', '-'])}${raw.slice(4, 10)}${pick([' ', '-'])}${raw.slice(10)}`
    }
    const raw = luhnComplete(
      pick(['4', '51', '55', '2221', '2720', '6011', '35', '36', '81']),
      pick([16, 16, 16, 19])
    )
    if (style === 0) {
      return raw
    }
    const sep = pick([' ', '-'])
    return (raw.match(/\d{1,4}/g) as string[]).join(sep)
  }

  const before = ['', 'call ', 'tel: ', '(', '"', 'number is ', 'a,', '[', 'Tel.']
  const after = ['', '.', ',', ')', '"', ' ok', ';', ']', '!']

  test('400 telephone numbers written with + or 00 are masked', () => {
    const misses: string[] = []
    for (let i = 0; i < 400; i++) {
      const number = phone()
      const input = `${pick(before)}${number}${pick(after)}`
      if (/\d{4}/.test(scrubText(input))) {
        misses.push(input)
      }
    }
    expect(misses).toEqual([])
  })

  test('400 card numbers are masked', () => {
    const misses: string[] = []
    for (let i = 0; i < 400; i++) {
      const number = card()
      const input = `${pick(before.filter((b) => b !== 'Tel.'))}${number}${pick(after)}`
      if (/\d{4}/.test(scrubText(input))) {
        misses.push(input)
      }
    }
    expect(misses).toEqual([])
  })
})

describe('adversarial pass: the id shapes this system makes are never altered', () => {
  const rand = seeded(24102026)
  const int = (min: number, max: number): number => min + Math.floor(rand() * (max - min + 1))
  const hex = (length: number, alphabet = '0123456789abcdef'): string =>
    Array.from({ length }, () => alphabet[int(0, alphabet.length - 1)]).join('')
  const prefixes = ['org', 'usr', 'mem', 'team', 'prs', 'evt', 'req', 'inv', 'ab', 'abcde']
  const uuid = (): string => `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`

  test('prefixed ids, UUIDs and trace ids come out byte for byte unchanged', () => {
    const altered: string[] = []
    const wrappers = [
      (v: string) => v,
      (v: string) => `request ${v} failed.`,
      (v: string) => `(${v})`,
      (v: string) => `org=${v}, req=${v}`,
    ]
    for (let i = 0; i < 1_500; i++) {
      const prefix = prefixes[i % prefixes.length] as string
      const values = [
        `${prefix}_${hex(32)}`,
        // Digit-heavy ids are the ones that look like numbers.
        `${prefix}_${hex(32, '0123456789abcdef0123456789012345678901')}`,
        `${prefix}_${hex(32, '0123456789')}`,
        uuid(),
        uuid().toUpperCase(),
        hex(32),
        hex(32, '0123456789'),
        `00-${hex(32)}-${hex(16)}-01`,
      ]
      for (const value of values) {
        const input = (wrappers[i % wrappers.length] as (v: string) => string)(value)
        if (scrubText(input) !== input) {
          altered.push(input)
        }
      }
    }
    expect(altered).toEqual([])
  })
})
