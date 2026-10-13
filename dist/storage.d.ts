import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
/** Decides whether a string is an Organization id this deployment accepts. */
type OrganizationIdCheck = (value: string) => boolean;
/** The deployment environments a service can run in, from its `ENVIRONMENT` variable. */
declare const ENVIRONMENTS: readonly ["local", "dev", "staging", "prod"];
/** One of the deployment environments. */
type Environment = (typeof ENVIRONMENTS)[number];
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
	/** The content type as the writer gave it. Informational only: nothing may branch on it. */
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
* keeps the content type as given and never looks at the content. Bodies are held in memory, so an
* object is at most `maxObjectBytes` (25 MiB by default, 100 MiB at most). Throws
* {@link StorageError}; only `storage.unavailable` is worth retrying.
*/
interface ObjectStore {
	/**
	* Writes an object, replacing one with the same key. Idempotent: the same call twice leaves the
	* same object. O(object size).
	*/
	put(organizationId: string, key: string, body: Uint8Array, options?: PutOptions): Promise<void>;
	/** Reads an object, or returns `undefined` when there is none. O(object size). */
	get(organizationId: string, key: string): Promise<StoredObject | undefined>;
	/** Reads an object's metadata, or returns `undefined` when there is none. O(1). */
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
	send(command: PutObjectCommand | GetObjectCommand | HeadObjectCommand | DeleteObjectCommand | ListObjectsV2Command, options?: {
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
	/** Bound on one operation including every attempt, in ms; default 60000. */
	deadlineMs?: number;
	/** Attempts per call, the first included, with the SDK's jittered exponential back-off; default 3. */
	maxAttempts?: number;
	/** A replacement for the SDK client, for unit tests with no network. */
	client?: S3Sender;
}
/** The default bound on one attempt, in milliseconds. */
declare const S3_DEFAULT_TIMEOUT_MS = 5e3;
/** The default bound on a whole operation, in milliseconds. */
declare const S3_DEFAULT_DEADLINE_MS = 6e4;
/** The default number of attempts per call. */
declare const S3_DEFAULT_MAX_ATTEMPTS = 3;
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
* Complexity: put and get O(object size); head and delete O(1); list O(limit); one HTTP call each.
*/
declare function createS3ObjectStore(options: S3ObjectStoreOptions): ObjectStore;
export { S3ObjectStoreOptions, S3Sender, S3_DEFAULT_DEADLINE_MS, S3_DEFAULT_MAX_ATTEMPTS, S3_DEFAULT_TIMEOUT_MS, S3_KEY_PREFIX, createS3ObjectStore };
