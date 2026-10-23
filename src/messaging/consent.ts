import type { ContactCheckId } from 'tula-closeline-contract'
import type { ContactGuard } from '../consent/port'
import { AttemptAborted, type MessagingDeadline, raceAbort } from './deadline'
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

/** The id of the Contact Check that allowed a message. */
export interface ConsentProof {
  /** The check about the Prospect and the number it goes to. */
  consentCheckId: ContactCheckId
}

/**
 * Asks the Contact Check whether this message may be sent (ADR 0003), once, about the Prospect
 * and the number it goes to together: the check binds the number to the Prospect's stored
 * identities, reads suppression on the number and consent on the Prospect. Anything but a clear
 * allowance, including a guard that throws or answers oddly, is `messaging.consent_denied`; a
 * guard that outlasts the send's deadline or the caller's signal is `messaging.timeout` or
 * `messaging.aborted`. Nothing is logged and the vendor is not called.
 */
export async function requireConsent(
  guard: ContactGuard,
  request: CheckedSendRequest,
  deadline: MessagingDeadline
): Promise<ConsentProof> {
  let result: Awaited<ReturnType<ContactGuard['check']>>
  try {
    result = await raceAbort(
      Promise.resolve().then(() =>
        guard.check({
          organizationId: request.organizationId,
          prospectId: request.prospectId,
          phone: request.to,
          channel: request.channel,
          purpose: request.purpose,
        })
      ),
      deadline.signal
    )
  } catch (error) {
    if (error instanceof AttemptAborted) {
      deadline.check()
    }
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
  return { consentCheckId: result.checkId }
}
