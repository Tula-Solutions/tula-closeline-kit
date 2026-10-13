import { SQSClient } from '@aws-sdk/client-sqs'
import type { Environment } from '../reporting/env'

// Internal: builds the SDK client of the SQS adapter. Not exported from any entry of the package.

/** What {@link createSqsClient} needs. */
export interface SqsClientSettings {
  region: string
  environment: Environment
  endpoint: string | undefined
  timeoutMs: number
  maxAttempts: number
}

/**
 * Builds the SQS client. Outside `local` the SDK is told to ignore every configured endpoint URL
 * (the shared config file's `endpoint_url`), so a deployed service can only talk to AWS.
 */
export function createSqsClient(settings: SqsClientSettings): SQSClient {
  return new SQSClient({
    region: settings.region,
    ...(settings.endpoint === undefined ? {} : { endpoint: settings.endpoint }),
    ...(settings.environment === 'local' ? {} : { ignoreConfiguredEndpointUrls: true }),
    maxAttempts: settings.maxAttempts,
    retryMode: 'standard',
    // Without throwOnRequestTimeout the handler only logs a warning when a request is slow and
    // keeps waiting, so a hung connection would never end.
    requestHandler: {
      connectionTimeout: settings.timeoutMs,
      requestTimeout: settings.timeoutMs,
      throwOnRequestTimeout: true,
    },
  })
}
