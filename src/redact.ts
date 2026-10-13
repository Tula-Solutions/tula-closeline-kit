import { cutText, dropHighSurrogate, scrubText } from './scrub'
import { isSensitiveKey, mayBeTokenCount } from './sensitive'

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
// Values written below the top level by one call, so many small objects cannot add up to a huge
// entry. Top-level fields are exempt: they are what identifies the entry.
const MAX_VALUES = 20_000

// What each top-level field is guaranteed once the shared budgets above are spent, so a small
// context object (a tenant, a request id) survives after a large earlier field. The allowance is
// per field and independent of key order, but it only covers a field that fits in it: a field
// larger than its allowance is cut. Worst case per call: 5,000 + 200 x 50 objects and 20,000 +
// 200 x 200 nested values (200 is the most top-level keys walked; error fields count as values).
// Errors whose text is scrubbed and copied by one call; each costs a scrub of up to 16 KiB.
const MAX_ERRORS = 200
const FIELD_NODE_ALLOWANCE = 50
const FIELD_VALUE_ALLOWANCE = 200

// Text budget, counted in UTF-16 code units (`string.length`) over every string value, object key,
// Map key and error name, message, stack and code written by one call. One entry writes at most
// MAX_ENTRY_CHARS from the shared pool plus FIELD_CHAR_ALLOWANCE for each of its (at most 200)
// top-level keys and again for each top-level object field's contents, plus the fixed markers
// (at most 24 units per object walked, 15,000 objects). One string is cut to MAX_STRING_CHARS and a
// key to MAX_KEY_CHARS, so one string cannot spend the entry's pool. Serialised with
// `JSON.stringify` an entry is at most 6 bytes per unit (a control character escapes to six): under
// 12 MB in the worst case (measured 7.9 MB for control characters, 2.1 MB for ASCII text), and
// about 1 byte per unit for ordinary text. Tests assert these.
const MAX_ENTRY_CHARS = 1_048_576
const MAX_STRING_CHARS = 16_384
const MAX_KEY_CHARS = 256
const FIELD_CHAR_ALLOWANCE = 1_024

// Keys pino writes itself; a caller field with one of these names is renamed, not allowed to
// overwrite it.
const RESERVED_KEYS = ['level', 'time', 'msg', 'service'] as const

interface State {
  nodes: number
  values: number
  /** Objects the current top-level field may still visit after the shared budget is spent. */
  nodeReserve: number
  /** Values the current top-level field may still write after the shared budget is spent. */
  valueReserve: number
  /** Errors copied so far; past MAX_ERRORS an Error is the truncation marker, its text unread. */
  errors: number
  /** Text units written so far from the shared pool. */
  chars: number
  /** Text units the current top-level field may still write after the shared pool is spent. */
  charReserve: number
}

/** Gives the next top-level field its own allowance of objects, values and text. */
function startField(state: State): void {
  state.nodeReserve = FIELD_NODE_ALLOWANCE
  state.valueReserve = FIELD_VALUE_ALLOWANCE
  state.charReserve = FIELD_CHAR_ALLOWANCE
}

/** Takes up to `wanted` text units from the shared pool, then the field's allowance; returns how many. */
function grant(state: State, wanted: number): number {
  const shared = Math.min(wanted, Math.max(0, MAX_ENTRY_CHARS - state.chars))
  state.chars += shared
  const extra = Math.min(wanted - shared, state.charReserve)
  state.charReserve -= extra
  return shared + extra
}

/** Text units the shared pool and the current field's allowance can still grant. */
function available(state: State): number {
  return Math.max(0, MAX_ENTRY_CHARS - state.chars) + state.charReserve
}

/** Cuts a string to what the text budget grants; a cut drops a trailing partial word and is marked. */
function clip(state: State, text: string): string {
  const want = Math.min(text.length, MAX_STRING_CHARS)
  if (want === 0) {
    return text
  }
  const got = grant(state, want)
  if (got >= text.length) {
    return text
  }
  return got <= TRUNCATED.length ? TRUNCATED : cutText(text, got - TRUNCATED.length)
}

/** The key as written (cut to MAX_KEY_CHARS), or undefined when the text budget cannot hold it. */
function clipKey(state: State, key: string): string | undefined {
  const shown =
    key.length > MAX_KEY_CHARS
      ? `${dropHighSurrogate(key.slice(0, MAX_KEY_CHARS - TRUNCATED.length))}${TRUNCATED}`
      : key
  return grant(state, shown.length) < shown.length ? undefined : shown
}

/** Counts one value written below the top level; false once the value budget is spent. */
function spend(state: State, depth: number): boolean {
  if (depth === 0) {
    return true
  }
  state.values++
  if (state.values <= MAX_VALUES) {
    return true
  }
  if (state.valueReserve > 0) {
    state.valueReserve--
    return true
  }
  return false
}

