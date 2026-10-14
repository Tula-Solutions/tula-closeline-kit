/** The longest client reference, in characters. */
export const MAX_CLIENT_REFERENCE_LENGTH = 128

/** The longest audio URL, in characters (a presigned S3 URL is about 1 KiB). */
export const MAX_AUDIO_URL_LENGTH = 4096

/** The most speakers a send may allow. */
export const MAX_SPEAKERS = 10

/** The default page size of {@link Transcriber.list}. */
export const DEFAULT_TRANSCRIBER_LIST_LIMIT = 100

/** The largest page size of {@link Transcriber.list}. */
export const MAX_TRANSCRIBER_LIST_LIMIT = 1000

/** The most turns one result may hold; an adapter that gets more answers `transcriber.bad_response`. */
export const MAX_TRANSCRIPT_TURNS = 50_000

/** The longest text of one turn, in characters. */
export const MAX_TURN_TEXT = 20_000

/** The longest vendor id, in characters. */
export const MAX_VENDOR_ID_LENGTH = 128

/** The audio to transcribe: a short-lived reference the vendor fetches, never the bytes. */
export interface AudioReference {
  /**
   * An `https:` URL (`http:` only when the adapter runs with `ENVIRONMENT=local`) that stays valid until the vendor has
   * fetched the audio, typically a presigned GET of the object store, valid for minutes. It may
   * carry credentials in its query string, so it is never logged, never put in an error and never
   * stored. No user information (`user:pass@`) is accepted. The service builds this URL from its
   * own object store; it is never taken from a user, or the vendor becomes a way to fetch any URL.
   */
  url: string
}

/** How the speakers are told apart. */
export type SpeakerMode =
  /** One channel per side (a stereo Recording): each channel is a speaker, no diarization needed. */
  | 'split_channels'
  /** One mixed channel: the vendor tells the speakers apart (diarization), up to `maxSpeakers`. */
  | 'diarize'

/** A send. */
export interface TranscribeRequest {
  /**
   * Chosen by the caller, unique per Organization, 1 to 128 of letters, digits, `.`, `_`, `:` and
   * `-`: the playbook service uses `<callId>:<sendNumber>`. It is the only key the caller needs
   * for {@link Transcriber.getResult} and {@link Transcriber.delete}; the vendor's id
   * ({@link Submission.vendorId}) is an optional shortcut, never required.
   */
  clientReference: string
  /** The audio. */
  audio: AudioReference
  /** How speakers are told apart. */
  speakers: SpeakerMode
  /** With `diarize`: the most speakers to find, 1 to 10. Not allowed with `split_channels`. */
  maxSpeakers?: number
  /**
   * Required: a stable name for the audio itself, such as the object key and content hash
   * (`<key>:<sha256>`), 1 to 256 of letters, digits, `.`, `_`, `:`, `/` and `-`. The audio URL is
   * short-lived and a retry gets a new one, so the URL is not part of what makes two sends "the
   * same"; this is. Sending a reference again with a different `audioKey` is a conflict.
   */
  audioKey: string
  /**
   * Optional: an `https:` URL the vendor may call when the result is ready, to save polling. The
   * service builds it; it is never taken from a user. The
   * port never requires one: a result is always readable with {@link Transcriber.getResult}, and a
   * webhook is only a hint to look sooner. An adapter that cannot use it ignores it.
   */
  callbackUrl?: string
}

/** What {@link Transcriber.submit} reports. */
export interface Submission {
  /** The client reference, as given. */
  clientReference: string
  /** True when this call created the copy; false when the same send was already there. */
  created: boolean
  /**
   * The vendor's id of the job: an opaque string of 1 to 128 letters, digits, `.`, `_`, `:` and `-`
   * (never parse it). Present whenever the vendor accepted the job, including `created: false`,
   * where it is the existing copy's id. **The caller stores it** beside its own record of the send
   * and passes it back as the `vendorId` hint of {@link Transcriber.getResult} and
   * {@link Transcriber.delete}. It is an identifier, not a secret, but it is not logged either.
   */
  vendorId: string
}

/** The optional hint of {@link Transcriber.getResult} and {@link Transcriber.delete}. */
export interface VendorIdHint {
  /**
   * The id {@link Submission.vendorId} returned. With it the adapter goes straight to that job
   * and scans nothing. It is only a hint, and a wrong one is **ignored, not refused**: an id that
   * names a job with another client reference, another Organization's job, or no job at all makes
   * the call behave exactly as if no hint had been given (found by the client reference and no
   * other), so a stale or mixed-up id can neither act on a job the call is not about nor tell a
   * caller whether another Organization's job exists. Only an id of the wrong shape is refused
   * (`transcriber.invalid_request`).
   */
  vendorId?: string
}

