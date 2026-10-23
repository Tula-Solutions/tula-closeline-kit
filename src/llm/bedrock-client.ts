import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime'
import type { ModelTier } from './port'

// Internal: builds the SDK client of the Bedrock adapter and checks the Region and model ids.
// Not exported from any entry of the package.

const REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/** The first segment of a model id that marks a cross-Region inference profile, not a provider. */
const PROFILE_GEOGRAPHIES = new Set(['us', 'eu', 'apac', 'global', 'us-gov', 'jp', 'au', 'ca'])

/** The environment variables that redirect the SDK to another endpoint. */
const ENDPOINT_VARIABLES = ['AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_BEDROCK_RUNTIME'] as const

/** The cross-Region inference profile prefix of each Region family; other families have none. */
function geographyOf(region: string): string | undefined {
  if (region.startsWith('us-gov-')) {
    return undefined
  }
  if (region.startsWith('us-')) {
    return 'us'
  }
  if (region.startsWith('eu-')) {
    return 'eu'
  }
  if (region.startsWith('ap-')) {
    return 'apac'
  }
  return undefined
}

/** Refuses a Region that is not shaped like an AWS Region, such as `eu-west-1`. */
export function assertRegion(region: unknown): asserts region is string {
  if (typeof region !== 'string' || !REGION.test(region)) {
    throw new TypeError('region must be an AWS Region such as eu-west-1')
  }
}

/**
 * Refuses a model id that could send the call out of `region`. A bare model id is served in the
 * Region. A cross-Region inference profile id (`eu.…`, `us.…`) may route to any Region of its
 * geography, so it is accepted only when its prefix is the geography of `region`; `global.…`
 * profiles and ARNs are refused, as they name no Region the adapter can vouch for.
 */
export function assertModelInRegion(tier: ModelTier, modelId: unknown, region: string): void {
  if (typeof modelId !== 'string' || !MODEL_ID.test(modelId)) {
    throw new TypeError(`models.${tier} is not a model id`)
  }
  const head = modelId.split('.')[0] ?? ''
  if (!modelId.includes('.') || !PROFILE_GEOGRAPHIES.has(head)) {
    return
  }
  if (head !== geographyOf(region)) {
    throw new TypeError(
      `models.${tier} is an inference profile for "${head}", which does not match the Region ${region}`
    )
  }
}

/** What {@link createBedrockClient} needs. */
export interface BedrockClientSettings {
  region: string
  connectTimeoutMs: number
}

/**
 * Builds the Bedrock Runtime client. The Region is always explicit, no endpoint can be set (the
 * endpoint environment variables are refused and the shared config file's `endpoint_url` is
 * ignored), so the host is always `bedrock-runtime.<region>.amazonaws.com`. The SDK does not retry:
 * the adapter's own bounded, jittered retry is the only one.
 */
export function createBedrockClient(settings: BedrockClientSettings): BedrockRuntimeClient {
  for (const name of ENDPOINT_VARIABLES) {
    if (process.env[name] !== undefined && process.env[name] !== '') {
      throw new TypeError(`${name} redirects the Bedrock client and is not accepted`)
    }
  }
  return new BedrockRuntimeClient({
    region: settings.region,
    maxAttempts: 1,
    retryMode: 'standard',
    ignoreConfiguredEndpointUrls: true,
    // Without throwOnRequestTimeout the handler only logs when a request is slow and keeps waiting.
    requestHandler: {
      connectionTimeout: settings.connectTimeoutMs,
      requestTimeout: settings.connectTimeoutMs,
      throwOnRequestTimeout: true,
    },
  })
}
