import { describe, expect, test } from 'bun:test'
import { scrubText } from './scrub'

// The rule these tests hold `scrubText` to: an identifier is never altered. Operators trace a
// request by its ids, so when a pattern cannot tell a telephone number or a card from an id it
// leaves the text alone. Every value below is generated from a fixed seed, so a failure repeats.

/** A small seeded generator (mulberry32): the same seed always gives the same sequence. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rand = random(20260612)
const int = (min: number, max: number): number => min + Math.floor(rand() * (max - min + 1))
const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)] as T
const HEX = '0123456789abcdef'
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
const chars = (alphabet: string, length: number): string => {
  let out = ''
  for (let i = 0; i < length; i++) {
    out += alphabet[int(0, alphabet.length - 1)]
  }
  return out
}
const digits = (length: number, firstNonZero = true): string =>
  (firstNonZero ? String(int(1, 9)) : String(int(0, 9))) + chars('0123456789', length - 1)
const casing = (value: string): string => (rand() < 0.25 ? value.toUpperCase() : value)

const uuidV4 = (): string =>
  casing(
    `${chars(HEX, 8)}-${chars(HEX, 4)}-4${chars(HEX, 3)}-${pick(['8', '9', 'a', 'b'])}${chars(HEX, 3)}-${chars(HEX, 12)}`
  )
const uuidV7 = (): string =>
  casing(
    `${int(0x18f000000000, 0x19f000000000)
      .toString(16)
      .padStart(12, '0')
      .replace(
        /^(.{8})(.{4})$/,
        '$1-$2'
      )}-7${chars(HEX, 3)}-${pick(['8', '9', 'a', 'b'])}${chars(HEX, 3)}-${chars(HEX, 12)}`
  )
const ulid = (): string => chars('01234567', 1) + chars(CROCKFORD, 25)
const prefixed = (prefix: string) => (): string => {
  const style = int(0, 3)
  const body =
    style === 0
      ? ulid()
      : style === 1
        ? chars(HEX, int(12, 32))
        : style === 2
          ? chars(BASE62, 21)
          : digits(int(6, 14))
  return `${prefix}_${body}`
}
const hexHash = (): string => chars(HEX, pick([8, 12, 16, 32, 40, 64]))
const epochSeconds = (): string => String(int(1_500_000_000, 1_900_000_000))
const epochMillis = (): string => `${epochSeconds()}${digits(3, false)}`
const epochNanos = (): string => `${epochSeconds()}${digits(9, false)}`
const pad = (n: number): string => String(n).padStart(2, '0')
const compactTimestamp = (): string =>
  `${int(1990, 2040)}${pad(int(1, 12))}${pad(int(1, 28))}${pad(int(0, 23))}${pad(int(0, 59))}${pad(int(0, 59))}${rand() < 0.5 ? digits(3, false) : ''}`
const isoTimestamp = (): string => {
  const date = `${int(1990, 2040)}-${pad(int(1, 12))}-${pad(int(1, 28))}`
  const time = `${pad(int(0, 23))}:${pad(int(0, 59))}:${pad(int(0, 59))}${rand() < 0.5 ? `.${digits(3, false)}` : ''}`
  return `${date}${pick(['T', ' '])}${time}${pick(['Z', '+05:30', '-0800', '+00:00', ''])}`
}
const dottedVersion = (): string => {
  const count = int(3, 4)
  const parts: string[] = []
  for (let i = 0; i < count; i++) {
    parts.push(String(int(0, i === 0 ? 40 : 99_999)))
  }
  return parts.join('.') + pick(['', '', '-rc.1', '+build.7', '-beta'])
}
const calVer = (): string =>
  pick([
    () => `${int(2000, 2040)}.${int(1, 12)}.${int(1, 31)}.${int(0, 999)}`,
    () => `${int(20, 40)}.${pad(int(1, 12))}.${int(0, 999)}`,
    () => `${int(2000, 2040)}.${pad(int(1, 12))}.${int(0, 9999)}`,
    () => `${int(2000, 2040)}.${int(1, 12)}`,
  ])()
const byteCount = (): string => {
  const groups = int(2, 5)
  const sep = pick([',', '.', ' ', '_', "'"])
  const parts = [String(int(1, 999))]
  for (let i = 1; i < groups; i++) {
    parts.push(digits(3, false))
  }
  return `${parts.join(sep)} ${pick(['bytes', 'B', 'bytes read'])}`
}
const money = (): string => {
  const whole = [String(int(1, 999))]
  for (let i = int(0, 3); i > 0; i--) {
    whole.push(digits(3, false))
  }
  const cents = pad(int(0, 99))
  return pick([
    () => `$${whole.join(',')}.${cents}`,
    () => `€${whole.join(',')}.${cents}`,
    () => `${whole.join(',')}.${cents} USD`,
    () => `${whole.join(' ')},${cents} EUR`,
    () => `-$${whole.join(',')}.${cents}`,
    () => `USD ${whole.join('.')},${cents}`,
  ])()
}
const ipv4 = (): string =>
  `${int(1, 255)}.${int(0, 255)}.${int(0, 255)}.${int(0, 255)}${rand() < 0.3 ? `:${int(1, 65535)}` : ''}`
const ipv6 = (): string => {
  const group = (): string => chars(HEX, int(1, 4))
  const style = int(0, 3)
  if (style === 0) {
    return Array.from({ length: 8 }, group).join(':')
  }
  if (style === 1) {
    return `fe80::${group()}:${group()}:${group()}:${group()}`
  }
  if (style === 2) {
    return `::ffff:${int(1, 255)}.${int(0, 255)}.${int(0, 255)}.${int(0, 255)}`
  }
  return `2001:db8:${group()}::${group()}`
}
const idList = (): string => {
  for (;;) {
    const lengths = Array.from({ length: int(2, 8) }, () => int(4, 9))
    // Four groups of four digits are written the way a card is, and are read as one.
    if (lengths.length === 4 && lengths.every((length) => length === 4)) {
      continue
    }
    return `${pick(['ids', 'orders', 'rows'])} ${lengths.map((length) => digits(length)).join(' ')}`
  }
}
// Counters and padded ids start with `00` (`0042-0017-0231`); a lone leading zero is a trunk zero.
// A counter is padded to one width, so its groups are alike; one with groups of different widths
// is generated only with a first group no country code can follow `00` in (`000…`), because
// `0044 20 7946 0958` is a telephone number and the two cannot be told apart.
const zeroPadded = (): string => {
  const separator = pick([' ', '-', '.'])
  const uniform = rand() < 0.6
  const width = int(3, 5)
  // Four groups of four after the first are written as a card is, and are read as one.
  const count = uniform && width === 4 ? int(3, 4) : int(3, 5)
  const groups = Array.from({ length: count }, () =>
    uniform ? chars('0123456789', width) : chars('0123456789', int(2, 5))
  )
  groups[0] = uniform
    ? `00${chars('0123456789', width - 2)}`
    : `000${chars('0123456789', int(0, 2))}`
  return `${pick(['invoice', 'order', 'seq', 'id='])}${rand() < 0.5 ? ' ' : ''}${groups.join(separator)}`
}
// 13 to 19 digits that no card issuer uses: outside 4, 5, 6, 3[4-9], 2221 to 2720, 81 and 86.
const longIdOutsideIssuers = (): string => {
  for (;;) {
    const value = digits(int(13, 19), false)
    if (!startsInIssuerRange(value) && value[0] !== '1') {
      return value
    }
  }
}
const idRange = (): string => `${digits(int(5, 7))}-${digits(int(5, 7))}`

/** Luhn check, as the card rule applies it. */
function luhn(value: string): boolean {
  let sum = 0
  for (let i = 0; i < value.length; i++) {
    let n = Number(value[value.length - 1 - i])
    if (i % 2 === 1) {
      n = n * 2 > 9 ? n * 2 - 9 : n * 2
    }
    sum += n
  }
  return sum % 10 === 0
}
function startsInIssuerRange(value: string): boolean {
  const first = value[0]
  if (first === '4' || first === '5' || first === '6') {
    return true
  }
  if (first === '3') {
    return !['1', '2', '3'].includes(value[1] as string)
  }
  if (first === '2') {
    const prefix = Number(value.slice(0, 4))
    return prefix >= 2221 && prefix <= 2720
  }
  return value.startsWith('81') || value.startsWith('86')
}

