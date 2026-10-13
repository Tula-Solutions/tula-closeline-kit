import { createOrganizationIdGuard, type OrganizationIdCheck } from '../organization'
import { STORAGE_ERROR_CODES, StorageError } from './errors'

/** The longest key, in bytes. */
export const MAX_KEY_BYTES = 512

/** The most `/`-separated segments a key can have. */
export const MAX_KEY_SEGMENTS = 16

/** The default largest object, in bytes (25 MiB). */
export const DEFAULT_MAX_OBJECT_BYTES = 25 * 1024 * 1024

/** The largest `maxObjectBytes` a store can be configured with (100 MiB): bodies are held in memory. */
export const MAX_OBJECT_BYTES_LIMIT = 100 * 1024 * 1024

/** The default page size of {@link ObjectStore.list}. */
export const DEFAULT_LIST_LIMIT = 100

/** The largest page size of {@link ObjectStore.list}. */
export const MAX_LIST_LIMIT = 1000

/** The content type stored when the caller gives none. */
export const DEFAULT_CONTENT_TYPE = 'application/octet-stream'

/** What a listing says about one object. */
export interface ObjectEntry {
  /** The key, relative to the Organization. */
  key: string
  /** The size in bytes. */
  size: number
  /** When the object was last written. */
  lastModified: Date
}

/** What {@link ObjectStore.head} says about one object. */
export interface ObjectInfo extends ObjectEntry {
  /**
   * The content type as the store holds it, which is what the writer gave except that a store may
   * normalise insignificant whitespace in the parameters (`text/plain; charset=utf-8` can come back
   * as `text/plain;charset=utf-8`). Never compare it as a raw string, and never use it to decide
   * behaviour: it is informational and untrusted.
   */
  contentType: string
}

/** An object with its body. */
export interface StoredObject extends ObjectInfo {
  /** The bytes. A copy: changing it does not change the store. */
  body: Uint8Array
}

/** Options of {@link ObjectStore.put}. */
export interface PutOptions {
  /** A `type/subtype` media type with optional parameters; default `application/octet-stream`. */
  contentType?: string
}

/** Options of {@link ObjectStore.list}. */
export interface ListOptions {
  /** Only keys that start with this, such as `documents/` or `documents/ab`; default all. */
  prefix?: string
  /** The `nextCursor` of the previous page. */
  cursor?: string
  /** Page size, 1 to 1000; default 100. */
  limit?: number
}

/** One page of a listing. */
export interface ListPage {
  /** Objects in ascending key order. */
  items: ObjectEntry[]
  /** Pass as `cursor` for the next page; absent on the last one. */
  nextCursor?: string
}

/**
 * Object storage scoped by Organization. Every call takes the Organization id first and can reach
 * only that Organization's objects: the adapter derives the real location from the validated id,
 * never from a string the caller built, so no key (`..`, a leading slash, an encoded separator, an
 * id that starts with another id) can name another Organization's data. Keys are relative to the
 * Organization and made of `/`-separated segments of letters, digits, `.`, `_` and `-`, none
 * starting with `.`, at most 512 bytes and 16 segments. Content is untrusted bytes: the store
 * keeps the content type as given (returned as the store holds it, see {@link ObjectInfo}) and never looks at the content. Bodies are held in memory, so an
 * object is at most `maxObjectBytes` (25 MiB by default, 100 MiB at most). Throws
 * {@link StorageError}; only `storage.unavailable` is worth retrying.
 */
export interface ObjectStore {
  /**
   * Writes an object, replacing one with the same key. Idempotent: the same call twice leaves the
   * same object. O(object size).
   */
  put(organizationId: string, key: string, body: Uint8Array, options?: PutOptions): Promise<void>
  /** Reads an object, or returns `undefined` when there is none. O(object size). */
  get(organizationId: string, key: string): Promise<StoredObject | undefined>
  /** Reads an object's metadata, or returns `undefined` when there is none. O(1). */
  head(organizationId: string, key: string): Promise<ObjectInfo | undefined>
  /** Deletes an object. Resolves when it is gone, including when it never existed. O(1). */
  delete(organizationId: string, key: string): Promise<void>
  /**
   * Lists one page of the Organization's objects in key order. The page is at most `limit` items
   * (1000 at most), so a listing is never unbounded: follow `nextCursor` for more. Memory adapter
   * O(n log n) in the Organization's n objects; S3 adapter one request, O(limit).
   */
  list(organizationId: string, options?: ListOptions): Promise<ListPage>
}

