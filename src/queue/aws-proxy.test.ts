import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import net from 'node:net'

/**
 * The SQS adapter and proxy variables (ADR 0013). Decision: the adapter ignores `HTTP_PROXY`,
 * `HTTPS_PROXY`, `ALL_PROXY` and their lower-case forms; queue traffic goes straight to the
 * endpoint. A stand-in proxy records every connection; the adapter runs in a child process
 * because Bun reads the variables at process start. `src/http/proxy.test.ts` holds the positive
 * control (Bun's `fetch` does reach such a proxy), so a zero here means something.
 */
const CHILD = new URL('./aws-probe-child.ts', import.meta.url).pathname
const VARIABLES = [
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
]

let proxyHits = 0
let proxyPort = 0
let deadPort = 0
let targetHits = 0
let target: ReturnType<typeof Bun.serve>
const proxy = net.createServer((socket) => {
  proxyHits += 1
  socket.on('error', () => undefined)
  socket.end('HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n')
})

beforeAll(async () => {
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  proxyPort = (proxy.address() as net.AddressInfo).port
  target = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => {
      targetHits += 1
      return new Response('{}', { status: 500 })
    },
  })
  const probe = net.createServer().listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => probe.once('listening', resolve))
  deadPort = (probe.address() as net.AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
})
afterAll(async () => {
  await target.stop(true)
  proxy.close()
})

async function run(variable: string, endpoint: string): Promise<string> {
  proxyHits = 0
  targetHits = 0
  const child = Bun.spawn(['bun', CHILD, endpoint], {
    env: { PATH: process.env.PATH ?? '', [variable]: `http://127.0.0.1:${proxyPort}` },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 20_000,
  })
  const output = (await new Response(child.stdout).text()).trim()
  await child.exited
  await Bun.sleep(25)
  expect(output).toMatch(/^(ok|error [\w.]+)\ndone$/)
  return output
}

describe('the SQS adapter never sends queue traffic through a proxy named in the environment', () => {
  test.each(VARIABLES)(
    '%s does not capture a request to an http endpoint',
    async (variable) => {
      const output = await run(variable, `http://127.0.0.1:${target.port}`)
      expect(proxyHits).toBe(0)
      // The request did run, straight to the target: it answered 500 and the adapter said so.
      expect(targetHits).toBeGreaterThan(0)
      expect(output).toBe('error queue.unavailable\ndone')
    },
    30_000
  )

  test.each(VARIABLES)(
    '%s does not capture a request to an https endpoint',
    async (variable) => {
      // Nothing listens on this port: only a proxy could answer, and none is used.
      const output = await run(variable, `https://127.0.0.1:${deadPort}`)
      expect(proxyHits).toBe(0)
      expect(output).toBe('error queue.unavailable\ndone')
    },
    30_000
  )
})
