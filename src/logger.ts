import pino from 'pino'
import { redactFields } from './redact'

/** Where log lines go: anything with a `write` that takes one newline-terminated JSON line. */
export interface LogDestination {
  write(line: string): void
}

/** The lowest severity a logger writes, or `silent` to write nothing. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

/** Structured logger that redacts secrets, tokens, recordings and message bodies. */
export interface Logger {
  /** Logs detail useful only while debugging. */
  debug(message: string, fields?: Record<string, unknown>): void
  /** Logs a normal event. */
  info(message: string, fields?: Record<string, unknown>): void
  /** Logs something unexpected that the service recovered from. */
  warn(message: string, fields?: Record<string, unknown>): void
  /** Logs a failure. */
  error(message: string, fields?: Record<string, unknown>): void
  /** Returns a logger that adds `fields` to every entry. */
  child(fields: Record<string, unknown>): Logger
}

/** Options for createLogger. */
export interface LoggerOptions {
  /** Service name written on every line. */
  service: string
  /** Lowest severity to write; defaults to `info`. */
  level?: LogLevel
  /** Where lines are written; defaults to stdout. */
  destination?: LogDestination
}

// Keys pino writes itself; a caller field with one of these names is renamed, not allowed to
// overwrite it.
const RESERVED_KEYS = ['level', 'time', 'msg', 'service'] as const

function protectReserved(fields: Record<string, unknown>): Record<string, unknown> {
  for (const key of RESERVED_KEYS) {
    if (key in fields) {
      fields[`field_${key}`] = fields[key]
      delete fields[key]
    }
  }
  return fields
}

function prepare(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  return protectReserved(redactFields(fields ?? {}))
}

function wrap(base: pino.Logger): Logger {
  return {
    debug: (message, fields) => base.debug(prepare(fields), message),
    info: (message, fields) => base.info(prepare(fields), message),
    warn: (message, fields) => base.warn(prepare(fields), message),
    error: (message, fields) => base.error(prepare(fields), message),
    child: (fields) => wrap(base.child(prepare(fields))),
  }
}

/** Creates a JSON-lines logger for one service that redacts sensitive fields at any depth. */
export function createLogger(options: LoggerOptions): Logger {
  const config: pino.LoggerOptions = {
    level: options.level ?? 'info',
    base: { service: options.service },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Errors are flattened by our own redaction; stop pino re-serialising the `err` key.
    serializers: { err: (value: unknown) => value },
  }
  return wrap(options.destination ? pino(config, options.destination) : pino(config))
}
