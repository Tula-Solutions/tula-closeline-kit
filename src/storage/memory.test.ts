import { describe, expect, test } from 'bun:test'
import { createFixedClock } from '../clock'
import { createMemoryObjectStore } from './memory'
import { DEFAULT_MAX_OBJECT_BYTES, MAX_OBJECT_BYTES_LIMIT } from './port'

const ORG = `org_${'1'.repeat(32)}`
const OTHER = `org_${'2'.repeat(32)}`

describe('the memory object store', () => {
  test("by default only the contract's Organization id format is accepted", async () => {
    const store = createMemoryObjectStore()
    for (const id of [
      'org_a',
      'a'.repeat(36),
      `org_${'1'.repeat(31)}`,
      `${ORG}0`,
      ORG.toUpperCase(),
    ]) {
      await expect(store.put(id, 'k', new Uint8Array())).rejects.toMatchObject({
        code: 'storage.invalid_request',
      })
    }
    await store.put(ORG, 'k', new Uint8Array([1]))
    expect((await store.get(ORG, 'k'))?.size).toBe(1)
  })

  test('a stricter id rule can be added but the character rule cannot be loosened', async () => {
    const store = createMemoryObjectStore({ isOrganizationId: () => true })
    await store.put('tenant-1', 'k', new Uint8Array())
    await expect(store.put('tenant/1', 'k', new Uint8Array())).rejects.toMatchObject({
      code: 'storage.invalid_request',
    })
    await expect(store.put('..', 'k', new Uint8Array())).rejects.toMatchObject({
      code: 'storage.invalid_request',
    })
  })

  test('lastModified comes from the clock and a rewrite moves it', async () => {
    const clock = createFixedClock('2026-01-01T00:00:00.000Z')
    const store = createMemoryObjectStore({ clock })
    await store.put(ORG, 'k', new Uint8Array([1]))
    clock.advance('1h')
    const first = await store.head(ORG, 'k')
    expect(first?.lastModified).toEqual(new Date('2026-01-01T00:00:00.000Z'))
    await store.put(ORG, 'k', new Uint8Array([2]))
    expect((await store.head(ORG, 'k'))?.lastModified).toEqual(new Date('2026-01-01T01:00:00.000Z'))
  })

  test('changing a returned date does not change the store', async () => {
    const store = createMemoryObjectStore({ clock: createFixedClock('2026-01-01T00:00:00.000Z') })
    await store.put(ORG, 'k', new Uint8Array())
    ;(await store.head(ORG, 'k'))?.lastModified.setFullYear(1999)
    expect((await store.head(ORG, 'k'))?.lastModified.getUTCFullYear()).toBe(2026)
  })

  test('the size limit defaults to 25 MiB and cannot be configured above 100 MiB', () => {
    expect(DEFAULT_MAX_OBJECT_BYTES).toBe(25 * 1024 * 1024)
    for (const bad of [0, -1, 1.5, MAX_OBJECT_BYTES_LIMIT + 1]) {
      expect(() => createMemoryObjectStore({ maxObjectBytes: bad })).toThrow(TypeError)
    }
    expect(() => createMemoryObjectStore({ maxObjectBytes: MAX_OBJECT_BYTES_LIMIT })).not.toThrow()
  })

  test('an error never carries the key, the Organization id or the content', async () => {
    const store = createMemoryObjectStore()
    const secret = 'top-secret-name.txt'
    const failures = [
      store.put(ORG, `../${secret}`, new Uint8Array()),
      store.put(ORG, secret, new Uint8Array(DEFAULT_MAX_OBJECT_BYTES + 1)),
      store.put(OTHER, secret, new Uint8Array(), { contentType: 'bad type' }),
    ]
    for (const failure of failures) {
      const error = await failure.catch((e: Error) => e)
      expect(error).toBeInstanceOf(Error)
      expect(JSON.stringify(error)).not.toContain(secret)
      expect((error as Error).message).not.toContain(secret)
      expect((error as Error).message).not.toContain(OTHER)
    }
  })
})
