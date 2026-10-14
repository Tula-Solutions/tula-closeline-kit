import { afterEach, describe, expect, test } from 'bun:test'
import type { VectorStore } from './port'

/** What the behaviour suite needs from an adapter under test. */
export interface VectorStoreSubject {
  /** The store under test, empty for the Organizations below, with at least 3 dimensions. */
  store: VectorStore
  /** Three Organization ids the store accepts: B is unrelated, and `aExtended` starts with `a`. */
  organizations: { a: string; b: string; aExtended: string }
  /** Removes what the subject created. */
  close(): Promise<void>
}

/**
 * The behaviour every {@link VectorStore} must show. Run it with {@link vectorStoreBehaviour}
 * against the memory adapter and against any real adapter (a store with no local stand-in runs it
 * in an integration test against a scratch namespace in a dev account).
 */
export function vectorStoreBehaviour(
  name: string,
  make: () => Promise<VectorStoreSubject>,
  skip = false
): void {
  const run = skip ? describe.skip : describe
  run(`VectorStore behaviour: ${name}`, () => {
    const open: VectorStoreSubject[] = []
    afterEach(async () => {
      await Promise.all(open.splice(0).map((subject) => subject.close()))
    })
    async function subject(): Promise<VectorStoreSubject> {
      const made = await make()
      open.push(made)
      return made
    }
    /** A vector of the store's size: the given leading numbers, then zeros. */
    const vec = (s: VectorStoreSubject, ...lead: number[]) =>
      Array.from({ length: s.store.dimensions }, (_, i) => lead[i] ?? 0)
    const ids = (hits: Array<{ id: string }>) => hits.map((hit) => hit.id)
    const invalid = { code: 'vector.invalid_request' }

    async function seed(s: VectorStoreSubject, org = s.organizations.a) {
      await s.store.upsert(org, [
        { id: 'x', vector: vec(s, 1, 0, 0), attributes: { document_id: 'doc_1', page: 1 } },
        { id: 'y', vector: vec(s, 0, 1, 0), attributes: { document_id: 'doc_1', page: 2 } },
        {
          id: 'xy',
          vector: vec(s, 1, 1, 0),
          attributes: { document_id: 'doc_2', page: 1, final: true },
        },
        { id: 'z', vector: vec(s, 0, 0, 1) },
      ])
    }

    test('a search returns the closest vectors first, with cosine scores and attributes', async () => {
      const s = await subject()
      const { a } = s.organizations
      await seed(s)
      const hits = await s.store.search(a, { vector: vec(s, 1, 0, 0), topK: 4 })
      expect(ids(hits).slice(0, 2)).toEqual(['x', 'xy'])
      expect(hits[0]?.score).toBeCloseTo(1, 4)
      expect(hits[1]?.score).toBeCloseTo(Math.SQRT1_2, 4)
      expect(hits[0]?.attributes).toEqual({ document_id: 'doc_1', page: 1 })
      expect(hits.find((hit) => hit.id === 'z')?.attributes).toEqual({})
    })

    test('a score does not depend on the length of either vector', async () => {
      const s = await subject()
      const { a } = s.organizations
      await s.store.upsert(a, [{ id: 'long', vector: vec(s, 50, 0, 0) }])
      const [hit] = await s.store.search(a, { vector: vec(s, 0.001, 0, 0), topK: 1 })
      expect(hit?.id).toBe('long')
      expect(hit?.score).toBeCloseTo(1, 4)
    })

    test('topK bounds the results', async () => {
      const s = await subject()
      const { a } = s.organizations
      await seed(s)
      expect(await s.store.search(a, { vector: vec(s, 1, 1, 1), topK: 2 })).toHaveLength(2)
      expect(await s.store.search(a, { vector: vec(s, 1, 1, 1), topK: 100 })).toHaveLength(4)
      expect(await s.store.search(s.organizations.b, { vector: vec(s, 1), topK: 5 })).toEqual([])
    })

    test.each([[0], [-1], [101], [1.5], [Number.NaN], ['5']])(
      'a topK of %p is refused',
      async (topK) => {
        const s = await subject()
        await expect(
          s.store.search(s.organizations.a, { vector: vec(s, 1), topK: topK as number })
        ).rejects.toMatchObject(invalid)
      }
    )

    test('a filter keeps vectors whose attributes equal every entry', async () => {
      const s = await subject()
      const { a } = s.organizations
      await seed(s)
      const search = async (filter: Record<string, string | number | boolean>) =>
        ids(await s.store.search(a, { vector: vec(s, 1, 1, 1), topK: 10, filter })).sort()
      expect(await search({ document_id: 'doc_1' })).toEqual(['x', 'y'])
      expect(await search({ document_id: 'doc_1', page: 2 })).toEqual(['y'])
      expect(await search({ final: true })).toEqual(['xy'])
      expect(await search({ page: 1 })).toEqual(['x', 'xy'])
      expect(await search({ document_id: 'nope' })).toEqual([])
      expect(await search({ page: '1' })).toEqual([])
    })

    test('a vector of the wrong length is a non-retryable dimension error and writes nothing', async () => {
      const s = await subject()
      const { a } = s.organizations
      const code = { code: 'vector.dimension_mismatch' }
      const short = Array.from({ length: s.store.dimensions - 1 }, () => 1)
      const long = Array.from({ length: s.store.dimensions + 1 }, () => 1)
      await expect(s.store.search(a, { vector: short, topK: 1 })).rejects.toMatchObject(code)
      await expect(s.store.search(a, { vector: long, topK: 1 })).rejects.toMatchObject(code)
      await expect(
        s.store.upsert(a, [
          { id: 'fine', vector: vec(s, 1) },
          { id: 'short', vector: short },
        ])
      ).rejects.toMatchObject(code)
      expect(await s.store.search(a, { vector: vec(s, 1), topK: 10 })).toEqual([])
    })

    test.each([
      ['NaN', (n: number) => Array.from({ length: n }, (_, i) => (i === 0 ? Number.NaN : 1))],
      [
        'Infinity',
        (n: number) =>
          Array.from({ length: n }, (_, i) => (i === 0 ? Number.POSITIVE_INFINITY : 1)),
      ],
      [
        'a value too large for a float',
        (n: number) => Array.from({ length: n }, (_, i) => (i === 0 ? 1e300 : 1)),
      ],
      ['all zeros', (n: number) => Array.from({ length: n }, () => 0)],
      [
        'a string',
        (n: number) =>
          Array.from({ length: n }, (_, i) => (i === 0 ? ('1' as unknown as number) : 1)),
      ],
    ])('a vector with %s is refused', async (_label, build) => {
      const s = await subject()
      const { a } = s.organizations
      const vector = build(s.store.dimensions)
      await expect(s.store.upsert(a, [{ id: 'v', vector }])).rejects.toMatchObject(invalid)
      await expect(s.store.search(a, { vector, topK: 1 })).rejects.toMatchObject(invalid)
    })

    test.each([
      ['an empty id', ''],
      ['a slash', 'a/b'],
      ['a leading dot', '.x'],
      ['a space', 'a b'],
      ['a long id', 'x'.repeat(65)],
    ])('an id with %s is refused', async (_label, id) => {
      const s = await subject()
      const { a } = s.organizations
      await expect(s.store.upsert(a, [{ id, vector: vec(s, 1) }])).rejects.toMatchObject(invalid)
      await expect(s.store.delete(a, [id])).rejects.toMatchObject(invalid)
    })

    test('a batch of 0 or 501 records, or one with a repeated id, is refused', async () => {
      const s = await subject()
      const { a } = s.organizations
      await expect(s.store.upsert(a, [])).rejects.toMatchObject(invalid)
      const many = Array.from({ length: 501 }, (_, i) => ({ id: `v${i}`, vector: vec(s, 1) }))
      await expect(s.store.upsert(a, many)).rejects.toMatchObject(invalid)
      await expect(
        s.store.upsert(a, [
          { id: 'same', vector: vec(s, 1) },
          { id: 'same', vector: vec(s, 0, 1) },
        ])
      ).rejects.toMatchObject(invalid)
      await expect(s.store.delete(a, [])).rejects.toMatchObject(invalid)
      await expect(
        s.store.delete(
          a,
          Array.from({ length: 501 }, (_, i) => `v${i}`)
        )
      ).rejects.toMatchObject(invalid)
      expect(await s.store.search(a, { vector: vec(s, 1), topK: 10 })).toEqual([])
    })

    test.each([
      ['the reserved name id', { id: 'x' }],
      ['the reserved name vector', { vector: 'x' }],
      ['a name starting with a dollar sign', { $dist: 'x' }],
      ['an upper-case name', { Document: 'x' }],
      ['a name with a dot', { 'a.b': 'x' }],
      ['an array value', { tags: ['x'] as unknown as string }],
      ['a null value', { n: null as unknown as string }],
      ['a non-finite number', { n: Number.NaN }],
      ['a long string', { n: 'x'.repeat(513) }],
      [
        'too many entries',
        Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v'])),
      ],
    ])('attributes with %s are refused', async (_label, attributes) => {
      const s = await subject()
      const { a } = s.organizations
      await expect(
        s.store.upsert(a, [{ id: 'v', vector: vec(s, 1), attributes }])
      ).rejects.toMatchObject(invalid)
      await expect(
        s.store.search(a, { vector: vec(s, 1), topK: 1, filter: attributes })
      ).rejects.toMatchObject(invalid)
      await expect(s.store.deleteByFilter(a, attributes)).rejects.toMatchObject(invalid)
    })

    test('storing an id again replaces its vector and attributes, and doing it twice changes nothing', async () => {
      const s = await subject()
      const { a } = s.organizations
      await s.store.upsert(a, [{ id: 'v', vector: vec(s, 1), attributes: { n: 1 } }])
      const replacement = [{ id: 'v', vector: vec(s, 0, 1), attributes: { n: 2 } }]
      await s.store.upsert(a, replacement)
      await s.store.upsert(a, replacement)
      const hits = await s.store.search(a, { vector: vec(s, 0, 1), topK: 10 })
      expect(ids(hits)).toEqual(['v'])
      expect(hits[0]?.score).toBeCloseTo(1, 4)
      expect(hits[0]?.attributes).toEqual({ n: 2 })
    })

    describe('setAttributes', () => {
      const query = (s: VectorStoreSubject) => ({ vector: vec(s, 1, 1, 0), topK: 10 })

      test('merges the attributes, leaves the others and the vector as they were', async () => {
        const s = await subject()
        const { a } = s.organizations
        await seed(s)
        const before = await s.store.search(a, query(s))

        const missing = await s.store.setAttributes(a, ['x', 'xy'], { outcome: 'won', seq: 2 })
        const after = await s.store.search(a, query(s))

        expect(missing).toEqual([])
        expect(after.map((hit) => [hit.id, hit.score])).toEqual(
          before.map((hit) => [hit.id, hit.score])
        )
        const byId = Object.fromEntries(after.map((hit) => [hit.id, hit.attributes]))
        expect(byId.x).toEqual({ document_id: 'doc_1', page: 1, outcome: 'won', seq: 2 })
        expect(byId.xy).toEqual({
          document_id: 'doc_2',
          page: 1,
          final: true,
          outcome: 'won',
          seq: 2,
        })
        expect(byId.y).toEqual({ document_id: 'doc_1', page: 2 })
        expect(byId.z).toEqual({})
      })

      test('overwrites a value that exists and keeps the rest', async () => {
        const s = await subject()
        const { a } = s.organizations
        await seed(s)
        await s.store.setAttributes(a, ['x'], { page: 9 })
        const hit = (await s.store.search(a, query(s))).find((item) => item.id === 'x')

        expect(hit?.attributes).toEqual({ document_id: 'doc_1', page: 9 })
      })

      test('reports ids it did not find, in order, and does not create them', async () => {
        const s = await subject()
        const { a } = s.organizations
        await seed(s)
        const missing = await s.store.setAttributes(a, ['nope', 'x', 'gone'], { outcome: 'lost' })

        expect(missing).toEqual(['nope', 'gone'])
        const all = await s.store.search(a, { vector: vec(s, 1), topK: 100 })
        expect(ids(all).sort()).toEqual(['x', 'xy', 'y', 'z'])
        expect(await s.store.setAttributes(s.organizations.b, ['x'], { n: 1 })).toEqual(['x'])
      })

      test('an Organization with no vectors reports every id and creates nothing', async () => {
        const s = await subject()
        const { a } = s.organizations

        expect(await s.store.setAttributes(a, ['x', 'y'], { n: 1 })).toEqual(['x', 'y'])
        expect(await s.store.search(a, { vector: vec(s, 1), topK: 10 })).toEqual([])
      })

      test('more than the upsert maximum, none, or a repeated id is refused and records nothing', async () => {
        const s = await subject()
        const { a } = s.organizations
        await seed(s)
        const many = ['x', ...Array.from({ length: 500 }, (_, i) => `v${i}`)]

        await expect(s.store.setAttributes(a, many, { n: 1 })).rejects.toMatchObject(invalid)
        await expect(s.store.setAttributes(a, [], { n: 1 })).rejects.toMatchObject(invalid)
        await expect(s.store.setAttributes(a, ['x', 'x'], { n: 1 })).rejects.toMatchObject(invalid)
        await expect(s.store.setAttributes(a, ['bad id'], { n: 1 })).rejects.toMatchObject(invalid)
        const atMax = Array.from({ length: 500 }, (_, i) => `v${i}`)
        expect(await s.store.setAttributes(a, atMax, { n: 1 })).toHaveLength(500)
        const x = (await s.store.search(a, { vector: vec(s, 1), topK: 1 }))[0]
        expect(x?.attributes).toEqual({ document_id: 'doc_1', page: 1 })
      })

      test("a second Organization's vectors with the same ids are untouched", async () => {
        const s = await subject()
        const { a, b } = s.organizations
        await seed(s, a)
        await seed(s, b)
        await s.store.setAttributes(a, ['x', 'y'], { outcome: 'won' })
        const other = await s.store.search(b, {
          vector: vec(s, 1),
          topK: 10,
          filter: { outcome: 'won' },
        })

        expect(other).toEqual([])
        const mine = await s.store.search(a, {
          vector: vec(s, 1),
          topK: 10,
          filter: { outcome: 'won' },
        })
        expect(ids(mine).sort()).toEqual(['x', 'y'])
      })

      test('repeating the call changes nothing', async () => {
        const s = await subject()
        const { a } = s.organizations
        await seed(s)
        await s.store.setAttributes(a, ['x', 'nope'], { outcome: 'won' })
        const once = await s.store.search(a, query(s))
        const missing = await s.store.setAttributes(a, ['x', 'nope'], { outcome: 'won' })

        expect(missing).toEqual(['nope'])
        expect(await s.store.search(a, query(s))).toEqual(once)
      })

      test('a filter on the changed attribute sees the new value and not the old', async () => {
        const s = await subject()
        const { a } = s.organizations
        await seed(s)
        await s.store.setAttributes(a, ['x'], { outcome: 'open' })
        await s.store.setAttributes(a, ['x'], { outcome: 'won' })
        const search = (outcome: string) =>
          s.store.search(a, { vector: vec(s, 1), topK: 10, filter: { outcome } })

        expect(ids(await search('won'))).toEqual(['x'])
        expect(await search('open')).toEqual([])
      })

      test.each([
        ['no entries', {}],
        ['the reserved name id', { id: 'x' }],
        ['the reserved name vector', { vector: 'x' }],
        ['an upper-case name', { Document: 'x' }],
        ['an array value', { tags: ['x'] as unknown as string }],
        ['a null value', { n: null as unknown as string }],
        ['a non-finite number', { n: Number.NaN }],
        ['a long string', { n: 'x'.repeat(513) }],
        [
          'too many entries',
          Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v'])),
        ],
      ])('attributes with %s are refused and change nothing', async (_label, attributes) => {
        const s = await subject()
        const { a } = s.organizations
        await seed(s)

        await expect(s.store.setAttributes(a, ['x'], attributes)).rejects.toMatchObject(invalid)
        const x = (await s.store.search(a, { vector: vec(s, 1), topK: 1 }))[0]
        expect(x?.attributes).toEqual({ document_id: 'doc_1', page: 1 })
      })

      test('a merge that would give a vector more than 16 attributes is refused and writes nothing', async () => {
        const s = await subject()
        const { a } = s.organizations
        await s.store.upsert(a, [
          {
            id: 'full',
            vector: vec(s, 1),
            attributes: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, 1])),
          },
          { id: 'room', vector: vec(s, 0, 1), attributes: { k0: 1 } },
        ])

        await expect(
          s.store.setAttributes(a, ['room', 'full'], { extra: 1 })
        ).rejects.toMatchObject(invalid)
        const room = (await s.store.search(a, { vector: vec(s, 0, 1), topK: 2 })).find(
          (hit) => hit.id === 'room'
        )
        expect(room?.attributes).toEqual({ k0: 1 })
        expect(await s.store.setAttributes(a, ['full'], { k0: 2 })).toEqual([])
      })

      test('an invalid Organization id is refused', async () => {
        const s = await subject()

        await expect(s.store.setAttributes('not an org', ['x'], { n: 1 })).rejects.toMatchObject(
          invalid
        )
      })
    })

    test('deleting by id removes those vectors, ignores unknown ids and can be repeated', async () => {
      const s = await subject()
      const { a } = s.organizations
      await seed(s)
      await s.store.delete(a, ['x', 'missing'])
      await s.store.delete(a, ['x', 'missing'])
      expect(ids(await s.store.search(a, { vector: vec(s, 1, 1, 1), topK: 10 })).sort()).toEqual([
        'xy',
        'y',
        'z',
      ])
    })

    test('deleting by filter removes the matching vectors only, and an empty filter is refused', async () => {
      const s = await subject()
      const { a } = s.organizations
      await seed(s)
      await expect(s.store.deleteByFilter(a, {})).rejects.toMatchObject(invalid)
      await s.store.deleteByFilter(a, { document_id: 'doc_1' })
      await s.store.deleteByFilter(a, { document_id: 'doc_1' })
      await s.store.deleteByFilter(a, { document_id: 'never' })
      expect(ids(await s.store.search(a, { vector: vec(s, 1, 1, 1), topK: 10 })).sort()).toEqual([
        'xy',
        'z',
      ])
    })

    test("a second Organization cannot search, overwrite or delete the first one's vectors", async () => {
      const s = await subject()
      const { a, b } = s.organizations
      await seed(s, a)
      expect(await s.store.search(b, { vector: vec(s, 1, 0, 0), topK: 100 })).toEqual([])
      expect(
        await s.store.search(b, {
          vector: vec(s, 1, 0, 0),
          topK: 100,
          filter: { document_id: 'doc_1' },
        })
      ).toEqual([])
      await s.store.upsert(b, [
        { id: 'x', vector: vec(s, 0, 0, 1), attributes: { document_id: 'b_doc' } },
      ])
      await s.store.delete(b, ['y', 'xy'])
      await s.store.deleteByFilter(b, { document_id: 'doc_1' })
      const mine = await s.store.search(a, { vector: vec(s, 1, 0, 0), topK: 100 })
      expect(ids(mine).sort()).toEqual(['x', 'xy', 'y', 'z'])
      expect(mine.find((hit) => hit.id === 'x')?.attributes).toEqual({
        document_id: 'doc_1',
        page: 1,
      })
      const theirs = await s.store.search(b, { vector: vec(s, 1, 0, 0), topK: 100 })
      expect(ids(theirs)).toEqual(['x'])
      expect(theirs[0]?.attributes).toEqual({ document_id: 'b_doc' })
    })

    test('an Organization whose id starts with another id is a different Organization', async () => {
      const s = await subject()
      const { a, aExtended } = s.organizations
      await s.store.upsert(a, [{ id: 'one', vector: vec(s, 1) }])
      await s.store.upsert(aExtended, [{ id: 'two', vector: vec(s, 1) }])
      expect(ids(await s.store.search(a, { vector: vec(s, 1), topK: 10 }))).toEqual(['one'])
      expect(ids(await s.store.search(aExtended, { vector: vec(s, 1), topK: 10 }))).toEqual(['two'])
      await s.store.delete(a, ['two'])
      await s.store.deleteByFilter(a, { n: 1 })
      expect(ids(await s.store.search(aExtended, { vector: vec(s, 1), topK: 10 }))).toEqual(['two'])
    })

    test('an id of exactly 64 characters is accepted', async () => {
      const s = await subject()
      const { a } = s.organizations
      const id = 'x'.repeat(64)
      await s.store.upsert(a, [{ id, vector: vec(s, 1) }])
      expect(ids(await s.store.search(a, { vector: vec(s, 1), topK: 1 }))).toEqual([id])
    })

    test('deleting everything an Organization has leaves other Organizations alone and can be repeated', async () => {
      const s = await subject()
      const { a, b, aExtended } = s.organizations
      await seed(s, a)
      await seed(s, b)
      await seed(s, aExtended)
      await s.store.deleteAll(a)
      await s.store.deleteAll(a)
      await s.store.deleteAll(`${a.slice(0, -1)}9`)
      expect(await s.store.search(a, { vector: vec(s, 1, 1, 1), topK: 10 })).toEqual([])
      expect(await s.store.search(b, { vector: vec(s, 1, 1, 1), topK: 10 })).toHaveLength(4)
      expect(await s.store.search(aExtended, { vector: vec(s, 1, 1, 1), topK: 10 })).toHaveLength(4)
      await s.store.upsert(a, [{ id: 'again', vector: vec(s, 1) }])
      expect(ids(await s.store.search(a, { vector: vec(s, 1), topK: 10 }))).toEqual(['again'])
    })

    test('warming an Organization changes nothing and works with or without data', async () => {
      const s = await subject()
      const { a, b } = s.organizations
      await s.store.warm(b)
      await seed(s, a)
      await s.store.warm(a)
      await s.store.warm(a)
      expect(await s.store.search(a, { vector: vec(s, 1, 1, 1), topK: 10 })).toHaveLength(4)
      expect(await s.store.search(b, { vector: vec(s, 1, 1, 1), topK: 10 })).toEqual([])
    })

    test.each([
      ['empty', ''],
      ['a path', 'org/../x'],
      ['a separator', 'x/y'],
      ['an encoded separator', 'x%2Fy'],
      ['a wildcard', 'x*'],
      ['too long', 'x'.repeat(65)],
    ])('an Organization id that is %s is refused by every operation', async (_label, id) => {
      const s = await subject()
      await expect(s.store.upsert(id, [{ id: 'v', vector: vec(s, 1) }])).rejects.toMatchObject(
        invalid
      )
      await expect(s.store.search(id, { vector: vec(s, 1), topK: 1 })).rejects.toMatchObject(
        invalid
      )
      await expect(s.store.delete(id, ['v'])).rejects.toMatchObject(invalid)
      await expect(s.store.deleteByFilter(id, { n: 1 })).rejects.toMatchObject(invalid)
      await expect(s.store.deleteAll(id)).rejects.toMatchObject(invalid)
      await expect(s.store.warm(id)).rejects.toMatchObject(invalid)
    })
  })
}