const WRAPPERS: ReadonlyArray<(value: string) => string> = [
  (value) => value,
  (value) => `request ${value} failed with status 502.`,
  (value) => `(${value})`,
  (value) => `"${value}"`,
  (value) => `[trace ${value}], retry in 3 s`,
  (value) => `from ${value}; to ${value}`,
]

interface Category {
  name: string
  count: number
  make: () => string
}

const CATEGORIES: Category[] = [
  { name: 'UUID v4', count: 20_000, make: uuidV4 },
  { name: 'UUID v7', count: 20_000, make: uuidV7 },
  { name: 'org_ ids', count: 5_000, make: prefixed('org') },
  { name: 'usr_ ids', count: 5_000, make: prefixed('usr') },
  { name: 'req_ ids', count: 5_000, make: prefixed('req') },
  { name: 'evt_ ids', count: 5_000, make: prefixed('evt') },
  { name: 'ULIDs', count: 5_000, make: ulid },
  { name: 'hex hashes', count: 5_000, make: hexHash },
  { name: 'epoch seconds', count: 5_000, make: epochSeconds },
  { name: 'epoch milliseconds', count: 5_000, make: epochMillis },
  { name: 'epoch nanoseconds', count: 5_000, make: epochNanos },
  { name: 'compact timestamps', count: 5_000, make: compactTimestamp },
  { name: 'ISO timestamps', count: 5_000, make: isoTimestamp },
  { name: 'dotted versions', count: 5_000, make: dottedVersion },
  { name: 'CalVer', count: 5_000, make: calVer },
  { name: 'byte counts', count: 5_000, make: byteCount },
  { name: 'money amounts', count: 5_000, make: money },
  { name: 'IPv4 addresses', count: 5_000, make: ipv4 },
  { name: 'IPv6 addresses', count: 5_000, make: ipv6 },
  { name: 'lists of numeric ids', count: 5_000, make: idList },
  { name: 'id ranges', count: 5_000, make: idRange },
  { name: 'zero-padded ids', count: 5_000, make: zeroPadded },
  { name: '13 to 19 digit ids no issuer uses', count: 5_000, make: longIdOutsideIssuers },
]

