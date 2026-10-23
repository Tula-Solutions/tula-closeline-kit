import { formatId, organizationIdSchema, type ProspectId } from 'tula-closeline-contract'
import { messagingBehaviour } from './behaviour'
import {
  ACCOUNT,
  AUTH_TOKEN,
  json,
  OUR_NUMBER,
  queued,
  RECIPIENT,
  type Reply,
  SERVICE,
  signedHook,
  twilioHarness,
} from './twilio.harness'

messagingBehaviour('twilio adapter over a stubbed fetch', async () => {
  const script: Reply[] = []
  const hangs = { next: 0 }
  const h = twilioHarness(() => {
    if (hangs.next > 0) {
      hangs.next -= 1
      return 'hang'
    }
    return script.shift() ?? queued()
  })
  const replies = {
    retryable: () => json(503, { code: 20003, message: 'down' }),
    fatal: () => json(401, { code: 20003, message: 'Authenticate' }),
    opted_out: () => json(400, { code: 21610, message: 'unsubscribed' }),
    template_required: () => json(400, { code: 63016, message: 'template' }),
    bad_response: () => new Response('not json', { status: 201 }),
  }
  return {
    port: h.port,
    guard: h.guard,
    organizations: {
      a: organizationIdSchema.parse(`org_${'a'.repeat(32)}`),
      b: organizationIdSchema.parse(`org_${'b'.repeat(32)}`),
    },
    prospect: formatId('prs', '1'.repeat(32)) as ProspectId,
    recipient: RECIPIENT,
    ourNumber: OUR_NUMBER,
    reporter: h.reporter,
    logs: () => h.logs,
    vendorCalls: () => h.seen.length,
    abortedCalls: () => h.seen.filter((s) => s.aborted).length,
    failNext: (kind, times) => {
      for (let i = 0; i < times; i += 1) {
        script.push(replies[kind]())
      }
    },
    hang: () => {
      hangs.next += 1
    },
    signedInbound: ({ from, to, body, channel, mediaCount }) => {
      const prefix = channel === 'whatsapp' ? 'whatsapp:' : ''
      return signedHook({
        MessageSid: `SM${'cd'.repeat(16)}`,
        From: `${prefix}${from}`,
        To: `${prefix}${to}`,
        Body: body,
        NumMedia: String(mediaCount ?? 0),
      })
    },
    signedStatus: ({ providerMessageId, status, errorCode }) =>
      signedHook({
        MessageSid: providerMessageId,
        MessageStatus: status,
        ...(errorCode === undefined ? {} : { ErrorCode: String(errorCode) }),
      }),
    sign: (fields) => signedHook({ ...fields }),
    secrets: () => [AUTH_TOKEN, ACCOUNT, SERVICE],
    close: async () => undefined,
  }
})
