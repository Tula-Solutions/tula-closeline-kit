import pino from 'pino'
import { prepareFields } from './redact'

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

type EmitLevel = 'debug' | 'info' | 'warn' | 'error'

function wrap(base: pino.Logger): Logger {
  // Check the level first: a disabled call must not pay for walking its fields.
  const emit = (level: EmitLevel) => (message: string, fields?: Record<string, unknown>) => {
    if (base.isLevelEnabled(level)) {
      base[level](prepareFields(fields), message)
    }
  }
  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    child: (fields) => wrap(base.child(prepareFields(fields))),
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
