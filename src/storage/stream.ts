import { STORAGE_ERROR_CODES, StorageError } from './errors'
import { type ByteStream, MAX_STREAM_BYTES_LIMIT, STREAM_IDLE_TIMEOUT_MS } from './port'

// Internal: the stream handling both adapters share. Not exported from any entry of the package.

/** Throws unless `maxBytes` is a whole number from 1 to 2 GiB; returns it. */
export function checkStreamLimit(maxBytes: unknown): number {
  if (
    typeof maxBytes !== 'number' ||
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_STREAM_BYTES_LIMIT
  ) {
    throw new StorageError(
      STORAGE_ERROR_CODES.invalidRequest,
      'maxBytes must be a whole number from 1 to 2147483648'
    )
  }
  return maxBytes
}

/** Throws unless the idle timeout is a whole number from 10 to 600000 ms; returns it or the default. */
export function checkIdleTimeout(idleMs: unknown): number {
  if (idleMs === undefined) {
    return STREAM_IDLE_TIMEOUT_MS
  }
  if (typeof idleMs !== 'number' || !Number.isInteger(idleMs) || idleMs < 10 || idleMs > 600_000) {
    throw new StorageError(
      STORAGE_ERROR_CODES.invalidRequest,
      'idleTimeoutMs must be a whole number from 10 to 600000'
    )
  }
  return idleMs
}

interface Puller {
  next(): Promise<{ done?: boolean | undefined; value?: Uint8Array | undefined }>
  close(): void
}

function puller(source: ByteStream): Puller {
  if (typeof (source as ReadableStream<Uint8Array>).getReader === 'function') {
    const reader = (source as ReadableStream<Uint8Array>).getReader()
    return {
      next: () => reader.read(),
      close: () => {
        void reader.cancel().catch(() => undefined)
      },
    }
  }
  const iterator = (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
  return {
    next: () => iterator.next(),
    close: () => {
      void Promise.resolve(iterator.return?.()).catch(() => undefined)
    },
  }
}

/**
 * Reads a source chunk by chunk. A source that stays silent for `idleMs`, a source that fails, a
 * chunk that is not bytes and a fired `signal` end the read with a StorageError; the source is
 * closed whenever the read ends. Chunks are not copied: use one before asking for the next.
 */
export async function* readChunks(
  source: ByteStream,
  signal: AbortSignal | undefined,
  idleMs: number = STREAM_IDLE_TIMEOUT_MS
): AsyncGenerator<Uint8Array> {
  if (
    typeof source !== 'object' ||
    source === null ||
    (typeof (source as ReadableStream).getReader !== 'function' &&
      typeof (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== 'function')
  ) {
    throw new StorageError(
      STORAGE_ERROR_CODES.invalidRequest,
      'the body must be a stream or an async iterable of bytes'
    )
  }
  const pull = puller(source)
  try {
    for (;;) {
      if (signal?.aborted) {
        throw new StorageError(STORAGE_ERROR_CODES.unavailable, 'the write was aborted')
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined
      const guard = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new StorageError(STORAGE_ERROR_CODES.unavailable, 'the source stream stalled')),
          idleMs
        )
        onAbort = () =>
          reject(new StorageError(STORAGE_ERROR_CODES.unavailable, 'the write was aborted'))
        signal?.addEventListener('abort', onAbort, { once: true })
      })
      let step: { done?: boolean | undefined; value?: Uint8Array | undefined }
      try {
        step = await Promise.race([pull.next(), guard])
      } catch (error) {
        if (error instanceof StorageError) {
          throw error
        }
        throw new StorageError(STORAGE_ERROR_CODES.invalidRequest, 'the source stream failed', {
          cause: error instanceof Error ? error.name : 'unknown',
        })
      } finally {
        clearTimeout(timer)
        if (onAbort !== undefined) {
          signal?.removeEventListener('abort', onAbort)
        }
        guard.catch(() => undefined)
      }
      if (step.done) {
        return
      }
      if (!(step.value instanceof Uint8Array)) {
        throw new StorageError(
          STORAGE_ERROR_CODES.invalidRequest,
          'the stream must hold only bytes'
        )
      }
      yield step.value
    }
  } finally {
    pull.close()
  }
}

/** The error for a stream over its limit; the message holds no key or content. */
export function tooLarge(maxBytes: number): StorageError {
  return new StorageError(STORAGE_ERROR_CODES.objectTooLarge, 'the stream is over its limit', {
    details: { limitBytes: maxBytes },
  })
}
