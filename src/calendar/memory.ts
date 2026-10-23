import type { OrganizationId } from 'tula-closeline-contract'
import type { Logger } from '../logger'
import { type Sleep, systemSleep } from '../queue/sleep'
import type { ErrorReporter } from '../reporting/port'
import { CalendarConnection } from './connection'
import { startCalendarDeadline, withCalendarRetry } from './deadline'
import { CALENDAR_ERROR_CODES, CalendarError } from './errors'
import {
  type BusyInterval,
  type CalendarBusyRequest,
  type CalendarCallOptions,
  type CalendarConnectRequest,
  type CalendarCreateRequest,
  type CalendarDeleteRequest,
  type CalendarEventChanges,
  type CalendarEventCreated,
  type CalendarEventInput,
  type CalendarEventRef,
  type CalendarPort,
  type CalendarRequestBase,
  type CalendarUpdateRequest,
  MAX_BUSY_INTERVALS,
} from './port'
import {
  checkBase,
  checkChanges,
  checkEvent,
  checkEventId,
  checkEventTimes,
  checkGrant,
  checkOptions,
  checkOrganizationId,
  checkRange,
  checkRequestId,
  invalid,
} from './validate'

/** The codes the vendor can be made to fail with. */
export type CalendarScriptedFailure = 'calendar.unavailable' | 'calendar.rejected'

/** What a test sees of one vendor request (never a title, an address or a token). */
export interface MemoryCalendarRequestView {
  /** Which call made it. */
  kind: 'connect' | 'busy' | 'create' | 'update' | 'delete' | 'revoke'
  /** The Organization. */
  organizationId: OrganizationId
  /** True once the request's AbortSignal fired while it was still pending. */
  aborted: boolean
  /** How it ended: still going, answered, failed or aborted. */
  outcome: 'pending' | 'ok' | 'failed' | 'aborted'
}

/** An event the memory calendar holds; for assertions only. */
export interface MemoryCalendarEvent {
  /** The event id. */
  eventId: string
  /** The title. */
  title: string
  /** The start, ISO UTC. */
  start: string
  /** The end, ISO UTC. */
  end: string
  /** The notes. */
  description?: string
  /** The place. */
  location?: string
  /** The invitees. */
  attendees: { email: string; name?: string }[]
  /** The join link, if video was asked for. */
  joinUrl?: string
}

/** Options for {@link createMemoryCalendar}. */
export interface MemoryCalendarOptions {
  /** Receives the errors that mean the vendor failed; nothing if absent. */
  reporter?: ErrorReporter
  /** Where retries are noted (metadata only); nothing if absent. */
  logger?: Logger
  /** Pauses between retries; real time by default. */
  sleep?: Sleep
  /** A number in `[0, 1)` for the jitter; `Math.random` by default. */
  random?: () => number
}

/** A {@link CalendarPort} that keeps calendars in the process, for tests. Not for production. */
export interface MemoryCalendar extends CalendarPort {
  /** Makes the vendor accept a grant whose code or refresh token is `secret`; any other grant is refused (`calendar.rejected`). */
  allowGrant(secret: string): void
  /** Adds a busy block the vendor holds that no event of ours made, such as the Rep's own meeting. */
  addBusy(connection: CalendarConnection, interval: BusyInterval): void
  /** Makes the next `times` (default 1) vendor requests fail with `code` before any effect. */
  failNext(code: CalendarScriptedFailure, times?: number): void
  /** Makes the next `times` (default 1) vendor requests take effect and then fail with `calendar.unavailable`, as a lost response does. */
  loseNextResponse(times?: number): void
  /** Makes the next vendor request never answer, until it is aborted. */
  hangNext(): void
  /** The Rep revokes access at the vendor, so the connection stops working with `calendar.revoked`. */
  revokeAtProvider(connection: CalendarConnection): void
  /** The events now on the calendar of `connection`, in creation order. */
  events(connection: CalendarConnection): MemoryCalendarEvent[]
  /** Every vendor request so far, in order; a retry is a request of its own. */
  requests(): MemoryCalendarRequestView[]
}

type Step = { kind: 'fail'; code: CalendarScriptedFailure } | { kind: 'lose' } | { kind: 'hang' }