describe('scrubText never alters an identifier (property tests, fixed seed)', () => {
  test.each(CATEGORIES)('$count $name come out byte for byte unchanged', ({ count, make }) => {
    let altered = 0
    const examples: string[] = []
    for (let i = 0; i < count; i++) {
      const value = make()
      const input = (WRAPPERS[i % WRAPPERS.length] as (value: string) => string)(value)
      const output = scrubText(input)
      if (output !== input) {
        altered++
        if (examples.length < 3) {
          examples.push(`${input}  =>  ${output}`)
        }
      }
    }
    expect({ altered, examples }).toEqual({ altered: 0, examples: [] })
  })

  test('the generators repeat: the same seed gives the same values', () => {
    const again = random(20260612)
    const first = random(20260612)
    expect([again(), again(), again()]).toEqual([first(), first(), first()])
  })
})

describe('scrubText: the ids that can still be altered are the ones the README lists', () => {
  const wrapped = (value: string): string => `request ${value} failed.`

  test('a bare 13 to 19 digit id starting 2 to 9 in an issuer range is altered only if it passes Luhn', () => {
    let seen = 0
    let altered = 0
    for (let i = 0; i < 5_000; i++) {
      const value = digits(int(13, 19))
      if (value[0] === '1' || !startsInIssuerRange(value)) {
        continue
      }
      seen++
      const changed = scrubText(wrapped(value)) !== wrapped(value)
      expect(changed).toBe(luhn(value))
      altered += changed ? 1 : 0
    }
    // About one in ten, as the README says; a wide band so the check is not about the seed.
    expect(altered / seen).toBeGreaterThan(0.03)
    expect(altered / seen).toBeLessThan(0.2)
  })

  test('four ids of four digits written like a card are altered only if they pass Luhn', () => {
    for (let i = 0; i < 3_000; i++) {
      const groups = Array.from({ length: 4 }, () => digits(4))
      const value = groups.join(pick([' ', '-']))
      const changed = scrubText(wrapped(value)) !== wrapped(value)
      if (changed) {
        expect(luhn(groups.join(''))).toBe(true)
      }
    }
  })

  test.each([
    ['groups led by 00', 'invoice 0012-3456-7890'],
    ['a zero-padded counter', 'order 0042 0017 0231'],
    ['four zero-padded groups', 'seq 0001 0002 0003 0004'],
    ['an assignment', 'id=0042-0017-0231'],
    ['two-digit groups led by 00', 'rows 00 11 22 33 44'],
  ])('%s is not read as a trunk-zero telephone number', (_name, text) => {
    expect(scrubText(text)).toBe(text)
  })

  test('a lone leading zero still reads as a trunk zero, which the README lists', () => {
    expect(scrubText('invoice 0123-4567-8901')).toBe('invoice [redacted]')
  })
})

