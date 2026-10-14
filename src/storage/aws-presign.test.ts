import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createMemoryLogger } from '../testing'
import { createS3ObjectStore, type S3Sender } from './aws'

const ORG = `org_${'1'.repeat(32)}`
const NAMES = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_EC2_METADATA_DISABLED',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
]
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const name of NAMES) {
    saved[name] = process.env[name]
  }
  process.env.AWS_ACCESS_KEY_ID = 'AKIATESTTESTTESTTEST'
  process.env.AWS_SECRET_ACCESS_KEY = 'secretsecretsecretsecretsecretsecret00'
  delete process.env.AWS_SESSION_TOKEN
})
afterEach(() => {
  for (const name of NAMES) {
    if (saved[name] === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = saved[name]
    }
  }
})

// The signer only computes a signature: nothing here reaches the network.
const noNetwork: S3Sender = {
  send: async () => {
    throw new Error('presigning must not send a request')
  },
}

function store(extra: Partial<Parameters<typeof createS3ObjectStore>[0]> = {}) {
  return createS3ObjectStore({
    bucket: 'closeline-test',
    region: 'eu-west-1',
    environment: 'dev',
    client: noNetwork,
    ...extra,
  })
}

describe('S3 presigned reads', () => {
  test('signs a GET for the Organization-scoped location, with the expiry asked for', async () => {
    const url = new URL(await store().presignGet(ORG, 'rec/one.mp3', { expiresInSeconds: 120 }))

    expect(url.protocol).toBe('https:')
    expect(url.host).toBe('closeline-test.s3.eu-west-1.amazonaws.com')
    expect(url.pathname).toBe(`/orgs/${ORG}/rec/one.mp3`)
    expect(url.searchParams.get('X-Amz-Expires')).toBe('120')
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
  })

  test('defaults to 300 seconds and refuses more than 900', async () => {
    const s3 = store()

    expect(new URL(await s3.presignGet(ORG, 'k')).searchParams.get('X-Amz-Expires')).toBe('300')
    expect(
      new URL(await s3.presignGet(ORG, 'k', { expiresInSeconds: 900 })).searchParams.get(
        'X-Amz-Expires'
      )
    ).toBe('900')
    await expect(s3.presignGet(ORG, 'k', { expiresInSeconds: 901 })).rejects.toMatchObject({
      code: 'storage.invalid_request',
    })
  })

  test('another Organization gets another location', async () => {
    const other = `org_${'2'.repeat(32)}`
    const s3 = store()

    expect(new URL(await s3.presignGet(other, 'k')).pathname).toBe(`/orgs/${other}/k`)
  })

  test('logs nothing, and a failed signature is an error without the URL or key', async () => {
    const logger = createMemoryLogger()
    const s3 = store({ logger })
    await s3.presignGet(ORG, 'rec/one.mp3')
    expect(logger.entries).toEqual([])

    // A new store, so its signer finds no credentials: no variables, no files, no metadata service.
    delete process.env.AWS_ACCESS_KEY_ID
    delete process.env.AWS_SECRET_ACCESS_KEY
    process.env.AWS_EC2_METADATA_DISABLED = 'true'
    process.env.AWS_SHARED_CREDENTIALS_FILE = '/nonexistent/credentials'
    process.env.AWS_CONFIG_FILE = '/nonexistent/config'
    try {
      await store({ logger }).presignGet(ORG, 'rec/secret-name.mp3')
      throw new Error('no credentials, yet it signed')
    } catch (error) {
      expect(error).toMatchObject({ name: 'StorageError' })
      expect(String((error as Error).message)).not.toContain('secret-name')
      expect(JSON.stringify(error)).not.toContain('X-Amz')
    }
  })
})
