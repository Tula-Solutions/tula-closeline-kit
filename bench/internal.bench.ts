import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { createInternalClient } from '../src/http/internal'
import { makeTestCert } from '../src/http/test-cert'

/**
 * Benchmark: what connection reuse saves in `createInternalClient`, against a local receiver.
 *
 * Input: sequential GET calls with a small JSON answer. Each leg runs twice:
 * - `new connection per call` is the default (`keepAlive` off), which is what the client did
 *   before 0.7: one TCP connection per call, and one TLS handshake over https.
 * - `reused connection` is one client with `keepAlive: true` making every call, so after the first call a warm
 *   connection serves each one.
 * Expected complexity per call: O(1); no work grows with the number of calls, and the pool is
 * capped (32 sockets, 8 idle), so nothing accumulates. Loopback has no network latency, so the
 * saving here understates a real network, where a new connection also costs round trips.
 *
 * Budgets, per call, from runs on one developer machine (http: reused about 0.1 ms, new about
 * 0.3 ms; https: reused about 0.2 ms, new about 3 ms): the reused leg's mean is gated at about 5x
 * its measurement, and the reused leg must also be at least 1.3x faster than the new-connection
 * leg on http and 3x on https, so a change that stops reusing connections fails here. The
 * https leg runs only where `openssl` can make a throwaway certificate in a temporary folder,
 * and says so when it is skipped.
 */
const WARMUP = 50
const HTTP_CALLS = 1_500
const HTTPS_CALLS = 300
const HTTP_REUSED_MEAN_MS = 0.3
const HTTPS_REUSED_MEAN_MS = 0.5
const HTTP_MIN_SPEEDUP = 1.3
const HTTPS_MIN_SPEEDUP = 3

type Target = { url: string; ca?: string; connections: () => number }

async function httpTarget(): Promise<{ target: Target; stop: () => void }> {
  let connections = 0
  const server = createHttpServer((_q, r) => r.end('{"ok":true}'))
  server.on('connection', () => {
    connections += 1
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    target: {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      connections: () => connections,
    },
    stop: () => {
      server.closeAllConnections()
      server.close()
    },
  }
}

async function httpsTarget(): Promise<{ target: Target; stop: () => void } | undefined> {
  const made = makeTestCert()
  if (made === undefined) {
    return undefined
  }
  let connections = 0
  const server = createHttpsServer({ cert: made.cert, key: made.key }, (_q, r) =>
    r.end('{"ok":true}')
  )
  const stop = () => {
    server.closeAllConnections()
    server.close()
    made.remove()
  }
  try {
    server.on('secureConnection', () => {
      connections += 1
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  } catch (error) {
    stop()
    throw error
  }
  return {
    target: {
      url: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
      ca: made.cert,
      connections: () => connections,
    },
    stop,
  }
}

function build(target: Target, keepAlive: boolean) {
  return createInternalClient({
    keepAlive,
    baseUrl: target.url,
    secret: 'bench-secret',
    environment: 'local',
    ...(target.ca === undefined ? {} : { ca: target.ca }),
  })
}

/** Mean milliseconds per call over `calls` sequential calls, after a warm-up. */
async function measure(calls: number, one: () => Promise<void>): Promise<number> {
  for (let i = 0; i < WARMUP; i++) {
    await one()
  }
  const start = performance.now()
  for (let i = 0; i < calls; i++) {
    await one()
  }
  return (performance.now() - start) / calls
}

const failures: string[] = []

async function leg(
  label: string,
  target: Target,
  calls: number,
  reusedBudget: number,
  minSpeedup: number
) {
  const before = target.connections()
  const fresh = await measure(calls, async () => {
    const client = build(target, false)
    try {
      await client.request({ method: 'GET', path: '/' })
    } finally {
      client.close()
    }
  })
  const freshConnections = target.connections() - before
  const shared = build(target, true)
  const mid = target.connections()
  const reused = await measure(calls, async () => {
    await shared.request({ method: 'GET', path: '/' })
  })
  const reusedConnections = target.connections() - mid
  shared.close()
  const speedup = fresh / reused
  process.stdout.write(
    `internal client over ${label}: new connection per call ${fresh.toFixed(3)} ms ` +
      `(${freshConnections} connections), reused ${reused.toFixed(3)} ms (budget ${reusedBudget}, ` +
      `${reusedConnections} connections), speedup ${speedup.toFixed(1)}x (budget ${minSpeedup}x)\n`
  )
  if (reusedConnections !== 1) {
    failures.push(`${label}: the reused leg opened ${reusedConnections} connections, not 1`)
  }
  if (reused > reusedBudget) {
    failures.push(`${label}: reused mean ${reused.toFixed(3)} ms > ${reusedBudget} ms`)
  }
  if (speedup < minSpeedup) {
    failures.push(`${label}: speedup ${speedup.toFixed(2)}x < ${minSpeedup}x`)
  }
}

const plain = await httpTarget()
try {
  await leg('http', plain.target, HTTP_CALLS, HTTP_REUSED_MEAN_MS, HTTP_MIN_SPEEDUP)
} finally {
  plain.stop()
}

const tls = await httpsTarget()
if (tls === undefined) {
  process.stdout.write(
    'internal client over https: skipped, openssl could not make a certificate\n'
  )
} else {
  try {
    await leg('https', tls.target, HTTPS_CALLS, HTTPS_REUSED_MEAN_MS, HTTPS_MIN_SPEEDUP)
  } finally {
    tls.stop()
  }
}
if (failures.length > 0) {
  process.stderr.write(`bench failed: ${failures.join('; ')}\n`)
  process.exit(1)
}
process.exit(0)
