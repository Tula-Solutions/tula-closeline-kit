import { maskEmails, maskNumbers } from './pii'
import { isSensitiveKey, mayBeTokenCount } from './sensitive'

const MASK = '[redacted]'
const TRUNCATED = '[truncated]'
const UNSCRUBBABLE = '[unscrubbable]'

// Longest text scrubbed in one call. Anything beyond it is cut, never passed through, so work and
// output stay bounded whatever the caller hands in.
const MAX_TEXT_LENGTH = 32_768

// Every pattern below is anchored to a literal, a word boundary or the start of a word, and no two
// adjacent quantifiers can match the same character, so no input can make the engine backtrack
// more than a constant (or the length of one run) per position. The key/value pass scans by hand
// for the same reason.

// Database and broker URLs are masked whole: the host, user, password and options are all
// connection details. The scheme is found by a regex; the extent is found by hand (below), because
// a password may hold a space or a newline.
const CONNECTION_SCHEME =
  /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql|sqlserver|nats|kafka|jdbc:[a-z0-9]{1,20}):\/\//gi
// How far past the scheme an `@` still counts as the end of the user and password.
const MAX_USERINFO = 128
// Any other URL keeps its host and path; only the `user:password@` part goes.
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/?#]+@/gi
const BEARER = /\bbearer\s+[A-Za-z0-9._~+/=-]+/gi
// A maximal run of characters a JWT or an API key is made of; each run is tested once, anchored.
const TOKEN_WORD = /[A-Za-z0-9_.-]{16,}/g
const SECRET_WORDS: readonly RegExp[] = [
  /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.?$/,
  /^(?:AKIA|ASIA)[0-9A-Z]{16}/,
  /^(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/,
  /^(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/,
  /^sk-[A-Za-z0-9_-]{16,}/,
  /^xox[abprs]-[A-Za-z0-9-]{10,}/,
]
// A key (optionally quoted) and its separator. The key must start a word, so each position is
// tried at most once and a key is at most 64 characters.
const KEY_AND_SEPARATOR = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{1,64})["']?\s*[:=]\s*/g

// A frame position (`at verify (/app/src/auth/token:12:3)`) looks like `token:` and a value but is a
// file name, a line and a column.
const FRAME_POSITION = /\d{1,9}:\d{1,9}/y
// A Postgres constraint detail: `Key (email)=(jane@acme.com) already exists.`
const KEY_DETAIL = /\bKey \(([^()\n]{1,200})\)=\(/g
const KEY_DETAIL_END = /\)(?=[ \t]+(?:already|is\b|conflicts)|[ \t]*[.,;]?[ \t]*(?:\r?\n|$))/g
const MAX_KEY_DETAIL_VALUE = 500

function isWordCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 || // _
    code === 46 || // .
    code === 45 || // -
    code === 126 || // ~
    code === 43 || // +
    code === 47 || // /
    code === 61 // =
  )
}

/**
 * Cuts text to at most `max` characters, drops a trailing partial word (it could be the front of a
 * secret) and marks the cut. Text that fits is returned as it is. Work is bounded by `max`.
 */
export function cutText(text: string, max: number): string {
  if (text.length <= max) {
    return text
  }
  let end = max
  while (end > 0 && isWordCode(text.charCodeAt(end - 1))) {
    end--
  }
  return `${text.slice(0, end)}${TRUNCATED}`
}

function maskSecretWords(text: string): string {
  return text.replace(TOKEN_WORD, (word) =>
    SECRET_WORDS.some((pattern) => pattern.test(word)) ? MASK : word
  )
}

/**
 * Where a value that starts at `start` ends: a closing quote (a doubled quote inside is part of the
 * value), or, unquoted, the end of the line. A value in a URL query string ends at the next `&`,
 * `#`, quote, comma, semicolon or space instead.
 */