/** Counts one object visited; false once both the shared budget and the field's allowance are spent. */
function visit(state: State): boolean {
  state.nodes++
  if (state.nodes <= MAX_NODES) {
    return true
  }
  if (state.nodeReserve > 0) {
    state.nodeReserve--
    return true
  }
  return false
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

/** Reads an error's text field and masks secrets inside it; an unreadable field becomes a marker. */
function scrubbedErrorText(state: State, read: () => unknown): unknown {
  const value = attempt(read)
  if (typeof value !== 'string' || value === UNSERIALIZABLE) {
    return value
  }
  // Cut to what can be written first, so scrubbing costs what is emitted and not what was given;
  // the cut text is then scrubbed whole, so a secret at the cut is masked like one at the end of a
  // message, and the scrubbed text is clipped again because masking can lengthen it.
  const room = Math.min(MAX_STRING_CHARS, available(state))
  if (room <= TRUNCATED.length) {
    return TRUNCATED
  }
  return clip(state, scrubText(cutText(value, room - TRUNCATED.length)))
}

function redactError(
  error: Error,
  state: State,
  ancestors: Set<object>,
  depth: number
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  // Each field is a value written below the top level, so a spent value budget cuts it.
  const field = (name: string, read: () => unknown): void => {
    put(out, name, spend(state, depth + 1) ? read() : TRUNCATED)
  }
  field('name', () => {
    const name = attempt(() => error.name)
    return typeof name === 'string' ? clip(state, name) : name
  })
  field('message', () => scrubbedErrorText(state, () => error.message))
  field('stack', () => scrubbedErrorText(state, () => error.stack))
  const code = attempt(() => (error as { code?: unknown }).code)
  if (code !== undefined) {
    field('code', () => redactValue(code, state, ancestors, depth + 1))
  }
  const cause = attempt(() => error.cause)
  if (cause !== undefined) {
    field('cause', () => redactValue(cause, state, ancestors, depth + 1))
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
    if (!spend(state, depth + 1)) {
      out.push(TRUNCATED)
      return out
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
    if (!spend(state, depth + 1)) {
      put(out, '[more]', TRUNCATED)
      return out
    }
    const shown = clipKey(state, name)
    if (shown === undefined) {
      put(out, '[more]', `[+${map.size - index} more]`)
      return out
    }
    const hidden = isSensitiveKey(name) && !(mayBeTokenCount(name) && typeof value === 'number')
    put(out, shown, hidden ? REDACTED : redactValue(value, state, ancestors, depth + 1))
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
  let spent = false
  let dropped = 0
  // Pass one writes every primitive (they cost no budget) and keeps each key's position; pass two
  // walks the objects, so a spent budget never costs the fields needed to trace a log line.
  for (const [position, key] of kept.entries()) {
    if (depth === 0) {
      startField(state)
    }
    // The top level is `depth` 0 and always written; anything deeper spends the value budget.
    if (!spend(state, depth)) {
      spent = true
      break
    }
    const sensitive = isSensitiveKey(key)
    const name = clipKey(state, key)
    if (name === undefined) {
      dropped = keys.length - position
      break
    }
    // A sensitive key's value is read only when it could be a token count, never otherwise.
    if (sensitive && !mayBeTokenCount(key)) {
      put(out, name, REDACTED)
      continue
    }
    const value = attempt(() => (record as Record<string, unknown>)[key])
    if (sensitive && typeof value !== 'number') {
      put(out, name, REDACTED)
      continue
    }
    if (typeof value === 'object' && value !== null) {
      put(out, name, undefined)
      nested.push([name, value])
    } else {
      put(out, name, typeof value === 'string' ? clip(state, value) : value)
    }
  }
  for (const [key, value] of nested) {
    if (depth === 0) {
      startField(state)
    }
    put(out, key, redactValue(value, state, ancestors, depth + 1))
  }
  if (dropped > 0) {
    put(out, '[more]', `[+${dropped} more]`)
  } else if (spent) {
    put(out, '[more]', TRUNCATED)
  } else if (keys.length > MAX_OBJECT_KEYS) {
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
    if (state.errors >= MAX_ERRORS) {
      return TRUNCATED
    }
    state.errors++
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
  if (typeof value === 'string') {
    return clip(state, value)
  }
  if (typeof value !== 'object' || value === null) {
    return value
  }
  if (ancestors.has(value)) {
    return CIRCULAR
  }
  if (!visit(state) || depth >= MAX_DEPTH) {
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

/**
 * Copies log fields with every sensitive key replaced by `[redacted]` at any depth; never throws.
 * O(fields + objects walked + text emitted): at most 5,000 objects and 20,000 nested values shared
 * by the call, at most 200 Errors scrubbed (the rest are `[truncated]`, text unread), plus 50 objects and 200 values guaranteed to each top-level object field (200 keys
 * at most), and 1 MiB of text (UTF-16 code units, over strings, keys and error text; a string is
 * cut at 16 KiB, a key at 256) plus 1 KiB guaranteed to each top-level field. Serialised, an entry
 * is under 12 MB in the worst case (6 bytes per unit of control characters) and about 2 MB for
 * ordinary text. A string over its cap is cut and marked `[truncated]`; keys past the budget are
 * dropped with a `[+N more]` marker.
 */
export function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  try {
    return redactRecord(
      fields,
      { nodes: 0, values: 0, nodeReserve: 0, valueReserve: 0, chars: 0, charReserve: 0, errors: 0 },
      new Set<object>([fields]),
      0
    )
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
