import { redactFields } from '../redact'
import { scrubText } from '../scrub'
import { isSensitiveKey } from '../sensitive'

// Keys that hold source code or the values of local variables. Never sent, at any depth.
const CODE_KEYS: ReadonlySet<string> = new Set([
  'vars',
  'pre_context',
  'context_line',
  'post_context',
])

type Plain = Record<string, unknown>

function isPlain(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Copies a value with every string (and every key) passed through scrubText and code keys removed. */
function scrubTree(value: unknown): unknown {
  if (typeof value === 'string') {
    return scrubText(value)
  }
  if (Array.isArray(value)) {
    return value.map(scrubTree)
  }
  if (isPlain(value) && !(value instanceof Date)) {
    const out: Plain = {}
    for (const [key, item] of Object.entries(value)) {
      if (!CODE_KEYS.has(key)) {
        Object.defineProperty(out, scrubText(key), {
          value: scrubTree(item),
          enumerable: true,
          writable: true,
          configurable: true,
        })
      }
    }
    return out
  }
  return value
}

/** The URL without its query string and fragment, which can hold tokens. */
function withoutQuery(url: string): string {
  const end = url.search(/[?#]/)
  return end === -1 ? url : url.slice(0, end)
}

function scrubRequest(request: Plain): void {
  delete request.data
  delete request.cookies
  delete request.query_string
  if (typeof request.url === 'string') {
    request.url = withoutQuery(request.url)
  }
  if (isPlain(request.headers)) {
    for (const name of Object.keys(request.headers)) {
      if (isSensitiveKey(name)) {
        delete request.headers[name]
      }
    }
  }
}

/**
 * Makes an error-tracker event safe to leave the process: redacts it by key with the kit's
 * redaction, runs every string through `scrubText`, removes request bodies, cookies, query strings,
 * sensitive headers, the user, source lines and local variables, and keeps stack frames and
 * messages. Returns a new event, or null (drop it) if the event cannot be scrubbed.
 */
export function scrubEvent<E extends object>(event: E): E | null {
  try {
    const { sdkProcessingMetadata, ...rest } = event as E & { sdkProcessingMetadata?: unknown }
    // The metadata is internal to the SDK and removed from the envelope before it is serialised.
    const clean = scrubTree(redactFields(rest as Plain)) as Plain
    delete clean.user
    if (isPlain(clean.request)) {
      scrubRequest(clean.request)
    }
    if (sdkProcessingMetadata !== undefined) {
      clean.sdkProcessingMetadata = sdkProcessingMetadata
    }
    return clean as E
  } catch {
    return null
  }
}
