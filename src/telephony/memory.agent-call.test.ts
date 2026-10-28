import { organizationIdSchema } from 'tula-closeline-contract'
import { agentCallBehaviour } from './agent-call.behaviour'
import { createMemoryTelephony } from './memory'

const orgA = organizationIdSchema.parse(`org_${'a'.repeat(32)}`)
const orgB = organizationIdSchema.parse(`org_${'b'.repeat(32)}`)

agentCallBehaviour('memory adapter', async () => {
  const telephony = createMemoryTelephony()
  const numbers = {
    human: '+14155550201',
    machine: '+14155550202',
    unknown: '+14155550203',
    busy: '+14155550204',
    no_answer: '+14155550205',
    carrier_failure: '+14155550206',
  } as const
  telephony.script(numbers.human, { kind: 'answers' })
  telephony.script(numbers.machine, { kind: 'answers', detection: 'machine' })
  telephony.script(numbers.unknown, { kind: 'answers', detection: 'unknown' })
  telephony.script(numbers.busy, { kind: 'busy' })
  telephony.script(numbers.no_answer, { kind: 'no_answer' })
  telephony.script(numbers.carrier_failure, { kind: 'carrier_failure' })
  return {
    telephony,
    organizations: { a: orgA, b: orgB },
    numberFor: (scenario) => numbers[scenario],
    settle: (organizationId, providerCallId) =>
      telephony.ring(organizationIdSchema.parse(organizationId), providerCallId),
    failNext: () => telephony.failNext('placeAgentCall', 'telephony.unavailable'),
    stallNext: () => telephony.stallNext('placeAgentCall'),
    takeEvents: () => telephony.takeEvents(),
  }
})
