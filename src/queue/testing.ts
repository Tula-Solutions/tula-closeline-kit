import { z } from 'zod'
import { createFixedClock, type FixedClock } from '../clock'
import {
  createMessageRegistry,
  defineMessage,
  type EnvelopeOf,
  type MessageRegistry,
} from './envelope'
import type { Sleep } from './sleep'

/** Time that moves only when a test says so: a clock and a {@link Sleep} that share it. */
export interface VirtualTime {
  /** The clock; pass it to the memory queue and store. */
  clock: FixedClock
  /** A sleep that resolves when `advance` has moved the clock past its wake-up time (or its signal aborts). */
  sleep: Sleep
  /** Moves time forward by `ms`, waking sleepers in order and letting their work run in between. */
  advance(ms: number): Promise<void>
  /** Lets pending promise work run without moving time. */
  settle(): Promise<void>
  /** How many sleeps are waiting. */
  pending(): number
}

const SETTLE_ROUNDS = 8

/** Creates {@link VirtualTime} starting at 2026-01-01T00:00:00.000Z. */
export function createVirtualTime(): VirtualTime {
  const clock = createFixedClock('2026-01-01T00:00:00.000Z')
  const sleepers = new Set<{ due: number; wake: () => void }>()
  const settle = async () => {
    for (let round = 0; round < SETTLE_ROUNDS; round++) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  return {
    clock,
    settle,
    pending: () => sleepers.size,
    sleep: (ms, signal) =>
      new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve()
          return
        }
        const sleeper = {
          due: clock.now().getTime() + ms,
          wake: () => {
            sleepers.delete(sleeper)
            signal?.removeEventListener('abort', sleeper.wake)
            resolve()
          },
        }
        sleepers.add(sleeper)
        signal?.addEventListener('abort', sleeper.wake, { once: true })
      }),
    async advance(ms) {
      const target = clock.now().getTime() + ms
      await settle()
      for (;;) {
        const due = [...sleepers].filter((sleeper) => sleeper.due <= target)
        const next = due.sort((a, b) => a.due - b.due)[0]
        if (next === undefined) {
          break
        }
        const step = Math.max(0, next.due - clock.now().getTime())
        clock.advance(`${step}ms`)
        next.wake()
        await settle()
      }
      clock.advance(`${Math.max(0, target - clock.now().getTime())}ms`)
      await settle()
    },
  }
}

/** A message that belongs to an Organization, for tests and examples. */
export const testPing = defineMessage({
  type: 'test.ping',
  version: 1,
  scope: 'organization',
  payload: z.object({ n: z.number().int() }),
})

/** A message that belongs to no Organization, for tests and examples. */
export const testNote = defineMessage({
  type: 'test.note',
  version: 1,
  scope: 'global',
  payload: z.object({ text: z.string() }),
})

/** The definitions the behaviour suite uses. */
export type TestDefinition = typeof testPing | typeof testNote

/** An envelope of either test type. */
export type TestEnvelope = EnvelopeOf<TestDefinition>

/** Creates a registry of {@link testPing} and {@link testNote}. */
export function createTestRegistry(
  options: Parameters<typeof createMessageRegistry>[1] = {}
): MessageRegistry<TestDefinition> {
  return createMessageRegistry<TestDefinition>([testPing, testNote], options)
}
