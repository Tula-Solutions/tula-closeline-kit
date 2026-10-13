import { S3Client } from '@aws-sdk/client-s3'
import type { Environment } from '../reporting/env'

// Internal: builds the SDK client of the S3 adapter. Not exported from any entry of the package.

/** What {@link createS3Client} needs. */
export interface S3ClientSettings {
  region: string
  environment: Environment
  endpoint: string | undefined
  timeoutMs: number
  maxAttempts: number
}

/**
 * Builds the S3 client. Outside `local` the SDK is told to ignore every configured endpoint URL
 * (the shared config file's `endpoint_url`), as the adapter already refuses the endpoint
 * environment variables there, so a deployed service can only talk to AWS.
 */
export function createS3Client(settings: S3ClientSettings): S3Client {
  return new S3Client({
    region: settings.region,
    maxAttempts: settings.maxAttempts,
    retryMode: 'standard',
    // Without throwOnRequestTimeout the handler only logs a warning when a request is slow and
    // keeps waiting, so a hung connection would never end.
    requestHandler: {
      connectionTimeout: settings.timeoutMs,
      requestTimeout: settings.timeoutMs,
      throwOnRequestTimeout: true,
    },
    ...(settings.environment === 'local' ? {} : { ignoreConfiguredEndpointUrls: true }),
    ...(settings.endpoint === undefined
      ? {}
      : {
          endpoint: settings.endpoint,
          forcePathStyle: true,
          // Stand-ins do not all take the SDK's default checksum trailers.
          requestChecksumCalculation: 'WHEN_REQUIRED' as const,
          responseChecksumValidation: 'WHEN_REQUIRED' as const,
        }),
  })
}
