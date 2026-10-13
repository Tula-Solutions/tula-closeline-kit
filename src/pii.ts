// Personal data inside free text: email addresses, telephone numbers and payment card numbers.
// Everything here scans by hand, one pass over the text, with every inner loop bounded by a small
// constant (an address part, a digit group), so no input makes the work grow faster than its length.

const MAX_LOCAL_PART = 64
const MAX_DOMAIN = 255
// A run is read at most this far; several numbers written together can have more.
const MAX_RUN_DIGITS = 64
const MAX_CARD_DIGITS = 19

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57
}

function isLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

// A letter, mark or number above U+007F (`jörg`, `田中`, `bücher`) belongs to an address too. The
// test runs only on such characters, and a surrogate half is taken as part of one.
const UNICODE_WORD = /[\p{L}\p{M}\p{N}]/u

function isWideWordCode(code: number, char: string): boolean {
  return code > 127 && ((code >= 0xd800 && code <= 0xdfff) || UNICODE_WORD.test(char))
}

function isLocalPartCode(code: number, char: string): boolean {
  return (
    isDigit(code) ||
    isLetter(code) ||
    isWideWordCode(code, char) ||
    code === 46 || // .
    code === 95 || // _
    code === 37 || // %
    code === 43 || // +
    code === 45 // -
  )
}

function isDomainCode(code: number, char: string): boolean {
  return isDigit(code) || isLetter(code) || isWideWordCode(code, char) || code === 46 || code === 45
}

/** True for a character that makes a digit run part of a longer word (`usr_4111…`, `ab4111…`). */
function isWordLetter(code: number): boolean {
  return isLetter(code) || code === 95
}

/** Masks email addresses: `local@domain.tld`, found from each `@` outwards. */
export function maskEmails(text: string, mask: string): string {
  let at = text.indexOf('@')
  if (at === -1) {
    return text
  }
  let out = ''
  let copied = 0
  while (at !== -1) {
    let start = at
    const floor = Math.max(copied, at - MAX_LOCAL_PART)
    while (
      start > floor &&
      isLocalPartCode(text.charCodeAt(start - 1), text[start - 1] as string)
    ) {
      start--
    }
    let end = at + 1
    const ceiling = Math.min(text.length, at + 1 + MAX_DOMAIN)
    while (end < ceiling && isDomainCode(text.charCodeAt(end), text[end] as string)) {
      end++
    }
    // A full stop or dash right after the address belongs to the sentence.
    while (end > at + 1 && (text[end - 1] === '.' || text[end - 1] === '-')) {
      end--
    }
    // Searched inside the domain only: a search over the whole text from here back would rescan the
    // same stretch at every `@` of a long run of them.
    const dot = text.slice(at + 1, end).lastIndexOf('.')
    const tld = dot > 0 ? text.slice(at + 2 + dot, end) : ''
    if (start < at && tld.length >= 2 && tld.length <= 24 && /^\p{L}+$/u.test(tld)) {
      out += text.slice(copied, start) + mask
      copied = end
      at = text.indexOf('@', end)
    } else {
      at = text.indexOf('@', at + 1)
    }
  }
  return copied === 0 ? text : out + text.slice(copied)
}

/** A run of digit groups joined by single separators, as a number is written. */
interface Run {
  /** Index of the first character (`+` or `(` included). */
  start: number
  /** Index just after the last digit. */
  end: number
  plus: boolean
  paren: boolean
  /** Where each group of digits ends. */
  groupEnds: number[]
  /** Length of each group of digits. */
  groups: number[]
  /** The separator that follows each group but the last. */
  seps: string[]
  digits: number
}

