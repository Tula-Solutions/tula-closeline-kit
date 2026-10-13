import { setDefaultTimeout } from 'bun:test'
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
}
