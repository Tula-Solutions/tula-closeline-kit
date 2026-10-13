import {
  type BunOptions,
  defaultStackParser,
  linkedErrorsIntegration,
  makeFetchTransport,
  NodeClient,
  Scope,
} from '@sentry/bun'
import { isAppError } from '../errors'
import { scrubText } from '../scrub'
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
const CLOSE_MS = 250
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
  /** Shuts the client down and removes its process listeners. */
  close(): Promise<void>
}

/** Cuts a value to a length and masks secrets in it. */
function text(value: unknown, max: number): string {
  return scrubText(String(value)).slice(0, max)
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
        tags[key] = text(value, MAX_TAG_VALUE)
      }
    }
  }
  Object.assign(tags, base)
  if (context.organizationId !== undefined) {
    tags.organization_id = text(context.organizationId, MAX_TAG_VALUE)
  }
  if (context.requestId !== undefined) {
    tags.request_id = text(context.requestId, MAX_TAG_VALUE)
  }
  if (context.method !== undefined) {
    tags.http_method = text(context.method, 16)
  }
  if (typeof context.status === 'number' && Number.isFinite(context.status)) {
    tags.http_status = String(Math.trunc(context.status))
  }
  if (isAppError(error)) {
    tags.error_code = error.code
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
 * Creates the Sentry adapter. It builds its own client and registers nothing globally: no process
 * handlers, no console or HTTP instrumentation, no breadcrumbs. Of the SDK's default integrations
 * only `LinkedErrors` (it follows an error's `cause` chain) is kept; the rest are off because each
 * either captures request bodies, console output, HTTP breadcrumbs with URLs and query strings,
 * local variables, source lines or host details, or installs process-wide handlers that a service
 * must wire through this port instead. Every event passes `scrubEvent` before it is sent.
 */
export function createSentryReporter(options: SentryReporterOptions): SentryReporter {
  const client = new NodeClient({
    // An invalid DSN would make the SDK print it to the console; leave it out and say so below.
    dsn: isSentryDsn(options.dsn) ? options.dsn : undefined,
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
    beforeSend: (event) => scrubEvent(event),
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
    warn('error reporting is off: SENTRY_DSN is not a valid Sentry DSN')
  }

  const reporter: SentryReporter = {
    client,
    integrations,
    capture(error, context) {
      try {
        if (!shouldReportError(error)) {
          return
        }
        const scope = new Scope()
        try {
          const given = context ?? {}
          scope.setTags(buildTags(base, given, error))
          scope.setContext('closeline', buildRequestContext(given))
        } catch {
          // The context could not be read; the error is still worth sending.
          warn('error reporter could not read the error context')
          scope.setTags(base)
        }
        // `originalException` is what LinkedErrors reads to follow the `cause` chain; a thrown value
        // that is not an Error has no stack of its own, so one is made here to locate the call.
        client.captureException(
          error,
          {
            originalException: error,
            ...(error instanceof Error ? {} : { syntheticException: new Error('not an Error') }),
          },
          scope
        )
      } catch {
        warn('error reporter failed to capture an error')
      }
    },
    flush(timeoutMs) {
      try {
        const ms = boundedTimeout(timeoutMs)
        return withDeadline(Promise.resolve(client.flush(ms)), ms)
      } catch {
        return Promise.resolve(false)
      }
    },
    async close() {
      await withDeadline(Promise.resolve(client.close(1)), CLOSE_MS)
    },
  }
  return reporter
}
