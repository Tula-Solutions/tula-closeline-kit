import { afterEach, describe, expect, test } from 'bun:test'
import { inspect } from 'node:util'
import type { OrganizationId } from 'tula-closeline-contract'
import type { MemoryErrorReporter } from '../reporting/testing'
import { CalendarConnection } from './connection'
import { CALENDAR_ERROR_CODES, CalendarError } from './errors'
import { type BusyInterval, type CalendarGrant, MAX_BUSY_RANGE_MS } from './port'

/** What the behaviour suite needs from an adapter under test. */
export interface CalendarSubject {
  /** The port under test. */
  port: import('./port').CalendarPort
  /** Two unrelated Organization ids the port accepts. */
  organizations: { a: OrganizationId; b: OrganizationId }
  /** The reporter the port was built with: the suite reads what it was given. */
  reporter: MemoryErrorReporter
  /** Everything the port logged, one JSON or text line per entry. */
  logs(): string[]
  /** A grant of `kind` the vendor accepts, whose secret part (code or refresh token) is `secret`. */
  acceptedGrant(secret: string, kind?: CalendarGrant['kind']): CalendarGrant
  /** A grant the vendor refuses. */
  refusedGrant(): CalendarGrant
  /** Puts a busy block on the calendar that none of our events made, such as the Rep's own meeting. */
  addBusy(connection: CalendarConnection, interval: BusyInterval): void
  /** Arranges that the next vendor request never answers, until it is aborted. */
  hang(): void
  /** Arranges that the next `times` vendor requests fail: `retryable` as throttling or a 5xx, `fatal` as a refusal. */
  failNext(kind: 'retryable' | 'fatal', times: number): void
  /** Arranges that the next `times` vendor requests take effect but their response is lost; leave out when the vendor cannot be made to. */
  loseResponse?(times: number): void
  /** The Rep revokes access at the vendor, outside our own `revoke`. */
  revokeAtProvider(connection: CalendarConnection): void
  /** How many requests have reached the vendor, a retry counting as its own. */
  vendorRequests(): number
  /** How many vendor requests were aborted while they were still pending. */
  abortedRequests(): number
  /** Removes what the subject created. */
  close(): Promise<void>
}

const SECRET_GRANT = 'GRANT-MARKER-SECRET'
const SECRET_TITLE = 'TITLE-MARKER-ZEBRA'
const SECRET_EMAIL = 'prospect-marker@example.com'
const SECRET_NOTE = 'NOTE-MARKER-PHONE'

const DAY = 24 * 60 * 60 * 1000
const WEEK_START = Date.parse('2026-03-02T00:00:00.000Z')
const at = (hours: number) => new Date(WEEK_START + hours * 3600_000).toISOString()
const dayRange = { from: at(0), to: at(24) }

/**
 * The behaviour every {@link import('./port').CalendarPort} must show: a grant becomes an opaque
 * connection whose tokens never reach a string, JSON or log; busy times come back sorted, merged
 * and clipped; an event write is idempotent by request id (also when a response is lost and the
 * call retries) and a different event under the same id is refused; a failing provider leaves no
 * half-written event and only a retryable failure is retried, a bounded number of times; a revoked
 * connection fails every call with `calendar.revoked`; the timeout and the caller's signal abort
 * the vendor request; a bad request never reaches the vendor; and no token, title, note or address
 * reaches a log, the error reporter or an error. Run it against the memory adapter and any real
 * adapter (which needs a subject that drives the vendor's test mode).
 */
