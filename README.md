# tula-closeline-kit

Closeline shared runtime helpers: token verification, queue port and adapters, logging, test fixtures

Part of Closeline. The hub repo [`tula-closeline`](https://github.com/Tula-Solutions/tula-closeline)
holds the glossary, decision records, plans, issues and the shared workflow setup.

## Getting started

```bash
gh auth setup-git      # once: lets git fetch the private tula-closeline-* libraries over https
bun install
bun run verify
```

Standards: `AGENTS.md` (this repo) and `.claude/COMMON.md` (shared).

## Signing keys and rotation

`createRemoteKeySet` caches the auth service's JWKS. A cached `kid` verifies with no I/O. An unknown
`kid` triggers at most one refresh per cooldown (30 s by default), and the answer depends on how
the most recent refresh ended:

| Most recent refresh | Unknown `kid` |
| --- | --- |
| succeeded, and its JWKS lacks the `kid` | 401 `auth.token_invalid` |
| failed, was cut off by the 5 s lookup deadline, is still running, or has not happened | 503 `auth.unavailable` |

A refresh blocked by the cooldown inherits the outcome of the attempt that started the cooldown.

**Rotation rule.** The auth service must publish a new key in its JWKS at least five minutes before
it signs with it. A verifier that refreshed successfully just before publication answers 401 for
the new `kid` until its cooldown (30 s) passes, because it cannot tell that token from a forged
one. Five minutes leaves every verifier's cooldown over before the first token with the new `kid`
exists, so its first lookup refreshes and finds the key.

## Calling another service (`createInternalClient`)

Every service-to-service call goes through this client (ADR 0013). It sends the shared secret as a
bearer token and never through an HTTP proxy.

**Why not `fetch`.** The probe in `src/http/proxy.test.ts` shows that in Bun 1.4.2 `fetch` sends a
request to the proxy named by `HTTP_PROXY`/`http_proxy` (for `http:` URLs) or
`HTTPS_PROXY`/`https_proxy` (for `https:` URLs), that `ALL_PROXY` is ignored, that a per-request
`proxy: ''` does not turn it off, and that `NO_PROXY` exempts a host only by matching it. The
client uses `node:http` and `node:https` with `agent: false`, which read no proxy variable at all,
so there is nothing to configure and no boot check to keep correct. The probe stays in the suite:
a Bun upgrade that changes a row fails it.

```ts
import { createInternalClient, InternalCallError } from 'tula-closeline-kit'

// src/container.ts, the only place adapters are built
const core = createInternalClient({
  baseUrl: env.CORE_URL,            // https, or http only for loopback or ENVIRONMENT=local
  secret: env.CORE_INTERNAL_TOKEN,
  environment: env.ENVIRONMENT,
  userAgent: 'closeline-auth',
  timeoutMs: 2_000,                 // one attempt; default 5 000
  retry: { maxAttempts: 2 },        // default 3 attempts; see below
  logger,
})

const { status, json } = await core.request({
  method: 'POST',
  path: '/internal/organizations',
  body: { userId, organizationName },
  idempotencyKey,                   // sent as Idempotency-Key; makes a POST safe to retry
})
```

- `request` resolves with `{ status, json, attempts, retryAfterMs? }` for every answer that is not a redirect,
  4xx and 5xx included: the adapter maps statuses and validates `json` with the contract's schema.
  `json` is parsed whatever the content type says. It is `undefined` for an empty body (204,
  `HEAD`) and for a non-2xx answer that is not JSON. A 2xx answer with a non-empty body that is not
  JSON (an HTML error or login page) is a failure, not an answer. `retryAfterMs` is present when
  the answer had a `Retry-After` of whole seconds (1 to 9 digits; the date form is ignored), in
  milliseconds and uncapped, so a caller that cannot retry itself (a sign-up that must tell the
  user to wait) applies its own cap; no other header is exposed. `request` rejects with
  `InternalCallError` (`failure`: `connection`, `timeout`, `aborted`, `redirect`,
  `response_too_large`, `response_invalid`), which carries `method`, `path` (no query), `status`
  and `attempts`, and never the secret, a body or the underlying error. `response_invalid`,
  `response_too_large` and `redirect` are not retried.
- Retries: only a connection failure, a timeout, 429, 502, 503 and 504, and only when the method is
  `GET`, `HEAD`, `PUT`, `DELETE` or `OPTIONS`, or an `idempotencyKey` is given. Never on another
  status. Defaults: 3 attempts, full jitter (`random * min(2000, 100 * 2^(n-1))` ms), and a
  `Retry-After` in seconds is used instead, cut to 5 s. Inject `sleep` and `random` in tests.
- A redirect is an error and is never followed. A response over `maxResponseBytes` (1 MiB) fails.
  TLS certificates are verified: every https request sets `rejectUnauthorized: true` itself, so
  `NODE_TLS_REJECT_UNAUTHORIZED=0` in the environment does not weaken it, and the client refuses
  to be built while that variable is `0` unless `ENVIRONMENT` is `local`. `ca` adds a trusted CA.
  `NODE_EXTRA_CA_CERTS` is honoured, as in any Bun process: the authorities in that file are
  trusted in addition to the system's, so an operator can add a private CA without a code change
  (it cannot switch verification off). Keep it out of images that talk to anything but your own CA.
- Numbers are checked when the client is built (and `timeoutMs` per call): `retry.maxAttempts` is an
  integer from 1 to 10, `timeoutMs` and `maxResponseBytes` are finite and above zero, and the retry
  delays are finite and not negative; anything else is a `TypeError`.
- Cost per call: one new connection (and one TLS handshake for https), no keep-alive, no allocation
  beyond the bounded response. It is not a hot path, so there is no benchmark.
- Outbound calls to vendors are not internal calls: they may use `fetch` and a proxy set on purpose.

**Replacing auth's transport.** In `src/adapters/http/membership.ts` drop the `fetch` option,
`callCore`'s `doFetch(...)`, `readBounded` and `AttemptFailed` classification, and call
`core.request({ method: 'POST', path, body, idempotencyKey, timeoutMs })` per attempt. Map an
`InternalCallError` to `MembershipUnavailable`, `status` 401/403 to `CoreCredentialsRejected`, and
validate `json` with the contract's schemas as today. Keep the adapter's concurrency limiter. The lookup sends a fresh `idempotencyKey` per lookup, so
the client may retry it (`retry: { maxAttempts: 2 }`); the sign-up writes keep the flow's key and
are retried by the flow, so pass `retry: { maxAttempts: 1 }` for them. The adapter's
test then names a stand-in proxy in the environment of a child process, as `proxy.test.ts` does.

## Reporting errors

Sentry is the error tracker for every Closeline service, and a service never imports a Sentry
package: it reports through the kit's `ErrorReporter` port.

```ts
interface ErrorReporter {
  capture(error: unknown, context?: ErrorContext): void // returns at once, never throws
  flush(timeoutMs: number): Promise<boolean> // bounded; waits for delivery
  close(timeoutMs: number): Promise<boolean> // flushes, then releases what the reporter holds; call it once on shutdown
}
// ErrorContext: requestId, organizationId, method, path, status, and free-form tags. Nothing else.
```

`createErrorReporter({ dsn, service, environment, region, release, logger })` returns the Sentry
adapter (`@sentry/bun`) when `dsn` is set and a no-op reporter when it is not, so `local` and tests
run without Sentry. `createMemoryErrorReporter()` from `tula-closeline-kit/testing` records calls
for tests, and `createTestDeps()` carries one as `errorReporter`.

**What is reported.** Unexpected errors, and an `AppError` with status 500 or above. An `AppError`
below 500 is never sent. `shouldReportError(error)` is the one predicate, and every adapter uses it.

**One reporter per process.** The Sentry SDK adds two `beforeExit` listeners for every client it
creates, so a service creates its reporter once, in the container, and calls `close` on shutdown,
which removes them. After `close`, `capture` does nothing and `flush` resolves `false` (the no-op
reporter is one shared object with no state, so its `flush` stays `true`). `createErrorReporter`
closes the client it built if the SDK turns out not to have taken the DSN, and falls back to the
no-op reporter.

**The DSN is per Region** (ADR 0001). The kit sends to whatever DSN it is given and does not look
at it: give the EU deployment the DSN of a Sentry project created in Sentry's EU data region
(`*.de.sentry.io`), and the US deployment one in the US region. Never share a project between
Regions, because an event can carry an Organization's identifiers. The DSN must be one the SDK
itself accepts (`https://<key>@<host>/<project id>`, no trailing slash, no dash in the key):
`isSentryDsn` and the env schema apply the SDK's own rule, so a DSN that passes boots and sends.
An invalid DSN gives the no-op reporter and one warning that does not repeat the DSN; nothing is
printed to the console. An `http:` DSN is accepted only when `ENVIRONMENT` is `local`
(`requireSentryDsn` fails the boot otherwise).

**Nothing leaves the process unredacted.** `capture` never hands the SDK what it was given:
- An `Error` is copied into a fresh one that keeps its name, its message (cut at 8 KiB), its
  frames and its `cause` chain and `AggregateError` children (six errors in all, five children per
  group, as the SDK follows no more). Own properties such as `details` are not copied. An error
  with a message over 1 MiB is sent without frames, so `capture` never does work proportional to
  an input it was handed; a 10-million-line message or a 20,000-child `AggregateError` returns in
  a few milliseconds.
- A thrown value that is not an `Error` (an object, a number, `null`) is replaced by an `Error`
  that names only its type, `non-Error value thrown (object)`, and for a string also the string
  after `scrubText`, cut to 512 characters. None of the object's fields is sent.
- Frames are read only from the lines of the stack after the message's own lines, so a message line
  that imitates `    at fn (file:1:2)` is never a frame. A stack that does not hold the message
  where it should (the message was changed after the error was made) is sent without frames.

The event's `exception` entries are rebuilt by the adapter from known fields (type, value, frames
with file, function, line and column, and the mechanism's type, handled flag and cause links), not
kept from the SDK, so nothing another event processor adds to them is sent; there is no
`debug_meta`. The other kept fields are rebuilt or checked too: `sdk` is the SDK's own name
and version and `contexts.runtime` is the adapter's own (`bun` and its version), never read from the
event, so free text a processor writes there is not sent; `release`, `environment` and `platform` are the adapter's own
values, `event_id` must be 32 hex digits and `timestamp` a number. The `organization_id` and
`request_id` tags are sent only if they have a shape this system makes: `<prefix>_<32 lowercase hex>`
with a 2 to 5 letter prefix (as `tula-closeline-contract` makes `org_`, `usr_`, `req_`), a UUID, or
32 hex digits (a trace id). They are never masked, so anything else (a key, a token, a hash, a ULID,
a card number passed by mistake) is sent as `[invalid]`. That includes a request id that is not
one of those shapes, such as an AWS X-Ray trace id (`1-5759e988-bd862e3fe1be46a994272793`) or a
ULID: put it in a free-form tag if it is needed, or pass the 32 hex digits.

Every event then passes the kit's key-based redaction and `scrubText` on every string, in
`beforeSend`. Only the fields this adapter set are kept: the SDK merges its process-wide global
and isolation scopes into every event, so tags, extra data, a user, contexts, breadcrumbs, a
fingerprint or attachments that an application or another library set there are dropped, and no
attachment is ever sent. Request bodies, cookies, query strings, sensitive headers, the user,
source lines and local variables are removed outright. Stack frames and error messages are kept
(messages after `scrubText`). Data collection is switched off (Sentry 11 replaced `sendDefaultPii`
with `dataCollection`), tracing and breadcrumbs are off, and only the `LinkedErrors` integration
(it follows `cause`) is on. Console, HTTP and fetch instrumentation, local variables, source
context, request data, modules, host context, sessions and the global
`uncaughtException`/`unhandledRejection` handlers are off. Wire those yourself through the port:
`process.on('uncaughtException', (e) => reportError(e))`.

**`scrubText(text)`** masks secrets and personal data inside free text. It cuts input at 32 KiB
(`cutText` drops a trailing partial word and marks the cut), runs in linear time and never throws.
The logger uses it for every message and every error `message` and `stack`, so a message over
32 KiB is cut in the log and in the event.

It masks:
- bearer tokens, JWT-shaped strings and common API-key shapes (AWS, GitHub, Stripe, Slack, `sk-`);
- the value of a `key=value` or `key: value` pair whose key the logger redacts (`password`,
  `token`, `secret`, `apiKey`, `authorization`, `cookie`, `body`, `transcript`, `recording`, `pass`,
  `pwd`, `passwd`, `auth`, `signature`, `sig`, `sid`, `session`, `session_id`,
  `AWS_SECRET_ACCESS_KEY`, ...). A quoted value is masked up to its closing quote (a doubled quote
  is part of it); an unquoted value is masked to the end of the line, except after a quoted key
  (JSON, `{"sid":42,"id":"x"}`), where it ends at the next `,`, `}`, `]` or space and an object or
  array value ends where it closes; a value in a URL query string (after `?` or `&`) ends at the
  next `&`, `#`, space, comma or semicolon;
- URL credentials, and database and broker URLs whole (`postgres://`, `redis://`, ... including a
  password with a space or a newline);
- the value in a Postgres constraint detail, `Key (email)=([redacted]) already exists.`;
- email addresses, including letters beyond ASCII (`jörg.müller@acme.de`, `田中@example.jp`);
- telephone numbers written with a `+` (8 to 15 digits), with a parenthesised area code
  (`(415) 555-0199`, `+1 (415) 555-0199`), with the `00` international prefix and a country code
  (`0044 20 7946 0958`, `00 33 6 12 34 56 78`, `001 415 555 0100`, `0065-6123-4567`,
  `00442079460958`, `+44(0)20 7946 0958`, `+33.6.12.34.56.78`) or in the national trunk form, a
  first group that starts with `0` and has 2 to 5 digits (`020 7946 0958`, `06 12 34 56 78`,
  `0171-123-4567`);
- payment card numbers: 13 to 19 digits, bare or written in the usual groups (4-4-4-4, 4-4-4-1, 4-6-5,
  separated by spaces, dashes or dots), in a
  card issuer's range (3x, 4, 5, 6, 2221 to 2720) that pass the Luhn check. A run that starts with
  `1` (epoch timestamps in milliseconds, microseconds and nanoseconds do, and must stay readable) is
  a card only when it is written in four groups of four.

**An identifier is never altered.** When a pattern cannot tell a telephone number or a card from an
id, it leaves the text alone. So these stay readable: UUIDs (including any made of digits only),
`org_`, `usr_`, `req_` and `evt_` ids, ULIDs, hashes, epoch and compact timestamps, ISO dates and
times with offsets, version numbers and CalVer, byte counts and money amounts with separators,
ranges (`984757-662552`), lists of numeric ids, IPv4 and IPv6 addresses, any digits attached to a
letter, `_`, or a `-` or `.` that follows one, ports, `@scope/package` names, and file positions in
stack frames (`at verify (/app/src/auth/token:12:3)` is not read as the key `token`). A property
test holds this to 20,000 UUIDs and thousands of ids of every other kind from a fixed seed.

**Not covered, on purpose.** Free-text scrubbing is a second line of defence that favours keeping
identifiers intact; the main protection is key-based redaction of structured fields, so put personal
data in fields, not in messages. These are not masked in free text:
- telephone numbers written as bare digits, or with separators but without a `+`, a parenthesised
  area code, `00` or a trunk zero (`4155550199`, `415-555-0199`, `1-800-555-0199`, French dotted
  `01.23.45.67.89`, which reads as an IPv4 address). US and Canadian numbers written without a
  `+`, `00` or a leading `0` (`1 415 555 0100`, `415-555-0100`) are not masked, by design: they
  cannot be told from an id or a range;
- international numbers separated by a tab or other whitespace, written one digit at a time, with
  fewer than 8 digits after the `00`, or whose `00` groups all start with `0` after the first
  (`0044 0079 0046 0958`);
- IBANs and other bank account identifiers, and national ids;
- postal addresses and names.

The places an id can still be altered, and the only ones:
- a bare run of 13 to 19 digits that starts in a card issuer's range (4, 5, 6, 3 not followed by
  1, 2 or 3, 2221 to 2720, 81, 86) and passes the Luhn check by chance (about one in ten such
  runs); an id starting with 1 is never read as a bare card, and neither is one outside those
  ranges;
