import type { ContactCheckId } from 'tula-closeline-contract'
import type { ContactGuard } from '../consent/port'
import { MESSAGING_ERROR_CODES, MessagingError } from './errors'
import type { CheckedSendRequest } from './validate'

const DENIAL_CODES: readonly string[] = [
  'consent.missing',
  'consent.withdrawn',
  'consent.suppressed',
  'consent.unavailable',
]

function denied(code: string): MessagingError {
  return new MessagingError(
    MESSAGING_ERROR_CODES.consentDenied,
    'The Contact Check did not allow this message',
    {
      details: { code: DENIAL_CODES.includes(code) ? code : 'consent.unavailable' },
    }
  )
}

/**
 * Asks the Contact Check whether this message may be sent (ADR 0003) and returns the id of the
 * check that allowed it. Anything but a clear allowance, including a guard that throws or answers
 * oddly, is `messaging.consent_denied`; the check is not logged and the vendor is not called.
 */
export async function requireConsent(
  guard: ContactGuard,
  request: CheckedSendRequest
): Promise<ContactCheckId> {
  let result: Awaited<ReturnType<ContactGuard['check']>>
  try {
    result = await guard.check({
      organizationId: request.organizationId,
      prospectId: request.prospectId,
      channel: request.channel,
      purpose: request.purpose,
    })
  } catch {
    throw denied('consent.unavailable')
  }
  if (typeof result !== 'object' || result === null || result.allowed !== true) {
    throw denied(
      typeof result === 'object' && result !== null && 'code' in result
        ? String(result.code)
        : 'consent.unavailable'
    )
  }
  if (typeof result.checkId !== 'string') {
    throw denied('consent.unavailable')
  }
  return result.checkId
}
