import { describe, expect, test } from 'bun:test'
import { formatId, organizationIdSchema, type ProspectId } from 'tula-closeline-contract'
import { createMemoryContactGuard } from '../consent/memory'
import { MESSAGING_ERROR_CODES, MessagingError } from './errors'
import { createMemoryMessaging } from './memory'
import type { SendMessageRequest } from './port'

const orgA = organizationIdSchema.parse(`org_${'a'.repeat(32)}`)
const orgB = organizationIdSchema.parse(`org_${'b'.repeat(32)}`)
const prospect = formatId('prs', '1'.repeat(32)) as ProspectId

function setup() {
  const guard = createMemoryContactGuard()
  for (const org of [orgA, orgB]) {
    guard.allow({ organizationId: org, prospectId: prospect }, 'sms')
    guard.allow({ organizationId: org, phone: '+14155550142' }, 'sms')
  }
  const memory = createMemoryMessaging({ guard, sleep: async () => undefined })
  const req = (over: Partial<SendMessageRequest> = {}): SendMessageRequest => ({
    organizationId: orgA,
    prospectId: prospect,
    channel: 'sms',
    purpose: 'agent_initiated',
    to: '+14155550142',
    content: { kind: 'text', body: 'hello there' },
    idempotencyKey: 'k1',
    ...over,
  })
  return { guard, memory, req }
}

describe('memory messaging', () => {
  test('the same key and content returns the same message without a second vendor call', async () => {
    const { memory, req } = setup()
    const first = await memory.send(req())
    const second = await memory.send(req())
    expect(second.providerMessageId).toBe(first.providerMessageId)
    expect(memory.requests().length).toBe(1)
    expect(memory.sentBodies()).toEqual(['hello there'])
  })

  test('the same key with different content is refused', async () => {
    const { memory, req } = setup()
    await memory.send(req())
    const error = await memory
      .send(req({ content: { kind: 'text', body: 'something else' } }))
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MessagingError)
    expect((error as MessagingError).code).toBe(MESSAGING_ERROR_CODES.invalidRequest)
  })

  test('the consent check is asked again on a deduped call', async () => {
    const { memory, guard, req } = setup()
    await memory.send(req())
    guard.deny({ organizationId: orgA, prospectId: prospect }, 'sms', 'consent.withdrawn')
    const error = await memory.send(req()).catch((e: unknown) => e)
    expect((error as MessagingError).code).toBe(MESSAGING_ERROR_CODES.consentDenied)
    expect(memory.requests().length).toBe(1)
  })

  test('a failed send can be retried under the same key', async () => {
    const { memory, req } = setup()
    memory.failNext('messaging.rejected', 1)
    await memory.send(req()).catch(() => undefined)
    const sent = await memory.send(req())
    expect(sent.providerMessageId).toMatch(/^SM/)
  })

  test('keys are scoped to the Organization', async () => {
    const { memory, req } = setup()
    const a = await memory.send(req())
    const b = await memory.send(req({ organizationId: orgB }))
    expect(a.providerMessageId).not.toBe(b.providerMessageId)
  })

  test('request views hold no text or number', async () => {
    const { memory, req } = setup()
    await memory.send(req())
    const view = JSON.stringify(memory.requests())
    expect(view).not.toContain('hello there')
    expect(view).not.toContain('+1415')
    expect(memory.requests()[0]).toMatchObject({
      contentKind: 'text',
      bodyChars: 11,
      outcome: 'ok',
    })
  })
})