function readRun(text: string, from: number, maxDigits: number): Run | null {
  let p = from
  let plus = false
  let paren = false
  if (text[p] === '+') {
    plus = true
    p++
  }
  if (text[p] === '(') {
    paren = true
    p++
  }
  if (!isDigit(text.charCodeAt(p))) {
    return null
  }
  // A number written `00 33 6 12 34 56 78` or `0061 2 9876 5432` has a lone digit after its country
  // code, as one written with a `+` can.
  const doubleZero = !plus && text.charCodeAt(p) === 48 && text.charCodeAt(p + 1) === 48
  const run: Run = {
    start: from,
    end: p,
    plus,
    paren,
    groupEnds: [],
    groups: [],
    seps: [],
    digits: 0,
  }
  for (;;) {
    let q = p
    while (isDigit(text.charCodeAt(q))) {
      q++
    }
    run.groups.push(q - p)
    run.groupEnds.push(q)
    run.digits += q - p
    run.end = q
    if (run.digits >= maxDigits) {
      break
    }
    let k = q
    let sep = ''
    if (text[k] === ')') {
      sep = ')'
      k++
    }
    const next = text[k]
    if (next === ' ' || next === '-' || next === '.') {
      sep += next
      k++
    }
    if (text[k] === '(') {
      // `+44(0)20 …`: a parenthesis straight after a group belongs to a `+` or `00` number only.
      if (sep === '' && !(plus || doubleZero)) {
        break
      }
      sep = sep === '' ? '(' : sep
      k++
    }
    if (sep === '') {
      break
    }
    if (!isDigit(text.charCodeAt(k))) {
      break
    }
    // After the first group, a single digit does not belong to a telephone or card number (`1-1-1…`
    // is a list); stopping here also keeps a long chain of them from being rescanned at each digit.
    // The last digit of a 13 digit card, written 4-4-4-1, is the one other lone digit.
    const cardTail = run.groups.length === 3 && run.groups.every((length) => length === 4) && !paren
    if (
      !(plus || (doubleZero && run.groups.length <= 3) || cardTail) &&
      !isDigit(text.charCodeAt(k + 1))
    ) {
      break
    }
    run.seps.push(sep)
    p = k
  }
  return run
}

function passesLuhn(digits: string): boolean {
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48
    if (double) {
      n *= 2
      if (n > 9) {
        n -= 9
      }
    }
    sum += n
    double = !double
  }
  return sum % 10 === 0
}

function digitsOf(text: string, run: Run): string {
  return text.slice(run.start, run.end).replace(/\D/g, '')
}

/**
 * How many leading groups are an ISO date (`2024-05-12`, with a month 1 to 12 and a day 1 to 31) or
 * an IPv4 address; 0 when neither. A run that opens with `+` or `00` is neither: no date has a year
 * `00xx` and no address has a plus.
 */
function leadingNonPhoneGroups(text: string, run: Run): number {
  if (run.plus || startsDoubleZero(text, run)) {
    return 0
  }
  const { groups, seps } = run
  if (groups[0] === 4 && groups[1] === 2 && groups[2] === 2 && seps[0] === '-' && seps[1] === '-') {
    const month = Number(text.slice((run.groupEnds[0] as number) + 1, run.groupEnds[1]))
    const day = Number(text.slice((run.groupEnds[1] as number) + 1, run.groupEnds[2]))
    return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? 3 : 0
  }
  if (
    groups.length >= 4 &&
    groups.slice(0, 4).every((length) => length <= 3) &&
    seps.slice(0, 3).every((sep) => sep === '.')
  ) {
    return 4
  }
  return 0
}

/** True for a letter or digit. */
function isAlnum(code: number): boolean {
  return isDigit(code) || isLetter(code)
}

/**
 * True when the character before `index` ties the run to a longer token: a letter or `_`, a digit,
 * or a `-` or `.` that follows a letter or digit (`req-415-…`, `4815-9301-…` inside a UUID,
 * `2026.10.25.564`), or a `:` that follows a digit (`10:30:05.109`). Such a run is part of an identifier, not a number on its own.
 */
function attachedBefore(text: string, index: number, labelled: boolean): boolean {
  if (index === 0) {
    return false
  }
  const code = text.charCodeAt(index - 1)
  if (isWordLetter(code) || isDigit(code)) {
    return true
  }
  if (code === 45 || code === 46) {
    // A number that opens with `+`, `00` or an area code after a label (`Tel.+44 …`, `ph-0044 …`) is
    // a number: only a digit before the dot or dash ties it to an id or a version.
    const two = index >= 2 ? text.charCodeAt(index - 2) : 0
    if (!labelled) {
      return isAlnum(two)
    }
    // After a dash a hex letter ties it too: a UUID or a hash is written with them.
    return isDigit(two) || (code === 45 && (two | 32) >= 97 && (two | 32) <= 102)
  }
  // `10:30:05.109-0800`: the seconds of a time are not a telephone number.
  return code === 58 && index >= 2 && isDigit(text.charCodeAt(index - 2))
}

/** True when the character after the run ties it to a longer token; see `attachedBefore`. */
function attachedAfter(text: string, index: number): boolean {
  if (index >= text.length) {
    return false
  }
  const code = text.charCodeAt(index)
  if (isWordLetter(code)) {
    return true
  }
  return (code === 45 || code === 46) && isAlnum(text.charCodeAt(index + 1))
}

