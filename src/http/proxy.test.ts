import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import net from 'node:net'
import { makeTestCert } from './test-cert'

/**
 * The probe behind ADR 0013 decision 4. It pins, for the Bun version in use, which transports
 * send a request to a proxy named in the environment. A stand-in proxy records every connection;
 * the transport runs in a child process because proxy variables are read at process start.
 *
 * `fetch` is the positive control: if it did not reach the stand-in, a "no hit" for another
 * transport would prove nothing. If a Bun upgrade changes any row, this suite fails.
 */

const VARIABLES = [
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
] as const
const CHILD = new URL('./probe-child.ts', import.meta.url).pathname

let hits = 0
let proxyPort = 0
let deadPort = 0
let target: ReturnType<typeof Bun.serve>
const proxy = net.createServer((socket) => {
  hits += 1
  socket.on('error', () => undefined)
  socket.end('HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n')
})

beforeAll(async () => {
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  proxyPort = (proxy.address() as net.AddressInfo).port
  target = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ ok: true }) })
  // A port nothing listens on: an https request there can only reach the proxy, never a server.
  const probe = net.createServer().listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => probe.once('listening', resolve))
  deadPort = (probe.address() as net.AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
})
afterAll(async () => {
  await target.stop(true)
  proxy.close()
})

/** Runs `mode` in a child with `variable` naming the stand-in proxy; returns hits and output. */
async function probe(
  mode: string,
  scheme: 'http' | 'https',
  variable: string,
  noProxy?: string
): Promise<{ hits: number; output: string }> {
  hits = 0
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    [variable]: `http://127.0.0.1:${proxyPort}`,
  }
  if (noProxy !== undefined) {
    env.NO_PROXY = noProxy
    env.no_proxy = noProxy
  }
  const port = scheme === 'http' ? target.port : deadPort
  const child = Bun.spawn(['bun', CHILD, mode, `${scheme}://127.0.0.1:${port}/`], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 15_000,
  })
  const output = (await new Response(child.stdout).text()).trim()
  await child.exited
  await Bun.sleep(25)
  // Every run must reach its end: a child that crashed or exited early prints no `done`.
  expect(output).toMatch(/^(ok \d+|error \w+)\ndone$/)
  return { hits, output }
}

/**
 * What a run that went straight to its target prints: the answer for the live http target, and
 * a refused connection for the https port where nothing listens (which proves the request ran).
 */
function expectDirect(output: string, scheme: 'http' | 'https') {
  if (scheme === 'http') {
    expect(output).toBe('ok 200\ndone')
  } else {
    expect(output).toMatch(/^error \w+\ndone$/)
    expect(output).not.toContain('ok')
  }
}

/** The variable that applies to a scheme: the others are ignored by Bun for that scheme. */
const APPLIES: Record<'http' | 'https', readonly string[]> = {
  http: ['HTTP_PROXY', 'http_proxy'],
  https: ['HTTPS_PROXY', 'https_proxy'],
}

describe('probe: what honours proxy variables (the positive control)', () => {
  test.each(
    (['http', 'https'] as const).flatMap((scheme) =>
      APPLIES[scheme].map((variable) => [scheme, variable] as const)
    )
  )(
    'fetch to %s reaches the proxy named by %s',
    async (scheme, variable) => {
      const result = await probe('fetch', scheme, variable)
      expect(result.hits).toBeGreaterThan(0)
    },
    20_000
  )

  test('fetch with an empty per-request proxy option still reaches the proxy', async () => {
    const result = await probe('fetch-proxy-empty', 'http', 'HTTP_PROXY')
    expect(result.hits).toBeGreaterThan(0)
    expect(result.output).toBe('ok 502\ndone')
  }, 20_000)

  test.each([
    ['ALL_PROXY', 'http'],
    ['all_proxy', 'https'],
  ] as const)(
    'observed: Bun fetch ignores %s (%s), so a future change shows here',
    async (variable, scheme) => {
      const result = await probe('fetch', scheme, variable)
      expect(result.hits).toBe(0)
      expectDirect(result.output, scheme)
    },
    20_000
  )

  test('NO_PROXY naming the host stops fetch, which is why it is not the mechanism', async () => {
    const result = await probe('fetch', 'http', 'HTTP_PROXY', '127.0.0.1')
    expect(result.hits).toBe(0)
    expectDirect(result.output, 'http')
  }, 20_000)
})

