import { isSensitiveKey, mayBeTokenCount, normalizeKey } from './sensitive'

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
// connection details.
const CONNECTION_STRING =
  /\b((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql|sqlserver|nats|kafka|jdbc:[a-z0-9]{1,20}):\/\/)\S+/gi
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

// Header-like keys whose value is everything to the end of the line: it holds spaces and
// `;`-separated parts (`Bearer x`, `a=1; b=2`).
const LINE_VALUE_KEYS: ReadonlySet<string> = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
])

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

/** Cuts text to the cap and drops a trailing partial word, which could be the front of a secret. */
function cap(text: string): string {
  if (text.length <= MAX_TEXT_LENGTH) {
    return text
  }
  let end = MAX_TEXT_LENGTH
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

/** Where a value that starts at `start` ends: a closing quote, the end of the line, or a delimiter. */
function valueEnd(text: string, start: number, lineValue: boolean): number {
  const first = text[start]
  if (first === '"' || first === "'") {
    for (let i = start + 1; i < text.length; i++) {
      if (text[i] === '\\') {
        i++
      } else if (text[i] === first) {
        return i + 1
      }
    }
    return text.length
  }
  if (lineValue) {
    const newline = text.indexOf('\n', start)
    return newline === -1 ? text.length : newline
  }
  let end = start
  while (end < text.length && !/[\s,;&"']/.test(text[end] as string)) {
    end++
  }
  return end
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
      if (!isSensitiveKey(key)) {
        // lastIndex stays after the separator, so a pair inside this value is still found.
        continue
      }
      const end = valueEnd(text, start, LINE_VALUE_KEYS.has(normalizeKey(key)))
      if (end === start) {
        continue
      }
      if (mayBeTokenCount(key) && /^[0-9]+$/.test(text.slice(start, end))) {
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
 * Masks secrets inside free text (an error message, a log message): bearer tokens, JWTs and common
 * API-key shapes, URL credentials, connection strings, and the value of any `key=value` or
 * `key: value` pair whose key the kit treats as sensitive. Input over 32 KiB is cut. Runs in time
 * linear in the input and never throws; if it somehow fails it returns a fixed placeholder.
 */
export function scrubText(text: string): string {
  try {
    const raw = typeof text === 'string' ? text : String(text)
    if (raw.length === 0) {
      return raw
    }
    let value = cap(raw)
    if (value.includes('://')) {
      value = value.replace(CONNECTION_STRING, `$1${MASK}`).replace(URL_CREDENTIALS, `$1${MASK}@`)
    }
    value = value.replace(BEARER, `Bearer ${MASK}`)
    value = maskSecretWords(value)
    return maskPairs(value)
  } catch {
    return UNSCRUBBABLE
  }
}