/** True for the layout of a UUID, 8-4-4-4-12 joined by dashes, which no number is written in. */
function isUuidLayout(run: Run): boolean {
  const { groups, seps } = run
  return (
    groups.length === 5 &&
    groups[0] === 8 &&
    groups[1] === 4 &&
    groups[2] === 4 &&
    groups[3] === 4 &&
    groups[4] === 12 &&
    seps.every((sep) => sep === '-')
  )
}

/** True when the first four digits fall in a range a card issuer uses. */
function hasIssuerPrefix(digits: string): boolean {
  const first = digits[0]
  if (first === '4' || first === '5' || first === '6') {
    return true
  }
  if (first === '3') {
    return digits[1] !== '1' && digits[1] !== '2' && digits[1] !== '3'
  }
  if (first === '2') {
    const prefix = Number(digits.slice(0, 4))
    return prefix >= 2221 && prefix <= 2720
  }
  return digits.startsWith('81') || digits.startsWith('86')
}

/** True when the groups are laid out as a card is: 4-4-4-4 (and the shorter or longer variants), 4-6-5. */
function isCardLayout(groups: number[]): boolean {
  const last = groups.length - 1
  if (groups.length === 1) {
    return true
  }
  if (groups.slice(0, last).every((length) => length === 4)) {
    return (groups[last] as number) <= 4
  }
  return (
    groups.length === 3 &&
    groups[0] === 4 &&
    groups[1] === 6 &&
    (groups[2] === 5 || groups[2] === 4)
  )
}

function isCard(text: string, run: Run): boolean {
  if (run.digits < 13 || run.digits > 19 || run.paren || run.plus) {
    return false
  }
  if (
    !run.seps.every((sep) => sep === ' ' || sep === '-' || sep === '.') ||
    !isCardLayout(run.groups)
  ) {
    return false
  }
  const digits = digitsOf(text, run)
  // Epoch timestamps in milliseconds, microseconds and nanoseconds (2001 to 2033) start with 1 and
  // are as long as a card number, so a run starting with 1 is a card only when it is written in
  // four groups of four. Compact timestamps (`20260623025718`) and most other ids start in no
  // issuer's range either.
  if (digits[0] === '1') {
    return (
      run.groups.length === 4 && run.groups.every((length) => length === 4) && passesLuhn(digits)
    )
  }
  return hasIssuerPrefix(digits) && passesLuhn(digits)
}

// Country calling codes (ITU-T E.164). They are prefix-free: no code starts another. The three-digit
// codes are given by their first two digits, a little wider than the assigned ranges, so that an
// unassigned code is masked rather than missed.
const TWO_DIGIT_CODES: ReadonlySet<string> = new Set(
  '20 27 30 31 32 33 34 36 39 40 41 43 44 45 46 47 48 49 51 52 53 54 55 56 57 58 60 61 62 63 64 65 66 81 82 84 86 90 91 92 93 94 95 98'.split(
    ' '
  )
)
const THREE_DIGIT_PREFIXES: ReadonlySet<string> = new Set(
  '21 22 23 24 25 26 29 35 37 38 42 50 59 67 68 69 85 87 88 96 97 99'.split(' ')
)

/** True for a country calling code: `1`, `7`, `44`, `353`. */
function isCountryCode(code: string): boolean {
  if (code.length === 1) {
    return code === '1' || code === '7'
  }
  if (code.length === 2) {
    return TWO_DIGIT_CODES.has(code)
  }
  return code.length === 3 && THREE_DIGIT_PREFIXES.has(code.slice(0, 2))
}

/** True when the run opens with the `00` international prefix (a trunk zero is a single zero). */
function startsDoubleZero(text: string, run: Run): boolean {
  return (
    !run.plus &&
    !run.paren &&
    text.charCodeAt(run.start) === 48 &&
    text.charCodeAt(run.start + 1) === 48
  )
}

/** Index of a group that is the optional trunk zero written `(0)` right after the country code; -1 if none. */
function trunkParenAt(text: string, run: Run): number {
  for (let i = 1; i <= 2 && i < run.groups.length; i++) {
    const end = run.groupEnds[i] as number
    if (
      run.groups[i] === 1 &&
      text.charCodeAt(end - 1) === 48 &&
      text[end - 2] === '(' &&
      text[end] === ')'
    ) {
      return i
    }
  }
  return -1
}

/** Digits of a `+` or `00` number: the country code and the number, without a `(0)` trunk zero. */
function numberDigits(text: string, run: Run): number {
  return run.digits - (trunkParenAt(text, run) === -1 ? 0 : 1)
}

