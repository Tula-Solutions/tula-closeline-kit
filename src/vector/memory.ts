import type { OrganizationIdCheck } from '../organization'
import { VECTOR_ERROR_CODES, VectorError } from './errors'
import { MAX_ATTRIBUTES, type SearchHit, type VectorStore } from './port'
import { attributesMatch, type CheckedRecord, createVectorValidator } from './validate'

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
 * setAttributes O(ids); deleteByFilter O(n); warm O(1); deleteAll O(1).
 */
export function createMemoryVectorStore(options: MemoryVectorStoreOptions): MemoryVectorStore {
  const check = createVectorValidator(options)
  const organizations = new Map<string, Map<string, Stored>>()

  return {
    dimensions: check.dimensions,

    async warm(organizationId) {
      check.organization(organizationId)
    },

    async deleteAll(organizationId) {
      organizations.delete(check.organization(organizationId))
    },

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

    async setAttributes(organizationId, ids, attributes) {
      const org = check.organization(organizationId)
      const checkedIds = check.updateIds(ids)
      const changes = check.nonEmptyAttributes(attributes)
      const vectors = organizations.get(org)
      const missing: string[] = []
      const merged: Array<[Stored, Stored['attributes']]> = []
      for (const id of checkedIds) {
        const stored = vectors?.get(id)
        if (stored === undefined) {
          missing.push(id)
          continue
        }
        const next = { ...stored.attributes, ...changes }
        if (Object.keys(next).length > MAX_ATTRIBUTES) {
          throw new VectorError(
            VECTOR_ERROR_CODES.invalidRequest,
            'a vector has at most 16 attributes'
          )
        }
        merged.push([stored, next])
      }
      // Everything is checked before anything is written, as in `upsert`.
      for (const [stored, next] of merged) {
        stored.attributes = next
      }
      return missing
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