- four ids of four digits written one after the other like a card, when they pass the Luhn check
  (and start in an issuer's range, unless they start with 1);
- digit groups of 9 to 15 digits written with one kind of separator whose first group has 2 to 5
  digits and starts with a single `0` followed by a non-zero digit, because that is how a national
  telephone number opens (`invoice 0123-4567-8901`);
- a run opening with `00` and a valid country code (in the first group, as the second group, or
  glued to the digits after it) is masked as an international number, with 10 to 17 digits, unless
  every group after the first starts with `0`, as a padded counter's do: `0044 0017 0231` and
  `0020-0021-0022` stay readable, and so does a real number that happens to be written that way. A
  first group of three to five digits that is `00` plus something that is no country code
  (`0042-0017-0231`, `0012-3456-7890`) is a counter too. The glued form with nothing between the
  digits (`00442079460958`) is masked, so a bare run of 10 to 17 digits starting `00` and a country
  code (an order number padded with zeros, say) is masked as well; that is the price of not leaking
  a number written without spaces. A lone digit group after the code is allowed once
  (`0055 11 9 1234 5678`);

**It over-masks on purpose.** Prose after a sensitive key goes with the value, because a free-text
value cannot be told from a secret: `Invalid token: expired` becomes `Invalid token: [redacted]`,
`Request body: invalid JSON` loses its last words, and `login failed password=x for ann` ends at
`password=[redacted]`. Put the facts that must survive in structured log fields, not after a
sensitive word in a message.

### Behaviour changes in 0.4.0

For callers of the logger and `scrubText` before this version:
- **More log field names are redacted.** Before: `password`, `token`, `secret`, `apiKey`,
  `authorization`, `cookie`, `body`, `transcript`, `recording` and their suffix forms. Now also
  `pass`, `pwd`, `passwd`, `passphrase`, `auth`, `sig`, `sid`, `session`, `sessionId`, `sessid`,
  `signature` and `AWS_SECRET_ACCESS_KEY`, and `pass`, `sig`, `sid` and `auth` as a whole word of a
  longer key (`db_pass`, `x-auth`, `userSid`, `X-Amz-Sig`) and `session` as its last word
  (`userSession`). A field named `auth: { mode }`, `pass: true` or `session: { ... }` is now
  `[redacted]`. A word inside another word is not touched: `bypass`, `compass`, `inside`, `design`,
  `possession` and `sessionCount` stay readable.
- **Log messages and error messages are scrubbed.** `msg`, and the `message` and `stack` of a logged
  `Error`, go through `scrubText`. An unquoted value after a sensitive key is masked to the end of
  the line (`login failed password=x for ann` becomes `login failed password=[redacted]`), except
  after a quoted JSON key.
- **Messages are cut at 32 KiB** (a trailing partial word is dropped and `[truncated]` added).
- **Email addresses, telephone numbers and card numbers are masked in messages**, within the limits
  above.
- **`sentryDsnSchema` trims** surrounding whitespace, as `createErrorReporter` does; a DSN with a
  trailing newline now boots.
- **The memory reporter** drops captures, and its `flush` resolves `false`, after `close`.
- **Tags set from typed context** (`organization_id`, `request_id`) are sent as they are when they
  have one of the id shapes in the contract (see above), and as `[invalid]` otherwise.
- **More field names are redacted**: `passwordHash`, `sessionKey`, `accessKey`, `connectionString`,
  `X-Hub-Signature-256`, and keys ending in `dsn`, `credential(s)`, `otp` or `cvv` (`SENTRY_DSN`,
  `smsOtp`, `card_cvv`, `dbCredentials`). `accessKeyId` stays readable.
- **A number group written with `00`** is a telephone number only if a country code follows (see
  above); other `00` groups are counters.
- **The Sentry event's `sdk` keeps a name and version** (the SDK adds its own package list after),
  and its `release`, `environment` and `platform` are always the adapter's own values.

### Wiring it into a service

In `src/env.ts`:

```ts
import { environmentSchema, requireSentryDsn, sentryDsnSchema } from 'tula-closeline-kit'

export const envSchema = z
  .object({
    ENVIRONMENT: environmentSchema,
    SENTRY_DSN: sentryDsnSchema, // optional in local, required in dev|staging|prod
    REGION: z.enum(['us', 'eu']),
    GIT_SHA: z.string().optional(),
  })
  .superRefine(requireSentryDsn)
```

In `src/container.ts`, the only place adapters are built:

```ts
const errors = createErrorReporter({
  dsn: env.SENTRY_DSN,
  service: 'core',
  environment: env.ENVIRONMENT,
  region: env.REGION,
  release: env.GIT_SHA,
  logger,
})
return {
  reportError: (error: unknown, context?: ErrorContext) => errors.capture(error, context),
  shutdown: () => errors.close(2_000),
}
```

In the Hono error handler (`app.onError`), report and answer. `capture` skips expected errors, so
call it for every error:

```ts
app.onError((error, c) => {
  container.reportError(error, {
    requestId: c.req.header('x-request-id'), // or the id your request-id middleware sets
    organizationId: c.get('organizationId'), // set by the auth middleware; undefined before sign-in
    method: c.req.method,
    path: c.req.path,
    status: isAppError(error) ? error.status : 500,
  })
  // ...build the response from toErrorBody(error)
})
```

On `SIGTERM`, `await container.shutdown()` before exiting.

## Queues and events (`Queue`, `createConsumer`)

Services publish events and queue work through the kit's `Queue` port. There are two adapters, the
SQS one (`createSqsQueue`) and a memory one for tests (`createMemoryQueue`, from
`tula-closeline-kit/testing`). One behaviour suite (`src/queue/behaviour.ts`) runs against both.

Where things are imported from: the envelope, the port types, errors and `ProcessedStore` come from
`tula-closeline-kit`. The SQS adapter and `createConsumer` come from `tula-closeline-kit/queue`, so
a service that only needs the types does not load the AWS SDK. The memory adapters and test helpers
come from `tula-closeline-kit/testing`. The behaviour suites (`queueBehaviour`,
`processedStoreBehaviour`) come from `tula-closeline-kit/testing/behaviour`, which imports
`bun:test`; keep it out of production code. FIFO queues and message ordering are out of scope:
everything here assumes a standard queue.

**What at-least-once means for a handler.** The queue hands a message out at least once, in no
guaranteed order. It can hand the same message out twice (a slow consumer, a crash, a duplicate in
SQS itself), and a publisher that retries after a timeout can put two copies in. Every handler is
therefore written so that a second run changes nothing, and `createConsumer` helps by recording
which message ids are done. Do not rely on order: carry what the handler needs in the payload, or
read current state.

### Defining messages

```ts
import { z } from 'zod'
import { createMessageRegistry, defineMessage } from 'tula-closeline-kit'

const organizationCreated = defineMessage({
  type: 'core.organization_created', // area.event_name
  version: 1, // raise it on an incompatible payload change
  scope: 'organization', // carries organizationId; 'global' messages must not
  payload: z.object({ name: z.string() }),
})
export const registry = createMessageRegistry([organizationCreated])

const envelope = registry.create({
  type: 'core.organization_created',
  organizationId,
  traceId: requestId,
  payload: { name },
})
```

The envelope is `{ id, type, version, occurredAt, organizationId?, traceId, payload }`. `id` is a
UUID unless you pass one: when you retry a publish, pass the same envelope, so the consumer can
recognise the copy. `encode` and `decode` validate with Zod on the way in and out. A body that is
not JSON, has an unknown type or another version, lacks (or wrongly has) an Organization id, or
fails its payload schema is never dropped and never throws in the consumer: `receive` returns it as
`{ kind: 'invalid', reason, issues }` (field names the schema declares and codes, never values; a record key or any path under a union is shown as `*`). Paths under a union or intersection are masked entirely, so a payload shaped as a discriminated union reports no field names; prefer an object with optional fields where diagnostics matter, the consumer logs and
reports it and hides it for `invalidDelaySeconds`, and the queue's redrive policy sends it to the
dead-letter queue after `maxReceiveCount` deliveries.

**Versions and deploy order.** A definition accepts its own `version` and the `previous` versions it
lists, each with its old payload schema and an `upcast` to the current shape (the handler only
ever sees the current shape and version). Raise a version in three steps: deploy consumers that
list the new version as current and the old one as `previous`; then deploy publishers that send the
new one; later drop `previous`. A message of a version nobody lists is not acknowledged: the
consumer hides it for `invalidDelaySeconds`, doubling with each delivery up to
`unsupportedVersionMaxSeconds`, and the queue sends it to the dead-letter queue after
`maxReceiveCount`. If publishers got ahead of consumers, redrive the dead-letter queue to the
source queue once the consumers are deployed; the consumer dedupes on the envelope id, so a
redrive is safe.

**Trust.** The envelope is trusted exactly as far as permission to send to the queue is. It
carries no signature, so anything that can send to the queue can claim any Organization id. The
registry checks the shape of the id (the contract's `org_` plus 32 lower-case hex digits; pass
`organizationIdSchema` to change it) but not that the sender may speak for that Organization.
Give each queue the narrowest send permission, and keep tokens out of payloads.

### The port

```ts
publish(envelope): Promise<void> // throws queue.invalid_message | message_too_large | unavailable
publishBatch(envelopes): Promise<{ sent: string[]; failed: BatchFailure[] }> // 1 to 10, 256 KiB total
receive({ maxMessages /*1-10*/, visibilityTimeoutSeconds, waitSeconds /*0-20*/, signal? }): Promise<Delivery[]>
acknowledge(receipt): Promise<void> // safe to repeat
extendVisibility(receipt, seconds): Promise<void> // queue.receipt_invalid if no longer in flight
release(receipt): Promise<void> // visible again at once
```

Publish is O(message size) and receive is O(batch size) (the memory adapter's receive scans what it
holds). Limits are checked before anything is sent; a partial batch failure comes back per
envelope in `failed`, so retry only those.

### Wiring it in a service

In `src/env.ts` add `QUEUE_URL`, `AWS_REGION` and, for `local` only, `QUEUE_ENDPOINT`. In
`src/container.ts`:

```ts
import { createConsumer, createSqsQueue } from 'tula-closeline-kit/queue'

const queue = createSqsQueue({
  queueUrl: env.QUEUE_URL,
  region: env.AWS_REGION,
  environment: env.ENVIRONMENT,
  endpoint: env.QUEUE_ENDPOINT, // ElasticMQ, http://127.0.0.1:9324; throws unless ENVIRONMENT=local
  registry,
})
```

Credentials come only from the AWS SDK's default chain (the task role in AWS). Locally ElasticMQ
ignores them, but the chain needs some, so export any `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY`. Every call has a connect and request timeout (`timeoutMs`, default 5 s; a
long poll adds its wait) and the SDK's own retry (`maxAttempts`, default 3, `standard` mode with
jittered exponential back-off); there is no second retry layer, so worst case for one call is
`maxAttempts` times (timeout plus back-off). Message bodies are never logged. **Proxies:** the
adapter ignores `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and their lower-case forms; queue traffic
never goes through a proxy named in the environment (ADR 0013), and `aws-proxy.test.ts` proves it.
There is no option for a deliberate proxy yet. The dead-letter queue and its `maxReceiveCount`
(5 in the dev stack) are infrastructure; the adapter neither creates nor reads them.

Consume with the idempotent helper:

```ts
const consumer = createConsumer({
  name: 'playbook.ingestion', // part of the idempotency key
  queue,
  store: createPostgresProcessedStore(db), // see below; createMemoryProcessedStore in tests
  logger,
  errorReporter,
  handlers: {
    'core.organization_created': async (message, { organizationId, signal }) => {
      // Scope every read and write to organizationId. Stop between steps if signal.aborted.
    },
  },
  concurrency: 4,
})
consumer.start()
// on SIGTERM:
await consumer.stop(20_000)
```

What `createConsumer` guarantees:

- A message completed before is acknowledged without running again (`store.claim` says `done`).
- Two consumers that get the same message do not both run it: the second sees a live claim, hides
  the message until the holder's lease would lapse (its lease length: 60 s by default) and
  acknowledges it on the next delivery if the holder finished.
- A handler that throws releases its claim and the message returns after a jittered exponential
  delay (`retryBaseSeconds` doubling to `retryMaxSeconds`); after the queue's `maxReceiveCount`
  deliveries it is in the dead-letter queue. Failures go to the logger (type, ids, error name; never
  the payload) and to `errorReporter`.
- A handler that runs longer than the visibility timeout has it extended every third of the
  timeout. The claim's lease is the longer of two visibility windows and the store timeout plus
  two heartbeat ticks plus a 5 s margin (so a renewal that takes the whole store timeout, or one
  missed tick, cannot lapse a healthy claim even with a 2 s visibility timeout), and is renewed
  (`store.renew`, beside the ticks so a slow store never delays a visibility extension) on the
  heartbeat, so a live holder keeps it however long its handler runs, and a holder that dies loses
  it within about a minute. A consumer that meets a busy claim hides the message for the seconds
  left on the lease, so a dead holder does not burn the message's receive count towards the
  dead-letter queue. If a renewal says the claim was lost, the handler's `signal` aborts and the
  message is not acknowledged.
- Past `handlerTimeoutMs` (default 5 minutes, measured by its own timer) the `signal` aborts, the
  message is not acknowledged and the claim lapses, so a retry can run. A handler that ignores
  its signal can overlap that retry. Every call to the store has `storeTimeoutMs` (10 s by
  default); a store call that hangs fails, and the message returns to the queue.
- At most `concurrency` handlers run at once; receive asks only for free slots.
- `stop(deadlineMs)` stops receiving, lets work in flight finish for up to the deadline, then aborts
  signals and gives the rest back to the queue (claims released, visibility 0). It reports
  `{ finished, abandoned }`; calling it again returns the same result.
- Tenant scoping: the handler is given the envelope's own Organization id, frozen, and the
  Organization id is part of the idempotency key, so another Organization's message with the same
  id is a different message and is never skipped or completed on the first one's account. An
  `organization` message without an id never reaches a handler.

What it cannot guarantee: a crash between the handler's effect and `store.complete` runs the effect
again after the lease. The consumer calls `complete` after the handler returns, in a separate
call, so the handler's own transaction and the store's record are never one commit. At-least-once
therefore applies to the effect: make the write idempotent itself (a unique key on the message id
or an upsert), or have the handler write `consumed_message` in its own transaction as well.

### The store table a service adds

`ProcessedStore` (`claim`, `renew`, `complete`, `release`, `purge`) must not live in process memory in
production. Each service that consumes adds this table to its own schema through a migration in
`tula-closeline-db` (the kit does not write migrations), with the usual `organization_id` and
fail-closed row-level security, and implements the port over it:

```sql
create table consumed_message (
  consumer text not null,
  organization_id uuid not null,   -- the wire id converted to a uuid; all zeros for a global message
  message_id text not null,
  state text not null check (state in ('claimed', 'done')),
  claim_token uuid not null,
  lease_expires_at timestamptz,    -- while claimed
  completed_at timestamptz,        -- when done
  primary key (consumer, organization_id, message_id)
);
create index on consumed_message (completed_at) where state = 'done';
```

- `claim`: one statement, `insert ... on conflict (consumer, organization_id, message_id) do update
  set state = 'claimed', claim_token = $new, lease_expires_at = now() + $lease where state =
  'claimed' and lease_expires_at <= now() returning ...`. A returned row is `claimed`; no row means
  look the row up: `done` or `busy`.
- Wire ids are `org_` plus 32 hex digits; the store converts them to the uuid form (insert dashes
  after 8, 12, 16 and 20 digits) before writing and never stores the prefix. A global message has no
  Organization, so its rows hold the all-zero uuid; the consumer of global messages therefore runs
  under the all-zero scope, and that scope is not any real Organization's.
- When `claim` finds a live claim it also returns `retryAfterSeconds`, `ceil(lease_expires_at -
  now())` and at least 1.
- `renew`: `update ... set lease_expires_at = now() + $lease where ... and claim_token = $token and
  state = 'claimed' and lease_expires_at > now()`; true if a row changed.
- `complete`: `update ... set state = 'done', completed_at = now() where ... and claim_token = $token
  and state = 'claimed'`; true if a row changed.
- `release`: `delete ... where ... and claim_token = $token and state = 'claimed'`.
- `purge(before, limit)`: delete up to `limit` rows that are `done` with `completed_at < before` or
  `claimed` with a lapsed lease. Run it from a periodic job with `before` older than the queue's
  retention (14 days at most; 15 is safe), or a very late redelivery would run twice. With
  fail-closed row-level security a plain `purge` sees no rows. Run it either as a maintenance role
  that is exempt from the policy (the simplest; it deletes only by age, never reads a row's
  content), or loop over Organizations and purge under each one's tenant-scoped helper (and once
  under the all-zero scope), splitting `limit` between them.

Run both behaviour suites against your own store and adapter: `processedStoreBehaviour(name, make)`
and `queueBehaviour(name, make)` from `tula-closeline-kit/testing/behaviour`. `make` returns the
store (or queue) plus a `pass(seconds)` that advances time (a fake database clock, or a real wait)
and a `close()`.

### Running the SQS suite against ElasticMQ

`src/queue/aws.integration.ts` runs the shared suite against the SQS adapter on ElasticMQ, the
same image as the hub's dev stack. It is an integration test, so `bun test src` does not run it.
`compose.yaml` starts ElasticMQ; CI (the hub's `verify.yml`) runs `docker compose up -d --wait` and
then `bun run test:integration`:

```sh
docker compose up -d --wait
bun run test:integration
```

Without `QUEUE_TEST_ENDPOINT` the suite is skipped with a notice on a developer machine and fails
when `CI` is set. The test refuses any endpoint that is not local, so it can never reach AWS. Its
queues, each with a dead-letter queue, are created and deleted per test. As of 0.6.0 this suite has
not been run against a live ElasticMQ by its author (no Docker on the machine it was written on):
CI is its first execution, so expect a small fix or two on the first run.
