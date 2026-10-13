// Compared after lowercasing and dropping `_` and `-`, so `apiKey`, `API_KEY` and `api-key` match.
// A key is sensitive when it, or it without one trailing `s`, is a listed word or ends with a
// suffix (`clientSecret`, `set-cookie`, `x-api-key`, `cookies`, `secretKey`, `requestBody`,
// `messageBodies`, `X-Amz-Signature`, `AWS_SECRET_ACCESS_KEY`). `recording`, `transcript` and the
// short words (`pass`, `pwd`, `auth`, `sig`, `sid`, `session`) only match as a whole key, so
// `recordingUrl`, `isRecording`, `bypass`, `author` and `sessionCount` stay readable.
//
// The short words (`pass`, `sig`, `sid`, `auth`) also match as one whole word of a longer key,
// bounded by `_`, `-`, `.` or a camelCase boundary (`db_pass`, `x-auth`, `userSid`, `X-Amz-Sig`),
// and `session` as the last word (`userSession`). They never match inside a word, so `bypass`,
// `compass`, `inside`, `design`, `possession` and `obsession` are not touched.
const SENSITIVE_WORDS: ReadonlySet<string> = new Set([
  'password',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'cookie',
  'secret',
  'apikey',
  'recording',
  'transcript',
  'body',
  'pass',
  'pwd',
  'passwd',
  'passphrase',
  'auth',
  'sig',
  'sid',
  'session',
  'sessionid',
  'sessid',
  'signature',
  'dsn',
  'otp',
  'cvv',
  'credential',
  'credentials',
])
const SENSITIVE_SUFFIXES = [
  'token',
  'secret',
  'password',
  'apikey',
  'cookie',
  'authorization',
  'secretkey',
  'privatekey',
  'secretaccesskey',
  'signature',
  'signature256',
  'passwordhash',
  'sessionkey',
  'accesskey',
  'connectionstring',
  'passwd',
  'sessionid',
  'sessid',
  'authorizationheader',
  'body',
  // The irregular plural: stripping one `s` from `bodies` does not give `body`.
  'bodies',
]

// Words that make a key sensitive when they stand alone as a word of it.
const SENSITIVE_WORD_SEGMENTS: ReadonlySet<string> = new Set(['pass', 'sig', 'sid', 'auth'])
// Words that do so only as the last word (`userSession`, not `sessionCount`).
const SENSITIVE_LAST_SEGMENTS: ReadonlySet<string> = new Set(['session'])

/** The words of a key: split at `_`, `-`, `.` and at camelCase boundaries, lowercased. */
function wordsOf(key: string): string[] {
  const words: string[] = []
  for (const part of key.split(/[_.-]+/)) {
    const pieces = part.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g)
    if (pieces !== null) {
      for (const piece of pieces) {
        words.push(piece.toLowerCase())
      }
    }
  }
  return words
}

/** Lowercases a key and drops `_` and `-`, so naming styles compare equal. */
export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '')
}

/** True when a key names a secret, token, recording, transcript or message body; see the rules above. */
export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key)
  const singular = normalized.endsWith('s') ? normalized.slice(0, -1) : normalized
  if (
    [normalized, singular].some(
      (name) =>
        SENSITIVE_WORDS.has(name) || SENSITIVE_SUFFIXES.some((suffix) => name.endsWith(suffix))
    )
  ) {
    return true
  }
  const words = wordsOf(key)
  return (
    words.some((word) => SENSITIVE_WORD_SEGMENTS.has(word)) ||
    SENSITIVE_LAST_SEGMENTS.has(words.at(-1) ?? '')
  )
}

/**
 * True for a key that may hold a count of language-model tokens (`inputTokens`, `total_tokens`).
 * Such a key is sensitive by its name, but a number under it is a usage figure that metering
 * needs in the logs, not a credential; anything else under it is still redacted.
 */
export function mayBeTokenCount(key: string): boolean {
  return normalizeKey(key).endsWith('tokens')
}
