import { z } from 'zod'

/** The deployment environments a service can run in, from its `ENVIRONMENT` variable. */
export const ENVIRONMENTS = ['local', 'dev', 'staging', 'prod'] as const

/** One of the deployment environments. */
export type Environment = (typeof ENVIRONMENTS)[number]

/** Zod schema for the `ENVIRONMENT` variable. */
export const environmentSchema = z.enum(ENVIRONMENTS)

/**
 * True for a string shaped like a Sentry DSN: `http(s)://<public key>@<host>/<numeric project id>`.
 * It checks the shape only; whether the project exists, and in which data region, is Sentry's.
 */
export function isSentryDsn(value: string): boolean {
  try {
    const url = new URL(value)
    const projectId = url.pathname.split('/').filter(Boolean).at(-1) ?? ''
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.username !== '' &&
      url.hostname !== '' &&
      /^[0-9]+$/.test(projectId)
    )
  } catch {
    return false
  }
}

/** Zod schema for `SENTRY_DSN`: a Sentry DSN, where an empty string means "not set". */
export const sentryDsnSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z
    .string()
    .refine(isSentryDsn, { message: 'SENTRY_DSN must look like https://<key>@<host>/<project id>' })
    .optional()
)

/**
 * Refinement for a service's env object: `SENTRY_DSN` may be missing in `local` and must be set in
 * `dev`, `staging` and `prod`. Use it as `z.object({ ENVIRONMENT, SENTRY_DSN, ... }).superRefine(requireSentryDsn)`
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
  }
}
