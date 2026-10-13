import { isSentryDsn } from './env'
import { createNoopErrorReporter } from './noop'
import type { ErrorReporter, ErrorReporterOptions } from './port'
import { createSentryReporter } from './sentry'

/**
 * Picks the error reporter for a service: the Sentry adapter when a DSN is given, otherwise the
 * no-op one, so `local` and tests run without Sentry. The DSN is per Region (ADR 0001): give each
 * deployment the DSN of a Sentry project in its own data region; the kit sends to whatever it is given.
 */
export function createErrorReporter(options: ErrorReporterOptions): ErrorReporter {
  const dsn = options.dsn?.trim()
  if (dsn === undefined || dsn === '') {
    const message = 'error reporting is off: no SENTRY_DSN'
    if (options.environment === 'local') {
      options.logger.info(message)
    } else {
      options.logger.warn(message)
    }
    return createNoopErrorReporter()
  }
  if (!isSentryDsn(dsn)) {
    // The DSN is not logged: it holds the project's public key.
    options.logger.warn('error reporting is off: SENTRY_DSN is not a valid Sentry DSN')
    return createNoopErrorReporter()
  }
  return createSentryReporter({ ...options, dsn })
}
