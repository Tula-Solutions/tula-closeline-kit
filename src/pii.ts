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
    if (sep === '') {
      break
    }
    if (text[k] === '(') {
      k++
    }
    if (!isDigit(text.charCodeAt(k))) {
      break
    }
    // After the first group, a single digit does not belong to a telephone or card number (`1-1-1…`
    // is a list); stopping here also keeps a long chain of them from being rescanned at each digit.
    if (!plus && !isDigit(text.charCodeAt(k + 1))) {
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

/** How many leading groups are an ISO date (`2024-05-12`) or an IPv4 address; 0 when neither. */
function leadingNonPhoneGroups(run: Run): number {
  const { groups, seps } = run
  if (groups[0] === 4 && groups[1] === 2 && groups[2] === 2 && seps[0] === '-' && seps[1] === '-') {
    return 3
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
function attachedBefore(text: string, index: number): boolean {
  if (index === 0) {
    return false
  }
  const code = text.charCodeAt(index - 1)
  if (isWordLetter(code) || isDigit(code)) {
    return true
  }
  if (code === 45 || code === 46) {
    return index >= 2 && isAlnum(text.charCodeAt(index - 2))
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
  if (!run.seps.every((sep) => sep === ' ' || sep === '-') || !isCardLayout(run.groups)) {
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

/**
 * True when a number written with separators opens the way telephone numbers do: a `+`, a
 * parenthesised area code `(415)`, or the national trunk zero (`020 7946 0958`, `06 12 34 56 78`;
 * a leading `00` is not one).
 * Without one of those it cannot be told from an id, a range or a count, and is left alone.
 */
function hasPhoneLead(text: string, run: Run): boolean {
  if (run.plus) {
    return true
  }
  if (run.paren) {
    return run.seps[0]?.startsWith(')') === true
  }
  const first = run.groups[0] as number
  // Written with one kind of separator throughout, so `05.109-0800` (seconds, then an offset) is not one.
  // `00` is not a trunk zero: padded counters and ids (`0042-0017-0231`) open that way.
  return (
    text.charCodeAt(run.start) === 48 &&
    text.charCodeAt(run.start + 1) !== 48 &&
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
    return run.digits >= 8 && run.digits <= 15
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
  if (run.digits < 16 || !run.groups.every((length, i) => i === 0 || length >= 2)) {
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
    if (isUuidLayout(run)) {
      // A UUID made of digits only is an id; it is never read as numbers.
      i = run.end
      continue
    }
    const skip = leadingNonPhoneGroups(run)
    if (skip > 0) {
      // The date or address is left as it is; what follows it is looked at on its own.
      i = run.groupEnds[skip - 1] as number
      continue
    }
    let masked = false
    if (run.groups.length === 1 && !run.plus) {
      // Bare digits: only a card number, and not inside a longer token or after a decimal point.
      masked =
        before !== 46 &&
        !attachedBefore(text, i) &&
        !attachedAfter(text, run.end) &&
        isCard(text, run)
    } else if (!attachedBefore(text, i) && !attachedAfter(text, run.end)) {
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
