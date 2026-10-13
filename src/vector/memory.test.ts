import { describe, expect, test } from 'bun:test'
import { createMemoryVectorStore } from './memory'
import { MAX_DIMENSIONS } from './port'

const ORG = `org_${'1'.repeat(32)}`

describe('the memory vector store', () => {
  test('the dimension count is checked at construction', () => {
    for (const bad of [0, -1, 1.5, MAX_DIMENSIONS + 1, Number.NaN]) {
      expect(() => createMemoryVectorStore({ dimensions: bad })).toThrow(TypeError)
    }
    expect(createMemoryVectorStore({ dimensions: MAX_DIMENSIONS }).dimensions).toBe(MAX_DIMENSIONS)
  })

  test("by default only the contract's Organization id format is accepted", async () => {
    const store = createMemoryVectorStore({ dimensions: 2 })
    await expect(store.upsert('org_a', [{ id: 'v', vector: [1, 0] }])).rejects.toMatchObject({
      code: 'vector.invalid_request',
    })
    await store.upsert(ORG, [{ id: 'v', vector: [1, 0] }])
    expect((await store.search(ORG, { vector: [1, 0], topK: 1 }))[0]?.id).toBe('v')
  })

  test('a dimension mismatch is not a retryable error', async () => {
    const store = createMemoryVectorStore({ dimensions: 2 })
    const error = await store.search(ORG, { vector: [1], topK: 1 }).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'vector.dimension_mismatch', status: 422 })
    expect((error as { details?: unknown }).details).toEqual({ expected: 2, actual: 1 })
  })

  test("typed arrays are accepted and the caller's array is not kept", async () => {
    const store = createMemoryVectorStore({ dimensions: 2 })
    const vector = new Float32Array([1, 0])
    await store.upsert(ORG, [{ id: 'v', vector }])
    vector[0] = 0
    vector[1] = 1
    const [hit] = await store.search(ORG, { vector: [1, 0], topK: 1 })
    expect(hit?.score).toBeCloseTo(1, 5)
  })

  test('equal scores come back in id order', async () => {
    const store = createMemoryVectorStore({ dimensions: 2 })
    await store.upsert(ORG, [
      { id: 'b', vector: [1, 0] },
      { id: 'a', vector: [2, 0] },
      { id: 'c', vector: [3, 0] },
    ])
    const hits = await store.search(ORG, { vector: [1, 0], topK: 3 })
    expect(hits.map((hit) => hit.id)).toEqual(['a', 'b', 'c'])
  })

  test('changing a returned attribute object does not change the store', async () => {
    const store = createMemoryVectorStore({ dimensions: 2 })
    await store.upsert(ORG, [{ id: 'v', vector: [1, 0], attributes: { n: 1 } }])
    const [hit] = await store.search(ORG, { vector: [1, 0], topK: 1 })
    ;(hit?.attributes as Record<string, unknown>).n = 2
    expect((await store.search(ORG, { vector: [1, 0], topK: 1 }))[0]?.attributes).toEqual({ n: 1 })
  })

  test('an attribute named like an object member is matched as data', async () => {
    const store = createMemoryVectorStore({ dimensions: 2 })
    await store.upsert(ORG, [{ id: 'v', vector: [1, 0], attributes: { constructor: 'x' } }])
    expect(
      await store.search(ORG, { vector: [1, 0], topK: 1, filter: { constructor: 'x' } })
    ).toHaveLength(1)
    await store.upsert(ORG, [{ id: 'w', vector: [1, 0] }])
    const hits = await store.search(ORG, { vector: [1, 0], topK: 5, filter: { constructor: 'x' } })
    expect(hits.map((hit) => hit.id)).toEqual(['v'])
  })
})
