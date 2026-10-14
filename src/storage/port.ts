/** The longest key, in bytes. */
export const MAX_KEY_BYTES = 512

/** The most `/`-separated segments a key can have. */
export const MAX_KEY_SEGMENTS = 16

/** The default largest object, in bytes (25 MiB). */
export const DEFAULT_MAX_OBJECT_BYTES = 25 * 1024 * 1024

/** The largest `maxObjectBytes` a store can be configured with (100 MiB): bodies are held in memory. */
export const MAX_OBJECT_BYTES_LIMIT = 100 * 1024 * 1024

/** The default page size of {@link ObjectStore.list}. */
export const DEFAULT_LIST_LIMIT = 100

/** The largest page size of {@link ObjectStore.list}. */
export const MAX_LIST_LIMIT = 1000

/** The content type stored when the caller gives none. */
export const DEFAULT_CONTENT_TYPE = 'application/octet-stream'

/** The largest `maxBytes` of a streamed put (2 GiB); streamed bodies are never held whole in memory. */
export const MAX_STREAM_BYTES_LIMIT = 2 * 1024 * 1024 * 1024

/** The longest a source stream may stay silent before a streamed put gives up, in ms. */
export const STREAM_IDLE_TIMEOUT_MS = 30_000

/** The bytes of a streamed put: a web stream or any async iterable of byte chunks. */
export type ByteStream = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>

/** What a listing says about one object. */
export interface ObjectEntry {
  /** The key, relative to the Organization. */
  key: string
  /** The size in bytes. */
  size: number
  /** When the object was last written. */
  lastModified: Date
}

/** What {@link ObjectStore.head} says about one object. */
export interface ObjectInfo extends ObjectEntry {
  /**
   * The content type as the store holds it, which is what the writer gave except that a store may
   * normalise insignificant whitespace in the parameters (`text/plain; charset=utf-8` can come back
   * as `text/plain;charset=utf-8`). Never compare it as a raw string, and never use it to decide
   * behaviour: it is informational and untrusted.
   */
  contentType: string
}

/** An object with its body. */
export interface StoredObject extends ObjectInfo {
  /** The bytes. A copy: changing it does not change the store. */
  body: Uint8Array
}

/** Options of {@link ObjectStore.put}. */
export interface PutOptions {
  /** A `type/subtype` media type with optional parameters; default `application/octet-stream`. */
  contentType?: string
}

/** Options of {@link ObjectStore.putStream}. */
export interface PutStreamOptions extends PutOptions {
  /** The most bytes the stream may hold, 1 to 2 GiB; one byte more aborts the write. Required. */
  maxBytes: number
  /** Aborts the write (and cleans up what it started) when it fires. */
  signal?: AbortSignal
  /** How long the source may stay silent, in ms, 10 to 600000; default 30000. */
  idleTimeoutMs?: number
}

/** What a finished streamed put reports. */
export interface PutStreamResult {
  /** The bytes written. */
  size: number
  /** The SHA-256 of the content, lower-case hex, computed while streaming. */
  sha256: string
}

/** An object whose body is read as a stream, so it is never held whole in memory. */
export interface ObjectStream extends ObjectInfo {
  /** The bytes, once. Cancel it if you stop reading, so the connection is released. */
  body: ReadableStream<Uint8Array>
}

/** Options of {@link ObjectStore.list}. */
export interface ListOptions {
  /** Only keys that start with this, such as `documents/` or `documents/ab`; default all. */
  prefix?: string
  /** The `nextCursor` of the previous page. */
  cursor?: string
  /** Page size, 1 to 1000; default 100. */
  limit?: number
}

/** One page of a listing. */
export interface ListPage {
  /** Objects in ascending key order. */
  items: ObjectEntry[]
  /** Pass as `cursor` for the next page; absent on the last one. */
  nextCursor?: string
}

/**
 * Object storage scoped by Organization. Every call takes the Organization id first and can reach
 * only that Organization's objects: the adapter derives the real location from the validated id,
 * never from a string the caller built, so no key (`..`, a leading slash, an encoded separator, an
 * id that starts with another id) can name another Organization's data. Keys are relative to the
 * Organization and made of `/`-separated segments of letters, digits, `.`, `_` and `-`, none
 * starting with `.`, at most 512 bytes and 16 segments. Content is untrusted bytes: the store
 * keeps the content type as given (returned as the store holds it, see {@link ObjectInfo}) and never looks at the content. Bodies are held in memory, so an
 * object is at most `maxObjectBytes` (25 MiB by default, 100 MiB at most). Throws
 * {@link StorageError}; only `storage.unavailable` is worth retrying.
 */
export interface ObjectStore {
  /**
   * Writes an object, replacing one with the same key. Idempotent: the same call twice leaves the
   * same object. O(object size).
   */
  put(organizationId: string, key: string, body: Uint8Array, options?: PutOptions): Promise<void>
  /**
   * Writes an object from a stream with a hard limit, for objects too large to hold (a 500 MB
   * recording). Memory stays bounded by a few parts, not by the object: the S3 adapter uploads in
   * parts of 8 MiB, two at a time. The limit is checked while streaming: when `maxBytes` is
   * exceeded, the source stalls for 30 s, the source fails or `signal` fires, the write is aborted,
   * its incomplete parts are aborted (the bucket must also expire incomplete multipart uploads), and
   * nothing becomes readable under the key; an object already there is left as it was. Returns the
   * size and the SHA-256 of the content. Objects written this way can be larger than
   * `maxObjectBytes`: read them with {@link ObjectStore.getStream}, because `get` refuses them with
   * `storage.object_too_large`. Idempotent: the same stream twice leaves the same object. O(object
   * size) time, O(part size) memory on S3 (the memory adapter, for tests, holds the object).
   */
  putStream(
    organizationId: string,
    key: string,
    body: ByteStream,
    options: PutStreamOptions
  ): Promise<PutStreamResult>
  /**
   * Reads an object as a stream, or returns `undefined` when there is none. Not limited by
   * `maxObjectBytes`. The caller must read or cancel the body. O(1) to open.
   */
  getStream(organizationId: string, key: string): Promise<ObjectStream | undefined>
  /** Reads an object, or returns `undefined` when there is none. O(object size). */
  get(organizationId: string, key: string): Promise<StoredObject | undefined>
  /**
   * Reads an object's metadata, or returns `undefined` when there is none. O(1). On S3 a HEAD of a
   * bucket that does not exist also reads as `undefined`, because a HEAD response carries no error
   * body to tell the two apart; `get`, `put`, `delete` and `list` do report a missing bucket as
   * `storage.rejected`.
   */
  head(organizationId: string, key: string): Promise<ObjectInfo | undefined>
  /** Deletes an object. Resolves when it is gone, including when it never existed. O(1). */
  delete(organizationId: string, key: string): Promise<void>
  /**
   * Lists one page of the Organization's objects in key order. The page is at most `limit` items
   * (1000 at most), so a listing is never unbounded: follow `nextCursor` for more. Memory adapter
   * O(n log n) in the Organization's n objects; S3 adapter one request, O(limit).
   */
  list(organizationId: string, options?: ListOptions): Promise<ListPage>
}
