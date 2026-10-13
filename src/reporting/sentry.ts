import {
  type BunOptions,
  defaultStackParser,
  type Event,
  type EventHint,
  linkedErrorsIntegration,
  makeFetchTransport,
  NodeClient,
  Scope,
} from '@sentry/bun'
import { isAppError } from '../errors'
import { cutText, scrubText } from '../scrub'
import { isSensitiveKey } from '../sensitive'
import { isSentryDsn } from './env'
import {
  type ErrorContext,
  type ErrorReporter,
  type ErrorReporterOptions,
  shouldReportError,
} from './port'
import { scrubEvent } from './scrub-event'

const MAX_TAGS = 20
const MAX_TAG_VALUE = 200
const MAX_FLUSH_MS = 60_000
const DATA_COLLECTION_OFF: NonNullable<BunOptions['dataCollection']> = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
  frameContextLines: 0,
}
const TAG_KEY = /^[A-Za-z0-9_.:-]{1,32}$/
// The ids the adapter sets from typed context are sent as they are, never through `scrubText`: an
// operator filters on them, so a pattern that guesses wrong must not be able to change one. A value
// outside this charset and length is not an id and is replaced by a fixed marker.
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,64}$/
const INVALID_IDENTIFIER = '[invalid]'
const MASK = '[redacted]'

// What `capture` hands the SDK is bounded, so the work it does before returning is too, whatever it
// is given. The SDK follows at most six errors (the one captured and five linked), so building
// more would be thrown away after being parsed.
const MAX_MESSAGE = 8_192
const MAX_NAME = 200
const MAX_LINKED_ERRORS = 6
const MAX_GROUP_CHILDREN = 5
// An error whose message is longer than this is not read back through `error.stack`, which repeats
// the message: building that string takes time in proportion to it. It is sent without frames.
const MAX_STACK_SOURCE_MESSAGE = 1_048_576
// The most a stack may hold besides its message: the frames that are read, and a name in front.
const MAX_STACK_TAIL = 16_384
const MAX_STACK_HEADER = 1_024
const MAX_EXCEPTIONS = 12
const MAX_FRAMES = 200
const MAX_STRING_VALUE = 512

// The event fields the adapter lets through as they are; anything else on an event came from a scope
// that belongs to someone else (see `confine`). `exception` is not here: it is rebuilt field by
// field (`ownException`). `debug_meta` is not, because the adapter sets none.
const KEPT_EVENT_KEYS: ReadonlySet<string> = new Set([
  'event_id',
  'timestamp',
  'platform',
  'release',
  'environment',
  'sdk',
])

/** Options for createSentryReporter: the common ones plus the DSN, which is required. */
export interface SentryReporterOptions extends ErrorReporterOptions {
  /** The Sentry DSN of this Region's project. */
  dsn: string
  /** Replaces the network transport; tests use it to see exactly what would be sent. */
  transport?: NonNullable<BunOptions['transport']>
}

/** The Sentry adapter, with the handles tests need. Services see it only as an ErrorReporter. */
export interface SentryReporter extends ErrorReporter {
  /** The underlying client, not registered globally. */
  readonly client: NodeClient
  /** Names of the SDK integrations that are on. */
  readonly integrations: readonly string[]
}

/** Cuts a value to a length and masks secrets in it. */
function text(value: unknown, max: number): string {
  return scrubText(String(value)).slice(0, max)
}

/** An id as it was given when it has the shape of one, otherwise a fixed marker. */
function identifier(value: unknown): string {
  return typeof value === 'string' && IDENTIFIER.test(value) ? value : INVALID_IDENTIFIER
}

