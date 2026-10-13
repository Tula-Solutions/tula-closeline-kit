const REDACTED = '[redacted]'
const MAX_DEPTH = 32

// Compared after lowercasing and dropping `_` and `-`, so `apiKey`, `API_KEY` and `api-key` match.
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
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

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''))
}

function serializeError(error: Error, ancestors: Set<object>, depth: number): unknown {
  const out: Record<string, unknown> = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  }
  const code = (error as { code?: unknown }).code
  if (code !== undefined) {
    out.code = redactValue(code, ancestors, depth + 1)
  }
  return out
}

function redactValue(value: unknown, ancestors: Set<object>, depth: number): unknown {
  if (typeof value !== 'object' || value === null) {
    return value
  }
  if (value instanceof Date) {
    return value
  }
  if (ancestors.has(value)) {
    return '[circular]'
  }
  if (depth >= MAX_DEPTH) {
    return '[truncated]'
  }
  ancestors.add(value)
  try {
    if (value instanceof Error) {
      return serializeError(value, ancestors, depth)
    }
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, ancestors, depth + 1))
    }
    const toJSON = (value as { toJSON?: unknown }).toJSON
    if (typeof toJSON === 'function') {
      try {
        return redactValue(toJSON.call(value), ancestors, depth + 1)
      } catch {
        return '[unserializable]'
      }
    }
    return redactRecord(value as Record<string, unknown>, ancestors, depth)
  } finally {
    ancestors.delete(value)
  }
}

function redactRecord(
  record: Record<string, unknown>,
  ancestors: Set<object>,
  depth: number
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(record)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactValue(record[key], ancestors, depth + 1)
  }
  return out
}

/** Copies log fields with every sensitive key replaced by `[redacted]` at any depth, and Errors flattened. */
export function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const ancestors = new Set<object>([fields])
  return redactRecord(fields, ancestors, 0)
}
