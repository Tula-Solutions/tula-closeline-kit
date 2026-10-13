import type { ErrorReporter } from './port'

const NOOP: ErrorReporter = Object.freeze({
  capture: (): void => undefined,
  flush: (): Promise<boolean> => Promise.resolve(true),
})

/** Returns the reporter that sends nothing, used when no DSN is configured; it costs one empty call. */
export function createNoopErrorReporter(): ErrorReporter {
  return NOOP
}
