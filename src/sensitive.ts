// Compared after lowercasing and dropping `_` and `-`, so `apiKey`, `API_KEY` and `api-key` match.
// A key is sensitive when it, or it without one trailing `s`, is a listed word or ends with a
// suffix (`clientSecret`, `set-cookie`, `x-api-key`, `cookies`, `secretKey`, `requestBody`,
// `messageBodies`). `recording` and `transcript` only match as a whole key, so `recordingUrl` and
// `isRecording` stay readable.
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
  'authorizationheader',
  'body',
  // The irregular plural: stripping one `s` from `bodies` does not give `body`.
  'bodies',
]

/** Lowercases a key and drops `_` and `-`, so naming styles compare equal. */
export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '')
}

/** True when a key names a secret, token, recording, transcript or message body; see the rules above. */
export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key)
  const singular = normalized.endsWith('s') ? normalized.slice(0, -1) : normalized
  return [normalized, singular].some(
    (name) =>
      SENSITIVE_WORDS.has(name) || SENSITIVE_SUFFIXES.some((suffix) => name.endsWith(suffix))
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