/** Length of the country code the digits open with (1 to 3), or 0 when they open with none. */
function codeLength(digits: string): number {
  if (digits[0] === '1' || digits[0] === '7') {
    return 1
  }
  if (TWO_DIGIT_CODES.has(digits.slice(0, 2))) {
    return 2
  }
  return digits.length >= 3 && THREE_DIGIT_PREFIXES.has(digits.slice(0, 2)) ? 3 : 0
}

/**
 * True when a run opening with `00` is written like an international number: the prefix is followed
 * by a country code, glued to the first group (`0044 20 7946 0958`) or as a group of its own
 * (`00 44 20 …`), or with the national number glued on (`0044 2079460958`). A code is read exactly
 * from a group of up to five digits (so `0042` and `0012`, which are no code, are not read as one)
 * and as a prefix from a longer group. A padded counter (`0044 0017 0231`, `0020-0021-0022`) also
 * opens that way, so a run whose every later group starts with `0` stays readable; everything
 * else is a number, whatever its group widths. One lone digit is allowed after the code
 * (`00 33 6 12 34 56 78`, `0055 11 9 1234 5678`), every other group has two or more digits.
 * Linear: it looks at the first two groups and at each group's width and first digit once.
 */
function opensAsInternational(text: string, run: Run): boolean {
  const { groups, groupEnds } = run
  const first = groups[0] as number
  let tail: number[]
  if (first === 2) {
    const second = groups[1] as number
    if (groups.length < 2) {
      return false
    }
    const digits = text.slice((groupEnds[0] as number) + 1, groupEnds[1])
    if (second >= 4 ? codeLength(digits) === 0 : !isCountryCode(digits) || groups.length < 3) {
      return false
    }
    tail = groups.slice(2)
  } else {
    if (first < 3 || groups.length < 2) {
      return false
    }
    const digits = text.slice(run.start + 2, groupEnds[0])
    if (first > 5 ? codeLength(digits) === 0 : !isCountryCode(digits)) {
      return false
    }
    tail = groups.slice(1)
  }
  const trunk = trunkParenAt(text, run)
  const lone = tail.filter(
    (length, i) => length === 1 && i + (groups.length - tail.length) !== trunk
  ).length
  if (lone > 1) {
    return false
  }
  // A padded counter: every group after the first starts with a zero.
  for (let i = 1; i < groups.length; i++) {
    if (text.charCodeAt((groupEnds[i] as number) - (groups[i] as number)) !== 48) {
      return true
    }
  }
  return false
}

/** True for one group of digits `00`, a country code and a number, with nothing written between. */
function isGluedInternational(text: string, run: Run): boolean {
  return (
    startsDoubleZero(text, run) &&
    run.groups.length === 1 &&
    run.digits >= 10 &&
    run.digits <= 17 &&
    codeLength(text.slice(run.start + 2, run.end)) > 0
  )
}

/**
 * True when a number written with separators opens the way telephone numbers do: a `+`, a
 * parenthesised area code `(415)`, the national trunk zero (`020 7946 0958`, `06 12 34 56 78`), or the
 * `00` international prefix followed by a country code (`0044 20 7946 0958`).
 * Without one of those it cannot be told from an id, a range or a count, and is left alone.
 */
function hasPhoneLead(text: string, run: Run): boolean {
  if (run.plus) {
    return true
  }
  if (run.paren) {
    return run.seps[0]?.startsWith(')') === true
  }
  if (startsDoubleZero(text, run)) {
    return opensAsInternational(text, run)
  }
  const first = run.groups[0] as number
  // Written with one kind of separator throughout, so `05.109-0800` (seconds, then an offset) is not one.
  return (
    text.charCodeAt(run.start) === 48 &&
    first >= 2 &&
    first <= 5 &&
    run.seps.every((sep) => sep === run.seps[0])
  )
}

function isPhone(text: string, run: Run): boolean {
  if (!hasPhoneLead(text, run)) {
    return false
  }
  if (run.plus) {
    return numberDigits(text, run) >= 8 && numberDigits(text, run) <= 15
  }
  if (startsDoubleZero(text, run)) {
    // The digits after the `00` are the number, as they are after a `+`.
    return numberDigits(text, run) >= 10 && numberDigits(text, run) <= 17
  }
  if (run.digits < 9 || run.digits > 15) {
    return false
  }
  const { groups, seps } = run
  const dotted = seps.every((sep) => sep === '.')
  // Every group after the first has at least two digits (`1 2 3 4 …` is a list, not a number), and
  // none is long (`3.14159265358979` is a float). Dotted numbers need three or more short groups.
  const limit = dotted ? 4 : 8
  if (dotted && groups.length < 3) {
    return false
  }
  return groups.every((length, i) => length <= limit && (i === 0 || length >= 2))
}