function valueEnd(text: string, start: number, inQuery: boolean): number {
  const first = text[start]
  if (first === '"' || first === "'") {
    for (let i = start + 1; i < text.length; i++) {
      if (text[i] === '\\') {
        i++
      } else if (text[i] === first) {
        if (text[i + 1] !== first) {
          return i + 1
        }
        i++
      }
    }
    return text.length
  }
  let end = start
  if (inQuery) {
    while (end < text.length && !/[\s,;&#"']/.test(text[end] as string)) {
      end++
    }
    return end
  }
  while (end < text.length && text[end] !== '\n' && text[end] !== '\r') {
    end++
  }
  return end
}

function isFramePosition(text: string, keyStart: number, valueStart: number): boolean {
  const before = text[keyStart - 1]
  if ((before !== '/' && before !== '\\') || text[valueStart - 1] !== ':') {
    return false
  }
  FRAME_POSITION.lastIndex = valueStart
  return FRAME_POSITION.test(text)
}

/** Where a connection string that starts after its scheme at `start` ends. */
function connectionEnd(text: string, start: number): number {
  const limit = Math.min(text.length, start + MAX_USERINFO)
  let at = -1
  for (let i = start; i < limit; i++) {
    const c = text[i]
    if (c === '@') {
      at = i
      break
    }
    if (c === '/' || c === '?' || c === '#') {
      break
    }
  }
  // The user and password may hold spaces; once the `@` is found, the host and path run to whitespace.
  let end = at === -1 ? start : at + 1
  while (end < text.length && !/\s/.test(text[end] as string)) {
    end++
  }
  return end
}

function maskConnectionStrings(text: string): string {
  const pattern = CONNECTION_SCHEME
  pattern.lastIndex = 0
  let out = ''
  let copied = 0
  try {
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      const start = match.index + match[0].length
      const end = connectionEnd(text, start)
      if (end === start) {
        continue
      }
      out += text.slice(copied, start) + MASK
      copied = end
      pattern.lastIndex = end
    }
  } finally {
    pattern.lastIndex = 0
  }
  return copied === 0 ? text : out + text.slice(copied)
}

/** Masks the value in `Key (column)=(value)`, which Postgres puts in constraint errors. */
function maskKeyDetails(text: string): string {
  if (!text.includes('Key (')) {
    return text
  }
  const pattern = KEY_DETAIL
  pattern.lastIndex = 0
  let out = ''
  let copied = 0
  try {
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      const start = pattern.lastIndex
      const window = text.slice(start, start + MAX_KEY_DETAIL_VALUE + 1)
      KEY_DETAIL_END.lastIndex = 0
      const close = KEY_DETAIL_END.exec(window)
      let end: number
      if (close !== null) {
        end = start + close.index
      } else {
        const newline = window.indexOf('\n')
        end = start + (newline === -1 ? window.length : newline)
      }
      out += text.slice(copied, start) + MASK
      copied = end
      pattern.lastIndex = end
    }
  } finally {
    pattern.lastIndex = 0
    KEY_DETAIL_END.lastIndex = 0
  }
  return copied === 0 ? text : out + text.slice(copied)
}

function maskPairs(text: string): string {
  const pattern = KEY_AND_SEPARATOR
  pattern.lastIndex = 0
  let out = ''
  let copied = 0
  try {
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      const key = match[1] as string
      const start = pattern.lastIndex
      if (!isSensitiveKey(key) || isFramePosition(text, match.index, start)) {
        // lastIndex stays after the separator, so a pair inside this value is still found.
        continue
      }
      const before = text[match.index - 1]
      const end = valueEnd(text, start, before === '?' || before === '&')
      if (end === start) {
        continue
      }
      // A figure under a token-count key is usage, not a credential, and what follows it is prose.
      if (mayBeTokenCount(key) && /^[0-9]+(?=[\s,;&]|$)/.test(text.slice(start, start + 24))) {
        continue
      }
      out += text.slice(copied, start) + MASK
      copied = end
      pattern.lastIndex = end
    }
  } finally {
    pattern.lastIndex = 0
  }
  return copied === 0 ? text : out + text.slice(copied)
}

/**
 * Masks secrets and personal data inside free text (an error message, a log message): bearer
 * tokens, JWTs and common API-key shapes, URL credentials, connection strings, the value in a
 * Postgres `Key (column)=(value)` detail, the value of any `key=value` or `key: value` pair whose
 * key the kit treats as sensitive (to the end of the line when unquoted), email addresses,
 * telephone numbers and payment card numbers. Input over 32 KiB is cut. Runs in time linear in the
 * input and never throws; if it somehow fails it returns a fixed placeholder.
 */
export function scrubText(text: string): string {
  try {
    const raw = typeof text === 'string' ? text : String(text)
    if (raw.length === 0) {
      return raw
    }
    let value = cutText(raw, MAX_TEXT_LENGTH)
    if (value.includes('://')) {
      value = maskConnectionStrings(value).replace(URL_CREDENTIALS, `$1${MASK}@`)
    }
    value = value.replace(BEARER, `Bearer ${MASK}`)
    value = maskSecretWords(value)
    value = maskKeyDetails(value)
    value = maskPairs(value)
    return maskNumbers(maskEmails(value, MASK), MASK)
  } catch {
    return UNSCRUBBABLE
  }
}