interface Stored {
  eventId: string
  title: string
  startMs: number
  endMs: number
  description?: string
  location?: string
  attendees: { email: string; name?: string }[]
  joinUrl?: string
}

interface Account {
  organizationId: OrganizationId
  revoked: boolean
  events: Map<string, Stored>
  foreignBusy: { startMs: number; endMs: number }[]
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function ref(event: Stored): CalendarEventRef {
  return {
    eventId: event.eventId,
    start: iso(event.startMs),
    end: iso(event.endMs),
    ...(event.joinUrl === undefined ? {} : { joinUrl: event.joinUrl }),
  }
}

/**
 * Builds a {@link CalendarPort} for tests with calendars held in memory. It keeps the rules a
 * real adapter must: validation before any vendor call, a hard timeout that aborts the vendor
 * request, idempotent writes by request id (also across a lost response), bounded jittered
 * retries of `calendar.unavailable` only, `calendar.revoked` after a revoke, and no token, title
 * or address in logs, reports or errors. Not for production.
 */
export function createMemoryCalendar(options: MemoryCalendarOptions = {}): MemoryCalendar {
  const sleep = options.sleep ?? systemSleep
  const allowed = new Set<string>()
  const accounts = new Map<string, Account>()
  const replays = new Map<string, { fingerprint: string; result: unknown }>()
  const script: Step[] = []
  const requests: { view: MemoryCalendarRequestView }[] = []
  let serial = 0

  function report(error: unknown, organizationId: OrganizationId) {
    if (
      !(error instanceof CalendarError) ||
      (error.code !== CALENDAR_ERROR_CODES.unavailable &&
        error.code !== CALENDAR_ERROR_CODES.rejected)
    ) {
      return
    }
    try {
      options.reporter?.capture(error, { organizationId, tags: { feature: 'calendar' } })
    } catch {
      // Reporting must never turn an error into a different one.
    }
  }

  function account(connection: CalendarConnection): Account {
    const found = accounts.get(connection.connectionId)
    if (found === undefined || found.organizationId !== connection.organizationId) {
      invalid('connection')
    }
    return found
  }

  /** One vendor request: scripted failure or hang, the revoked check, then the effect. */
  async function vendorRequest<T>(
    kind: MemoryCalendarRequestView['kind'],
    organizationId: OrganizationId,
    signal: AbortSignal,
    connection: CalendarConnection | undefined,
    effect: () => T
  ): Promise<T> {
    const entry = { view: { kind, organizationId, aborted: false, outcome: 'pending' as const } }
    const view: MemoryCalendarRequestView = entry.view
    requests.push(entry)
    signal.addEventListener(
      'abort',
      () => {
        if (view.outcome === 'pending') {
          view.aborted = true
          view.outcome = 'aborted'
        }
      },
      { once: true }
    )
    const abortedError = () =>
      new CalendarError(CALENDAR_ERROR_CODES.aborted, 'The call was cancelled')
    const fail = (error: CalendarError): never => {
      if (view.outcome === 'pending') {
        view.outcome = 'failed'
      }
      throw error
    }
    if (signal.aborted) {
      throw abortedError()
    }
    if (connection !== undefined && kind !== 'revoke' && account(connection).revoked) {
      fail(new CalendarError(CALENDAR_ERROR_CODES.revoked, 'The calendar connection was revoked'))
    }
    const step = script.shift()
    if (step?.kind === 'fail') {
      fail(new CalendarError(step.code, 'The vendor failed'))
    }
    if (step?.kind === 'hang') {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
      throw abortedError()
    }
    let result: T
    try {
      result = effect()
    } catch (error) {
      view.outcome = 'failed'
      throw error
    }
    if (step?.kind === 'lose') {
      fail(new CalendarError(CALENDAR_ERROR_CODES.unavailable, 'The vendor connection was lost'))
    }
    view.outcome = 'ok'
    return result
  }

  /** The whole call: options, deadline, bounded retry, reporting. */
  async function call<T>(
    kind: MemoryCalendarRequestView['kind'],
    organizationId: OrganizationId,
    connection: CalendarConnection | undefined,
    callOptions: CalendarCallOptions | undefined,
    effect: () => T
  ): Promise<T> {
    const checked = checkOptions(callOptions)
    const deadline = startCalendarDeadline(checked.timeoutMs, checked.signal)
    try {
      return await withCalendarRetry(
        () => vendorRequest(kind, organizationId, deadline.signal, connection, effect),
        {
          policy: kind === 'connect' ? { ...checked.retry, maxRetries: 0 } : checked.retry,
          deadline,
          sleep,
          ...(options.random === undefined ? {} : { random: options.random }),
          onRetry: (retry, delayMs) =>
            options.logger?.warn('A calendar call is retrying', { kind, retry, delayMs }),
        }
      )
    } catch (error) {
      report(error, organizationId)
      throw error
    } finally {
      deadline.stop()
    }
  }

  /** A repeat of a write returns the first result; the same id with other content is refused. */
  function replay<T>(
    key: string,
    fingerprint: string,
    make: () => T
  ): { result: T; first: boolean } {
    const seen = replays.get(key)
    if (seen !== undefined) {
      if (seen.fingerprint !== fingerprint) {
        invalid('requestId')
      }
      return { result: seen.result as T, first: false }
    }
    const result = make()
    replays.set(key, { fingerprint, result })
    return { result, first: true }
  }

  function busyIntervals(acct: Account, fromMs: number, toMs: number): BusyInterval[] {
    const blocks = [
      ...acct.foreignBusy,
      ...[...acct.events.values()].map((e) => ({ startMs: e.startMs, endMs: e.endMs })),
    ]
      .map((b) => ({ startMs: Math.max(b.startMs, fromMs), endMs: Math.min(b.endMs, toMs) }))
      .filter((b) => b.startMs < b.endMs)
      .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
    const merged: { startMs: number; endMs: number }[] = []
    for (const block of blocks) {
      const last = merged.at(-1)
      if (last !== undefined && block.startMs <= last.endMs) {
        last.endMs = Math.max(last.endMs, block.endMs)
      } else {
        merged.push({ ...block })
      }
    }
    if (merged.length > MAX_BUSY_INTERVALS) {
      throw new CalendarError(
        CALENDAR_ERROR_CODES.rejected,
        'The calendar has too many busy intervals',
        {
          details: { reason: 'too_many_intervals', max: MAX_BUSY_INTERVALS },
        }
      )
    }
    return merged.map((b) => ({ start: iso(b.startMs), end: iso(b.endMs) }))
  }

  function fingerprintOf(value: unknown): string {
    return JSON.stringify(value)
  }

  function eventFromInput(input: CalendarEventInput, startMs: number, endMs: number): Stored {
    serial += 1
    const eventId = `evt_${serial}_${crypto.randomUUID()}`
    return {
      eventId,
      title: input.title,
      startMs,
      endMs,
      attendees: (input.attendees ?? []).map((a) => ({ ...a })),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.location === undefined ? {} : { location: input.location }),
      ...(input.conferencing === 'video' ? { joinUrl: `https://meet.memory.test/${eventId}` } : {}),
    }
  }

