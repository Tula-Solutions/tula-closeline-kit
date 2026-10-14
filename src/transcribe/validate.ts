import type { OrganizationIdCheck } from '../organization'
import { createOrganizationIdGuard } from '../organization-guard'
import type { Environment } from '../reporting/env'
import { TRANSCRIBER_ERROR_CODES, TranscriberError } from './errors'
import {
  DEFAULT_TRANSCRIBER_LIST_LIMIT,
  MAX_AUDIO_URL_LENGTH,
  MAX_CLIENT_REFERENCE_LENGTH,
  MAX_SPEAKERS,
  MAX_TRANSCRIBER_LIST_LIMIT,
  type TranscriptionListOptions,
} from './port'

// Internal: the checks every adapter shares. Not exported from any entry of the package.

const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const AUDIO_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/
const CURSOR = /^[A-Za-z0-9_-]{1,300}$/

const bad = (message: string) =>
  new TranscriberError(TRANSCRIBER_ERROR_CODES.invalidRequest, message)

/** A request after validation. */
export interface CheckedRequest {
  clientReference: string
  audioUrl: string
  speakers: 'split_channels' | 'diarize'
  maxSpeakers: number | undefined
  audioKey: string
  callbackUrl: string | undefined
}

/** A list call after validation. */
export interface CheckedList {
  prefix: string
  after: string | undefined
  limit: number
}

/** The checks every adapter runs before it touches the vendor. */
export interface TranscriberValidator {
  /** Throws unless `organizationId` is acceptable; returns it. */
  organization(organizationId: unknown): string
  /** Throws unless `reference` is a valid client reference; returns it. */
  reference(reference: unknown): string
  /** Validates a send. The messages never hold the URLs. */
  request(request: unknown): CheckedRequest
  /** Validates the options of a list call. */
  list(options: TranscriptionListOptions | undefined): CheckedList
}

/** Encodes a reference as an opaque list cursor. */
export function encodeReferenceCursor(reference: string): string {
  return Buffer.from(reference, 'utf8').toString('base64url')
}

function checkUrl(value: unknown, what: string, allowHttp: boolean): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_AUDIO_URL_LENGTH) {
    throw bad(`${what} must be a URL of at most 4096 characters`)
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw bad(`${what} must be a URL`)
  }
  if (
    (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) ||
    url.hostname === '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw bad(`${what} must be an https URL without user information (http only in local)`)
  }
  return value
}

/** Builds the validator a {@link Transcriber} adapter uses. */
export function createTranscriberValidator(options: {
  isOrganizationId?: OrganizationIdCheck | undefined
  /** The `ENVIRONMENT`: plain `http:` URLs are accepted only in `local`. */
  environment: Environment
}): TranscriberValidator {
  const allowHttp = options.environment === 'local'
  const isOrganization = createOrganizationIdGuard(options.isOrganizationId)
  const reference = (value: unknown): string => {
    if (
      typeof value !== 'string' ||
      value.length > MAX_CLIENT_REFERENCE_LENGTH ||
      !REFERENCE.test(value)
    ) {
      throw bad('a client reference is 1 to 128 letters, digits, ".", "_", ":" or "-"')
    }
    return value
  }
  const audioKey = (value: unknown): string => {
    if (typeof value !== 'string' || !AUDIO_KEY.test(value)) {
      throw bad('an audio key is required: 1 to 256 letters, digits, ".", "_", ":", "/" or "-"')
    }
    return value
  }
  return {
    organization(value) {
      if (!isOrganization(value)) {
        throw bad('the Organization id is not valid')
      }
      return value
    },
    reference,
    request(value) {
      if (typeof value !== 'object' || value === null) {
        throw bad('a send must be an object')
      }
      const raw = value as Record<string, unknown>
      const audio = raw.audio
      if (typeof audio !== 'object' || audio === null) {
        throw bad('audio must be an object with a url')
      }
      if (raw.speakers !== 'split_channels' && raw.speakers !== 'diarize') {
        throw bad('speakers must be "split_channels" or "diarize"')
      }
      let maxSpeakers: number | undefined
      if (raw.maxSpeakers !== undefined) {
        if (
          raw.speakers !== 'diarize' ||
          typeof raw.maxSpeakers !== 'number' ||
          !Number.isInteger(raw.maxSpeakers) ||
          raw.maxSpeakers < 1 ||
          raw.maxSpeakers > MAX_SPEAKERS
        ) {
          throw bad('maxSpeakers is a whole number from 1 to 10 and only goes with "diarize"')
        }
        maxSpeakers = raw.maxSpeakers
      }
      return {
        clientReference: reference(raw.clientReference),
        audioUrl: checkUrl((audio as { url?: unknown }).url, 'the audio url', allowHttp),
        speakers: raw.speakers,
        maxSpeakers,
        callbackUrl:
          raw.callbackUrl === undefined
            ? undefined
            : checkUrl(raw.callbackUrl, 'the callback url', allowHttp),
        audioKey: audioKey(raw.audioKey),
      }
    },
    list(listOptions) {
      const raw: TranscriptionListOptions = listOptions ?? {}
      if (typeof raw !== 'object' || raw === null) {
        throw bad('list options must be an object')
      }
      let prefix = ''
      if (raw.prefix !== undefined) {
        if (
          typeof raw.prefix !== 'string' ||
          raw.prefix.length > MAX_CLIENT_REFERENCE_LENGTH ||
          (raw.prefix !== '' && !REFERENCE.test(raw.prefix))
        ) {
          throw bad('the prefix is up to 128 letters, digits, ".", "_", ":" or "-"')
        }
        prefix = raw.prefix
      }
      let after: string | undefined
      if (raw.cursor !== undefined) {
        if (typeof raw.cursor !== 'string' || !CURSOR.test(raw.cursor)) {
          throw bad('the cursor is not valid')
        }
        const decoded = Buffer.from(raw.cursor, 'base64url').toString('utf8')
        if (encodeReferenceCursor(decoded) !== raw.cursor || !REFERENCE.test(decoded)) {
          throw bad('the cursor is not valid')
        }
        after = decoded
      }
      const limit = raw.limit ?? DEFAULT_TRANSCRIBER_LIST_LIMIT
      if (
        typeof limit !== 'number' ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > MAX_TRANSCRIBER_LIST_LIMIT
      ) {
        throw bad('the limit is a whole number from 1 to 1000')
      }
      return { prefix, after, limit }
    },
  }
}

/** True when two checked requests ask for the same send (the URLs are only a means of fetching). */
export function sameSend(x: CheckedRequest, y: CheckedRequest): boolean {
  // The audio URL is not compared: it is short-lived, and a retry presigns a new one.
  return x.audioKey === y.audioKey && x.speakers === y.speakers && x.maxSpeakers === y.maxSpeakers
}
