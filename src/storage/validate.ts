import type { OrganizationIdCheck } from '../organization'
import { createOrganizationIdGuard } from '../organization-guard'
import { STORAGE_ERROR_CODES, StorageError } from './errors'
import {
  DEFAULT_CONTENT_TYPE,
  DEFAULT_LIST_LIMIT,
  DEFAULT_MAX_OBJECT_BYTES,
  DEFAULT_PRESIGN_SECONDS,
  type ListOptions,
  MAX_KEY_BYTES,
  MAX_KEY_SEGMENTS,
  MAX_LIST_LIMIT,
  MAX_OBJECT_BYTES_LIMIT,
  MAX_PRESIGN_SECONDS,
} from './port'

// Internal: the checks both adapters share. Not exported from any entry of the package.

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
  /** True when `key` passes the key rules (what `key` checks, without throwing). */
  isKey(key: string): boolean
  /** Throws unless `body` is a Uint8Array within the size limit. */
  body(body: unknown): Uint8Array
  /** Throws unless the content type is valid; returns it, or the default. */
  contentType(contentType: unknown): string
  /** Throws unless the expiry is a whole number of seconds from 1 to 900; returns it or the default. */
  expiry(options: unknown): number
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
    isKey(value) {
      try {
        key(value)
        return true
      } catch {
        return false
      }
    },
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
    expiry(options) {
      const raw = (options as { expiresInSeconds?: unknown } | undefined)?.expiresInSeconds
      if (options !== undefined && (typeof options !== 'object' || options === null)) {
        throw bad('the presign options must be an object')
      }
      if (raw === undefined) {
        return DEFAULT_PRESIGN_SECONDS
      }
      if (
        typeof raw !== 'number' ||
        !Number.isInteger(raw) ||
        raw < 1 ||
        raw > MAX_PRESIGN_SECONDS
      ) {
        throw bad('expiresInSeconds must be a whole number from 1 to 900')
      }
      return raw
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