describe('scrubText: each guard in the number rules decides something (round 3 F5)', () => {
  test.each([
    ['digits after a time and a colon', 'at 12:020 7946 0958'],
    ['digits after a ratio and a colon', 'ratio 1:0171-123-4567'],
    ['a card-length id written as a fraction', 'x .4111111111111111'],
    [
      'a digits-only UUID that starts with a plus sign',
      'ref +12345678-1234-4234-8234-123456789012',
    ],
  ])('%s is left alone', (_name, text) => {
    expect(scrubText(text)).toBe(text)
  })

  test('a single digit after a card is not part of it, so the card is still masked', () => {
    expect(scrubText('card 4111 1111 1111 1111 1')).toBe('card [redacted] 1')
    expect(scrubText('card 4111 1111 1111 1111 7 ok')).toBe('card [redacted] 7 ok')
  })
})

describe('scrubText: an id is not a telephone number or a card (N1)', () => {
  test.each([
    ['a UUID that ends its fourth group in digits', 'ae506499-d871-4815-9301-322b14037713'],
    ['a UUID made of digits only', '12345678-1234-4234-8234-123456789012'],
    ['a UUID whose first four groups are digits', '12345678-1234-4234-8234-12345678abcd'],
    ['a range of ids', '984757-662552'],
    ['CalVer', 'release 2026.10.25.564'],
    ['a byte count', '278.405.959 bytes'],
    ['a compact timestamp', 'at 20260623025718547 and 20260623025718'],
    ['a list of ids', 'ids 38294 44957 51203'],
    ['a token attached to letters by a dash', 'req-415-555-0199-a'],
    ['a token attached to letters by a dash before it', 'usr-415-555-0199'],
    ['a number attached to a word by a dot', 'node.415.555.0199'],
    ['a long id that happens to pass the Luhn check', 'order 4111111111111111abc'],
    ['a long digit id after a dash', 'txn-4111111111111111'],
    ['a trunk-form number tied to a word after it by a dash', 'ref 0171-123-4567-ab'],
  ])('%s is left alone', (_name, text) => {
    expect(scrubText(text)).toBe(text)
  })

  test.each([
    ['plus', 'dial +14155550199 now', 'dial [redacted] now'],
    ['parentheses', 'call (415) 555-0199 today', 'call [redacted] today'],
    ['plus and parentheses', 'call +1 (415) 555-0199.', 'call [redacted].'],
    ['the national trunk form', 'call 020 7946 0958', 'call [redacted]'],
    ['a trunk form with dashes', 'call 0171-123-4567 now', 'call [redacted] now'],
    ['a French mobile number with spaces', 'appelle 06 12 34 56 78', 'appelle [redacted]'],
  ])('a telephone number written with %s is still masked', (_name, text, expected) => {
    expect(scrubText(text)).toBe(expected)
  })

  test.each([
    ['dashes without a lead', 'call 415-555-0199 today'],
    ['dots without a lead', 'call 415.555.0199 today'],
    ['a toll-free number without a lead', 'call 1-800-555-0199'],
    ['bare digits', 'call 4155550199'],
  ])('a number written with %s is left alone on purpose', (_name, text) => {
    expect(scrubText(text)).toBe(text)
  })

  test('numbers written one after the other are all masked', () => {
    expect(scrubText('(415) 555-0199 (415) 555-0188')).not.toMatch(/\d{3}/)
    expect(scrubText('+14155550199 4111 1111 1111 1111')).not.toMatch(/\d{4}/)
  })
})

describe('scrubText: cards (N4)', () => {
  test.each([
    ['a Visa number', 'card 4111111111111111 declined'],
    ['a card with spaces', 'card 5555 5555 5555 4444 declined'],
    ['a card with dashes', 'card 6011-1111-1111-1117 declined'],
    ['an Amex number', 'card 3782 822463 10005 declined'],
    ['four groups of four starting with 1', 'card 1234 5678 9012 3452 declined'],
  ])('%s is masked whole', (_name, text) => {
    expect(scrubText(text)).toBe(text.replace(/\d[\d -]{11,}\d/, '[redacted]'))
  })

  test('a run starting with 1 is left alone unless written in four groups of four', () => {
    expect(scrubText('ts 1700000000123456 end')).toBe('ts 1700000000123456 end')
    expect(scrubText('card 1234567890123452 end')).toBe('card 1234567890123452 end')
  })
})