/** Why a transcription failed. A closed list; none says more than the reason. */
export type TranscriptionFailure =
  /** The vendor could not fetch the audio (expired URL, not found, refused). */
  | 'audio_unreachable'
  /** The audio is not a format or shape the vendor can use (corrupt, wrong channel count). */
  | 'audio_invalid'
  /** The audio has no speech. */
  | 'no_speech'
  /** The audio is longer than the vendor takes. */
  | 'too_long'
  /** The vendor gave up or had an internal error. */
  | 'vendor_failed'
  /** The vendor did not finish within its own limit. */
  | 'timed_out'

/** One stretch of speech by one speaker. */
export interface TranscriptTurn {
  /**
   * Who spoke, as a label: `A`, `B`... for `diarize`; for `split_channels` a label the vendor
   * assigns per channel (see `channel`). Labels are data, never instructions, and are not logged.
   */
  speaker: string
  /** With `split_channels`: the 0-based channel this turn came from. Absent with `diarize`. */
  channel?: number
  /** Start, in milliseconds from the start of the audio. */
  startMs: number
  /** End, in milliseconds; not before `startMs`. */
  endMs: number
  /** What was said, at most 20,000 characters. Untrusted text. */
  text: string
}

/** The state of one send. */
export type TranscriptionResult =
  | { status: 'pending' }
  | {
      status: 'done'
      /** The audio's length in milliseconds, as the vendor measured it (what it bills). */
      durationMs: number
      /** Turns in time order, at most 50,000. */
      turns: TranscriptTurn[]
    }
  | { status: 'failed'; reason: TranscriptionFailure }

/** One send in a listing. */
export interface TranscriptionEntry {
  /** The client reference. */
  clientReference: string
  /** The vendor's id of this copy, as {@link Submission.vendorId} returned it. */
  vendorId: string
  /** `pending`, `done` or `failed`. */
  status: TranscriptionResult['status']
}

/** Options of {@link Transcriber.list}. */
export interface TranscriptionListOptions {
  /**
   * Only references that start with this; default all. End the prefix with the separator
   * (`call_1:`): `call_1` also matches `call_10:`.
   */
  prefix?: string
  /** The `nextCursor` of the previous page. */
  cursor?: string
  /** Page size, 1 to 1000; default 100. */
  limit?: number
}

/** One page of a listing. */
export interface TranscriptionPage {
  /** Entries in ascending reference order. */
  items: TranscriptionEntry[]
  /** Pass as `cursor` for the next page; absent on the last one. */
  nextCursor?: string
}

/**
 * Batch speech-to-text behind a vendor (ADR 0010: AssemblyAI), scoped by Organization. Every call
 * takes the Organization id first and reaches only that Organization's sends: a real adapter must
 * put the validated id into the reference it gives the vendor (`<organizationId>/<clientReference>`)
 * so a second Organization's identical reference is a different send and can never be read or
 * deleted. Audio is given by reference (a short-lived URL the vendor fetches), never as bytes: a
 * 500 MB Recording is never buffered by the service, and the URL is the "short-lived presigned
 * URL" of ADR 0018. Results are read by polling; a webhook is only an optional hint.
 *
 * What every adapter must do: give every vendor call a timeout and a bounded, jittered retry
 * (only `transcriber.unavailable` is retryable by the caller after that), make `submit` idempotent
 * by client reference, throw {@link TranscriberError} with a code from the closed set, read at most
 * `MAX_TRANSCRIPT_RESPONSE_BYTES` of any response before parsing it and run every result through
 * `checkTranscriptionResult` (vendor output is untrusted), and never log, throw or report audio,
 * an audio URL, transcript text, speaker labels or a vendor id. Audio and text are personal data
 * of Prospects; the vendor must not train on them and must delete them (see `delete`).
 *
 * **The vendor id (decided, hub issue 75):** `submit` returns the vendor's job id, the caller
 * stores it beside its own record of the send (the playbook service keeps it next to
 * `vendor_send_seq`), and passes it back as a hint so a read or delete goes straight to the job.
 * The adapter owns no storage of its own: no mapping table. The fallback for a crash after the
 * vendor accepted the job and before the caller stored the id is `list`, which finds every copy
 * for a client reference, so `getResult` and `delete` still work with the reference alone.
 *
 * **A blocker for the real adapter, unverified:** whether AssemblyAI lets the caller give a
 * reference of its own, or list its jobs by one (for example through metadata or a webhook query
 * parameter echoed on the job), is not established; its transcript object has no such field in the
 * documentation read so far. The fallback above needs exactly that listing, so until it is shown
 * to work against the vendor no real adapter may be written, and this port cannot paper over it. The
 * other open questions (ADR 0018, "before real audio"): can a stereo file be transcribed per
 * channel with its own speaker label (`multichannel`) and what does it bill, the EU endpoint for
 * the EU Region, and how soon after a delete the vendor's copy is gone and whether it confirms
 * it. Until all are answered, no real adapter may run outside `local`.
 */
