/** A source of the current time, so code under test never reads the real clock. */
export interface Clock {
  /** Returns the current time as a new Date each call. */
  now(): Date
}

/** A clock that can be moved forward by hand. */
export interface FixedClock extends Clock {
  /** Moves the clock forward by a duration such as `500ms`, `30s`, `10m`, `2h` or `1d`. */
  advance(duration: string): void
}

const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const
const DURATION_PATTERN = /^(\d+)(ms|s|m|h|d)$/

function isUnit(unit: string | undefined): unit is keyof typeof UNIT_MS {
  return unit !== undefined && unit in UNIT_MS
}

/** The real clock, for production wiring. */
export const systemClock: Clock = {
  now: () => new Date(),
}

/** Creates a clock frozen at `start` that only moves when `advance` is called. */
export function createFixedClock(start: Date | string): FixedClock {
  let current = new Date(start).getTime()
  if (Number.isNaN(current)) {
    throw new TypeError(`createFixedClock needs a valid start time, got ${String(start)}`)
  }
  return {
    now: () => new Date(current),
    advance(duration) {
      const match = DURATION_PATTERN.exec(duration)
      const amount = match?.[1]
      const unit = match?.[2]
      if (amount === undefined || !isUnit(unit)) {
        throw new TypeError(
          `Invalid duration ${JSON.stringify(duration)}: use a whole number and ms, s, m, h or d`
        )
      }
      current += Number(amount) * UNIT_MS[unit]
    },
  }
}
