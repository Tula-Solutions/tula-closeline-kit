import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { organizationIdSchema } from 'tula-closeline-contract'
import { createGoogleCalendar } from './google'

/**
 * Calls Google Calendar for real, with a test Google account's calendar named by
 * `GOOGLE_CALENDAR_TEST_CLIENT_ID`, `GOOGLE_CALENDAR_TEST_CLIENT_SECRET` and
 * `GOOGLE_CALENDAR_TEST_REFRESH_TOKEN` (a refresh token granted the scopes in
 * `GOOGLE_CALENDAR_SCOPES`). It creates one 15-minute event a month ahead with no attendees (so
 * nobody is mailed), moves it, deletes it, and never revokes the token. The shared `CalendarPort`
 * behaviour suite needs scripted failures and hangs, so it runs against a fake Google in
 * `google.behaviour.test.ts`; this file checks the same port against the real service.
 *
 * Without those variables it is skipped and says so on stderr. It never fails CI for want of
 * credentials: a Google test account is not part of the local stack.
 */
const clientId = process.env.GOOGLE_CALENDAR_TEST_CLIENT_ID
const clientSecret = process.env.GOOGLE_CALENDAR_TEST_CLIENT_SECRET
const refreshToken = process.env.GOOGLE_CALENDAR_TEST_REFRESH_TOKEN
const organizationId = organizationIdSchema.parse(`org_${'a'.repeat(32)}`)

if (!clientId || !clientSecret || !refreshToken) {
  process.stderr.write(
    'SKIPPED: the Google Calendar adapter was not run against Google. Set GOOGLE_CALENDAR_TEST_CLIENT_ID, GOOGLE_CALENDAR_TEST_CLIENT_SECRET and GOOGLE_CALENDAR_TEST_REFRESH_TOKEN and run `bun run test:integration`.\n'
  )
  describe.skip('Calendar integration: Google adapter (GOOGLE_CALENDAR_TEST_* not set)', () => {
    test('skipped', () => undefined)
  })
} else {
  setDefaultTimeout(60_000)
  const port = createGoogleCalendar({ clientId, clientSecret })
  const day = 24 * 3600_000
  const start = new Date(Math.ceil((Date.now() + 30 * day) / 900_000) * 900_000)
  const iso = (offsetMs: number) => new Date(start.getTime() + offsetMs).toISOString()

  describe('Calendar integration: Google adapter', () => {
    test('connect, read busy times, create with Meet, move, delete', async () => {
      const connection = await port.connect({
        organizationId,
        grant: { kind: 'refresh_token', refreshToken },
      })
      const base = { organizationId, connection }
      const requestId = `it-${Date.now()}`
      const created = await port.createEvent({
        ...base,
        requestId,
        event: {
          title: 'Closeline integration test',
          start: iso(0),
          end: iso(900_000),
          conferencing: 'video',
        },
      })
      try {
        expect(created.created).toBe(true)
        const again = await port.createEvent({
          ...base,
          requestId,
          event: {
            title: 'Closeline integration test',
            start: iso(0),
            end: iso(900_000),
            conferencing: 'video',
          },
        })
        expect(again).toMatchObject({ eventId: created.eventId, created: false })
        const busy = await port.busy({ ...base, from: iso(-3600_000), to: iso(3600_000) })
        expect(busy.some((b) => b.start <= iso(0) && b.end >= iso(900_000))).toBe(true)
        const moved = await port.updateEvent({
          ...base,
          eventId: created.eventId,
          requestId: `${requestId}-move`,
          changes: { start: iso(1_800_000), end: iso(2_700_000) },
        })
        expect(moved.start).toBe(iso(1_800_000))
      } finally {
        const gone = await port.deleteEvent({
          ...base,
          eventId: created.eventId,
          requestId: `${requestId}-del`,
        })
        expect(gone.deleted).toBe(true)
      }
    })
  })
}
