import { describe, expect, test } from 'bun:test'
import { isSensitiveKey } from './sensitive'

describe('isSensitiveKey', () => {
  test.each([
    'password',
    'apiKey',
    'x-api-key',
    'clientSecret',
    'set-cookie',
    'requestBody',
    'transcript',
    'pass',
    'pwd',
    'passwd',
    'auth',
    'signature',
    'X-Amz-Signature',
    'sig',
    'sid',
    'session',
    'session_id',
    'sessionId',
    'PHPSESSID',
    'AWS_SECRET_ACCESS_KEY',
    'aws_secret_access_key',
    'secretAccessKey',
  ])('%s is sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(true)
  })

  test.each([
    'passenger',
    'bypass',
    'compass',
    'author',
    'authority',
    'design',
    'signal',
    'sidebar',
    'inside',
    'sessionCount',
    'accessKeyId',
    'recordingUrl',
    'isRecording',
    'tokenizer',
    'requestId',
    'status',
  ])('%s is not sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(false)
  })
})
