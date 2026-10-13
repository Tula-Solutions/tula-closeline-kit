import { afterEach, describe, expect, test } from 'bun:test'
import type { ObjectStore } from './port'

/** What the behaviour suite needs from an adapter under test. */
export interface ObjectStoreSubject {
  /** The store under test, empty for the Organizations below. */
  store: ObjectStore
  /** Three Organization ids the store accepts, none empty of data: B is unrelated, and `aExtended` starts with `a`. */
  organizations: { a: string; b: string; aExtended: string }
  /** The store's `maxObjectBytes`, small (a few KiB) so the suite can cross it. */
  maxObjectBytes: number
  /** Removes what the subject created. */
  close(): Promise<void>
}

/**
 * True when two content types are the same media type: `type/subtype` equal ignoring case, and the
 * parameters equal as a set, names ignoring case and values exact. A store may normalise the
 * whitespace around parameters (`a; b=c` against `a;b=c`), so a raw string comparison is wrong.
 */
function sameMediaType(x: string | undefined, y: string): boolean {
  if (x === undefined) {
    return false
  }
  const parse = (value: string) => {
    const [type = '', ...params] = value.split(';')
    return {
      type: type.trim().toLowerCase(),
      params: params
        .map((param) => {
          const at = param.indexOf('=')
          return `${param.slice(0, at).trim().toLowerCase()}=${param.slice(at + 1).trim()}`
        })
        .sort(),
    }
  }
  const left = parse(x)
  const right = parse(y)
  return left.type === right.type && left.params.join(';') === right.params.join(';')
}

const bytes = (text: string) => new TextEncoder().encode(text)
const text = (data: Uint8Array) => new TextDecoder().decode(data)

/**
 * The behaviour every {@link ObjectStore} must show. Run it with {@link objectStoreBehaviour}
 * against the memory adapter and against the S3 adapter on its stand-in; a change that passes for
 * one and fails for the other is a bug in one of them.
 */
