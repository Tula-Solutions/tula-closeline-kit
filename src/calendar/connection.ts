import type { OrganizationId } from 'tula-closeline-contract'

const INSPECT = Symbol.for('nodejs.util.inspect.custom')

/** What {@link CalendarConnection}'s constructor takes. */
export interface CalendarConnectionInit {
  /** The Organization the Rep belongs to. */
  organizationId: OrganizationId
  /** The vendor, such as `google` or `microsoft`; `memory` for the test adapter. */
  provider: string
  /** A stable, non-secret id of this connection; safe to log and to use as a database key. */
  connectionId: string
  /** The secret the adapter needs to call the vendor (a refresh token or a sealed blob). Never logged. */
  credential: string
}

/**
 * A Rep's authorised link to their calendar, as the adapter handed it back from `connect`. It is
 * opaque: the OAuth credential is held in a private field, so it is not in `JSON.stringify`, a
 * spread, `String()`, a log line or a console dump; only `connectionId`, `provider` and the
 * Organization are. core stores {@link CalendarConnection.unsafeCredential} encrypted at rest and
 * rebuilds the connection with `new CalendarConnection(...)`; only an adapter reads it for any
 * other reason.
 */
export class CalendarConnection {
  /** The Organization the connection belongs to. */
  readonly organizationId: OrganizationId
  /** The vendor name. */
  readonly provider: string
  /** The non-secret id of the connection. */
  readonly connectionId: string
  readonly #credential: string

  constructor(init: CalendarConnectionInit) {
    if (
      typeof init.provider !== 'string' ||
      init.provider.length < 1 ||
      init.provider.length > 64 ||
      typeof init.connectionId !== 'string' ||
      init.connectionId.length < 1 ||
      init.connectionId.length > 256 ||
      typeof init.credential !== 'string' ||
      init.credential.length < 1
    ) {
      throw new TypeError('CalendarConnection needs a provider, a connection id and a credential')
    }
    this.organizationId = init.organizationId
    this.provider = init.provider
    this.connectionId = init.connectionId
    this.#credential = init.credential
  }

  /** The vendor credential. For the adapter that issued the connection and for encrypted storage only; never log it. */
  unsafeCredential(): string {
    return this.#credential
  }

  /** The non-secret parts, for `JSON.stringify`. */
  toJSON(): { organizationId: OrganizationId; provider: string; connectionId: string } {
    return {
      organizationId: this.organizationId,
      provider: this.provider,
      connectionId: this.connectionId,
    }
  }

  /** A readable label without the credential. */
  toString(): string {
    return `CalendarConnection(${this.provider}:${this.connectionId})`
  }

  /** The console and `util.inspect` form, without the credential. */
  [INSPECT](): string {
    return this.toString()
  }
}
