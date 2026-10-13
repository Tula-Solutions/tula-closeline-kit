// Personal data inside free text: email addresses, telephone numbers and payment card numbers.
// Everything here scans by hand, one pass over the text, with every inner loop bounded by a small
// constant (an address part, a digit group), so no input makes the work grow faster than its length.

const MAX_LOCAL_PART = 64
const MAX_DOMAIN = 255
// A run is read at most this far; several numbers written together can have more.
const MAX_RUN_DIGITS = 64

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57
}

function isLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

function isLocalPartCode(code: number): boolean {
  return (
    isDigit(code) ||
    isLetter(code) ||
    code === 46 || // .
    code === 95 || // _
    code === 37 || // %
    code === 43 || // +
    code === 45 // -
  )
}

function isDomainCode(code: number): boolean {
  return isDigit(code) || isLetter(code) || code === 46 || code === 45
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
    while (start > floor && isLocalPartCode(text.charCodeAt(start - 1))) {
      start--
    }
    let end = at + 1
    const ceiling = Math.min(text.length, at + 1 + MAX_DOMAIN)
    while (end < ceiling && isDomainCode(text.charCodeAt(end))) {
      end++
    }
    // A full stop or dash right after the address belongs to the sentence.
    while (end > at + 1 && (text[end - 1] === '.' || text[end - 1] === '-')) {
      end--
    }
    const dot = text.lastIndexOf('.', end - 1)
    const tld = dot > at + 1 ? text.slice(dot + 1, end) : ''
    if (start < at && tld.length >= 2 && tld.length <= 24 && /^[A-Za-z]+$/.test(tld)) {
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

function readRun(text: string, from: number): Run | null {
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
    if (run.digits >= MAX_RUN_DIGITS) {
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

function isCard(text: string, run: Run): boolean {
  if (run.digits < 13 || run.digits > 19 || run.paren || run.plus) {
    return false
  }
  if (!run.seps.every((sep) => sep === ' ' || sep === '-')) {
    return false
  }
  const digits = digitsOf(text, run)
  // Epoch timestamps in milliseconds, microseconds and nanoseconds (2001 to 2033) start with 1 and
  // are as long as a card number; card issuers' ranges start with 2 to 9.
  return digits[0] !== '1' && passesLuhn(digits)
}

function isPhone(run: Run): boolean {
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
// run too long for either; a run this long is more than one number, so all of it goes.
function isSeveralNumbers(run: Run): boolean {
  return run.digits >= 20 && run.groups.every((length, i) => i === 0 || length >= 2)
}

/**
 * Masks telephone numbers (`+` and 8 to 15 digits, or 9 to 15 digits with spaces, dashes, dots or
 * parentheses) and payment card numbers (13 to 19 digits that pass the Luhn check). A bare run of
 * digits is never a telephone number, and is a card only when it is not part of a longer word, so
 * ids, counters and timestamps stay readable.
 */
export function maskNumbers(text: string, mask: string): string {
  let out = ''
  let copied = 0
  let i = 0
  while (i < text.length) {
    const code = text.charCodeAt(i)
    if (!(isDigit(code) || code === 43 || code === 40)) {
      i++
      continue
    }
    const run = readRun(text, i)
    if (run === null) {
      i++
      continue
    }
    const before = i === 0 ? 0 : text.charCodeAt(i - 1)
    const after = run.end < text.length ? text.charCodeAt(run.end) : 0
    const skip = leadingNonPhoneGroups(run)
    if (skip > 0) {
      // The date or address is left as it is; what follows it is looked at on its own.
      i = run.groupEnds[skip - 1] as number
      continue
    }
    let masked = false
    if (run.groups.length === 1 && !run.plus) {
      // Bare digits: only a card number, and not inside a word or after a decimal point.
      masked =
        !isWordLetter(before) &&
        !isDigit(before) &&
        before !== 46 &&
        !isWordLetter(after) &&
        isCard(text, run)
    } else if (!(isWordLetter(before) || isDigit(before))) {
      masked = isCard(text, run) || isPhone(run) || isSeveralNumbers(run)
    }
    if (masked) {
      const end = run.paren && text[run.end] === ')' ? run.end + 1 : run.end
      out += text.slice(copied, run.start) + mask
      copied = end
      i = end
    } else {
      // Not a number; try again from the next group, which can start one.
      i = run.groups.length > 1 ? (run.groupEnds[0] as number) : run.end
    }
  }
  return copied === 0 ? text : out + text.slice(copied)
}
