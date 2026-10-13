/** The most vectors one `upsert` takes. */
export const MAX_UPSERT_BATCH = 500

/** The most ids one `delete` takes. */
export const MAX_DELETE_BATCH = 500

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

/** Named values stored with a vector and matched by filters, such as `{ document_id: 'doc_1' }`. */
export type VectorAttributes = Readonly<Record<string, AttributeValue>>

/** A vector to store. */
export interface VectorRecord {
  /** Unique within the Organization; storing an id again replaces the vector. */
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
  /** Deletes up to 500 vectors by id. Ids that do not exist are ignored. Idempotent. O(ids). */
  delete(organizationId: string, ids: readonly string[]): Promise<void>
  /**
   * Deletes every vector whose attributes equal every entry of `filter` (at least one entry, so it
   * cannot empty an Organization by accident). Idempotent. Memory adapter O(n). Work proportional
   * to the Organization's size: call it from a queued job, not a request.
   */
  deleteByFilter(organizationId: string, filter: VectorAttributes): Promise<void>
}