const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/
const CONTENT_TYPE =
  /^[A-Za-z0-9][\w!#$&^.+-]*\/[A-Za-z0-9][\w!#$&^.+-]*(?:;[ \t]*[\w.-]+=[\w.+"-]+)*$/
const CURSOR = /^[A-Za-z0-9_-]{1,700}$/

const bad = (message: string) => new StorageError(STORAGE_ERROR_CODES.invalidRequest, message)

/** The validated parts of a `list` call. */
export interface ListQuery {
  prefix: string
  after: string | undefined
  limit: number
}

/** The checks both adapters run before touching their store. */
export interface StorageValidator {
  /** Throws unless `organizationId` is acceptable; returns it. */
  organization(organizationId: unknown): string
  /** Throws unless `key` is a valid key; returns it. */
  key(key: unknown): string
  /** Throws unless `body` is a Uint8Array within the size limit. */
  body(body: unknown): Uint8Array
  /** Throws unless the content type is valid; returns it, or the default. */
  contentType(contentType: unknown): string
  /** Validates and normalises the options of a list call. */
  list(options: ListOptions | undefined): ListQuery
  /** The largest object accepted, in bytes. */
  readonly maxObjectBytes: number
}

/** Options of {@link createStorageValidator}. */
export interface StorageValidatorOptions {
  /** Largest object in bytes; default 25 MiB, at most 100 MiB. */
  maxObjectBytes?: number | undefined
  /** Extra Organization id rule; the contract's format by default. */
  isOrganizationId?: OrganizationIdCheck | undefined
}

/** Encodes a key as an opaque list cursor. */
export function encodeCursor(key: string): string {
  return Buffer.from(key, 'utf8').toString('base64url')
}

/**
 * Builds the validator an {@link ObjectStore} adapter uses. A cursor is the last key of the
 * previous page, so decoding one gives a key that is checked like any other and cannot point
 * outside the Organization.
 */
export function createStorageValidator(options: StorageValidatorOptions = {}): StorageValidator {
  const maxObjectBytes = options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES
  if (
    !Number.isInteger(maxObjectBytes) ||
    maxObjectBytes < 1 ||
    maxObjectBytes > MAX_OBJECT_BYTES_LIMIT
  ) {
    throw new TypeError('maxObjectBytes must be a whole number from 1 to 104857600')
  }
  const isOrganization = createOrganizationIdGuard(options.isOrganizationId)

  function key(value: unknown): string {
    if (typeof value !== 'string' || value === '' || value.length > MAX_KEY_BYTES) {
      throw bad('the key must be a non-empty string of at most 512 bytes')
    }
    const segments = value.split('/')
    if (segments.length > MAX_KEY_SEGMENTS || !segments.every((s) => SEGMENT.test(s))) {
      throw bad(
        'the key must be up to 16 segments of letters, digits, ".", "_" and "-", none empty or starting with "."'
      )
    }
    return value
  }

  function prefix(value: unknown): string {
    if (value === undefined || value === '') {
      return ''
    }
    if (typeof value !== 'string' || value.length > MAX_KEY_BYTES) {
      throw bad('the prefix must be a string of at most 512 bytes')
    }
    const segments = value.split('/')
    const last = segments.pop() ?? ''
    if (
      segments.length >= MAX_KEY_SEGMENTS ||
      !segments.every((s) => SEGMENT.test(s)) ||
      (last !== '' && !SEGMENT.test(last))
    ) {
      throw bad('the prefix must be whole segments, optionally ending in a part of one')
    }
    return value
  }

  function cursor(value: unknown): string | undefined {
    if (value === undefined) {
      return undefined
    }
    if (typeof value !== 'string' || !CURSOR.test(value)) {
      throw bad('the cursor is not one this store gave')
    }
    const decoded = Buffer.from(value, 'base64url').toString('utf8')
    try {
      key(decoded)
    } catch {
      throw bad('the cursor is not one this store gave')
    }
    if (encodeCursor(decoded) !== value) {
      throw bad('the cursor is not one this store gave')
    }
    return decoded
  }

  return {
    maxObjectBytes,
    organization(value) {
      if (!isOrganization(value)) {
        throw bad('the Organization id is not valid')
      }
      return value
    },
    key,
    body(value) {
      if (!(value instanceof Uint8Array)) {
        throw bad('the body must be a Uint8Array')
      }
      if (value.byteLength > maxObjectBytes) {
        throw new StorageError(STORAGE_ERROR_CODES.objectTooLarge, 'the object is too large', {
          details: { limitBytes: maxObjectBytes },
        })
      }
      return value
    },
    contentType(value) {
      if (value === undefined) {
        return DEFAULT_CONTENT_TYPE
      }
      if (typeof value !== 'string' || value.length > 255 || !CONTENT_TYPE.test(value)) {
        throw bad('the content type must look like "type/subtype" with optional parameters')
      }
      return value
    },
    list(listOptions) {
      const limit = listOptions?.limit ?? DEFAULT_LIST_LIMIT
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
        throw bad('the limit must be a whole number from 1 to 1000')
      }
      return {
        prefix: prefix(listOptions?.prefix),
        after: cursor(listOptions?.cursor),
        limit,
      }
    },
  }
}
