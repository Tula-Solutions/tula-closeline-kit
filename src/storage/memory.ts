import { createHash } from 'node:crypto'
import { type Clock, systemClock } from '../clock'
import type { OrganizationIdCheck } from '../organization'
import { STORAGE_ERROR_CODES, StorageError } from './errors'
import type { ListPage, ObjectInfo, ObjectStore, StoredObject } from './port'
import { checkIdleTimeout, checkStreamLimit, readChunks, tooLarge } from './stream'
import { createStorageValidator, encodeCursor } from './validate'

/** Options for {@link createMemoryObjectStore}. */
export interface MemoryObjectStoreOptions {
  /** Time source for `lastModified`; default the system clock. */
  clock?: Clock
  /** Largest object in bytes; default 25 MiB. */
  maxObjectBytes?: number
  /** Extra Organization id rule; the contract's format by default. */
  isOrganizationId?: OrganizationIdCheck
}

interface Entry {
  body: Uint8Array
  contentType: string
  lastModified: Date
}

/** An {@link ObjectStore} that keeps everything in the process, for tests. Not for production. */
export type MemoryObjectStore = ObjectStore

/**
 * Creates an {@link ObjectStore} in memory. Each Organization has its own map, so no key can reach
 * another Organization's objects. Bodies are copied on the way in and out. Complexity: put and get
 * O(object size), head and delete O(1), list O(n log n) in the Organization's n objects.
 */
export function createMemoryObjectStore(options: MemoryObjectStoreOptions = {}): MemoryObjectStore {
  const clock = options.clock ?? systemClock
  const check = createStorageValidator({
    maxObjectBytes: options.maxObjectBytes,
    isOrganizationId: options.isOrganizationId,
  })
  const organizations = new Map<string, Map<string, Entry>>()

  const info = (key: string, entry: Entry): ObjectInfo => ({
    key,
    size: entry.body.byteLength,
    contentType: entry.contentType,
    lastModified: new Date(entry.lastModified),
  })

  return {
    async put(organizationId, key, body, putOptions) {
      const org = check.organization(organizationId)
      const name = check.key(key)
      const bytes = check.body(body)
      const contentType = check.contentType(putOptions?.contentType)
      let objects = organizations.get(org)
      if (objects === undefined) {
        objects = new Map()
        organizations.set(org, objects)
      }
      objects.set(name, { body: bytes.slice(), contentType, lastModified: clock.now() })
    },

    async putStream(organizationId, key, body, putOptions) {
      const org = check.organization(organizationId)
      const name = check.key(key)
      const contentType = check.contentType(putOptions?.contentType)
      const maxBytes = checkStreamLimit(putOptions?.maxBytes)
      const hash = createHash('sha256')
      const parts: Uint8Array[] = []
      let size = 0
      // Nothing is stored until the whole stream is in, so an abort leaves the key as it was.
      for await (const chunk of readChunks(
        body,
        putOptions?.signal,
        checkIdleTimeout(putOptions?.idleTimeoutMs)
      )) {
        size += chunk.byteLength
        if (size > maxBytes) {
          throw tooLarge(maxBytes)
        }
        hash.update(chunk)
        parts.push(chunk.slice())
      }
      const whole = new Uint8Array(size)
      let offset = 0
      for (const part of parts) {
        whole.set(part, offset)
        offset += part.byteLength
      }
      let objects = organizations.get(org)
      if (objects === undefined) {
        objects = new Map()
        organizations.set(org, objects)
      }
      objects.set(name, { body: whole, contentType, lastModified: clock.now() })
      return { size, sha256: hash.digest('hex') }
    },

    async getStream(organizationId, key) {
      const org = check.organization(organizationId)
      const name = check.key(key)
      const entry = organizations.get(org)?.get(name)
      if (entry === undefined) {
        return undefined
      }
      const bytes = entry.body.slice()
      let offset = 0
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= bytes.byteLength) {
            controller.close()
            return
          }
          controller.enqueue(bytes.subarray(offset, offset + 65_536))
          offset += 65_536
        },
      })
      return { ...info(name, entry), body }
    },

    async get(organizationId, key) {
      const org = check.organization(organizationId)
      const name = check.key(key)
      const entry = organizations.get(org)?.get(name)
      if (entry === undefined) {
        return undefined
      }
      if (entry.body.byteLength > check.maxObjectBytes) {
        throw new StorageError(STORAGE_ERROR_CODES.objectTooLarge, 'the object is too large', {
          details: { limitBytes: check.maxObjectBytes },
        })
      }
      const stored: StoredObject = { ...info(name, entry), body: entry.body.slice() }
      return stored
    },

    async head(organizationId, key) {
      const org = check.organization(organizationId)
      const name = check.key(key)
      const entry = organizations.get(org)?.get(name)
      return entry === undefined ? undefined : info(name, entry)
    },

    async delete(organizationId, key) {
      const org = check.organization(organizationId)
      const name = check.key(key)
      organizations.get(org)?.delete(name)
    },

    async list(organizationId, listOptions) {
      const org = check.organization(organizationId)
      const { prefix, after, limit } = check.list(listOptions)
      const matches: Array<[string, Entry]> = []
      for (const pair of organizations.get(org) ?? []) {
        if (pair[0].startsWith(prefix) && (after === undefined || pair[0] > after)) {
          matches.push(pair)
        }
      }
      matches.sort((x, y) => (x[0] < y[0] ? -1 : 1))
      const items = matches.slice(0, limit).map(([name, entry]) => {
        const { key, size, lastModified } = info(name, entry)
        return { key, size, lastModified }
      })
      const last = items.at(-1)
      const result: ListPage = { items }
      if (matches.length > limit && last !== undefined) {
        result.nextCursor = encodeCursor(last.key)
      }
      return result
    },
  }
}
