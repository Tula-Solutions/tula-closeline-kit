import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Signs a webhook the way Twilio does (`X-Twilio-Signature`): HMAC-SHA1 with the Auth Token over
 * the URL followed by each form field's name and value in sorted order, in base64. For tests and
 * for simulating Twilio; the adapters themselves only verify.
 */
export function signTwilioRequest(
  authToken: string,
  url: string,
  params: Readonly<Record<string, string>> | readonly (readonly [string, string])[] = {}
): string {
  const pairs = Array.isArray(params) ? [...params] : Object.entries(params)
  const text = pairs
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .reduce((acc, [name, value]) => acc + name + value, url)
  return createHmac('sha1', authToken).update(text, 'utf8').digest('base64')
}

/**
 * The URLs a webhook signature may have been computed over: the URL as given, plus the form with
 * and without the default port, because a proxy may add or drop it before Twilio signs.
 */
export function twilioUrlVariants(url: string): string[] {
  const variants = [url]
  try {
    const parsed = new URL(url)
    if (parsed.username || parsed.password) {
      return variants
    }
    const standard = parsed.protocol === 'https:' ? '443' : parsed.protocol === 'http:' ? '80' : ''
    // An explicit non-default port is part of the signed URL; only a default port may be added or dropped.
    if (standard === '' || (parsed.port !== '' && parsed.port !== standard)) {
      return variants
    }
    const rest = `${parsed.pathname}${parsed.search}`
    const bare = `${parsed.protocol}//${parsed.hostname}${rest}`
    const withPort = `${parsed.protocol}//${parsed.hostname}:${standard}${rest}`
    for (const variant of [bare, withPort]) {
      if (!variants.includes(variant)) {
        variants.push(variant)
      }
    }
  } catch {
    // an unparseable URL is only ever compared as given
  }
  return variants
}

/** Compares two strings in constant time for equal lengths; different lengths are unequal. */
export function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Whether `signature` is Twilio's for a form webhook: the HMAC over each URL variant and the form
 * fields, compared in constant time against every variant (so timing does not show which matched).
 */
export function verifyTwilioFormSignature(
  authToken: string,
  url: string,
  fields: readonly (readonly [string, string])[],
  signature: string
): boolean {
  let matched = false
  for (const variant of twilioUrlVariants(url)) {
    matched = sameText(signTwilioRequest(authToken, variant, fields), signature) || matched
  }
  return matched
}
