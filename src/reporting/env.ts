import { z } from 'zod'

/** The deployment environments a service can run in, from its `ENVIRONMENT` variable. */
export const ENVIRONMENTS = ['local', 'dev', 'staging', 'prod'] as const

/** One of the deployment environments. */
export type Environment = (typeof ENVIRONMENTS)[number]

/** Zod schema for the `ENVIRONMENT` variable. */
export const environmentSchema = z.enum(ENVIRONMENTS)

// The rule the Sentry SDK applies to a DSN (`dsnFromString` in `@sentry/core`), written out so that a
// DSN is checked without calling the SDK, whose parser prints a rejected DSN, key included, to the
// console. It is the SDK's pattern made exact: the whole string must match, the scheme is lower
// case, and the path is `/<segments>/<project id>` with nothing after the id. Whatever it accepts,
// the SDK accepts too (a test builds a client from each).
const DSN_PATTERN =
  /^(https?):\/\/(\w+)(?::(\w+))?@(\[[:.%\w]+\]|[\w.-]+)(?::(\d+))?\/(?:[\w.-]+\/)*(\d+)$/
const MAX_DSN_LENGTH = 1_024

function hasDsnShape(value: string): RegExpExecArray | null {
  return value.length <= MAX_DSN_LENGTH ? DSN_PATTERN.exec(value) : null
}

/**
 * True for a string the Sentry SDK takes as a DSN: `https://<public key>@<host>/<project id>`, with
 * an optional secret, port and path prefix and no trailing slash. A DSN with the `http:` scheme
 * passes only when `environment` is `local`, so events and the project key are never sent in clear
 * text from a deployed service. It checks the shape only; whether the project exists, and in which
 * data region, is Sentry's.
 */
export function isSentryDsn(value: string, environment: Environment): boolean {
  const match = hasDsnShape(value)
  return match !== null && (match[1] === 'https' || environment === 'local')
}

/** Zod schema for `SENTRY_DSN`: a Sentry DSN, where an empty string means "not set". */
export const sentryDsnSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z
    .string()
    // The scheme is checked by `requireSentryDsn`, which knows the environment.
    .refine((value) => hasDsnShape(value) !== null, {
      message: 'SENTRY_DSN must look like https://<key>@<host>/<project id>',
    })
    .optional()
)

/**
 * Refinement for a service's env object: `SENTRY_DSN` may be missing in `local` and must be set in
 * `dev`, `staging` and `prod`, where it must use `https:`. Use it as `z.object({ ENVIRONMENT, SENTRY_DSN, ... }).superRefine(requireSentryDsn)`
 * so boot fails when a deployed service has no error tracker.
 */
export function requireSentryDsn(
  env: { ENVIRONMENT: Environment; SENTRY_DSN?: string | undefined },
  ctx: z.RefinementCtx
): void {
  if (env.ENVIRONMENT !== 'local' && env.SENTRY_DSN === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['SENTRY_DSN'],
      message: `SENTRY_DSN is required when ENVIRONMENT is ${env.ENVIRONMENT}`,
    })
  } else if (
    env.SENTRY_DSN !== undefined &&
    hasDsnShape(env.SENTRY_DSN) !== null &&
    !isSentryDsn(env.SENTRY_DSN, env.ENVIRONMENT)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['SENTRY_DSN'],
      message: `SENTRY_DSN must use https when ENVIRONMENT is ${env.ENVIRONMENT}`,
    })
  }
}
