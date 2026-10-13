/**
 * Child process of the proxy probe (`proxy.test.ts`). Proxy variables are read at process start,
 * so each case runs in its own process with the variables in its environment. Prints one line:
 * `ok <status>` or `error <name>`. Not part of the public API.
 */
import { Agent, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createInternalClient } from './internal'

const [mode, rawUrl] = process.argv.slice(2)
if (mode === undefined || rawUrl === undefined) {
  throw new Error('usage: probe-child <mode> <url>')
}
const url = new URL(rawUrl)

/** One request through `node:http` or `node:https` with the given agent option. */
function viaNode(agent: false | Agent): Promise<number> {
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const outgoing = send(
      {
        host: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port,
        path: '/',
        agent,
        timeout: 3000,
      },
      (response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      }
    )
    outgoing.on('timeout', () => outgoing.destroy(new Error('timeout')))
    outgoing.on('error', reject)
    outgoing.end()
  })
}

/** Runs the transport named by `mode` once against the URL. */
async function run(): Promise<number> {
  switch (mode) {
    case 'fetch':
      return (await fetch(rawUrl as string, { signal: AbortSignal.timeout(3000) })).status
    case 'fetch-proxy-empty':
      // Bun's per-request `proxy` option: an empty string is not documented to disable anything.
      return (
        await fetch(rawUrl as string, {
          proxy: '',
          signal: AbortSignal.timeout(3000),
        })
      ).status
    case 'node-agent-false':
      return await viaNode(false)
    case 'node-keepalive-agent':
      return await viaNode(new Agent({ keepAlive: true }))
    case 'internal-client': {
      const client = createInternalClient({
        baseUrl: `${url.protocol}//${url.host}`,
        secret: 'probe-secret-value',
        environment: 'local',
        timeoutMs: 3000,
        retry: { maxAttempts: 1 },
      })
      return (await client.request({ method: 'GET', path: '/' })).status
    }
    default:
      throw new Error(`unknown mode ${mode}`)
  }
}

run().then(
  (status) => {
    process.stdout.write(`ok ${status}\n`)
    process.exit(0)
  },
  (error: unknown) => {
    process.stdout.write(`error ${error instanceof Error ? error.name : 'unknown'}\n`)
    process.exit(0)
  }
)