// Two or more numbers written one after the other (`+14155550199 4111 1111 1111 1111`) read as one
// run too long for either. A run that is too long for a telephone number and opens as one, or opens
// as a card followed by more digits, is more than one number, so all of it goes.
function isSeveralNumbers(text: string, run: Run): boolean {
  const trunk = trunkParenAt(text, run)
  if (
    numberDigits(text, run) < 16 ||
    !run.groups.every((length, i) => i === 0 || length >= 2 || i === trunk)
  ) {
    return false
  }
  if (hasPhoneLead(text, run)) {
    return true
  }
  if (
    run.digits < 20 ||
    run.groups.length < 5 ||
    !run.groups.slice(0, 4).every((length) => length === 4) ||
    !run.seps.slice(0, 3).every((sep) => sep === ' ' || sep === '-')
  ) {
    return false
  }
  const card = digitsOf(text, run).slice(0, 16)
  return card[0] !== '1' && hasIssuerPrefix(card) && passesLuhn(card)
}

/**
 * Masks telephone numbers (`+` and 8 to 15 digits, or 9 to 15 digits with spaces, dashes, dots or
 * parentheses that open with a `+`, a `(area code)` or a trunk zero) and payment card numbers (13 to
 * 19 digits in a card issuer's range that pass the Luhn check). A bare run of digits is never a
 * telephone number, and a run that is part of a longer token (a UUID, a CalVer, `req-…`) is never
 * touched, so ids, counters and timestamps stay readable.
 */
export function maskNumbers(text: string, mask: string): string {
  let out = ''
  let copied = 0
  let i = 0
  // End of the longest run of digit groups already rejected as a whole. A group inside it is not the
  // start of a telephone number (`649 005 068 150` holds `005 068 150`), but a card can still start there.
  let sequenceEnd = 0
  while (i < text.length) {
    const code = text.charCodeAt(i)
    if (!(isDigit(code) || code === 43 || code === 40)) {
      i++
      continue
    }
    // Inside a run already rejected only a card can start (at most 19 digits), so read no further.
    const inside = isDigit(code) && i < sequenceEnd
    const run = readRun(text, i, inside ? MAX_CARD_DIGITS + 1 : MAX_RUN_DIGITS)
    if (run === null) {
      i++
      continue
    }
    const before = i === 0 ? 0 : text.charCodeAt(i - 1)
    if (run.paren && !run.plus && run.seps[0]?.startsWith(')') !== true) {
      // A bracket round the number (`(4111 1111 …)`), not an area code: read from the digit.
      i++
      continue
    }
    if (isUuidLayout(run)) {
      // A UUID made of digits only is an id; it is never read as numbers.
      i = run.end
      continue
    }
    const skip = leadingNonPhoneGroups(text, run)
    if (skip > 0) {
      // The date or address is left as it is; what follows it is looked at on its own.
      i = run.groupEnds[skip - 1] as number
      continue
    }
    // Opens as a telephone number does, so a label right before it (`Tel.`) does not tie it to a word.
    const labelled = run.plus || run.paren || startsDoubleZero(text, run)
    let masked = false
    if (run.groups.length === 1 && !run.plus) {
      // Bare digits: only a card number, and not inside a longer token or after a decimal point.
      masked =
        (before !== 46 || startsDoubleZero(text, run)) &&
        !attachedBefore(text, i, startsDoubleZero(text, run)) &&
        !attachedAfter(text, run.end) &&
        (isCard(text, run) || isGluedInternational(text, run))
    } else if (!attachedBefore(text, i, labelled) && !attachedAfter(text, run.end)) {
      masked = isCard(text, run) || (!inside && (isPhone(text, run) || isSeveralNumbers(text, run)))
    }
    if (masked) {
      const end = run.paren && text[run.end] === ')' ? run.end + 1 : run.end
      out += text.slice(copied, run.start) + mask
      copied = end
      i = end
    } else {
      // Not a number; try again from the next group, which can start one.
      if (run.groups.length > 1) {
        sequenceEnd = Math.max(sequenceEnd, run.end)
      }
      i = run.groups.length > 1 ? (run.groupEnds[0] as number) : run.end
    }
  }
  return copied === 0 ? text : out + text.slice(copied)
}