export function calendarBehaviour(
  name: string,
  make: () => Promise<CalendarSubject>,
  skip = false
): void {
  const run = skip ? describe.skip : describe
  run(`Calendar behaviour: ${name}`, () => {
    const made: CalendarSubject[] = []
    afterEach(async () => {
      await Promise.all(made.splice(0).map((subject) => subject.close()))
    })
    async function subject(): Promise<CalendarSubject> {
      const next = await make()
      made.push(next)
      return next
    }

    const retry = { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 4 }
    const opts = { retry }

    async function connect(s: CalendarSubject, secret = 'secret-1', org = s.organizations.a) {
      return s.port.connect({ organizationId: org, grant: s.acceptedGrant(secret) }, opts)
    }

    function event(overrides: Record<string, unknown> = {}) {
      return { title: 'Discovery call', start: at(10), end: at(10.5), ...overrides }
    }

    async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
      try {
        await promise
        return undefined
      } catch (error) {
        return error instanceof CalendarError ? error.code : `not a CalendarError: ${String(error)}`
      }
    }

    async function busy(s: CalendarSubject, connection: CalendarConnection, range = dayRange) {
      return s.port.busy({ organizationId: connection.organizationId, connection, ...range }, opts)
    }

    function create(
      s: CalendarSubject,
      connection: CalendarConnection,
      requestId: string,
      overrides: Record<string, unknown> = {},
      options: Record<string, unknown> = opts
    ) {
      return s.port.createEvent(
        {
          organizationId: connection.organizationId,
          connection,
          requestId,
          event: event(overrides),
        },
        options
      )
    }

    test('a grant becomes a connection for the Organization, from a code or a refresh token', async () => {
      const s = await subject()
      const fromCode = await connect(s)
      expect(fromCode).toBeInstanceOf(CalendarConnection)
      expect(fromCode.organizationId).toBe(s.organizations.a)
      expect(fromCode.connectionId.length).toBeGreaterThan(0)
      expect(fromCode.provider.length).toBeGreaterThan(0)
      const fromRefresh = await s.port.connect(
        { organizationId: s.organizations.b, grant: s.acceptedGrant('secret-2', 'refresh_token') },
        opts
      )
      expect(fromRefresh.organizationId).toBe(s.organizations.b)
      expect(fromRefresh.connectionId).not.toBe(fromCode.connectionId)
    })

    test('a grant the vendor refuses is calendar.rejected and is not retried', async () => {
      const s = await subject()
      expect(
        await codeOf(
          s.port.connect({ organizationId: s.organizations.a, grant: s.refusedGrant() }, opts)
        )
      ).toBe(CALENDAR_ERROR_CODES.rejected)
      expect(s.vendorRequests()).toBe(1)
    })

    test('the credential is not in the connection string, JSON, spread or console form', async () => {
      const s = await subject()
      const connection = await connect(s, SECRET_GRANT)
      const credential = connection.unsafeCredential()
      expect(credential.length).toBeGreaterThan(0)
      const forms = [
        String(connection),
        `${connection}`,
        JSON.stringify(connection),
        JSON.stringify({ connection }),
        JSON.stringify({ ...connection }),
        inspect(connection, { depth: 5, showHidden: true }),
        inspect({ nested: [connection] }, { depth: 5 }),
      ].join('\n')
      expect(forms).not.toContain(credential)
      expect(forms).not.toContain(SECRET_GRANT)
      expect(forms).toContain(connection.connectionId)
    })

    test('busy times come back sorted, merged where they touch or overlap, and clipped to the range', async () => {
      const s = await subject()
      const c = await connect(s)
      expect(await busy(s, c)).toEqual([])
      s.addBusy(c, { start: at(12), end: at(13) })
      s.addBusy(c, { start: at(9), end: at(10) })
      s.addBusy(c, { start: at(9.5), end: at(11) })
      s.addBusy(c, { start: at(11), end: at(11.5) })
      s.addBusy(c, { start: at(-3), end: at(1) })
      s.addBusy(c, { start: at(23), end: at(30) })
      expect(await busy(s, c)).toEqual([
        { start: at(0), end: at(1) },
        { start: at(9), end: at(11.5) },
        { start: at(12), end: at(13) },
        { start: at(23), end: at(24) },
      ])
      expect(await busy(s, c, { from: at(14), to: at(20) })).toEqual([])
    })

    test('a range that is empty, backwards, not a time or over the limit never reaches the vendor', async () => {
      const s = await subject()
      const c = await connect(s)
      const before = s.vendorRequests()
      const bad = [
        { from: at(5), to: at(5) },
        { from: at(6), to: at(5) },
        { from: 'tomorrow', to: at(5) },
        { from: at(0), to: '2026-03-02' },
        { from: at(0), to: new Date(WEEK_START + MAX_BUSY_RANGE_MS + DAY).toISOString() },
      ]
      for (const range of bad) {
        expect(await codeOf(busy(s, c, range))).toBe(CALENDAR_ERROR_CODES.invalidRequest)
      }
      expect(s.vendorRequests()).toBe(before)
    })

    test('a created event is busy time, has an id and a join link when video is asked for', async () => {
      const s = await subject()
      const c = await connect(s)
      const plain = await create(s, c, 'req-1')
      expect(plain).toMatchObject({ created: true, start: at(10), end: at(10.5) })
      expect(plain.eventId.length).toBeGreaterThan(0)
      expect(plain.joinUrl).toBeUndefined()
      const video = await create(s, c, 'req-2', {
        start: at(14),
        end: at(15),
        conferencing: 'video',
      })
      expect(typeof video.joinUrl).toBe('string')
      expect(video.eventId).not.toBe(plain.eventId)
      expect(await busy(s, c)).toEqual([
        { start: at(10), end: at(10.5) },
        { start: at(14), end: at(15) },
      ])
    })

    test('creating again with the same request id returns the same event and makes no second one', async () => {
      const s = await subject()
      const c = await connect(s)
      const first = await create(s, c, 'req-same')
      const again = await create(s, c, 'req-same')
      expect(again.eventId).toBe(first.eventId)
      expect(again.created).toBe(false)
      expect(first.created).toBe(true)
      expect(await busy(s, c)).toEqual([{ start: at(10), end: at(10.5) }])
    })

    test('the same request id with a different event is calendar.invalid_request', async () => {
      const s = await subject()
      const c = await connect(s)
      await create(s, c, 'req-reused')
      expect(await codeOf(create(s, c, 'req-reused', { start: at(11), end: at(12) }))).toBe(
        CALENDAR_ERROR_CODES.invalidRequest
      )
      expect(await busy(s, c)).toEqual([{ start: at(10), end: at(10.5) }])
    })

    test('request ids are per connection', async () => {
      const s = await subject()
      const one = await connect(s, 'secret-1')
      const two = await connect(s, 'secret-2')
      const a = await create(s, one, 'req-shared')
      const b = await create(s, two, 'req-shared', { start: at(11), end: at(12) })
      expect(b.created).toBe(true)
      expect(b.eventId).not.toBe(a.eventId)
    })

    test('updating moves the busy time, and a replay of the request id changes nothing more', async () => {
      const s = await subject()
      const c = await connect(s)
      const made = await create(s, c, 'req-1')
      const update = {
        organizationId: c.organizationId,
        connection: c,
        eventId: made.eventId,
        requestId: 'req-2',
        changes: { start: at(16), end: at(17) },
      }
      const moved = await s.port.updateEvent(update, opts)
      expect(moved).toMatchObject({ eventId: made.eventId, start: at(16), end: at(17) })
      expect(await busy(s, c)).toEqual([{ start: at(16), end: at(17) }])
      const replayed = await s.port.updateEvent(update, opts)
      expect(replayed).toEqual(moved)
      expect(await busy(s, c)).toEqual([{ start: at(16), end: at(17) }])
      expect(
        await codeOf(
          s.port.updateEvent({ ...update, changes: { start: at(18), end: at(19) } }, opts)
        )
      ).toBe(CALENDAR_ERROR_CODES.invalidRequest)
    })

    test('updating an event that does not exist is calendar.not_found', async () => {
      const s = await subject()
      const c = await connect(s)
      expect(
        await codeOf(
          s.port.updateEvent(
            {
              organizationId: c.organizationId,
              connection: c,
              eventId: 'no-such-event',
              requestId: 'req-1',
              changes: { title: 'New title' },
            },
            opts
          )
        )
      ).toBe(CALENDAR_ERROR_CODES.notFound)
    })

    test('an update that leaves the event ending before it starts is refused', async () => {
      const s = await subject()
      const c = await connect(s)
      const made = await create(s, c, 'req-1')
      expect(
        await codeOf(
          s.port.updateEvent(
            {
              organizationId: c.organizationId,
              connection: c,
              eventId: made.eventId,
              requestId: 'req-2',
              changes: { end: at(9) },
            },
            opts
          )
        )
      ).toBe(CALENDAR_ERROR_CODES.invalidRequest)
      expect(await busy(s, c)).toEqual([{ start: at(10), end: at(10.5) }])
    })

    test('deleting frees the time; a replay and a second delete of a gone event are not errors', async () => {
      const s = await subject()
      const c = await connect(s)
      const made = await create(s, c, 'req-1')
      const del = (requestId: string, eventId = made.eventId) =>
        s.port.deleteEvent(
          { organizationId: c.organizationId, connection: c, eventId, requestId },
          opts
        )
      expect(await del('del-1')).toEqual({ deleted: true })
      expect(await busy(s, c)).toEqual([])
      expect(await del('del-1')).toEqual({ deleted: true })
      expect(await del('del-2')).toEqual({ deleted: false })
      expect(await del('del-3', 'never-existed')).toEqual({ deleted: false })
    })

    test('one connection cannot read, change or remove the events of another', async () => {
      const s = await subject()
      const mine = await connect(s, 'secret-1', s.organizations.a)
      const theirs = await connect(s, 'secret-2', s.organizations.b)
      const made = await create(s, mine, 'req-1')
      expect(await busy(s, theirs)).toEqual([])
      expect(
        await codeOf(
          s.port.updateEvent(
            {
              organizationId: theirs.organizationId,
              connection: theirs,
              eventId: made.eventId,
              requestId: 'req-x',
              changes: { title: 'Hijacked' },
            },
            opts
          )
        )
      ).toBe(CALENDAR_ERROR_CODES.notFound)
      expect(
        await s.port.deleteEvent(
          {
            organizationId: theirs.organizationId,
            connection: theirs,
            eventId: made.eventId,
            requestId: 'del-x',
          },
          opts
        )
      ).toEqual({ deleted: false })
      expect(await busy(s, mine)).toEqual([{ start: at(10), end: at(10.5) }])
    })

    test('a connection used for another Organization is refused before any vendor call', async () => {
      const s = await subject()
      const c = await connect(s)
      const before = s.vendorRequests()
      expect(
        await codeOf(
          s.port.busy({ organizationId: s.organizations.b, connection: c, ...dayRange }, opts)
        )
      ).toBe(CALENDAR_ERROR_CODES.invalidRequest)
      expect(s.vendorRequests()).toBe(before)
    })

    test('a request that is not acceptable is refused before any vendor call', async () => {
      const s = await subject()
      const c = await connect(s)
      const before = s.vendorRequests()
      const many = Array.from({ length: 21 }, (_, i) => ({ email: `p${i}@example.com` }))
      const bad: Record<string, unknown>[] = [
        { requestId: '' },
        { requestId: 'has spaces' },
        { requestId: 'x'.repeat(129) },
        { event: event({ title: '' }) },
        { event: event({ title: 'x'.repeat(257) }) },
        { event: event({ start: 'soon' }) },
        { event: event({ end: at(10) }) },
        { event: event({ end: at(9) }) },
        { event: event({ end: new Date(WEEK_START + 10 * DAY).toISOString() }) },
        { event: event({ attendees: many }) },
        { event: event({ attendees: [{ email: 'not-an-email' }] }) },
        { event: event({ conferencing: 'phone' }) },
        { event: event({ surprise: true }) },
        { connection: { connectionId: 'forged', credential: 'x' } },
        { organizationId: 'org_nope' },
      ]
      for (const overrides of bad) {
        const request = {
          organizationId: c.organizationId,
          connection: c,
          requestId: 'req-ok',
          event: event(),
          ...overrides,
        }
        expect(await codeOf(s.port.createEvent(request as never, opts))).toBe(
          CALENDAR_ERROR_CODES.invalidRequest
        )
      }
      const badOptions: Record<string, unknown>[] = [
        { timeoutMs: 0 },
        { timeoutMs: 10_000_000 },
        { retry: { maxRetries: 99 } },
        { retry: { baseDelayMs: 100, maxDelayMs: 10 } },
        { signal: 'stop' },
      ]
      for (const option of badOptions) {
        expect(await codeOf(create(s, c, 'req-ok', {}, option))).toBe(
          CALENDAR_ERROR_CODES.invalidRequest
        )
      }
      expect(
        await codeOf(
          s.port.connect(
            {
              organizationId: s.organizations.a,
              grant: { kind: 'refresh_token', refreshToken: '' },
            },
            opts
          )
        )
      ).toBe(CALENDAR_ERROR_CODES.invalidRequest)
      expect(s.vendorRequests()).toBe(before)
      expect(await busy(s, c)).toEqual([])
    })

    test('a failing provider is retried a bounded number of times, then calendar.unavailable, and nothing is half-written', async () => {
      const s = await subject()
      const c = await connect(s)
      const before = s.vendorRequests()
      s.failNext('retryable', 10)
      expect(await codeOf(create(s, c, 'req-1'))).toBe(CALENDAR_ERROR_CODES.unavailable)
      expect(s.vendorRequests() - before).toBe(3)
      expect(s.reporter.captured.length).toBeGreaterThan(0)
    })

    test('after a failed create the same request id makes exactly one event', async () => {
      const s = await subject()
      const c = await connect(s)
      s.failNext('retryable', 3)
      expect(await codeOf(create(s, c, 'req-1'))).toBe(CALENDAR_ERROR_CODES.unavailable)
      expect(await busy(s, c)).toEqual([])
      const made = await create(s, c, 'req-1')
      expect(made.created).toBe(true)
      expect(await busy(s, c)).toEqual([{ start: at(10), end: at(10.5) }])
    })

    test('a retryable failure that clears is retried and the call succeeds with one event', async () => {
      const s = await subject()
      const c = await connect(s)
      const before = s.vendorRequests()
      s.failNext('retryable', 2)
      const made = await create(s, c, 'req-1')
      expect(made.eventId.length).toBeGreaterThan(0)
      expect(s.vendorRequests() - before).toBe(3)
      expect(await busy(s, c)).toEqual([{ start: at(10), end: at(10.5) }])
    })

    test('a lost response is retried and the request id keeps it to one event', async () => {
      const s = await subject()
      if (s.loseResponse === undefined) {
        return
      }
      const c = await connect(s)
      s.loseResponse(1)
      const made = await create(s, c, 'req-1')
      expect(made.eventId.length).toBeGreaterThan(0)
      expect(await busy(s, c)).toEqual([{ start: at(10), end: at(10.5) }])
      const again = await create(s, c, 'req-1')
      expect(again.eventId).toBe(made.eventId)
    })

    test('connect is not retried, because a grant is single-use', async () => {
      const s = await subject()
      s.failNext('retryable', 1)
      const before = s.vendorRequests()
      expect(
        await codeOf(
          s.port.connect(
            { organizationId: s.organizations.a, grant: s.acceptedGrant('secret-1') },
            opts
          )
        )
      ).toBe(CALENDAR_ERROR_CODES.unavailable)
      expect(s.vendorRequests() - before).toBe(1)
    })

    test('a fatal vendor failure is calendar.rejected, reported and not retried', async () => {
      const s = await subject()
      const c = await connect(s)
      const before = s.vendorRequests()
      s.failNext('fatal', 1)
      expect(await codeOf(create(s, c, 'req-1'))).toBe(CALENDAR_ERROR_CODES.rejected)
      expect(s.vendorRequests() - before).toBe(1)
      expect(s.reporter.captured.length).toBeGreaterThan(0)
    })

    test('after revoke every call fails with calendar.revoked, and revoking again succeeds', async () => {
      const s = await subject()
      const c = await connect(s)
      const other = await connect(s, 'secret-2')
      const made = await create(s, c, 'req-1')
      await s.port.revoke({ organizationId: c.organizationId, connection: c }, opts)
      const base = { organizationId: c.organizationId, connection: c }
      expect(await codeOf(busy(s, c))).toBe(CALENDAR_ERROR_CODES.revoked)
      expect(await codeOf(create(s, c, 'req-2'))).toBe(CALENDAR_ERROR_CODES.revoked)
      expect(await codeOf(create(s, c, 'req-1'))).toBe(CALENDAR_ERROR_CODES.revoked)
      expect(
        await codeOf(
          s.port.updateEvent(
            { ...base, eventId: made.eventId, requestId: 'req-3', changes: { title: 'x' } },
            opts
          )
        )
      ).toBe(CALENDAR_ERROR_CODES.revoked)
      expect(
        await codeOf(
          s.port.deleteEvent({ ...base, eventId: made.eventId, requestId: 'req-4' }, opts)
        )
      ).toBe(CALENDAR_ERROR_CODES.revoked)
      await s.port.revoke(base, opts)
      expect(await busy(s, other)).toEqual([])
    })

    test('access revoked at the vendor is calendar.revoked, not retried', async () => {
      const s = await subject()
      const c = await connect(s)
      s.revokeAtProvider(c)
      const before = s.vendorRequests()
      expect(await codeOf(busy(s, c))).toBe(CALENDAR_ERROR_CODES.revoked)
      expect(s.vendorRequests() - before).toBeLessThanOrEqual(1)
    })

    test('the timeout aborts the vendor request and fails with calendar.timeout', async () => {
      const s = await subject()
      const c = await connect(s)
      const aborted = s.abortedRequests()
      s.hang()
      const started = Date.now()
      expect(await codeOf(create(s, c, 'req-1', {}, { timeoutMs: 30, retry }))).toBe(
        CALENDAR_ERROR_CODES.timeout
      )
      expect(Date.now() - started).toBeLessThan(2000)
      expect(s.abortedRequests() - aborted).toBe(1)
    })

    test('the caller signal aborts the vendor request and fails with calendar.aborted', async () => {
      const s = await subject()
      const c = await connect(s)
      const aborted = s.abortedRequests()
      s.hang()
      const controller = new AbortController()
      const pending = codeOf(
        s.port.busy(
          { organizationId: c.organizationId, connection: c, ...dayRange },
          { ...opts, signal: controller.signal }
        )
      )
      setTimeout(() => controller.abort(), 10)
      expect(await pending).toBe(CALENDAR_ERROR_CODES.aborted)
      expect(s.abortedRequests() - aborted).toBe(1)
    })

    test('a signal that is already aborted fails with calendar.aborted', async () => {
      const s = await subject()
      const c = await connect(s)
      expect(
        await codeOf(create(s, c, 'req-1', {}, { ...opts, signal: AbortSignal.abort() }))
      ).toBe(CALENDAR_ERROR_CODES.aborted)
      expect(await busy(s, c)).toEqual([])
    })

    test('no token, title, note or address reaches a log, the reporter or an error', async () => {
      const s = await subject()
      const c = await connect(s, SECRET_GRANT)
      const seenErrors: unknown[] = []
      const sensitive = {
        title: SECRET_TITLE,
        description: SECRET_NOTE,
        attendees: [{ email: SECRET_EMAIL, name: SECRET_TITLE }],
      }
      const swallow = (promise: Promise<unknown>) => promise.catch((e) => seenErrors.push(e))

      await create(s, c, 'req-ok', sensitive)
      s.failNext('retryable', 3)
      await swallow(create(s, c, 'req-fail', sensitive))
      s.failNext('fatal', 1)
      await swallow(create(s, c, 'req-fatal', sensitive))
      await swallow(create(s, c, 'req-ok', { ...sensitive, title: `${SECRET_TITLE} changed` }))
      await swallow(create(s, c, 'req-bad', { ...sensitive, end: at(1) }))
      await swallow(
        s.port.connect({ organizationId: s.organizations.a, grant: s.refusedGrant() }, opts)
      )
      await swallow(
        s.port.updateEvent(
          {
            organizationId: c.organizationId,
            connection: c,
            eventId: 'missing',
            requestId: 'req-up',
            changes: sensitive,
          },
          opts
        )
      )
      await s.port.revoke({ organizationId: c.organizationId, connection: c }, opts)
      await swallow(create(s, c, 'req-revoked', sensitive))

      expect(seenErrors.length).toBeGreaterThan(0)
      const asText = (value: unknown) =>
        JSON.stringify(value, (_key, v) =>
          v instanceof Error
            ? { ...v, name: v.name, message: v.message, stack: v.stack, cause: v.cause }
            : v
        )
      const seen = [...s.logs(), asText(s.reporter.captured), asText(seenErrors)].join('\n')
      for (const secret of [
        SECRET_GRANT,
        SECRET_TITLE,
        SECRET_EMAIL,
        SECRET_NOTE,
        'MARKER',
        c.unsafeCredential(),
      ]) {
        expect(seen).not.toContain(secret)
      }
    })
  })
}
