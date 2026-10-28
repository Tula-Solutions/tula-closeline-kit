import { timeZoneForNumber } from './zones'

/** The platform's calling window in minutes after local midnight: 08:00 up to, not including, 21:00. */
export const PLATFORM_CALLING_WINDOW = { startMinute: 8 * 60, endMinute: 21 * 60 } as const

/** A narrower window an Organization or Campaign may ask for; it can never widen the platform's. */
export interface CallingWindowNarrowing {
  /** Earliest minute after local midnight; earlier than the platform's start is ignored. */
  startMinute?: number
  /** First minute after local midnight that is closed; later than the platform's end is ignored. */
  endMinute?: number
}

/** What the calling window says about one number at one instant. */
export type CallingWindowCheck =
  | { allowed: true; timeZone: string }
  | { allowed: false; reason: 'timezone_unknown' }
  | { allowed: false; reason: 'outside_hours'; timeZone: string; nextOpening?: Date }

const partsFormat = new Map<string, Intl.DateTimeFormat>()

function localParts(zone: string, at: Date) {
  let format = partsFormat.get(zone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    partsFormat.set(zone, format)
  }
  const p: Record<string, number> = {}
  for (const { type, value } of format.formatToParts(at)) {
    p[type] = Number(value)
  }
  return p as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>
}

function offsetMs(zone: string, at: Date): number {
  const p = localParts(zone, at)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(at.getTime() / 1000) * 1000
}

/** Converts a local wall time in `zone` to an instant (two passes settle across an offset change). */
function localToInstant(zone: string, y: number, m: number, d: number, minute: number): Date {
  const wall = Date.UTC(y, m - 1, d, 0, minute)
  let guess = new Date(wall - offsetMs(zone, new Date(wall)))
  guess = new Date(wall - offsetMs(zone, guess))
  return guess
}

function effectiveWindow(narrow?: CallingWindowNarrowing): { start: number; end: number } | null {
  const start = Math.max(PLATFORM_CALLING_WINDOW.startMinute, narrow?.startMinute ?? 0)
  const end = Math.min(
    PLATFORM_CALLING_WINDOW.endMinute,
    narrow?.endMinute ?? Number.POSITIVE_INFINITY
  )
  // A NaN bound or an inverted window leaves nothing open: fail closed.
  return start < end ? { start, end } : null
}

/**
 * Decides whether `now` is inside the calling window in the number's time zone. An unknown zone
 * refuses (never a default). When closed, `nextOpening` is the next start of the window; it is
 * absent only when the narrowing leaves no open time at all.
 */
export function checkCallingWindow(input: {
  e164: string
  now: Date
  /** A known zone for the Prospect, when a later field supplies one. */
  timeZoneOverride?: string
  narrow?: CallingWindowNarrowing
}): CallingWindowCheck {
  const timeZone = timeZoneForNumber(input.e164, input.timeZoneOverride)
  if (!timeZone) {
    return { allowed: false, reason: 'timezone_unknown' }
  }
  const window = effectiveWindow(input.narrow)
  if (!window) {
    return { allowed: false, reason: 'outside_hours', timeZone }
  }
  const p = localParts(timeZone, input.now)
  const seconds = p.hour * 3600 + p.minute * 60 + p.second
  if (seconds >= window.start * 60 && seconds < window.end * 60) {
    return { allowed: true, timeZone }
  }
  const dayOffset = seconds < window.start * 60 ? 0 : 1
  const nextOpening = localToInstant(timeZone, p.year, p.month, p.day + dayOffset, window.start)
  return { allowed: false, reason: 'outside_hours', timeZone, nextOpening }
}
