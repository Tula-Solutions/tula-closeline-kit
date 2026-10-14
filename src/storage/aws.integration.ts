import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { createS3ObjectStore } from './aws'
import { objectStoreBehaviour } from './behaviour'

/**
 * Runs the shared behaviour suite against the S3 adapter on S3Mock, the S3-compatible stand-in of
 * the hub's local stack (and of this repo's `compose.yaml`, which creates the bucket). It is an
 * integration test: `bun test src` does not pick it up; `bun run test:integration` runs it, and CI
 * starts `compose.yaml` first. It never reaches AWS: the endpoint override is only accepted for
 * `ENVIRONMENT=local`, and an endpoint that is not on the loopback interface or the `storage`
 * compose host is refused here.
 *
 * Without `STORAGE_TEST_ENDPOINT` it is skipped with a notice on a developer machine, and fails
 * when `CI` is set, so CI cannot pass by running nothing.
 */
const endpoint = process.env.STORAGE_TEST_ENDPOINT
const BUCKET = process.env.STORAGE_TEST_BUCKET ?? 'closeline-kit-test'
const LOCAL_ENDPOINT = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]|storage)(:\d+)?\/?$/
const MAX_OBJECT_BYTES = 2048

if (endpoint === undefined || endpoint === '') {
  if (process.env.CI !== undefined && process.env.CI !== '') {
    throw new Error('CI is set but STORAGE_TEST_ENDPOINT is not: the S3 suite would run nothing')
  }
  process.stderr.write(
    'SKIPPED: the S3 adapter was not run against S3Mock. Run `docker compose up -d --wait` and `bun run test:integration`.' +
      '\n'
  )
  objectStoreBehaviour(
    'S3 adapter on S3Mock',
    async () => Promise.reject(new Error('skipped')),
    true
  )
} else if (!LOCAL_ENDPOINT.test(endpoint)) {
  throw new Error('STORAGE_TEST_ENDPOINT must be a local http endpoint, never AWS')
} else {
  setDefaultTimeout(30_000)
  objectStoreBehaviour('S3 adapter on S3Mock', async () => {
    // The adapter takes credentials from the default chain only, so give the chain some.
    process.env.AWS_ACCESS_KEY_ID ??= 'test'
    process.env.AWS_SECRET_ACCESS_KEY ??= 'test'
    // Fresh Organizations for every test, so a test never sees another's leftovers.
    const hex = crypto.randomUUID().replaceAll('-', '')
    const a = `org_${hex}`
    const organizations = {
      a,
      b: `org_${crypto.randomUUID().replaceAll('-', '')}`,
      aExtended: `${a}ff`,
    }
    const store = createS3ObjectStore({
      bucket: BUCKET,
      region: 'eu-west-1',
      environment: 'local',
      endpoint,
      maxObjectBytes: MAX_OBJECT_BYTES,
      // The suite needs an id that starts with another id, which the contract format cannot have.
      isOrganizationId: () => true,
    })
    return {
      store,
      organizations,
      maxObjectBytes: MAX_OBJECT_BYTES,
      // A real GET of the presigned URL, as the vendor would make. S3Mock serves it without
      // checking the signature or the expiry, so those two are covered by the offline signer test.
      readPresigned: async (url) => {
        const response = await fetch(url)
        return response.ok ? new Uint8Array(await response.arrayBuffer()) : undefined
      },
      close: async () => {
        for (const id of Object.values(organizations)) {
          let cursor: string | undefined
          do {
            const page = await store.list(id, {
              limit: 1000,
              ...(cursor === undefined ? {} : { cursor }),
            })
            await Promise.all(page.items.map((item) => store.delete(id, item.key)))
            cursor = page.nextCursor
          } while (cursor !== undefined)
        }
      },
    }
  })

  describe('S3 adapter on S3Mock: multipart', () => {
    // 12 MiB with parts of 5 MiB is a real multipart upload of three parts on the stand-in.
    test('a streamed put of about 12 MiB reads back byte for byte with its SHA-256', async () => {
      process.env.AWS_ACCESS_KEY_ID ??= 'test'
      process.env.AWS_SECRET_ACCESS_KEY ??= 'test'
      const org = `org_${crypto.randomUUID().replaceAll('-', '')}`
      const store = createS3ObjectStore({
        bucket: BUCKET,
        region: 'eu-west-1',
        environment: 'local',
        endpoint,
        partBytes: 5 * 1024 * 1024,
        isOrganizationId: () => true,
      })
      const total = 12 * 1024 * 1024 + 4321
      const source = new Uint8Array(total)
      let x = 0x9e3779b9
      for (let i = 0; i < total; i++) {
        x ^= x << 13
        x ^= x >>> 17
        x ^= x << 5
        source[i] = x & 0xff
      }
      async function* chunks(): AsyncGenerator<Uint8Array> {
        for (let at = 0; at < total; at += 100_003) {
          yield source.slice(at, Math.min(at + 100_003, total))
        }
      }

      try {
        const result = await store.putStream(org, 'rec/big.bin', chunks(), {
          maxBytes: 20 * 1024 * 1024,
          contentType: 'audio/wav',
        })
        expect(result).toEqual({
          size: total,
          sha256: createHash('sha256').update(source).digest('hex'),
        })
        const got = await store.getStream(org, 'rec/big.bin')
        expect(got?.size).toBe(total)
        const back = new Uint8Array(await new Response(got?.body).arrayBuffer())
        expect(createHash('sha256').update(back).digest('hex')).toBe(result.sha256)
        expect(Buffer.from(back).equals(Buffer.from(source))).toBe(true)
        await expect(
          store.putStream(org, 'rec/over.bin', chunks(), { maxBytes: 8 * 1024 * 1024 })
        ).rejects.toMatchObject({ code: 'storage.object_too_large' })
        expect(await store.head(org, 'rec/over.bin')).toBeUndefined()
      } finally {
        await store.delete(org, 'rec/big.bin')
      }
    }, 60_000)
  })
}
