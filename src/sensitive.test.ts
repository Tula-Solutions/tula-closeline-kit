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
    'user_sid',
    'x-auth',
    'db_pass',
    'DB_PASS',
    'X-Amz-Sig',
    'userSid',
    'dbPass',
    'userSession',
    'admin_session',
    'auth.mode',
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
    'possession',
    'obsession',
    'recession',
    'compassion',
    'passion',
    'passport',
    'authored',
    'signup',
    'sidecar',
    'inside_out',
    'outside',
    'bypass_cache',
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