  const port: MemoryCalendar = {
    async connect(request: CalendarConnectRequest, callOptions) {
      checkOrganizationId(request?.organizationId)
      const grant = checkGrant(request.grant)
      const secret = grant.kind === 'authorization_code' ? grant.code : grant.refreshToken
      return call('connect', request.organizationId, undefined, callOptions, () => {
        if (!allowed.has(secret)) {
          throw new CalendarError(CALENDAR_ERROR_CODES.rejected, 'The vendor refused the grant')
        }
        serial += 1
        const connectionId = `calconn_${serial}_${crypto.randomUUID()}`
        accounts.set(connectionId, {
          organizationId: request.organizationId,
          revoked: false,
          events: new Map(),
          foreignBusy: [],
        })
        return new CalendarConnection({
          organizationId: request.organizationId,
          provider: 'memory',
          connectionId,
          credential: `access-${connectionId}-${secret}`,
        })
      })
    },

    async busy(request: CalendarBusyRequest, callOptions) {
      const connection = checkBase(request)
      const { fromMs, toMs } = checkRange(request.from, request.to)
      return call('busy', request.organizationId, connection, callOptions, () =>
        busyIntervals(account(connection), fromMs, toMs)
      )
    },

    async createEvent(request: CalendarCreateRequest, callOptions): Promise<CalendarEventCreated> {
      const connection = checkBase(request)
      const requestId = checkRequestId(request.requestId)
      const { event, startMs, endMs } = checkEvent(request.event)
      return call('create', request.organizationId, connection, callOptions, () => {
        const acct = account(connection)
        const { result, first } = replay(
          `${connection.connectionId}:create:${requestId}`,
          fingerprintOf({
            ...event,
            start: startMs,
            end: endMs,
            conferencing: event.conferencing ?? 'none',
          }),
          () => {
            const stored = eventFromInput(event, startMs, endMs)
            acct.events.set(stored.eventId, stored)
            return stored.eventId
          }
        )
        const stored = acct.events.get(result)
        if (stored === undefined) {
          throw new CalendarError(CALENDAR_ERROR_CODES.rejected, 'The event was removed since', {
            details: { reason: 'event_deleted' },
          })
        }
        return { ...ref(stored), created: first }
      })
    },

    async updateEvent(request: CalendarUpdateRequest, callOptions) {
      const connection = checkBase(request)
      const eventId = checkEventId(request.eventId)
      const requestId = checkRequestId(request.requestId)
      const changes: CalendarEventChanges = checkChanges(request.changes)
      return call('update', request.organizationId, connection, callOptions, () => {
        const acct = account(connection)
        return replay(
          `${connection.connectionId}:update:${requestId}`,
          fingerprintOf({ eventId, changes }),
          (): CalendarEventRef => {
            const stored = acct.events.get(eventId)
            if (stored === undefined) {
              throw new CalendarError(CALENDAR_ERROR_CODES.notFound, 'The event does not exist')
            }
            const startMs = changes.start === undefined ? stored.startMs : Date.parse(changes.start)
            const endMs = changes.end === undefined ? stored.endMs : Date.parse(changes.end)
            checkEventTimes(startMs, endMs)
            stored.startMs = startMs
            stored.endMs = endMs
            if (changes.title !== undefined) {
              stored.title = changes.title
            }
            if (changes.description !== undefined) {
              stored.description = changes.description
            }
            if (changes.location !== undefined) {
              stored.location = changes.location
            }
            if (changes.attendees !== undefined) {
              stored.attendees = changes.attendees.map((a) => ({ ...a }))
            }
            return ref(stored)
          }
        ).result
      })
    },

    async deleteEvent(request: CalendarDeleteRequest, callOptions) {
      const connection = checkBase(request)
      const eventId = checkEventId(request.eventId)
      const requestId = checkRequestId(request.requestId)
      return call('delete', request.organizationId, connection, callOptions, () => {
        const acct = account(connection)
        return replay(
          `${connection.connectionId}:delete:${requestId}`,
          fingerprintOf({ eventId }),
          () => ({ deleted: acct.events.delete(eventId) })
        ).result
      })
    },

    async revoke(request: CalendarRequestBase, callOptions) {
      const connection = checkBase(request)
      await call('revoke', request.organizationId, connection, callOptions, () => {
        account(connection).revoked = true
      })
    },

    allowGrant(secret) {
      allowed.add(secret)
    },
    addBusy(connection, interval) {
      const { fromMs, toMs } = checkRange(interval.start, interval.end)
      account(connection).foreignBusy.push({ startMs: fromMs, endMs: toMs })
    },
    failNext(code, times = 1) {
      for (let i = 0; i < times; i++) {
        script.push({ kind: 'fail', code })
      }
    },
    loseNextResponse(times = 1) {
      for (let i = 0; i < times; i++) {
        script.push({ kind: 'lose' })
      }
    },
    hangNext() {
      script.push({ kind: 'hang' })
    },
    revokeAtProvider(connection) {
      account(connection).revoked = true
    },
    events(connection) {
      return [...account(connection).events.values()].map((e) => ({
        eventId: e.eventId,
        title: e.title,
        start: iso(e.startMs),
        end: iso(e.endMs),
        attendees: e.attendees.map((a) => ({ ...a })),
        ...(e.description === undefined ? {} : { description: e.description }),
        ...(e.location === undefined ? {} : { location: e.location }),
        ...(e.joinUrl === undefined ? {} : { joinUrl: e.joinUrl }),
      }))
    },
    requests() {
      return requests.map((entry) => ({ ...entry.view }))
    },
  }
  return port
}
