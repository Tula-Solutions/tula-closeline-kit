import { organizationIdSchema } from 'tula-closeline-contract'
import { z } from 'zod'
import { CalendarConnection } from './connection'
import { CALENDAR_ERROR_CODES, CalendarError } from './errors'
import {
  type CalendarCallOptions,
  type CalendarEventChanges,
  type CalendarEventInput,
  type CalendarGrant,
  type CalendarRequestBase,
  DEFAULT_CALENDAR_RETRY_POLICY,
  DEFAULT_CALENDAR_TIMEOUT_MS,
  MAX_BUSY_RANGE_MS,
  MAX_CALENDAR_TIMEOUT_MS,
  MAX_EVENT_ATTENDEES,
  MAX_EVENT_DURATION_MS,
  type ResolvedCalendarRetryPolicy,
} from './port'

/** Refuses with `calendar.invalid_request`; `what` names the field, never its value. */
export function invalid(what: string): never {
  throw new CalendarError(CALENDAR_ERROR_CODES.invalidRequest, `${what} is not acceptable`)
}

function integerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

/** The call options with their defaults filled in. */
export interface CheckedOptions {
  /** The time limit, in ms. */
  timeoutMs: number
  /** The retry policy. */
  retry: ResolvedCalendarRetryPolicy
  /** The caller's signal, if any. */
  signal?: AbortSignal
}

/** Checks the call options and fills in the defaults. */
export function checkOptions(options: CalendarCallOptions | undefined): CheckedOptions {
  if (options !== undefined && (typeof options !== 'object' || options === null)) {
    invalid('options')
  }
  const timeoutMs = options?.timeoutMs ?? DEFAULT_CALENDAR_TIMEOUT_MS
  if (!integerIn(timeoutMs, 1, MAX_CALENDAR_TIMEOUT_MS)) {
    invalid('timeoutMs')
  }
  if (options?.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    invalid('signal')
  }
  const policy = options?.retry
  const maxRetries = policy?.maxRetries ?? DEFAULT_CALENDAR_RETRY_POLICY.maxRetries
  const baseDelayMs = policy?.baseDelayMs ?? DEFAULT_CALENDAR_RETRY_POLICY.baseDelayMs
  const maxDelayMs = policy?.maxDelayMs ?? DEFAULT_CALENDAR_RETRY_POLICY.maxDelayMs
  if (!integerIn(maxRetries, 0, 5)) {
    invalid('retry.maxRetries')
  }
  if (!integerIn(baseDelayMs, 1, 60_000)) {
    invalid('retry.baseDelayMs')
  }
  if (!integerIn(maxDelayMs, baseDelayMs, 60_000)) {
    invalid('retry.maxDelayMs')
  }
  return {
    timeoutMs,
    retry: { maxRetries, baseDelayMs, maxDelayMs },
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
  }
}

/** Parses `value` with `schema`; on failure refuses naming only the field path, never the value. */
function parse<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.filter((p) => typeof p === 'string').join('.')
    return invalid(path ? `${what}.${path}` : what)
  }
  return parsed.data
}

const instant = z.iso.datetime({ offset: true })
const requestIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)
const eventIdSchema = z
  .string()
  .min(1)
  .max(256)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  .regex(/^[^\u0000-\u001f\u007f]+$/)
const attendeeSchema = z.strictObject({
  email: z.email().max(254),
  name: z.string().min(1).max(200).optional(),
})
const titleSchema = z.string().min(1).max(256)
const descriptionSchema = z.string().max(8192)
const locationSchema = z.string().max(512)
const attendeesSchema = z.array(attendeeSchema).max(MAX_EVENT_ATTENDEES)

const eventSchema = z.strictObject({
  title: titleSchema,
  start: instant,
  end: instant,
  description: descriptionSchema.optional(),
  location: locationSchema.optional(),
  attendees: attendeesSchema.optional(),
  conferencing: z.enum(['video', 'none']).optional(),
})

const changesSchema = z
  .strictObject({
    title: titleSchema.optional(),
    start: instant.optional(),
    end: instant.optional(),
    description: descriptionSchema.optional(),
    location: locationSchema.optional(),
    attendees: attendeesSchema.optional(),
  })
  .refine((c) => Object.values(c).some((v) => v !== undefined))

const grantSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('authorization_code'),
    code: z.string().min(1).max(4096),
    redirectUri: z.url().max(2048),
    codeVerifier: z.string().min(1).max(256).optional(),
  }),
  z.strictObject({ kind: z.literal('refresh_token'), refreshToken: z.string().min(1).max(4096) }),
])

/** Checks the Organization id. */
export function checkOrganizationId(value: unknown): string {
  return organizationIdSchema.safeParse(value).success
    ? (value as string)
    : invalid('organizationId')
}

/** Checks the Organization and the connection of a request, and that the connection is the Organization's. */
export function checkBase(request: CalendarRequestBase): CalendarConnection {
  if (typeof request !== 'object' || request === null) {
    return invalid('request')
  }
  checkOrganizationId(request.organizationId)
  if (!(request.connection instanceof CalendarConnection)) {
    return invalid('connection')
  }
  if (request.connection.organizationId !== request.organizationId) {
    return invalid('connection')
  }
  return request.connection
}

/** Checks a grant. */
export function checkGrant(value: unknown): CalendarGrant {
  return parse(grantSchema, value, 'grant')
}

/** Checks a request id. */
export function checkRequestId(value: unknown): string {
  return parse(requestIdSchema, value, 'requestId')
}

/** Checks an event id. */
export function checkEventId(value: unknown): string {
  return parse(eventIdSchema, value, 'eventId')
}

/** A time range in epoch milliseconds. */
export interface CheckedRange {
  /** The start. */
  fromMs: number
  /** The end. */
  toMs: number
}

/** Checks `from` and `to`: instants, in order, no longer than {@link MAX_BUSY_RANGE_MS}. */
export function checkRange(from: unknown, to: unknown): CheckedRange {
  const fromMs = Date.parse(parse(instant, from, 'from'))
  const toMs = Date.parse(parse(instant, to, 'to'))
  if (!(fromMs < toMs) || toMs - fromMs > MAX_BUSY_RANGE_MS) {
    invalid('range')
  }
  return { fromMs, toMs }
}

/** A new event with its times in epoch milliseconds. */
export interface CheckedEvent {
  /** The fields as given. */
  event: CalendarEventInput
  /** The start. */
  startMs: number
  /** The end. */
  endMs: number
}

/** Checks the times of an event: in order and no longer than {@link MAX_EVENT_DURATION_MS}. */
export function checkEventTimes(startMs: number, endMs: number): void {
  if (!(startMs < endMs) || endMs - startMs > MAX_EVENT_DURATION_MS) {
    invalid('event.times')
  }
}

/** Checks a new event. */
export function checkEvent(value: unknown): CheckedEvent {
  const event = parse(eventSchema, value, 'event') as CalendarEventInput
  const startMs = Date.parse(event.start)
  const endMs = Date.parse(event.end)
  checkEventTimes(startMs, endMs)
  return { event, startMs, endMs }
}

/** Checks the changes of an update. */
export function checkChanges(value: unknown): CalendarEventChanges {
  return parse(changesSchema, value, 'changes') as CalendarEventChanges
}
