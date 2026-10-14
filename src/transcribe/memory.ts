import { createHash } from 'node:crypto'
import type { OrganizationIdCheck } from '../organization'
import type { Environment } from '../reporting/env'
import { TRANSCRIBER_ERROR_CODES, TranscriberError, type TranscriberErrorCode } from './errors'
import type {
  Transcriber,
  TranscriptionEntry,
  TranscriptionFailure,
  TranscriptionPage,
  TranscriptionResult,
  TranscriptTurn,
} from './port'
import { checkTranscriptionResult } from './result'
import {
  type CheckedRequest,
  createTranscriberValidator,
  encodeReferenceCursor,
  sameSend,
} from './validate'

/** What a scripted send ends as. */
export interface ScriptedOutcome {
  /** How many reads answer `pending` before the result; default 1. */
  pendingReads?: number
  /** The final state. */
  result:
    | { status: 'done'; durationMs: number; turns: TranscriptTurn[] }
    | { status: 'failed'; reason: TranscriptionFailure }
}

/** A copy the stand-in still holds, as a test sees it (never the audio URL or the text). */
export interface HeldCopy {
  /** The Organization. */
  organizationId: string
  /** The client reference. */
  clientReference: string
  /** The stand-in's own id for it, which a caller may never have stored. */
  vendorId: string
  /** Its state now, without consuming a pending read. */
  status: 'pending' | 'done' | 'failed'
}

/** The operations a test can make fail. */
export type TranscriberOperation = 'submit' | 'getResult' | 'delete' | 'list'

/** Options for {@link createMemoryTranscriber}. */
export interface MemoryTranscriberOptions {
  /** Extra Organization id rule; the contract's format by default. */
  isOrganizationId?: OrganizationIdCheck
  /** The `ENVIRONMENT` to behave as: plain `http:` URLs are accepted only in `local`; default `local`. */
  environment?: Environment
  /** Chooses what a send ends as when no outcome was scripted for its reference. */
  outcome?: (request: {
    speakers: 'split_channels' | 'diarize'
    maxSpeakers?: number
  }) => ScriptedOutcome
}

/** A {@link Transcriber} in the process with scripting and inspection, for tests. Not for production. */
export interface MemoryTranscriber extends Transcriber {
  /**
   * Sets what the send with this reference ends as, before or after it is submitted (a later script
   * replaces the earlier one and restarts the pending reads). Validated like a send.
   */
  script(organizationId: string, clientReference: string, outcome: ScriptedOutcome): void
  /** Makes the next `times` (default 1) calls of `operation` throw a TranscriberError with `code`, changing nothing. */
  failNext(operation: TranscriberOperation, code: TranscriberErrorCode, times?: number): void
  /**
   * Makes the next `times` (default 1) submits accept the send, keep the copy, and then throw
   * `transcriber.unavailable`: the vendor has the audio and the caller never learned it.
   */
  acceptThenFailNext(times?: number): void
  /** The copies still held, for one Organization or all, in Organization then reference order. */
  copies(organizationId?: string): HeldCopy[]
}

interface Copy {
  request: CheckedRequest
  vendorId: string
  pendingReads: number
  outcome: ScriptedOutcome['result']
}

function defaultTurns(request: CheckedRequest): TranscriptTurn[] {
  const split = request.speakers === 'split_channels'
  return [0, 1, 2, 3].map((index) => {
    const channel = index % 2
    return {
      speaker: split ? `ch${channel}` : channel === 0 ? 'A' : 'B',
      ...(split ? { channel } : {}),
      startMs: index * 5_000,
      endMs: index * 5_000 + 4_000,
      text: `Turn ${index + 1} of the scripted conversation.`,
    }
  })
}

function defaultOutcome(request: CheckedRequest): ScriptedOutcome {
  return {
    pendingReads: 1,
    result: { status: 'done', durationMs: 20_000, turns: defaultTurns(request) },
  }
}

function checkOutcome(outcome: ScriptedOutcome): ScriptedOutcome {
  // A scripted result must be one a real vendor could legitimately return.
  checkTranscriptionResult(outcome.result)
  const reads = outcome.pendingReads ?? 1
  if (!Number.isInteger(reads) || reads < 0 || reads > 1000) {
    throw new TypeError('pendingReads must be a whole number from 0 to 1000')
  }
  return { pendingReads: reads, result: outcome.result }
}

/**
 * Creates a {@link Transcriber} in memory. Deterministic: a send answers `pending` for its
 * scripted number of reads (one by default) and then a fixed four-turn conversation, or whatever
 * was scripted. Each Organization has its own map, so no reference can reach another Organization's
 * sends. Complexity: submit, getResult and delete O(1); list O(n log n) in the Organization's n
 * sends.
 */