function pathWithoutQuery(path: string): string {
  const end = path.search(/[?#]/)
  return end === -1 ? path : path.slice(0, end)
}

/** The standard tags plus those the context supplies; the standard ones cannot be overridden. */
function buildTags(
  base: Record<string, string>,
  context: ErrorContext,
  error: unknown
): Record<string, string> {
  const tags: Record<string, string> = {}
  if (context.tags !== undefined) {
    for (const [key, value] of Object.entries(context.tags).slice(0, MAX_TAGS)) {
      if (TAG_KEY.test(key)) {
        // The tags skip `scrubEvent` (see `beforeSend`), so a sensitive key is dealt with here.
        tags[key] = isSensitiveKey(key) ? MASK : text(value, MAX_TAG_VALUE)
      }
    }
  }
  Object.assign(tags, base)
  if (context.organizationId !== undefined) {
    tags.organization_id = identifier(context.organizationId)
  }
  if (context.requestId !== undefined) {
    tags.request_id = identifier(context.requestId)
  }
  if (context.method !== undefined) {
    tags.http_method = text(context.method, 16)
  }
  if (typeof context.status === 'number' && Number.isFinite(context.status)) {
    tags.http_status = String(Math.trunc(context.status))
  }
  if (isAppError(error)) {
    tags.error_code = text(error.code, MAX_TAG_VALUE)
  }
  return tags
}

function buildRequestContext(context: ErrorContext): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (context.method !== undefined) {
    out.method = text(context.method, 16)
  }
  if (context.path !== undefined) {
    out.path = text(pathWithoutQuery(String(context.path)), 512)
  }
  if (typeof context.status === 'number' && Number.isFinite(context.status)) {
    out.status = Math.trunc(context.status)
  }
  return out
}

/** What `capture` decided to send, carried to `beforeSend` so it can tell it from anything added to the event. */
interface OwnData {
  tags: Record<string, string>
  closeline: Record<string, unknown>
}

function read<T>(get: () => T): T | undefined {
  try {
    return get()
  } catch {
    return undefined
  }
}

function isErrorLike(value: unknown): value is Error {
  return (
    value instanceof Error ||
    (typeof value === 'object' &&
      value !== null &&
      Object.prototype.toString.call(value) === '[object Error]')
  )
}

/**
 * Where the message ends inside a stack, which starts with the error's name and its message; -1 when
 * the stack does not hold the message there (the message was changed after the error was made).
 */
function messageEnd(stack: string, message: string): number {
  if (message === '') {
    const newline = stack.indexOf('\n')
    return newline === -1 ? stack.length : newline
  }
  let from = 0
  for (let attempt = 0; attempt < 3; attempt++) {
    const at = stack.indexOf(message, from)
    if (at === -1 || at > MAX_STACK_HEADER) {
      return -1
    }
    const end = at + message.length
    if (end === stack.length || stack[end] === '\n') {
      return end
    }
    from = at + 1
  }
  return -1
}

/**
 * The frames of a stack: its `at` lines that come after the message's own lines, so a line of the
 * message that imitates a frame is never one. Only the first 16 KiB after the message is read, and a
 * stack that does not hold the message where it should is sent without frames.
 */
function framesOf(stack: unknown, message: string): string {
  if (typeof stack !== 'string') {
    return ''
  }
  const limit = message.length + MAX_STACK_HEADER + MAX_STACK_TAIL
  const head = stack.length > limit ? stack.slice(0, limit) : stack
  const end = messageEnd(head, message)
  if (end === -1) {
    return ''
  }
  const lines = head.slice(end).split('\n')
  if (head !== stack) {
    lines.pop()
  }
  return lines.filter((line) => /^\s+at /.test(line)).join('\n')
}

function define(target: Error, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, configurable: true, writable: true })
}

/**
 * A fresh Error with the same type, a cut message, the frames and the causes the SDK would follow,
 * and nothing else: no own properties, no `details`, no cut-off message tail. `budget` is the number
 * of errors still allowed, shared by the whole tree.
 */
function boundedCopy(source: Error, budget: { left: number }): Error {
  budget.left--
  const rawMessage = read(() => source.message)
  const rawName = read(() => source.name)
  const message =
    typeof rawMessage === 'string'
      ? cutText(rawMessage, MAX_MESSAGE)
      : 'the error message could not be read'
  const name =
    typeof rawName === 'string' && rawName !== ''
      ? cutText(rawName, MAX_NAME).replace(/[\r\n]+/g, ' ')
      : 'Error'
  const copy = new Error(message)
  define(copy, 'name', name)
  // The SDK skips the first line of a stack, so the header must be exactly one line.
  const header = `${name}: ${message.split('\n', 1)[0]}`
  const frames =
    typeof rawMessage === 'string' && rawMessage.length <= MAX_STACK_SOURCE_MESSAGE
      ? framesOf(
          read(() => source.stack),
          rawMessage
        )
      : ''
  define(copy, 'stack', frames === '' ? header : `${header}\n${frames}`)
  if (budget.left > 0) {
    const cause = read(() => (source as { cause?: unknown }).cause)
    if (isErrorLike(cause)) {
      define(copy, 'cause', boundedCopy(cause, budget))
    }
  }
  if (budget.left > 0) {
    const errors = read(() => (source as { errors?: unknown }).errors)
    if (Array.isArray(errors)) {
      const children: Error[] = []
      const count = Math.min(errors.length, MAX_GROUP_CHILDREN)
      for (let i = 0; i < count && budget.left > 0; i++) {
        const child = read(() => errors[i])
        if (isErrorLike(child)) {
          children.push(boundedCopy(child, budget))
        }
      }
      define(copy, 'errors', children)
    }
  }
  return copy
}

