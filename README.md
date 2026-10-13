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
  flush(timeoutMs: number): Promise<boolean> // bounded; call it on shutdown
}
// ErrorContext: requestId, organizationId, method, path, status, and free-form tags. Nothing else.
```

`createErrorReporter({ dsn, service, environment, region, release, logger })` returns the Sentry
adapter (`@sentry/bun`) when `dsn` is set and a no-op reporter when it is not, so `local` and tests
run without Sentry. `createMemoryErrorReporter()` from `tula-closeline-kit/testing` records calls
for tests, and `createTestDeps()` carries one as `errorReporter`.

**What is reported.** Unexpected errors, and an `AppError` with status 500 or above. An `AppError`
below 500 is never sent. `shouldReportError(error)` is the one predicate, and every adapter uses it.

**The DSN is per Region** (ADR 0001). The kit sends to whatever DSN it is given and does not look
at it: give the EU deployment the DSN of a Sentry project created in Sentry's EU data region
(`*.de.sentry.io`), and the US deployment one in the US region. Never share a project between
Regions, because an event can carry an Organization's identifiers.

**Nothing leaves the process unredacted.** Every event passes the kit's key-based redaction, then
`scrubText` on every string, in `beforeSend`. Request bodies, cookies, query strings, sensitive
headers, the user, source lines and local variables are removed outright. Stack frames and error
messages are kept (messages after `scrubText`). Data collection is switched off (Sentry 11 replaced
`sendDefaultPii` with `dataCollection`), tracing and breadcrumbs are off, and only the `LinkedErrors`
integration (it follows `cause`) is on. Console, HTTP and fetch instrumentation, local variables,
source context, request data, modules, host context, sessions and the global
`uncaughtException`/`unhandledRejection` handlers are off. Wire those yourself through the port:
`process.on('uncaughtException', (e) => reportError(e))`.

**`scrubText(text)`** masks secrets inside free text: bearer tokens, JWT-shaped strings, common API
key shapes, `key=value` and `key: value` pairs whose key the logger redacts, URL credentials and
connection strings. It cuts input at 32 KiB, runs in linear time and never throws. The logger uses
it for every message and every error `message` and `stack`.

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
  shutdown: () => errors.flush(2_000),
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
