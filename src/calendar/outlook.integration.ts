import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { organizationIdSchema } from 'tula-closeline-contract'
import { createOutlookCalendar } from './outlook'

/**
 * Calls Microsoft Graph (Outlook Calendar) for real, with a test Microsoft account's calendar named by
 * `OUTLOOK_CALENDAR_TEST_CLIENT_ID`, `OUTLOOK_CALENDAR_TEST_CLIENT_SECRET` and
 * `OUTLOOK_CALENDAR_TEST_REFRESH_TOKEN` (a refresh token granted the scopes in
 * `OUTLOOK_CALENDAR_SCOPES`). It creates one 15-minute event a month ahead with no attendees (so
 * nobody is mailed), moves it, deletes it, and never revokes the token. The shared `CalendarPort`
 * behaviour suite needs scripted failures and hangs, so it runs against a fake Graph in
 * `outlook.behaviour.test.ts`; this file checks the same port against the real service.
 *
 * Without those variables it is skipped and says so on stderr. It never fails CI for want of
 * credentials: a Microsoft test account is not part of the local stack.
 */
const clientId = process.env.OUTLOOK_CALENDAR_TEST_CLIENT_ID
const clientSecret = process.env.OUTLOOK_CALENDAR_TEST_CLIENT_SECRET
const refreshToken = process.env.OUTLOOK_CALENDAR_TEST_REFRESH_TOKEN
const organizationId = organizationIdSchema.parse(`org_${'a'.repeat(32)}`)

if (!clientId || !clientSecret || !refreshToken) {
  process.stderr.write(
    'SKIPPED: the Microsoft Graph (Outlook Calendar) adapter was not run against Microsoft Graph. Set OUTLOOK_CALENDAR_TEST_CLIENT_ID, OUTLOOK_CALENDAR_TEST_CLIENT_SECRET and OUTLOOK_CALENDAR_TEST_REFRESH_TOKEN and run `bun run test:integration`.\n'
  )
  describe.skip('Calendar integration: Outlook adapter (OUTLOOK_CALENDAR_TEST_* not set)', () => {
    test('skipped', () => undefined)
  })
} else {
  setDefaultTimeout(60_000)
  const port = createOutlookCalendar({ clientId, clientSecret })
  const day = 24 * 3600_000
  const start = new Date(Math.ceil((Date.now() + 30 * day) / 900_000) * 900_000)
  const iso = (offsetMs: number) => new Date(start.getTime() + offsetMs).toISOString()

  describe('Calendar integration: Outlook adapter', () => {
    test('connect, read busy times, create with Teams, move, delete', async () => {
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
