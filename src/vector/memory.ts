import type { OrganizationIdCheck } from '../organization'
import {
  attributesMatch,
  type CheckedRecord,
  createVectorValidator,
  type SearchHit,
  type VectorStore,
} from './port'

/** Options for {@link createMemoryVectorStore}. */
export interface MemoryVectorStoreOptions {
  /** The dimension count of the embedding model, 1 to 4096. */
  dimensions: number
  /** Extra Organization id rule; the contract's format by default. */
  isOrganizationId?: OrganizationIdCheck
}

/** A {@link VectorStore} that keeps everything in the process, for tests. Not for production. */
export type MemoryVectorStore = VectorStore

interface Stored {
  /** The vector scaled to length 1, so a dot product is the cosine. */
  unit: Float32Array
  attributes: CheckedRecord['attributes']
}

function normalise(vector: Float32Array): Float32Array {
  let norm = 0
  for (const x of vector) {
    norm += x * x
  }
  const scale = 1 / Math.sqrt(norm)
  return vector.map((x) => x * scale)
}

/**
 * Creates a {@link VectorStore} in memory. Each Organization has its own map, so no query can
 * reach another Organization's vectors. Complexity: upsert O(batch × dimensions); search
 * O(n × dimensions + n log n) in the Organization's n vectors, an exact scan; delete O(ids);
 * deleteByFilter O(n).
 */
export function createMemoryVectorStore(options: MemoryVectorStoreOptions): MemoryVectorStore {
  const check = createVectorValidator(options)
  const organizations = new Map<string, Map<string, Stored>>()

  return {
    dimensions: check.dimensions,

    async upsert(organizationId, records) {
      const org = check.organization(organizationId)
      const checked = check.records(records)
      let vectors = organizations.get(org)
      if (vectors === undefined) {
        vectors = new Map()
        organizations.set(org, vectors)
      }
      for (const record of checked) {
        vectors.set(record.id, {
          unit: normalise(record.vector),
          attributes: { ...record.attributes },
        })
      }
    },

    async search(organizationId, query) {
      const org = check.organization(organizationId)
      const { vector, topK, filter } = check.query(query)
      const unit = normalise(vector)
      const hits: SearchHit[] = []
      for (const [id, stored] of organizations.get(org) ?? []) {
        if (!attributesMatch(stored.attributes, filter)) {
          continue
        }
        let dot = 0
        for (let i = 0; i < unit.length; i++) {
          dot += (unit[i] as number) * (stored.unit[i] as number)
        }
        hits.push({ id, score: dot, attributes: { ...stored.attributes } })
      }
      hits.sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : 1))
      return hits.slice(0, topK)
    },

    async delete(organizationId, ids) {
      const org = check.organization(organizationId)
      const checked = check.ids(ids)
      const vectors = organizations.get(org)
      for (const id of checked) {
        vectors?.delete(id)
      }
    },

    async deleteByFilter(organizationId, filter) {
      const org = check.organization(organizationId)
      const checked = check.nonEmptyFilter(filter)
      const vectors = organizations.get(org)
      for (const [id, stored] of vectors ?? []) {
        if (attributesMatch(stored.attributes, checked)) {
          vectors?.delete(id)
        }
      }
    },
  }
}
