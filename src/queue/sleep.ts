/**
 * Waits `ms` milliseconds, or less when `signal` aborts. Resolves either way, never rejects, so a
 * loop that sleeps checks its own stop flag. Injected so tests drive time by hand.
 */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>

/** The real {@link Sleep}, on `setTimeout`. */
export const systemSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