describe('probe: what ignores them', () => {
  const cases = VARIABLES.flatMap((variable) =>
    (['http', 'https'] as const).map((scheme) => [variable, scheme] as const)
  )

  test.each(cases)(
    'node:http(s) with agent: false ignores %s on %s',
    async (variable, scheme) => {
      for (const noProxy of [undefined, '127.0.0.1']) {
        const result = await probe('node-agent-false', scheme, variable, noProxy)
        expect(result.hits).toBe(0)
        expectDirect(result.output, scheme)
      }
    },
    30_000
  )

  test.each(cases)(
    'a keep-alive Agent ignores %s on %s',
    async (variable, scheme) => {
      const result = await probe('node-keepalive-agent', scheme, variable)
      expect(result.hits).toBe(0)
      expectDirect(result.output, scheme)
    },
    20_000
  )
})

describe('the internal client', () => {
  const cases = VARIABLES.flatMap((variable) =>
    (['http', 'https'] as const).map((scheme) => [variable, scheme] as const)
  )

  test.each(cases)(
    'never reaches the proxy named by %s for an %s base URL',
    async (variable, scheme) => {
      for (const noProxy of [undefined, '127.0.0.1', 'example.invalid']) {
        const result = await probe('internal-client', scheme, variable, noProxy)
        expect(result.hits).toBe(0)
        expectDirect(result.output, scheme)
      }
    },
    40_000
  )
})

describe('the internal client with keep-alive on', () => {
  const cert = makeTestCert()
  const cases = VARIABLES.flatMap((variable) =>
    (['http', 'https'] as const).map((scheme) => [variable, scheme] as const)
  )
  let connections = 0
  const stubs = {
    http: createHttpServer((_q, r) => r.end('{"ok":true}')),
    https:
      cert === undefined
        ? undefined
        : createHttpsServer({ cert: cert.cert, key: cert.key }, (_q, r) => r.end('{"ok":true}')),
  }
  const ports = { http: 0, https: 0 }

  beforeAll(async () => {
    stubs.http.on('connection', () => {
      connections += 1
    })
    stubs.https?.on('secureConnection', () => {
      connections += 1
    })
    for (const scheme of ['http', 'https'] as const) {
      const server = stubs[scheme]
      await new Promise<void>((resolve) =>
        server ? server.listen(0, '127.0.0.1', resolve) : resolve()
      )
      ports[scheme] = (server?.address() as net.AddressInfo | null)?.port ?? 0
    }
  })
  afterAll(() => {
    for (const server of [stubs.http, stubs.https]) {
      server?.closeAllConnections()
      server?.close()
    }
    cert?.remove()
  })

  test.each(cases)(
    'three calls on one client reach the live %s target over one kept connection, not the proxy named by %s',
    async (variable, scheme) => {
      if (scheme === 'https' && cert === undefined) {
        return // openssl could not make a certificate; nothing to probe over TLS
      }
      hits = 0
      connections = 0
      const child = Bun.spawn(
        ['bun', CHILD, 'internal-client-keepalive', `${scheme}://127.0.0.1:${ports[scheme]}/`],
        {
          env: {
            PATH: process.env.PATH ?? '',
            [variable]: `http://127.0.0.1:${proxyPort}`,
            ...(cert === undefined ? {} : { PROBE_CA: cert.cert }),
          },
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 15_000,
        }
      )
      const output = (await new Response(child.stdout).text()).trim()
      await child.exited
      await Bun.sleep(25)
      expect(output).toBe('ok 200\ndone')
      expect(hits).toBe(0)
      expect(connections).toBe(1)
    },
    20_000
  )
})