export function objectStoreBehaviour(
  name: string,
  make: () => Promise<ObjectStoreSubject>,
  skip = false
): void {
  const run = skip ? describe.skip : describe
  run(`ObjectStore behaviour: ${name}`, () => {
    const open: ObjectStoreSubject[] = []
    afterEach(async () => {
      await Promise.all(open.splice(0).map((subject) => subject.close()))
    })
    async function subject(): Promise<ObjectStoreSubject> {
      const made = await make()
      open.push(made)
      return made
    }
    async function keysOf(s: ObjectStoreSubject, org: string, prefix?: string): Promise<string[]> {
      const keys: string[] = []
      let cursor: string | undefined
      for (let page = 0; page < 50; page++) {
        const got = await s.store.list(org, {
          ...(prefix === undefined ? {} : { prefix }),
          ...(cursor === undefined ? {} : { cursor }),
          limit: 1000,
        })
        keys.push(...got.items.map((item) => item.key))
        cursor = got.nextCursor
        if (cursor === undefined) {
          break
        }
      }
      return keys
    }

    const BAD_KEYS = [
      '',
      '/',
      '/a',
      'a/',
      'a//b',
      '.',
      '..',
      '../a',
      'a/..',
      'a/../b',
      'a/./b',
      '.hidden',
      'a/.hidden',
      '%2e%2e/a',
      'a%2fb',
      'a\\b',
      'a b',
      'a\u0000b',
      'a\nb',
      'café',
      `${'a/'.repeat(16)}a`,
      'x'.repeat(513),
      `${'x'.repeat(129)}`,
    ]

    test.each(BAD_KEYS.map((key) => [JSON.stringify(key.slice(0, 40)), key]))(
      'the key %s is refused by every operation',
      async (_label, key) => {
        const s = await subject()
        const { a } = s.organizations
        const code = { code: 'storage.invalid_request' }
        await expect(s.store.put(a, key, bytes('x'))).rejects.toMatchObject(code)
        await expect(s.store.get(a, key)).rejects.toMatchObject(code)
        await expect(s.store.head(a, key)).rejects.toMatchObject(code)
        await expect(s.store.delete(a, key)).rejects.toMatchObject(code)
      }
    )

    test.each([
      ['empty', ''],
      ['a path', 'org/../x'],
      ['a separator', '/x'],
      ['an encoded separator', 'x%2Fy'],
      ['a dot segment', '..'],
      ['a wildcard', 'x*'],
      ['spaces', 'x y'],
      ['too long', 'x'.repeat(65)],
    ])('an Organization id that is %s is refused', async (_label, id) => {
      const s = await subject()
      const code = { code: 'storage.invalid_request' }
      await expect(s.store.put(id, 'k', bytes('x'))).rejects.toMatchObject(code)
      await expect(s.store.get(id, 'k')).rejects.toMatchObject(code)
      await expect(s.store.head(id, 'k')).rejects.toMatchObject(code)
      await expect(s.store.delete(id, 'k')).rejects.toMatchObject(code)
      await expect(s.store.list(id)).rejects.toMatchObject(code)
    })

    test('an id built from another Organization id and a path does not reach it', async () => {
      const s = await subject()
      const { a, b } = s.organizations
      await s.store.put(b, 'secret.txt', bytes('b only'))
      for (const id of [`${a}/../${b}`, `${a}/${b}`, `../${b}`, `${b}/`, `${b}/.`]) {
        await expect(s.store.get(id, 'secret.txt')).rejects.toMatchObject({
          code: 'storage.invalid_request',
        })
        await expect(s.store.list(id)).rejects.toMatchObject({ code: 'storage.invalid_request' })
      }
    })

    test('an object comes back as written, with its content type as given', async () => {
      const s = await subject()
      const { a } = s.organizations
      await s.store.put(a, 'docs/one.txt', bytes('hello'), {
        contentType: 'text/plain; charset=utf-8',
      })
      const got = await s.store.get(a, 'docs/one.txt')
      expect(got?.key).toBe('docs/one.txt')
      expect(text(got?.body ?? new Uint8Array())).toBe('hello')
      expect(got?.size).toBe(5)
      expect(sameMediaType(got?.contentType, 'text/plain; charset=utf-8')).toBe(true)
      expect(got?.lastModified).toBeInstanceOf(Date)
      expect(Number.isNaN(got?.lastModified.getTime())).toBe(false)
      const info = await s.store.head(a, 'docs/one.txt')
      expect(info).toMatchObject({ key: 'docs/one.txt', size: 5 })
      expect(sameMediaType(info?.contentType, 'text/plain; charset=utf-8')).toBe(true)
    })

    test('a content type without parameters comes back byte for byte', async () => {
      const s = await subject()
      const { a } = s.organizations
      await s.store.put(a, 'a.pdf', bytes('%PDF'), { contentType: 'application/pdf' })
      expect((await s.store.get(a, 'a.pdf'))?.contentType).toBe('application/pdf')
      expect((await s.store.head(a, 'a.pdf'))?.contentType).toBe('application/pdf')
    })

    test('a different media type or parameter value is not the same content type', async () => {
      const s = await subject()
      const { a } = s.organizations
      await s.store.put(a, 'k', bytes('x'), { contentType: 'text/plain; charset=utf-8' })
      const got = await s.store.head(a, 'k')
      expect(sameMediaType(got?.contentType, 'text/html; charset=utf-8')).toBe(false)
      expect(sameMediaType(got?.contentType, 'text/plain; charset=latin1')).toBe(false)
      expect(sameMediaType(got?.contentType, 'text/plain')).toBe(false)
    })

    test('without a content type the store says application/octet-stream', async () => {
      const s = await subject()
      const { a } = s.organizations
      await s.store.put(a, 'blob', new Uint8Array([0, 255, 1, 254]))
      const got = await s.store.get(a, 'blob')
      expect(got?.contentType).toBe('application/octet-stream')
      expect([...(got?.body ?? [])]).toEqual([0, 255, 1, 254])
    })

    test('content is stored as bytes whatever its content type claims', async () => {
      const s = await subject()
      const { a } = s.organizations
      const html = bytes('<script>alert(1)</script>')
      await s.store.put(a, 'liar.png', html, { contentType: 'image/png' })
      const got = await s.store.get(a, 'liar.png')
      expect(text(got?.body ?? new Uint8Array())).toBe('<script>alert(1)</script>')
      expect(got?.contentType).toBe('image/png')
    })

    test('an empty object is stored', async () => {
      const s = await subject()
      const { a } = s.organizations
      await s.store.put(a, 'empty', new Uint8Array())
      expect((await s.store.get(a, 'empty'))?.size).toBe(0)
    })

    test.each([
      ['no slash', 'text'],
      ['a header break', 'text/plain\r\nx-injected: 1'],
      ['spaces in the type', 'te xt/plain'],
      ['a quote-less parameter name', 'text/plain; =x'],
      ['an empty string', ''],
      ['too long', `text/${'x'.repeat(260)}`],
    ])('a content type with %s is refused and nothing is stored', async (_label, contentType) => {
      const s = await subject()
      const { a } = s.organizations
      await expect(s.store.put(a, 'k', bytes('x'), { contentType })).rejects.toMatchObject({
        code: 'storage.invalid_request',
      })
      expect(await s.store.head(a, 'k')).toBeUndefined()
    })

    test('a body that is not bytes is refused', async () => {
      const s = await subject()
      const { a } = s.organizations
      await expect(s.store.put(a, 'k', 'text' as unknown as Uint8Array)).rejects.toMatchObject({
        code: 'storage.invalid_request',
      })
    })

    test('an object over the size limit is refused and the limit itself is accepted', async () => {
      const s = await subject()
      const { a } = s.organizations
      await expect(
        s.store.put(a, 'big', new Uint8Array(s.maxObjectBytes + 1))
      ).rejects.toMatchObject({ code: 'storage.object_too_large' })
      expect(await s.store.head(a, 'big')).toBeUndefined()
      await s.store.put(a, 'edge', new Uint8Array(s.maxObjectBytes))
      expect((await s.store.head(a, 'edge'))?.size).toBe(s.maxObjectBytes)
    })

    test('a missing object reads as undefined', async () => {
      const s = await subject()
      const { a } = s.organizations
      expect(await s.store.get(a, 'nothing')).toBeUndefined()
      expect(await s.store.head(a, 'nothing')).toBeUndefined()
    })

    test('writing a key again replaces the object, and writing the same thing twice changes nothing', async () => {
      const s = await subject()
      const { a } = s.organizations
      await s.store.put(a, 'k', bytes('one'), { contentType: 'text/plain' })
      await s.store.put(a, 'k', bytes('two'), { contentType: 'text/csv' })
      await s.store.put(a, 'k', bytes('two'), { contentType: 'text/csv' })
      const got = await s.store.get(a, 'k')
      expect(text(got?.body ?? new Uint8Array())).toBe('two')
      expect(got?.contentType).toBe('text/csv')
      expect(await keysOf(s, a)).toEqual(['k'])
    })

    test('deleting removes the object, and deleting again or deleting nothing resolves', async () => {
      const s = await subject()
      const { a } = s.organizations
      await s.store.put(a, 'k', bytes('x'))
      await s.store.delete(a, 'k')
      expect(await s.store.get(a, 'k')).toBeUndefined()
      await s.store.delete(a, 'k')
      await s.store.delete(a, 'never-existed')
    })

    test("a second Organization cannot read, head, list or delete the first one's objects", async () => {
      const s = await subject()
      const { a, b } = s.organizations
      await s.store.put(a, 'docs/plan.txt', bytes('a secret'))
      expect(await s.store.get(b, 'docs/plan.txt')).toBeUndefined()
      expect(await s.store.head(b, 'docs/plan.txt')).toBeUndefined()
      expect(await keysOf(s, b)).toEqual([])
      expect(await keysOf(s, b, 'docs/')).toEqual([])
      await s.store.delete(b, 'docs/plan.txt')
      expect(text((await s.store.get(a, 'docs/plan.txt'))?.body ?? new Uint8Array())).toBe(
        'a secret'
      )
    })

    test('the same key in two Organizations holds two objects', async () => {
      const s = await subject()
      const { a, b } = s.organizations
      await s.store.put(a, 'same', bytes('from a'))
      await s.store.put(b, 'same', bytes('from b'))
      expect(text((await s.store.get(a, 'same'))?.body ?? new Uint8Array())).toBe('from a')
      expect(text((await s.store.get(b, 'same'))?.body ?? new Uint8Array())).toBe('from b')
      await s.store.delete(a, 'same')
      expect(text((await s.store.get(b, 'same'))?.body ?? new Uint8Array())).toBe('from b')
    })

    test('an Organization whose id starts with another id is a different Organization', async () => {
      const s = await subject()
      const { a, aExtended } = s.organizations
      await s.store.put(a, 'one', bytes('a'))
      await s.store.put(aExtended, 'two', bytes('extended'))
      expect(await keysOf(s, a)).toEqual(['one'])
      expect(await keysOf(s, aExtended)).toEqual(['two'])
      expect(await s.store.get(a, 'two')).toBeUndefined()
      expect(await s.store.get(aExtended, 'one')).toBeUndefined()
      await s.store.delete(a, 'two')
      expect(await keysOf(s, aExtended)).toEqual(['two'])
    })

    test('a key cannot name another Organization through a path', async () => {
      const s = await subject()
      const { a, b } = s.organizations
      await s.store.put(b, 'secret.txt', bytes('b only'))
      for (const key of [
        `../${b}/secret.txt`,
        `/${b}/secret.txt`,
        `${b}/../${b}/secret.txt`,
        `..%2f${b}%2fsecret.txt`,
      ]) {
        await expect(s.store.get(a, key)).rejects.toMatchObject({ code: 'storage.invalid_request' })
        await expect(s.store.delete(a, key)).rejects.toMatchObject({
          code: 'storage.invalid_request',
        })
      }
      for (const prefix of ['../', `../${b}/`, '/', `${a}/../${b}/`, '%2e%2e/', '*', '..']) {
        await expect(s.store.list(a, { prefix })).rejects.toMatchObject({
          code: 'storage.invalid_request',
        })
      }
      expect(text((await s.store.get(b, 'secret.txt'))?.body ?? new Uint8Array())).toBe('b only')
    })

    test('a list is a page, in key order, that ends with no cursor', async () => {
      const s = await subject()
      const { a } = s.organizations
      for (const key of ['c', 'a', 'b/2', 'b/1', 'd']) {
        await s.store.put(a, key, bytes(key))
      }
      const seen: string[] = []
      let cursor: string | undefined
      let pages = 0
      do {
        const page = await s.store.list(a, {
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        })
        expect(page.items.length).toBeLessThanOrEqual(2)
        seen.push(...page.items.map((item) => item.key))
        for (const item of page.items) {
          expect(item.size).toBe(item.key.length)
          expect(item.lastModified).toBeInstanceOf(Date)
        }
        cursor = page.nextCursor
        pages += 1
      } while (cursor !== undefined && pages < 10)
      expect(seen).toEqual(['a', 'b/1', 'b/2', 'c', 'd'])
      expect(pages).toBe(3)
    })

    test('a list without a limit returns at most 100', async () => {
      const s = await subject()
      const { a } = s.organizations
      await Promise.all(
        Array.from({ length: 105 }, (_, i) =>
          s.store.put(a, `n${String(i).padStart(3, '0')}`, bytes('x'))
        )
      )
      const page = await s.store.list(a)
      expect(page.items).toHaveLength(100)
      expect(page.nextCursor).toBeDefined()
      const rest = await s.store.list(a, { cursor: page.nextCursor as string })
      expect(rest.items).toHaveLength(5)
      expect(rest.nextCursor).toBeUndefined()
    })

    test('a prefix keeps only the keys that start with it', async () => {
      const s = await subject()
      const { a } = s.organizations
      for (const key of ['docs/a.txt', 'docs/b.txt', 'docs2/c.txt', 'other/d.txt', 'docsx']) {
        await s.store.put(a, key, bytes('x'))
      }
      expect(await keysOf(s, a, 'docs/')).toEqual(['docs/a.txt', 'docs/b.txt'])
      expect(await keysOf(s, a, 'docs/a')).toEqual(['docs/a.txt'])
      expect(await keysOf(s, a, 'docs')).toEqual([
        'docs/a.txt',
        'docs/b.txt',
        'docs2/c.txt',
        'docsx',
      ])
      expect(await keysOf(s, a, 'nothing/')).toEqual([])
    })

    test.each([[0], [-1], [1001], [1.5], [Number.NaN]])(
      'a list limit of %p is refused',
      async (limit) => {
        const s = await subject()
        await expect(s.store.list(s.organizations.a, { limit })).rejects.toMatchObject({
          code: 'storage.invalid_request',
        })
      }
    )

    test('a forged cursor is refused', async () => {
      const s = await subject()
      const { a } = s.organizations
      const forged = [
        'not a cursor!',
        '',
        Buffer.from('../x').toString('base64url'),
        Buffer.from('/x').toString('base64url'),
        Buffer.from(`${a}/../x`).toString('base64url'),
        `${Buffer.from('k').toString('base64url')}=`,
        'a'.repeat(701),
      ]
      for (const cursor of forged) {
        await expect(s.store.list(a, { cursor })).rejects.toMatchObject({
          code: 'storage.invalid_request',
        })
      }
    })

    test("one Organization's cursor used by another lists only the second one's objects", async () => {
      const s = await subject()
      const { a, b } = s.organizations
      for (const key of ['k1', 'k2', 'k3']) {
        await s.store.put(a, key, bytes('a'))
      }
      await s.store.put(b, 'k9', bytes('b'))
      const page = await s.store.list(a, { limit: 1 })
      const cursor = page.nextCursor as string
      const other = await s.store.list(b, { cursor })
      expect(other.items.map((item) => item.key)).toEqual(['k9'])
    })

    test('the body that get returns is a copy', async () => {
      const s = await subject()
      const { a } = s.organizations
      const original = bytes('keep')
      await s.store.put(a, 'k', original)
      original[0] = 0
      const first = await s.store.get(a, 'k')
      ;(first?.body as Uint8Array)[1] = 0
      expect(text((await s.store.get(a, 'k'))?.body ?? new Uint8Array())).toBe('keep')
    })
  })
}