export function createMemoryTranscriber(options: MemoryTranscriberOptions = {}): MemoryTranscriber {
  const check = createTranscriberValidator({
    isOrganizationId: options.isOrganizationId,
    environment: options.environment ?? 'local',
  })
  const organizations = new Map<string, Map<string, Copy>>()
  const scripts = new Map<string, ScriptedOutcome>()
  const failures: Array<{ operation: TranscriberOperation; code: TranscriberErrorCode }> = []
  let acceptThenFail = 0

  const vendorIdOf = (org: string, reference: string) =>
    `mem_${createHash('sha256').update(`${org}\u0000${reference}`).digest('hex').slice(0, 20)}`
  const scriptKey = (org: string, reference: string) => `${org}\u0000${reference}`
  function maybeFail(operation: TranscriberOperation): void {
    const at = failures.findIndex((entry) => entry.operation === operation)
    if (at >= 0) {
      const [entry] = failures.splice(at, 1)
      throw new TranscriberError(
        (entry as { code: TranscriberErrorCode }).code,
        'the scripted failure of the stand-in'
      )
    }
  }
  const stateOf = (copy: Copy, consume: boolean): TranscriptionResult => {
    if (copy.pendingReads > 0) {
      if (consume) {
        copy.pendingReads -= 1
      }
      return { status: 'pending' }
    }
    return copy.outcome.status === 'done'
      ? {
          status: 'done',
          durationMs: copy.outcome.durationMs,
          turns: copy.outcome.turns.map((turn) => ({ ...turn })),
        }
      : { status: 'failed', reason: copy.outcome.reason }
  }

  return {
    async submit(organizationId, request) {
      maybeFail('submit')
      const org = check.organization(organizationId)
      const checked = check.request(request)
      let sends = organizations.get(org)
      if (sends === undefined) {
        sends = new Map()
        organizations.set(org, sends)
      }
      const existing = sends.get(checked.clientReference)
      if (existing !== undefined) {
        if (!sameSend(existing.request, checked)) {
          throw new TranscriberError(
            TRANSCRIBER_ERROR_CODES.conflict,
            'the client reference is already used by a different send'
          )
        }
        return {
          clientReference: checked.clientReference,
          created: false,
          vendorId: existing.vendorId,
        }
      }
      const scripted =
        scripts.get(scriptKey(org, checked.clientReference)) ??
        options.outcome?.({
          speakers: checked.speakers,
          ...(checked.maxSpeakers === undefined ? {} : { maxSpeakers: checked.maxSpeakers }),
        }) ??
        defaultOutcome(checked)
      const outcome = checkOutcome(scripted)
      const vendorId = vendorIdOf(org, checked.clientReference)
      sends.set(checked.clientReference, {
        request: checked,
        vendorId,
        pendingReads: outcome.pendingReads ?? 1,
        outcome: outcome.result,
      })
      if (acceptThenFail > 0) {
        acceptThenFail -= 1
        throw new TranscriberError(
          TRANSCRIBER_ERROR_CODES.unavailable,
          'the stand-in accepted the send and then failed to answer'
        )
      }
      return { clientReference: checked.clientReference, created: true, vendorId }
    },

    async getResult(organizationId, clientReference, hint) {
      maybeFail('getResult')
      const org = check.organization(organizationId)
      const reference = check.reference(clientReference)
      // A hint is validated and then ignored: the copy is always the one this reference names in
      // this Organization, so an id of another send or Organization can never redirect the call.
      check.hint(hint)
      const copy = organizations.get(org)?.get(reference)
      return copy === undefined ? undefined : stateOf(copy, true)
    },

    async delete(organizationId, clientReference, hint) {
      maybeFail('delete')
      const org = check.organization(organizationId)
      const reference = check.reference(clientReference)
      check.hint(hint)
      const existed = organizations.get(org)?.delete(reference) === true
      scripts.delete(scriptKey(org, reference))
      return { existed }
    },

    async list(organizationId, listOptions) {
      maybeFail('list')
      const org = check.organization(organizationId)
      const { prefix, after, limit } = check.list(listOptions)
      const matches: Array<[string, Copy]> = []
      for (const pair of organizations.get(org) ?? []) {
        if (pair[0].startsWith(prefix) && (after === undefined || pair[0] > after)) {
          matches.push(pair)
        }
      }
      matches.sort((x, y) => (x[0] < y[0] ? -1 : 1))
      const items: TranscriptionEntry[] = matches
        .slice(0, limit)
        .map(([clientReference, copy]) => ({
          clientReference,
          vendorId: copy.vendorId,
          status: stateOf(copy, false).status,
        }))
      const last = items.at(-1)
      const page: TranscriptionPage = { items }
      if (matches.length > limit && last !== undefined) {
        page.nextCursor = encodeReferenceCursor(last.clientReference)
      }
      return page
    },

    script(organizationId, clientReference, outcome) {
      const org = check.organization(organizationId)
      const reference = check.reference(clientReference)
      const checked = checkOutcome(outcome)
      scripts.set(scriptKey(org, reference), checked)
      const copy = organizations.get(org)?.get(reference)
      if (copy !== undefined) {
        copy.outcome = checked.result
        copy.pendingReads = checked.pendingReads ?? 1
      }
    },

    failNext(operation, code, times = 1) {
      for (let i = 0; i < times; i++) {
        failures.push({ operation, code })
      }
    },

    acceptThenFailNext(times = 1) {
      acceptThenFail += times
    },

    copies(organizationId) {
      const held: HeldCopy[] = []
      for (const [org, sends] of [...organizations].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
        if (organizationId !== undefined && org !== organizationId) {
          continue
        }
        for (const [clientReference, copy] of [...sends].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
          held.push({
            organizationId: org,
            clientReference,
            vendorId: copy.vendorId,
            status: stateOf(copy, false).status,
          })
        }
      }
      return held
    },
  }
}
