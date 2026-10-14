/** The most vectors one `upsert` takes. */
export const MAX_UPSERT_BATCH = 500

/** The most ids one `delete` takes. */
export const MAX_DELETE_BATCH = 500

/** The longest vector id, in characters (ids are ASCII, so bytes): turbopuffer's limit for string ids. */
export const MAX_VECTOR_ID_LENGTH = 64

/** The largest `topK` of a search. */
export const MAX_TOP_K = 100

/** The most dimensions a store can be configured with. */
export const MAX_DIMENSIONS = 4096

/** The most attributes on one vector, and the most keys in one filter. */
export const MAX_ATTRIBUTES = 16

/** The longest string attribute value, in characters. */
export const MAX_ATTRIBUTE_STRING = 512

/** One attribute value. Attributes are flat: no arrays, no nesting, no null. */
export type AttributeValue = string | number | boolean

/**
 * Named values stored with a vector and matched by filters, such as `{ document_id: 'doc_1' }`.
 * Names are lower-case snake_case; `id` and `vector` are reserved. A name should always carry the
 * same kind of value (string, number or boolean): a vendor that infers a column's type from its
 * first value refuses a later value of another type.
 */
export type VectorAttributes = Readonly<Record<string, AttributeValue>>

/** A vector to store. */
export interface VectorRecord {
  /** Unique within the Organization, 1 to 64 of letters, digits, `.`, `_`, `:` and `-`; storing an id again replaces the vector. */
  id: string
  /** Exactly the store's `dimensions` finite numbers, not all zero. */
  vector: ArrayLike<number>
  /** Optional attributes (at most 16). */
  attributes?: VectorAttributes
}

/** A similarity search. */
export interface SearchQuery {
  /** The query vector, the store's `dimensions` long. */
  vector: ArrayLike<number>
  /** How many hits at most, 1 to 100. */
  topK: number
  /** Keep only vectors whose attributes equal every entry here. */
  filter?: VectorAttributes
}

/** One search result. */
export interface SearchHit {
  /** The vector's id. */
  id: string
  /** Cosine similarity to the query, -1 to 1; higher is closer. */
  score: number
  /** The vector's attributes (empty when it had none). */
  attributes: VectorAttributes
}

/**
 * Vector storage scoped by Organization. Every call takes the Organization id first and reaches
 * only that Organization's vectors: an adapter derives its namespace or filter from the validated
 * id, never from a caller's string, so a search, an upsert or a delete cannot touch another
 * Organization. A store is created for one embedding model's dimension count; a vector of any
 * other length is `vector.dimension_mismatch`, which no retry fixes. Scores are cosine similarity.
 * Throws {@link VectorError}; only `vector.unavailable` is worth retrying. Text and vectors are
 * data, never instructions, and no operation logs them.
 */
export interface VectorStore {
  /** The length every vector and query must have. */
  readonly dimensions: number
  /**
   * Tells the store to get an Organization's index ready for low-latency search, as ADR 0010
   * wants done when a call starts. Resolves when the hint is accepted, not when the index is warm.
   * Never changes data; harmless to repeat or to send for an Organization with no vectors. O(1).
   */
  warm(organizationId: string): Promise<void>
  /**
   * Deletes every vector the Organization has (offboarding). Idempotent: an Organization with
   * none resolves. Work proportional to the Organization's size: call it from a queued job.
   */
  deleteAll(organizationId: string): Promise<void>
  /**
   * Stores up to 500 vectors, replacing any with the same id. Idempotent: the same call twice
   * leaves the same data. Everything is validated before anything is written, so a bad record
   * writes nothing. Memory adapter O(batch × dimensions).
   */
  upsert(organizationId: string, records: readonly VectorRecord[]): Promise<void>
  /**
   * Returns the `topK` closest vectors that match the filter, best first (the order of equal scores is not promised). Memory
   * adapter O(n × dimensions + n log n) in the Organization's n vectors (a scan, for tests only).
   */
  search(organizationId: string, query: SearchQuery): Promise<SearchHit[]>
  /**
   * Changes attributes on up to 500 existing vectors without touching or needing their vectors,
   * and returns the ids it did not find, in the order given (empty when every id was found), so a
   * caller can tell a complete update from a partial one. It merges: each attribute in
   * `attributes` is set (replacing a value of the same name) and every other attribute of the
   * vector stays. `attributes` has at least one entry and the same names and values `upsert`
   * accepts; a vector that would end with more than 16 attributes makes the whole call
   * `vector.invalid_request`. It never creates a vector: a missing id is only reported. Ids must
   * be valid and distinct; a bad call writes nothing. Idempotent: the same call twice leaves the
   * same data and reports the same ids. Memory adapter O(ids). A real adapter must patch
   * attributes by id in the vendor's store (turbopuffer: a patch by id) and must not resend or
   * re-embed vectors; a vendor that cannot patch has no business behind this port.
   */
  setAttributes(
    organizationId: string,
    ids: readonly string[],
    attributes: VectorAttributes
  ): Promise<string[]>
  /** Deletes up to 500 vectors by id. Ids that do not exist are ignored. Idempotent. O(ids). */
  delete(organizationId: string, ids: readonly string[]): Promise<void>
  /**
   * Deletes every vector whose attributes equal every entry of `filter` (at least one entry, so it
   * cannot empty an Organization by accident). Idempotent. Memory adapter O(n). Work proportional
   * to the Organization's size: call it from a queued job, not a request.
   */
  deleteByFilter(organizationId: string, filter: VectorAttributes): Promise<void>
}
