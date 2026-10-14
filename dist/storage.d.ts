import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, UploadPartCommand } from "@aws-sdk/client-s3";
/** Structured logger that redacts secrets, tokens, recordings and message bodies. */
interface Logger {
	/** Logs detail useful only while debugging. */
	debug(message: string, fields?: Record<string, unknown>): void;
	/** Logs a normal event. */
	info(message: string, fields?: Record<string, unknown>): void;
	/** Logs something unexpected that the service recovered from. */
	warn(message: string, fields?: Record<string, unknown>): void;
	/** Logs a failure. */
	error(message: string, fields?: Record<string, unknown>): void;
	/** Returns a logger that adds `fields` to every entry. */
	child(fields: Record<string, unknown>): Logger;
}
/** Decides whether a string is an Organization id this deployment accepts. */
type OrganizationIdCheck = (value: string) => boolean;
/** The deployment environments a service can run in, from its `ENVIRONMENT` variable. */
declare const ENVIRONMENTS: readonly ["local", "dev", "staging", "prod"];
/** One of the deployment environments. */
type Environment = (typeof ENVIRONMENTS)[number];
/** The bytes of a streamed put: a web stream or any async iterable of byte chunks. */
type ByteStream = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;
/** What a listing says about one object. */
interface ObjectEntry {
	/** The key, relative to the Organization. */
	key: string;
	/** The size in bytes. */
	size: number;
	/** When the object was last written. */
	lastModified: Date;
}
/** What {@link ObjectStore.head} says about one object. */
interface ObjectInfo extends ObjectEntry {
	/**
	* The content type as the store holds it, which is what the writer gave except that a store may
	* normalise insignificant whitespace in the parameters (`text/plain; charset=utf-8` can come back
	* as `text/plain;charset=utf-8`). Never compare it as a raw string, and never use it to decide
	* behaviour: it is informational and untrusted.
	*/
	contentType: string;
}
/** An object with its body. */
interface StoredObject extends ObjectInfo {
	/** The bytes. A copy: changing it does not change the store. */
	body: Uint8Array;
}
/** Options of {@link ObjectStore.put}. */
interface PutOptions {
	/** A `type/subtype` media type with optional parameters; default `application/octet-stream`. */
	contentType?: string;
}
/** Options of {@link ObjectStore.putStream}. */
interface PutStreamOptions extends PutOptions {
	/** The most bytes the stream may hold, 1 to 2 GiB; one byte more aborts the write. Required. */
	maxBytes: number;
	/** Aborts the write (and cleans up what it started) when it fires. */
	signal?: AbortSignal;
	/** How long the source may stay silent, in ms, 10 to 600000; default 30000. */
	idleTimeoutMs?: number;
}
/** What a finished streamed put reports. */
interface PutStreamResult {
	/** The bytes written. */
	size: number;
	/** The SHA-256 of the content, lower-case hex, computed while streaming. */
	sha256: string;
}
/** An object whose body is read as a stream, so it is never held whole in memory. */
interface ObjectStream extends ObjectInfo {
	/** The bytes, once. Cancel it if you stop reading, so the connection is released. */
	body: ReadableStream<Uint8Array>;
}
/** Options of {@link ObjectStore.list}. */
interface ListOptions {
	/** Only keys that start with this, such as `documents/` or `documents/ab`; default all. */
	prefix?: string;
	/** The `nextCursor` of the previous page. */
	cursor?: string;
	/** Page size, 1 to 1000; default 100. */
	limit?: number;
}
/** One page of a listing. */
interface ListPage {
	/** Objects in ascending key order. */
	items: ObjectEntry[];
	/** Pass as `cursor` for the next page; absent on the last one. */
	nextCursor?: string;
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
interface ObjectStore {
	/**
	* Writes an object, replacing one with the same key. Idempotent: the same call twice leaves the
	* same object. O(object size).
	*/
	put(organizationId: string, key: string, body: Uint8Array, options?: PutOptions): Promise<void>;
	/**
	* Writes an object from a stream with a hard limit, for objects too large to hold (a 500 MB
	* recording). Memory stays bounded by a few parts, not by the object: the S3 adapter uploads in
	* parts of 8 MiB, two at a time. The limit is checked while streaming: when `maxBytes` is
	* exceeded, the source stalls for 30 s, the source fails or `signal` fires, the write is aborted,
	* its incomplete parts are aborted (the bucket must also expire incomplete multipart uploads), and
	* nothing becomes readable under the key; an object already there is left as it was. Returns the
	* size and the SHA-256 of the content. Objects written this way can be larger than
	* `maxObjectBytes`: read them with {@link ObjectStore.getStream}, because `get` refuses them with
	* `storage.object_too_large`. **Residual cases:** a throw after the last part was sent (the
	* completing request timed out or its answer was lost) means the content under the key is
	* unknown: the store may have finished. Retry the write (it is idempotent), or `head` and
	* `delete` before relying on the key being absent. Aborting the upload is best-effort, and a
	* create or a part request that timed out client-side but reached the store can leave an
	* incomplete upload that only the bucket's lifecycle rule removes: abort incomplete multipart
	* uploads one day after initiation (`AbortIncompleteMultipartUpload`, `DaysAfterInitiation: 1`).
	* Idempotent: the same stream twice leaves the same object. O(object
	* size) time, O(part size) memory on S3 (the memory adapter, for tests, holds the object).
	*/
	putStream(organizationId: string, key: string, body: ByteStream, options: PutStreamOptions): Promise<PutStreamResult>;
	/**
	* Reads an object as a stream, or returns `undefined` when there is none. Not limited by
	* `maxObjectBytes`. The caller must read or cancel the body. O(1) to open.
	*/
	getStream(organizationId: string, key: string): Promise<ObjectStream | undefined>;
	/** Reads an object, or returns `undefined` when there is none. O(object size). */
	get(organizationId: string, key: string): Promise<StoredObject | undefined>;
	/**
	* Reads an object's metadata, or returns `undefined` when there is none. O(1). On S3 a HEAD of a
	* bucket that does not exist also reads as `undefined`, because a HEAD response carries no error
	* body to tell the two apart; `get`, `put`, `delete` and `list` do report a missing bucket as
	* `storage.rejected`.
	*/
	head(organizationId: string, key: string): Promise<ObjectInfo | undefined>;
	/** Deletes an object. Resolves when it is gone, including when it never existed. O(1). */
	delete(organizationId: string, key: string): Promise<void>;
	/**
	* Lists one page of the Organization's objects in key order. The page is at most `limit` items
	* (1000 at most), so a listing is never unbounded: follow `nextCursor` for more. Memory adapter
	* O(n log n) in the Organization's n objects; S3 adapter one request, O(limit).
	*/
	list(organizationId: string, options?: ListOptions): Promise<ListPage>;
}
/** The one SDK method the adapter uses; a test passes a stub with this shape. */
interface S3Sender {
	/** Sends one SDK command, with a per-call timeout and abort signal. */
	send(command: PutObjectCommand | GetObjectCommand | HeadObjectCommand | DeleteObjectCommand | ListObjectsV2Command | CreateMultipartUploadCommand | UploadPartCommand | CompleteMultipartUploadCommand | AbortMultipartUploadCommand, options?: {
		requestTimeout?: number;
		abortSignal?: AbortSignal;
	}): Promise<unknown>;
}
/** Options for {@link createS3ObjectStore}. */
interface S3ObjectStoreOptions {
	/** The bucket. One bucket per Region (ADR 0001); Organizations are separated by key prefix. */
	bucket: string;
	/** The AWS Region of the bucket. */
	region: string;
	/** The `ENVIRONMENT` the service runs in. */
	environment: Environment;
	/**
	* An endpoint to use instead of AWS, for the S3 stand-in in local development
	* (`http://127.0.0.1:9090`). Accepted only when `environment` is `local`; anywhere else it
	* throws at construction, as does a set `AWS_ENDPOINT_URL` or `AWS_ENDPOINT_URL_S3`. Credentials
	* are never an option: they come from the SDK's default chain.
	*/
	endpoint?: string;
	/** Largest object in bytes; default 25 MiB, at most 100 MiB. */
	maxObjectBytes?: number;
	/** Extra Organization id rule; the contract's format by default. */
	isOrganizationId?: OrganizationIdCheck;
	/** Bound on one attempt's connect and idle time, in ms; default 5000. */
	timeoutMs?: number;
	/** Bound on one public call (a `list` may make several requests) including every attempt, in ms; default 60000. */
	deadlineMs?: number;
	/** Attempts per call, the first included, with the SDK's jittered exponential back-off; default 3. */
	maxAttempts?: number;
	/** Size of one part of a streamed put in bytes, 5 MiB to 64 MiB; default 8 MiB. */
	partBytes?: number;
	/** Parts of one streamed put uploading at once, 1 to 8; default 2. */
	partConcurrency?: number;
	/** Where `list` reports, by number, the keys it skipped; nothing else is logged. */
	logger?: Logger;
	/** A replacement for the SDK client, for unit tests with no network. */
	client?: S3Sender;
}
/** The default bound on one attempt, in milliseconds. */
declare const S3_DEFAULT_TIMEOUT_MS = 5e3;
/** The default bound on a whole operation, in milliseconds. */
declare const S3_DEFAULT_DEADLINE_MS = 6e4;
/** The default number of attempts per call. */
declare const S3_DEFAULT_MAX_ATTEMPTS = 3;
/** The default size of a part of a streamed put, in bytes. */
declare const S3_DEFAULT_PART_BYTES: number;
/** The default number of parts of one streamed put uploading at once. */
declare const S3_DEFAULT_PART_CONCURRENCY = 2;
/** Every object of every Organization lives under this prefix, then `<organizationId>/`. */
declare const S3_KEY_PREFIX = "orgs/";
/**
* Creates the S3 adapter, built on the AWS SDK v3 S3 client.
*
* Location: an object is stored at `orgs/<organizationId>/<key>`. Both parts were validated, the
* Organization id against a hard character set (no separator, dot or escape) and the key by the
* port's segment rules, and the prefix ends in `/`, so `org_1` never reaches `org_10`. A listing
* asks S3 for that prefix only and the adapter refuses any key S3 returns outside it.
*
* Timeouts: every attempt has a connect and an idle timeout (`timeoutMs`) and the whole operation
* has a deadline (`deadlineMs`). Retries: the SDK's own, `maxAttempts` with the `standard` mode's
* jittered exponential back-off and retry quota, for the failures it calls retryable (5xx,
* throttling, timeouts, dropped connections); a 4xx such as access denied is not retried. Put and
* delete are idempotent, so a retry is safe. Neither bodies nor keys are logged: the adapter does
* not log.
*
* Proxies: the SDK's Node HTTP handler is used with its default agents, which in Bun do not read
* `HTTP_PROXY`, `HTTPS_PROXY` or `ALL_PROXY` (see the SQS adapter's proof, `aws-proxy.test.ts`).
*
* Keys the port cannot name (a console folder marker, a name with a space) are skipped by `list`,
* which reads ahead for at most ten requests: the first asks for the page size, the other nine for
* 1000 keys each. The cursor is the last key handed out, so more than about 9,000 such keys in a
* row after it (the page size plus 9,000) make every attempt to list past them fail with
* `storage.bad_response`, and the valid keys beyond the run cannot be reached through the port.
* Accepted by design: this adapter is the only writer under the prefix, and it never writes one.
*
* Streamed puts: a body of at most one part is one PutObject. A larger one is a multipart upload
* with parts of `partBytes` (8 MiB), `partConcurrency` (2) at a time, so memory is about
* (concurrency + 1) parts whatever the object size. Every request has the per-call deadline
* (`deadlineMs`) and the SDK's retries; the stream as a whole is bounded by `maxBytes` and by the
* caller's `signal`. On any failure the in-flight parts are awaited and the multipart upload is
* aborted, so no part stays billed. The object appears only when the upload completes, so a write
* that fails before the completing request leaves nothing readable and an object already under
* the key stays as it was.
*
* Residual cases, which no code here can close: (1) a throw after the last part was sent (the
* completing request timed out or its answer was lost) means the content under the key is unknown,
* because S3 may have finished: the caller retries (put is idempotent) or heads and deletes before
* relying on absence; (2) the abort is best-effort; (3) a create or part request that timed out
* client-side but reached S3 can leave an incomplete upload that only the bucket's lifecycle rule
* removes, as does a process that dies mid-upload. The bucket must carry that rule: abort
* incomplete multipart uploads 1 day after initiation (`AbortIncompleteMultipartUpload`,
* `DaysAfterInitiation: 1`, the finest S3 offers).
*
* Complexity: put and get O(object size); putStream O(object size) time and O(part size)
* memory; getStream, head and delete O(1); list O(limit); one HTTP call each, except a streamed
* put (one call per part).
*/
declare function createS3ObjectStore(options: S3ObjectStoreOptions): ObjectStore;
export { S3ObjectStoreOptions, S3Sender, S3_DEFAULT_DEADLINE_MS, S3_DEFAULT_MAX_ATTEMPTS, S3_DEFAULT_PART_BYTES, S3_DEFAULT_PART_CONCURRENCY, S3_DEFAULT_TIMEOUT_MS, S3_KEY_PREFIX, createS3ObjectStore };
