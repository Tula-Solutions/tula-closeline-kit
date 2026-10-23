import { expect, test } from 'bun:test'
import * as root from './index'
import { PACKAGE } from './index'
import * as testing from './testing'

test('the library reports its own package name', () => {
  expect(PACKAGE).toBe('tula-closeline-kit')
})

test('validation helpers shared by the adapters are not public API', () => {
  const internal = [
    'createStorageValidator',
    'encodeCursor',
    'createVectorValidator',
    'attributesMatch',
    'createOrganizationIdGuard',
    'contractOrganizationIdCheck',
  ]
  for (const name of internal) {
    expect(Object.keys(root)).not.toContain(name)
    expect(Object.keys(testing)).not.toContain(name)
  }
})

test('the ports, errors and limits a consumer needs are exported', () => {
  for (const name of ['StorageError', 'VectorError', 'MAX_KEY_BYTES', 'MAX_TOP_K']) {
    expect(Object.keys(root)).toContain(name)
  }
})

test('the audit recorder port and queue adapter are in the root, the memory adapter in testing', () => {
  for (const name of [
    'AuditError',
    'AUDIT_LIMITS',
    'auditRecordedMessage',
    'createQueueAuditRecorder',
  ]) {
    expect(Object.keys(root)).toContain(name)
  }
  expect(Object.keys(testing)).toContain('createMemoryAuditRecorder')
  expect(Object.keys(root)).not.toContain('createMemoryAuditRecorder')
})
