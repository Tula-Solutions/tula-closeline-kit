import { organizationIdSchema } from 'tula-closeline-contract'
import { telephonyBehaviour } from './behaviour'
import { createMemoryTelephony } from './memory'

const orgA = organizationIdSchema.parse(`org_${'a'.repeat(32)}`)
const orgB = organizationIdSchema.parse(`org_${'b'.repeat(32)}`)

telephonyBehaviour('memory adapter', async () => {
  const telephony = createMemoryTelephony()
  const numbers = {
    answers: '+14155550111',
    no_answer: '+14155550112',
    busy: '+14155550113',
    hangs_up_during_disclosure: '+14155550114',
    carrier_failure: '+14155550115',
  } as const
  telephony.script(numbers.no_answer, { kind: 'no_answer' })
  telephony.script(numbers.busy, { kind: 'busy' })
  telephony.script(numbers.hangs_up_during_disclosure, {
    kind: 'hangs_up',
    when: 'during_disclosure',
  })
  telephony.script(numbers.carrier_failure, { kind: 'carrier_failure', reason: 'carrier_dropped' })
  return {
    telephony,
    organizations: { a: orgA, b: orgB },
    numberFor: (scenario) => numbers[scenario],
    receiveInbound: (organizationId) =>
      telephony.receiveInbound(
        organizationIdSchema.parse(organizationId),
        '+14155550199',
        '+14155550100'
      ),
    prospectHangsUp: (organizationId, providerCallId) =>
      telephony.prospectHangsUp(organizationIdSchema.parse(organizationId), providerCallId),
    stallNext: (operation) => telephony.stallNext(operation),
    failNext: (operation) => telephony.failNext(operation, 'telephony.unavailable'),
    takeEvents: () => telephony.takeEvents(),
    signedWebhook: (event) => telephony.webhookFor(event),
    close: async () => undefined,
  }
})
