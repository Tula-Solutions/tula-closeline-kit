import { type Clock, systemClock } from '../clock'
import type { OrganizationIdCheck } from '../organization'
import type { ListPage, ObjectInfo, ObjectStore, StoredObject } from './port'
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

    async get(organizationId, key) {
      const org = check.organization(organizationId)
      const name = check.key(key)
      const entry = organizations.get(org)?.get(name)
      if (entry === undefined) {
        return undefined
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
