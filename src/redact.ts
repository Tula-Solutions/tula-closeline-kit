const REDACTED = '[redacted]'
const CIRCULAR = '[circular]'
const TRUNCATED = '[truncated]'
const UNSERIALIZABLE = '[unserializable]'

const MAX_DEPTH = 32
const MAX_ARRAY_ITEMS = 100
const MAX_OBJECT_KEYS = 200
// Objects (including arrays, Maps, Sets and Errors) visited by one call, so shared references
// cannot multiply the work. Primitives are free: the caps above already bound them per object.
const MAX_NODES = 5_000

// Compared after lowercasing and dropping `_` and `-`, so `apiKey`, `API_KEY` and `api-key` match.
// A key is sensitive when it, or it without one trailing `s`, is a listed word or ends with a
// suffix (`clientSecret`, `set-cookie`, `x-api-key`, `cookies`, `secretKey`). `recording`,
// `transcript` and `body` only match as a whole key.
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
]

// Keys pino writes itself; a caller field with one of these names is renamed, not allowed to
// overwrite it.
const RESERVED_KEYS = ['level', 'time', 'msg', 'service'] as const

interface State {
  nodes: number
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, '')
  const singular = normalized.endsWith('s') ? normalized.slice(0, -1) : normalized
  return [normalized, singular].some(
    (name) =>
      SENSITIVE_WORDS.has(name) || SENSITIVE_SUFFIXES.some((suffix) => name.endsWith(suffix))
  )
}

/** Runs a read that may throw (a getter, a Proxy trap) and returns a marker if it does. */
function attempt<T>(read: () => T): T | typeof UNSERIALIZABLE {
  try {
    return read()
  } catch {
    return UNSERIALIZABLE
  }
}

/** Sets an own data property, so a parsed `__proto__` key stays data instead of changing the prototype. */
function put(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

function summarizeBinary(value: object): { type: string; byteLength: number } {
  const buffer = value as { byteLength: number }
  return { type: Object.prototype.toString.call(value).slice(8, -1), byteLength: buffer.byteLength }
}

function isBinary(value: object): boolean {
  return (
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)
  )
}

function redactError(
  error: Error,
  state: State,
  ancestors: Set<object>,
  depth: number
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  put(
    out,
    'name',
    attempt(() => error.name)
  )
  put(
    out,
    'message',
    attempt(() => error.message)
  )
  put(
    out,
    'stack',
    attempt(() => error.stack)
  )
  const code = attempt(() => (error as { code?: unknown }).code)
  if (code !== undefined) {
    put(out, 'code', redactValue(code, state, ancestors, depth + 1))
  }
  const cause = attempt(() => error.cause)
  if (cause !== undefined) {
    put(out, 'cause', redactValue(cause, state, ancestors, depth + 1))
  }
  return out
}

function redactList(
  items: Iterable<unknown>,
  size: number,
  state: State,
  ancestors: Set<object>,
  depth: number
): unknown[] {
  const out: unknown[] = []
  for (const item of items) {
    if (out.length >= MAX_ARRAY_ITEMS) {
      break
    }
    out.push(redactValue(item, state, ancestors, depth + 1))
  }
  if (size > MAX_ARRAY_ITEMS) {
    out.push(`[+${size - MAX_ARRAY_ITEMS} more]`)
  }
  return out
}

function redactMap(
  map: Map<unknown, unknown>,
  state: State,
  ancestors: Set<object>,
  depth: number
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  let index = 0
  for (const [key, value] of map) {
    if (index >= MAX_OBJECT_KEYS) {
      break
    }
    const name = typeof key === 'string' ? key : `[key ${index}]`
    put(
      out,
      name,
      isSensitiveKey(name) ? REDACTED : redactValue(value, state, ancestors, depth + 1)
    )
    index++
  }
  if (map.size > MAX_OBJECT_KEYS) {
    put(out, '[more]', `[+${map.size - MAX_OBJECT_KEYS} more]`)
  }
  return out
}

function redactRecord(
  record: object,
  state: State,
  ancestors: Set<object>,
  depth: number
): Record<string, unknown> {
  const keys = Object.keys(record)
  const kept = keys.slice(0, MAX_OBJECT_KEYS)
  const out: Record<string, unknown> = {}
  const nested: Array<[string, object]> = []
  // Pass one writes every primitive (they cost no budget) and keeps each key's position; pass two
  // walks the objects, so a spent budget never costs the fields needed to trace a log line.
  for (const key of kept) {
    if (isSensitiveKey(key)) {
      put(out, key, REDACTED)
      continue
    }
    const value = attempt(() => (record as Record<string, unknown>)[key])
    if (typeof value === 'object' && value !== null) {
      put(out, key, undefined)
      nested.push([key, value])
    } else {
      put(out, key, value)
    }
  }
  for (const [key, value] of nested) {
    put(out, key, redactValue(value, state, ancestors, depth + 1))
  }
  if (keys.length > MAX_OBJECT_KEYS) {
    put(out, '[more]', `[+${keys.length - MAX_OBJECT_KEYS} more]`)
  }
  return out
}

function redactObject(value: object, state: State, ancestors: Set<object>, depth: number): unknown {
  if (value instanceof Date) {
    return value
  }
  if (isBinary(value)) {
    return summarizeBinary(value)
  }
  if (value instanceof Error) {
    return redactError(value, state, ancestors, depth)
  }
  if (Array.isArray(value)) {
    return redactList(value, value.length, state, ancestors, depth)
  }
  if (value instanceof Map) {
    return redactMap(value, state, ancestors, depth)
  }
  if (value instanceof Set) {
    return redactList(value, value.size, state, ancestors, depth)
  }
  const toJSON = (value as { toJSON?: unknown }).toJSON
  if (typeof toJSON === 'function') {
    return redactValue(toJSON.call(value), state, ancestors, depth + 1)
  }
  return redactRecord(value, state, ancestors, depth)
}

function redactValue(value: unknown, state: State, ancestors: Set<object>, depth: number): unknown {
  if (typeof value !== 'object' || value === null) {
    return value
  }
  if (ancestors.has(value)) {
    return CIRCULAR
  }
  state.nodes++
  if (state.nodes > MAX_NODES || depth >= MAX_DEPTH) {
    return TRUNCATED
  }
  ancestors.add(value)
  try {
    return redactObject(value, state, ancestors, depth)
  } catch {
    return UNSERIALIZABLE
  } finally {
    ancestors.delete(value)
  }
}

/** Copies log fields with every sensitive key replaced by `[redacted]` at any depth; never throws. */
export function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  try {
    return redactRecord(fields, { nodes: 0 }, new Set<object>([fields]), 0)
  } catch {
    return { fields: UNSERIALIZABLE }
  }
}

/** Redacts fields and renames keys the logger writes itself; the one preparation step both loggers share. */
export function prepareFields(
  fields: Record<string, unknown> | undefined
): Record<string, unknown> {
  const prepared = redactFields(fields ?? {})
  for (const key of RESERVED_KEYS) {
    if (key in prepared) {
      put(prepared, `field_${key}`, prepared[key])
      delete prepared[key]
    }
  }
  return prepared
}
