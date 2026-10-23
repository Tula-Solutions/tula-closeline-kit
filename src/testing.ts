import { createFixedClock, type FixedClock } from './clock'
import type { Logger } from './logger'
import { prepareFields } from './redact'
import { createMemoryErrorReporter, type MemoryErrorReporter } from './reporting/testing'
import { scrubText } from './scrub'

/** One recorded log call, with fields already redacted. */
export interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  fields: Record<string, unknown>
}

/** A Logger that keeps its entries in memory so tests can assert on them. */
export interface MemoryLogger extends Logger {
  /** Every entry logged through this logger or its children, in order, after redaction. */
  readonly entries: LogEntry[]
}

/** The dependencies most services take, as test doubles. */
export interface TestDeps {
  clock: FixedClock
  logger: MemoryLogger
  errorReporter: MemoryErrorReporter
}

function build(entries: LogEntry[], bound: Record<string, unknown>): MemoryLogger {
  const record =
    (level: LogEntry['level']) => (message: string, fields?: Record<string, unknown>) => {
      entries.push({
        level,
        message: scrubText(message),
        fields: { ...bound, ...prepareFields(fields) },
      })
    }
  return {
    entries,
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: (fields) => build(entries, { ...bound, ...prepareFields(fields) }),
  }
}

/** Creates a Logger that records redacted entries in memory instead of writing them. */
export function createMemoryLogger(): MemoryLogger {
  return build([], {})
}

/** Creates test deps: a clock fixed at 2026-01-01T00:00:00.000Z, a memory logger and a memory error reporter. */
export function createTestDeps(overrides: Partial<TestDeps> = {}): TestDeps {
  return {
    clock: overrides.clock ?? createFixedClock('2026-01-01T00:00:00.000Z'),
    logger: overrides.logger ?? createMemoryLogger(),
    errorReporter: overrides.errorReporter ?? createMemoryErrorReporter(),
  }
}

export * from './auth/testing'
export * from './consent/memory'
export * from './queue/memory'
export * from './queue/testing'
export * from './reporting/testing'
export * from './storage/memory'
export * from './transcribe/memory'
export * from './vector/memory'