/**
 * What the SDK is given in place of whatever was thrown. An Error is copied with bounds. Anything
 * else becomes a new Error that names only the value's type, plus the text of a string after
 * `scrubText`: the SDK would otherwise copy the whole value into the event.
 */
function toReportable(value: unknown): Error {
  try {
    if (isErrorLike(value)) {
      return boundedCopy(value, { left: MAX_LINKED_ERRORS })
    }
    const type = value === null ? 'null' : typeof value
    if (typeof value === 'string') {
      return new Error(
        `non-Error value thrown (string): ${cutText(scrubText(value), MAX_STRING_VALUE)}`
      )
    }
    return new Error(`non-Error value thrown (${type})`)
  } catch {
    return new Error('an error that could not be read was thrown')
  }
}

type Plain = Record<string, unknown>

function isPlain(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ownFrame(frame: Plain): Plain {
  const out: Plain = {}
  if (typeof frame.filename === 'string') {
    out.filename = frame.filename
  }
  if (typeof frame.function === 'string') {
    out.function = frame.function
  }
  if (typeof frame.lineno === 'number' && Number.isFinite(frame.lineno)) {
    out.lineno = frame.lineno
  }
  if (typeof frame.colno === 'number' && Number.isFinite(frame.colno)) {
    out.colno = frame.colno
  }
  return out
}

function ownMechanism(mechanism: Plain): Plain {
  const out: Plain = {}
  if (typeof mechanism.type === 'string') {
    out.type = mechanism.type.slice(0, 64)
  }
  if (typeof mechanism.handled === 'boolean') {
    out.handled = mechanism.handled
  }
  // How a cause chain is linked, so the tracker can show it as one.
  for (const key of ['exception_id', 'parent_id']) {
    const value = mechanism[key]
    if (typeof value === 'number' && Number.isSafeInteger(value)) {
      out[key] = value
    }
  }
  if (typeof mechanism.source === 'string' && /^[a-z_]{1,32}$/.test(mechanism.source)) {
    out.source = mechanism.source
  }
  if (typeof mechanism.is_exception_group === 'boolean') {
    out.is_exception_group = mechanism.is_exception_group
  }
  return out
}

/**
 * The exception entries of an event, rebuilt from known fields only: type, value, the frames (file,
 * function, line, column) and the mechanism (type, handled, and the links between a cause chain's
 * entries). Whatever else the SDK or an event processor put in the subtree is not carried over.
 */
function ownException(exception: unknown): { values: Plain[] } | undefined {
  if (!isPlain(exception) || !Array.isArray(exception.values)) {
    return undefined
  }
  const values: Plain[] = []
  for (const entry of exception.values.slice(0, MAX_EXCEPTIONS)) {
    if (!isPlain(entry)) {
      continue
    }
    const out: Plain = {}
    if (typeof entry.type === 'string') {
      out.type = entry.type
    }
    if (typeof entry.value === 'string') {
      out.value = entry.value
    }
    const frames = isPlain(entry.stacktrace) ? entry.stacktrace.frames : undefined
    if (Array.isArray(frames)) {
      out.stacktrace = { frames: frames.slice(-MAX_FRAMES).filter(isPlain).map(ownFrame) }
    }
    if (isPlain(entry.mechanism)) {
      out.mechanism = ownMechanism(entry.mechanism)
    }
    values.push(out)
  }
  return { values }
}

/**
 * Keeps only what this adapter put on the event. The SDK merges the process-wide global and
 * isolation scopes into every event, and an application or another library can set tags, extra
 * data, a user, contexts or attachments there; none of it may travel with a Closeline error.
 */
function confine(event: Event, hint: EventHint): Event {
  const own = hint.data as OwnData | undefined
  const kept: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(event)) {
    if (KEPT_EVENT_KEYS.has(key)) {
      kept[key] = value
    }
  }
  kept.level = 'error'
  kept.tags = own?.tags ?? {}
  const exception = ownException(event.exception)
  if (exception !== undefined) {
    kept.exception = exception
  }
  const runtime = (event.contexts as Record<string, unknown> | undefined)?.runtime
  kept.contexts = {
    ...(runtime === undefined ? {} : { runtime }),
    ...(own === undefined ? {} : { closeline: own.closeline }),
  }
  // Attachments skip `beforeSend` in the SDK; none is ever sent.
  hint.attachments = []
  return kept as Event
}