export interface Transcriber {
  /**
   * Starts a transcription. Idempotent by `(organizationId, clientReference)`: repeating the same
   * request returns `created: false` and starts nothing, so a caller that crashed before storing
   * anything can send again safely; the same reference with a different mode, speaker cap or
   * `audioKey` is `transcriber.conflict`. Concurrent submits of one reference create it at most
   * once: at most one of them answers `created: true`. The audio URL is not compared (a retry presigns a new
   * one), so without an `audioKey` the audio itself is not checked. An adapter validates with the
   * shared checks and its `ENVIRONMENT`: plain `http:` URLs only in `local`. Everything is validated before anything is sent. O(1).
   */
  submit(organizationId: string, request: TranscribeRequest): Promise<Submission>
  /**
   * Reads one send's state, or returns `undefined` when there is no send with that reference (never
   * submitted, or deleted). A `done` result is final and can be read again. Poll with
   * {@link waitForTranscription}. With a `vendorId` hint the adapter reads that job directly (see
   * {@link VendorIdHint}: a wrong id is ignored); without one it finds the copy through `list`.
   * O(result size) with the hint, O(the Organization's size) without it on a real vendor.
   */
  getResult(
    organizationId: string,
    clientReference: string,
    hint?: VendorIdHint
  ): Promise<TranscriptionResult | undefined>
  /**
   * Deletes the vendor's copy (audio, transcript and metadata) of the send with this reference,
   * every copy that carries it, and returns `existed: true` when at least one was found and
   * removed (or cancelled). Idempotent: deleting again, or a reference never sent, resolves with
   * `existed: false`. It works with the client reference alone, including for a send whose vendor
   * id the caller never stored (a crash between the vendor accepting it and the caller recording
   * its id), which is why {@link Transcriber.list} exists. A send still processing is cancelled,
   * or waited for a bounded time; if the vendor can do neither within that time the call throws
   * `transcriber.unavailable` (retryable) and the caller retries: a purge is not done until
   * `delete` has resolved for every reference. It resolves only when the vendor confirmed the
   * deletion. **The caller must stop new submits for a Call before it lists and deletes**, or a
   * send made in between survives. With a `vendorId` hint the adapter deletes that job directly (a
   * wrong id is ignored, see {@link VendorIdHint}); the reference is still deleted, so a hint never
   * narrows a purge. O(1) with the hint.
   *
   * **A purge retries.** `transcriber.unavailable` is the one retryable code: a purge retries each
   * `delete` with exponential backoff and jitter for at least the vendor's longest processing time
   * (a send still processing may only be deletable after it ends), then escalates, for example by
   * reporting the Call as not purged and alerting an operator, rather than dropping it. A failed
   * `delete` changes nothing, so the retry is always safe.
   */
  delete(
    organizationId: string,
    clientReference: string,
    hint?: VendorIdHint
  ): Promise<{ existed: boolean }>
  /**
   * Lists the Organization's sends by reference prefix, **for background jobs only**: it may scan
   * the vendor's account, so it is slow and never on a request path. The order is stable (by
   * reference) and the cursor is opaque, valid only for the same Organization and prefix. A page
   * may be shorter than `limit`, even empty, and still have a `nextCursor`: follow the cursor until
   * it is absent. A purge lists `<callId>:` and deletes each entry, so a send the caller has no
   * record of is still removed. Work proportional to the Organization's size.
   */
  list(organizationId: string, options?: TranscriptionListOptions): Promise<TranscriptionPage>
}

/** Options of {@link waitForTranscription}. */
export interface WaitOptions {
  /** The most reads, the first included, 1 to 1000; default 60. */
  maxAttempts?: number
  /** The pause between reads in ms before jitter, 0 to 60000; default 5000. */
  intervalMs?: number
  /** Replaces the pause, for tests. */
  sleep?: (ms: number) => Promise<void>
  /** Replaces the random source in [0, 1) for the jitter, for tests. */
  random?: () => number
  /** Stops waiting when it fires. */
  signal?: AbortSignal
  /** The {@link Submission.vendorId} the caller stored, passed to every read as the hint. */
  vendorId?: string
}
