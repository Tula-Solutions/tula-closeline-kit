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
  is part of it); an unquoted value is masked to the end of the line; a value in a URL query string
  (after `?` or `&`) to the next `&`, `#`, space, comma or semicolon;
- URL credentials, and database and broker URLs whole (`postgres://`, `redis://`, ... including a
  password with a space or a newline);
- the value in a Postgres constraint detail, `Key (email)=([redacted]) already exists.`;
- email addresses;
- telephone numbers: `+` and 8 to 15 digits, or 9 to 15 digits with spaces, dashes, dots or
  parentheses (`(415) 555-0199`, `415.555.0199`, `020 7946 0958`);
- payment card numbers: 13 to 19 digits, with or without spaces or dashes, that pass the Luhn check
  and do not start with 1 (epoch timestamps in milliseconds, microseconds and nanoseconds do, and
  must stay readable; UATP airline cards, the only cards that start with 1, are not recognised).

It leaves alone: bare digit runs that are not a card number (ids, counters, timestamps, ports),
digits inside a longer word (`req_4111…`, hex ids), ISO dates (`2024-05-12 10:30`), IPv4 addresses,
version numbers, `@scope/package` names, and file positions in stack frames
(`at verify (/app/src/auth/token:12:3)` is not read as the key `token`).

**It over-masks on purpose.** Prose after a sensitive key goes with the value, because a free-text
value cannot be told from a secret: `Invalid token: expired` becomes `Invalid token: [redacted]`,
`Request body: invalid JSON` loses its last words, and `login failed password=x for ann` ends at
`password=[redacted]`. A ten-digit list written with spaces can read as a telephone number. Put
the facts that must survive in structured log fields, not after a sensitive word in a message.

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