/** Resolves false when `work` has not finished after `ms`; `work` failing also resolves false. */
function withDeadline(work: Promise<boolean>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    work.then(
      (done) => {
        clearTimeout(timer)
        resolve(done)
      },
      () => {
        clearTimeout(timer)
        resolve(false)
      }
    )
  })
}

function boundedTimeout(timeoutMs: number): number {
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, MAX_FLUSH_MS) : 1
}

/**
 * Creates the Sentry adapter. It builds its own client and installs no process handlers, console or
 * HTTP instrumentation or breadcrumbs. Of the SDK's default integrations only `LinkedErrors` (it
 * follows an error's `cause` chain) is kept; the rest are off because each either captures request
 * bodies, console output, HTTP breadcrumbs with URLs and query strings, local variables, source
 * lines or host details, or installs process-wide handlers that a service must wire through this
 * port instead. Every error is copied into a bounded Error before it reaches the SDK, every event
 * is cut down to the fields this adapter set (`confine`) and passes `scrubEvent`, and no
 * attachment is ever sent.
 *
 * The SDK itself adds two `beforeExit` listeners per client and sets its async-context strategy
 * once per process; `close` removes the listeners. A process creates one reporter.
 */
export function createSentryReporter(options: SentryReporterOptions): SentryReporter {
  const client = new NodeClient({
    // An invalid DSN would make the SDK print it to the console; leave it out and say so below.
    dsn: isSentryDsn(options.dsn, options.environment) ? options.dsn : undefined,
    release: options.release,
    environment: options.environment,
    stackParser: defaultStackParser,
    transport: options.transport ?? makeFetchTransport,
    runtime: { name: 'bun', version: typeof Bun === 'undefined' ? 'unknown' : Bun.version },
    includeServerName: false,
    integrations: [linkedErrorsIntegration()],
    // Sentry 11 replaced `sendDefaultPii` with `dataCollection`; every category is switched off.
    dataCollection: DATA_COLLECTION_OFF,
    maxBreadcrumbs: 0,
    sendClientReports: false,
    traceLifecycle: 'static',
    enableRuntimeChannelInjection: false,
    beforeSend: (event, hint) => {
      try {
        // The tags are the adapter's own and were checked or scrubbed one by one when they were
        // built; they skip `scrubEvent`, which would run its patterns over an id again.
        const { tags, ...rest } = confine(event, hint)
        const clean = scrubEvent(rest)
        return clean === null ? null : ({ ...clean, tags } as typeof event)
      } catch {
        return null
      }
    },
  })
  client.init()

  const integrations = client.getOptions().integrations.map((integration) => integration.name)
  const base = {
    service: text(options.service, MAX_TAG_VALUE),
    environment: options.environment,
    region: options.region,
  }
  const warn = (message: string): void => {
    try {
      options.logger.warn(message)
    } catch {
      // A broken logger must not turn into a broken request.
    }
  }

  if (client.getDsn() === undefined) {
    // The client is disabled and sends nothing; createErrorReporter swaps in the no-op reporter.
    warn(
      'error reporting is off: SENTRY_DSN is not a valid Sentry DSN (https is required outside local)'
    )
  }

  let closed = false
  let closing: Promise<boolean> | undefined

  const reporter: SentryReporter = {
    client,
    integrations,
    capture(error, context) {
      try {
        if (closed || !shouldReportError(error)) {
          return
        }
        const scope = new Scope()
        let tags: Record<string, string> = base
        let closeline: Record<string, unknown> = {}
        try {
          const given = context ?? {}
          tags = buildTags(base, given, error)
          closeline = buildRequestContext(given)
        } catch {
          // The context could not be read; the error is still worth sending.
          warn('error reporter could not read the error context')
        }
        scope.setTags(tags)
        scope.setContext('closeline', closeline)
        const data: OwnData = { tags, closeline }
        const reportable = toReportable(error)
        // `originalException` is what LinkedErrors reads to follow the `cause` chain.
        client.captureException(reportable, { originalException: reportable, data }, scope)
      } catch {
        warn('error reporter failed to capture an error')
      }
    },
    flush(timeoutMs) {
      try {
        if (closed) {
          return Promise.resolve(false)
        }
        const ms = boundedTimeout(timeoutMs)
        return withDeadline(Promise.resolve(client.flush(ms)), ms)
      } catch {
        return Promise.resolve(false)
      }
    },
    close(timeoutMs) {
      closed = true
      if (closing === undefined) {
        const ms = boundedTimeout(timeoutMs)
        try {
          closing = withDeadline(Promise.resolve(client.close(ms)), ms)
        } catch {
          closing = Promise.resolve(false)
        }
      }
      return closing
    },
  }
  return reporter
}
