import { type ErrorContext, type ErrorReporter, shouldReportError } from './port'

/** One error a MemoryErrorReporter recorded, with the context it was reported with. */
export interface CapturedError {
  error: unknown
  context: ErrorContext
}

/** An ErrorReporter that keeps what it is given in memory so tests can assert on it. */
export interface MemoryErrorReporter extends ErrorReporter {
  /** Every error that would have been sent, in order; expected (below 500) AppErrors are left out. */
  readonly captured: CapturedError[]
  /** The timeout of every flush, in order. */
  readonly flushes: number[]
}

function copyContext(context: ErrorContext | undefined): ErrorContext {
  try {
    const copy: ErrorContext = { ...context }
    if (context?.tags !== undefined) {
      copy.tags = { ...context.tags }
    }
    return copy
  } catch {
    return {}
  }
}

/** Creates an ErrorReporter that records reported errors in memory instead of sending them. */
export function createMemoryErrorReporter(): MemoryErrorReporter {
  const captured: CapturedError[] = []
  const flushes: number[] = []
  return {
    captured,
    flushes,
    capture(error, context) {
      if (shouldReportError(error)) {
        captured.push({ error, context: copyContext(context) })
      }
    },
    flush(timeoutMs) {
      flushes.push(timeoutMs)
      return Promise.resolve(true)
    },
  }
}
