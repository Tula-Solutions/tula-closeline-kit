import type { OrganizationIdCheck } from '../organization'
import { createOrganizationIdGuard } from '../organization-guard'
import { VECTOR_ERROR_CODES, VectorError } from './errors'
import {
  type AttributeValue,
  MAX_ATTRIBUTE_STRING,
  MAX_ATTRIBUTES,
  MAX_DELETE_BATCH,
  MAX_DIMENSIONS,
  MAX_TOP_K,
  MAX_UPSERT_BATCH,
  type VectorAttributes,
} from './port'

// Internal: the checks both adapters share. Not exported from any entry of the package.

const VECTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const ATTRIBUTE_NAME = /^[a-z][a-z0-9_]{0,63}$/

const bad = (message: string) => new VectorError(VECTOR_ERROR_CODES.invalidRequest, message)

/** A record after validation. */
export interface CheckedRecord {
  id: string
  vector: Float32Array
  attributes: VectorAttributes
}

/** A search after validation. */
export interface CheckedQuery {
  vector: Float32Array
  topK: number
  filter: VectorAttributes
}

/** The checks both adapters run before touching their store. */
export interface VectorValidator {
  /** The dimension count of the store. */
  readonly dimensions: number
  /** Throws unless `organizationId` is acceptable; returns it. */
  organization(organizationId: unknown): string
  /** Validates a batch of records. */
  records(records: unknown): CheckedRecord[]
  /** Validates a search. */
  query(query: unknown): CheckedQuery
  /** Validates a batch of ids. */
  ids(ids: unknown): string[]
  /** Validates a non-empty filter. */
  nonEmptyFilter(filter: unknown): VectorAttributes
}

/** Options of {@link createVectorValidator}. */
export interface VectorValidatorOptions {
  /** The dimension count of the embedding model, 1 to 4096. */
  dimensions: number
  /** Extra Organization id rule; the contract's format by default. */
  isOrganizationId?: OrganizationIdCheck | undefined
}

/** True when `a` and `b` hold the same value, for attribute matching. */
export function attributesMatch(attributes: VectorAttributes, filter: VectorAttributes): boolean {
  for (const name of Object.keys(filter)) {
    if (!Object.hasOwn(attributes, name) || attributes[name] !== filter[name]) {
      return false
    }
  }
  return true
}

/** Builds the validator a {@link VectorStore} adapter uses. */
export function createVectorValidator(options: VectorValidatorOptions): VectorValidator {
  const { dimensions } = options
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > MAX_DIMENSIONS) {
    throw new TypeError('dimensions must be a whole number from 1 to 4096')
  }
  const isOrganization = createOrganizationIdGuard(options.isOrganizationId)

  function vector(value: unknown): Float32Array {
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof (value as ArrayLike<number>).length !== 'number'
    ) {
      throw bad('a vector must be an array of numbers')
    }
    const source = value as ArrayLike<number>
    if (source.length !== dimensions) {
      throw new VectorError(
        VECTOR_ERROR_CODES.dimensionMismatch,
        `a vector must have ${dimensions} dimensions`,
        { details: { expected: dimensions, actual: source.length } }
      )
    }
    const out = new Float32Array(dimensions)
    let norm = 0
    for (let i = 0; i < dimensions; i++) {
      const x = source[i]
      if (typeof x !== 'number') {
        throw bad('a vector holds only finite numbers')
      }
      out[i] = x
      const stored = out[i] as number
      if (!Number.isFinite(stored)) {
        throw bad('a vector holds only finite numbers')
      }
      norm += stored * stored
    }
    if (!(norm > 0) || !Number.isFinite(norm)) {
      throw bad('a vector must not be all zeros or too large to compare')
    }
    return out
  }

  function attributes(value: unknown, what: string): VectorAttributes {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw bad(`${what} must be an object`)
    }
    const names = Object.keys(value)
    if (names.length > MAX_ATTRIBUTES) {
      throw bad(`${what} has at most 16 entries`)
    }
    const out: Record<string, AttributeValue> = {}
    for (const name of names) {
      const item = (value as Record<string, unknown>)[name]
      const okValue =
        typeof item === 'boolean' ||
        (typeof item === 'number' && Number.isFinite(item)) ||
        (typeof item === 'string' && item.length <= MAX_ATTRIBUTE_STRING)
      if (!ATTRIBUTE_NAME.test(name) || !okValue) {
        throw bad(
          `${what} names are lower-case snake_case; values are booleans, finite numbers or strings of at most 512 characters`
        )
      }
      out[name] = item as AttributeValue
    }
    return out
  }

  function id(value: unknown): string {
    if (typeof value !== 'string' || !VECTOR_ID.test(value)) {
      throw bad('a vector id is 1 to 128 letters, digits, ".", "_", ":" or "-"')
    }
    return value
  }

  return {
    dimensions,
    organization(value) {
      if (!isOrganization(value)) {
        throw bad('the Organization id is not valid')
      }
      return value
    },
    records(value) {
      if (!Array.isArray(value) || value.length < 1 || value.length > MAX_UPSERT_BATCH) {
        throw bad('an upsert takes 1 to 500 records')
      }
      const seen = new Set<string>()
      return value.map((record: unknown) => {
        if (typeof record !== 'object' || record === null) {
          throw bad('a record must be an object')
        }
        const raw = record as { id?: unknown; vector?: unknown; attributes?: unknown }
        const recordId = id(raw.id)
        if (seen.has(recordId)) {
          throw bad('an upsert holds each id once')
        }
        seen.add(recordId)
        return {
          id: recordId,
          vector: vector(raw.vector),
          attributes: raw.attributes === undefined ? {} : attributes(raw.attributes, 'attributes'),
        }
      })
    },
    query(value) {
      if (typeof value !== 'object' || value === null) {
        throw bad('a search must be an object')
      }
      const raw = value as { vector?: unknown; topK?: unknown; filter?: unknown }
      if (
        typeof raw.topK !== 'number' ||
        !Number.isInteger(raw.topK) ||
        raw.topK < 1 ||
        raw.topK > MAX_TOP_K
      ) {
        throw bad('topK must be a whole number from 1 to 100')
      }
      return {
        vector: vector(raw.vector),
        topK: raw.topK,
        filter: raw.filter === undefined ? {} : attributes(raw.filter, 'filter'),
      }
    },
    ids(value) {
      if (!Array.isArray(value) || value.length < 1 || value.length > MAX_DELETE_BATCH) {
        throw bad('a delete takes 1 to 500 ids')
      }
      return value.map(id)
    },
    nonEmptyFilter(value) {
      const filter = attributes(value, 'filter')
      if (Object.keys(filter).length === 0) {
        throw bad('the filter must have at least one entry')
      }
      return filter
    },
  }
}
