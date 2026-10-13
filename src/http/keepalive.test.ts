import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createInternalClient,
  INTERNAL_DEFAULT_IDLE_TIMEOUT_MS,
  INTERNAL_DEFAULT_MAX_FREE_SOCKETS,
  INTERNAL_DEFAULT_MAX_SOCKETS,
  InternalCallError,
  type InternalClient,
  type InternalClientOptions,
} from './internal'

type Handler = (request: IncomingMessage, response: ServerResponse, count: number) => void
type Receiver = {
  url: string
  /** Connections accepted so far. */
  connections: () => number
  /** Requests that reached the handler. */
  requests: () => number
  /** Most requests being handled at once. */
  peak: () => number
  sockets: Socket[]
  closed: () => number
}

const servers: Server[] = []
const clients: InternalClient[] = []
afterEach(() => {
  for (const client of clients.splice(0)) {
    client.close()
  }
})
afterAll(() => {
  for (const server of servers) {
    server.closeAllConnections()
    server.close()
  }
})

const ok: Handler = (_q, response) => {
  response.setHeader('content-type', 'application/json')
  response.end('{"ok":true}')
}

/** A node:http receiver that counts connections, so reuse can be seen from the server's side. */
async function receiver(handler: Handler = ok, keepAliveTimeout = 60_000): Promise<Receiver> {
  let connections = 0
  let requests = 0
  let inFlight = 0
  let peak = 0
  let closed = 0
  const sockets: Socket[] = []
  const server = createHttpServer((request, response) => {
    requests += 1
    inFlight += 1
    peak = Math.max(peak, inFlight)
    response.on('close', () => {
      inFlight -= 1
    })
    handler(request, response, requests)
  })
  server.keepAliveTimeout = keepAliveTimeout
  server.on('connection', (socket) => {
    connections += 1
    sockets.push(socket)
    socket.on('close', () => {
      closed += 1
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    connections: () => connections,
    requests: () => requests,
    peak: () => peak,
    sockets,
    closed: () => closed,
  }
}

function clientFor(target: { url: string }, extra: Partial<InternalClientOptions> = {}) {
  const pauses: number[] = []
  const client = createInternalClient({
    baseUrl: target.url,
    secret: 'keepalive-secret',
    environment: 'local',
    sleep: async (ms) => {
      pauses.push(ms)
    },
    random: () => 0.5,
    ...extra,
  })
  clients.push(client)
  return { client, pauses }
}

async function failureOf(promise: Promise<unknown>): Promise<InternalCallError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(InternalCallError)
    return error as InternalCallError
  }
  throw new Error('the call did not fail')
}

describe('connection reuse', () => {
  test('sequential calls share one connection', async () => {
    const target = await receiver()
    const { client } = clientFor(target)
    for (let i = 0; i < 20; i += 1) {
      expect((await client.request({ method: 'GET', path: '/' })).status).toBe(200)
    }
    expect(target.requests()).toBe(20)
    expect(target.connections()).toBe(1)
  })

  test('concurrent calls never exceed maxSockets, and later calls reuse them', async () => {
    const target = await receiver((_q, response) => {
      setTimeout(() => response.end('{"ok":true}'), 20)
    })
    const { client } = clientFor(target, { maxSockets: 4 })
    const answers = await Promise.all(
      Array.from({ length: 20 }, () => client.request({ method: 'GET', path: '/' }))
    )
    expect(answers.every((answer) => answer.status === 200)).toBe(true)
    expect(target.peak()).toBeLessThanOrEqual(4)
    expect(target.connections()).toBeLessThanOrEqual(4)
    const opened = target.connections()
    await Promise.all(
      Array.from({ length: 20 }, () => client.request({ method: 'GET', path: '/' }))
    )
    expect(target.connections()).toBeLessThanOrEqual(opened + 4)
    expect(target.peak()).toBeLessThanOrEqual(4)
  })

  test('two clients share no connections, and closing one leaves the other working', async () => {
    const target = await receiver()
    const a = clientFor(target)
    const b = clientFor(target)
    await a.client.request({ method: 'GET', path: '/' })
    await b.client.request({ method: 'GET', path: '/' })
    expect(target.connections()).toBe(2)
    a.client.close()
    expect((await b.client.request({ method: 'GET', path: '/' })).status).toBe(200)
    expect(target.connections()).toBe(2)
  })

  test('a call longer than the idle timeout is not cut by it', async () => {
    const target = await receiver((_q, response) => {
      setTimeout(() => response.end('{"ok":true}'), 400)
    })
    const { client } = clientFor(target, { idleTimeoutMs: 100, timeoutMs: 3_000 })
    expect((await client.request({ method: 'GET', path: '/' })).status).toBe(200)
  })
})

describe('the pool is bounded', () => {
  test('a call beyond maxSockets waits and then runs on the same connection', async () => {
    const release: Array<() => void> = []
    const target = await receiver((_q, response) => {
      release.push(() => response.end('{"ok":true}'))
    })
    const { client } = clientFor(target, { maxSockets: 1 })
    const first = client.request({ method: 'GET', path: '/a' })
    const second = client.request({ method: 'GET', path: '/b' })
    await Bun.sleep(100)
    expect(target.requests()).toBe(1)
    release.shift()?.()
    await first
    await Bun.sleep(50)
    release.shift()?.()
    expect((await second).status).toBe(200)
    expect(target.connections()).toBe(1)
  })

  test('the wait for a connection counts against the timeout and never reaches the wire', async () => {
    const target = await receiver(() => undefined)
    const { client } = clientFor(target, { maxSockets: 1, retry: { maxAttempts: 1 } })
    const held = client.request({ method: 'GET', path: '/held', timeoutMs: 1_500 })
    held.catch(() => undefined)
    await Bun.sleep(50)
    const started = Date.now()
    const error = await failureOf(client.request({ method: 'GET', path: '/waits', timeoutMs: 200 }))
    expect(error.failure).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(await failureOf(held)).toMatchObject({ failure: 'timeout' })
    await Bun.sleep(100)
    // the waiter was dropped from the queue: only the held call ever reached the receiver
    expect(target.requests()).toBe(1)
    expect(target.connections()).toBe(1)
  })

  test("the caller's signal removes a waiting call", async () => {
    const target = await receiver(() => undefined)
    const { client } = clientFor(target, { maxSockets: 1, retry: { maxAttempts: 1 } })
    const held = client.request({ method: 'GET', path: '/held', timeoutMs: 600 })
    held.catch(() => undefined)
    await Bun.sleep(50)
    const stop = new AbortController()
    const waiting = client.request({ method: 'GET', path: '/waits', signal: stop.signal })
    setTimeout(() => stop.abort(), 50)
    expect((await failureOf(waiting)).failure).toBe('aborted')
    await held.catch(() => undefined)
    expect(target.requests()).toBe(1)
  })
})

describe('a kept connection the receiver closed', () => {
  /** Closes the receiver's end of every kept connection in the same tick as the next call. */
  function dropKept(target: Receiver) {
    for (const socket of target.sockets) {
      socket.destroy()
    }
  }

  test('a POST without a key surfaces stale_connection and is not resent', async () => {
    const target = await receiver()
    const { client, pauses } = clientFor(target)
    await client.request({ method: 'GET', path: '/' })
    dropKept(target)
    const call = client.request({ method: 'POST', path: '/x', body: { a: 1 } })
    const error = await failureOf(call)
    expect(error.failure).toBe('stale_connection')
    expect(error.attempts).toBe(1)
    expect(pauses).toEqual([])
    expect(target.requests()).toBe(1)
    // the dead connection left the pool: the next call works on a fresh one
    expect((await client.request({ method: 'POST', path: '/x', body: { a: 1 } })).status).toBe(200)
    expect(target.connections()).toBe(2)
  })

  test('a GET is resent at once on a fresh connection', async () => {
    const target = await receiver()
    const { client, pauses } = clientFor(target)
    await client.request({ method: 'GET', path: '/' })
    dropKept(target)
    const answer = await client.request({ method: 'GET', path: '/' })
    expect(answer).toMatchObject({ status: 200, attempts: 2 })
    expect(pauses).toEqual([0])
    expect(target.connections()).toBe(2)
  })

  test('a POST with an idempotency key is resent, and with one attempt it is not', async () => {
    const target = await receiver()
    const { client } = clientFor(target)
    await client.request({ method: 'GET', path: '/' })
    dropKept(target)
    const answer = await client.request({ method: 'POST', path: '/x', idempotencyKey: 'k1' })
    expect(answer.attempts).toBe(2)

    const single = clientFor(target, { retry: { maxAttempts: 1 } })
    await single.client.request({ method: 'GET', path: '/' })
    dropKept(target)
    const error = await failureOf(single.client.request({ method: 'GET', path: '/' }))
    expect(error.failure).toBe('stale_connection')
  })

  test('a fresh connection that fails is a plain connection failure', async () => {
    const target = await receiver((_q, response) => {
      response.socket?.destroy()
    })
    const { client } = clientFor(target, { retry: { maxAttempts: 1 } })
    expect((await failureOf(client.request({ method: 'GET', path: '/' }))).failure).toBe(
      'connection'
    )
  })
})

describe('idle connections', () => {
  test('are closed by the client after idleTimeoutMs, and the next call opens a new one', async () => {
    const target = await receiver()
    const { client } = clientFor(target, { idleTimeoutMs: 150 })
    await client.request({ method: 'GET', path: '/' })
    expect(target.closed()).toBe(0)
    await Bun.sleep(600)
    expect(target.closed()).toBe(1)
    await client.request({ method: 'GET', path: '/' })
    expect(target.connections()).toBe(2)
  })

  test('the default is shorter than a Node server keep-alive of 5 seconds', () => {
    expect(INTERNAL_DEFAULT_IDLE_TIMEOUT_MS).toBeLessThan(5_000)
    expect(INTERNAL_DEFAULT_MAX_FREE_SOCKETS).toBeLessThanOrEqual(INTERNAL_DEFAULT_MAX_SOCKETS)
  })

  test('do not keep the process alive, with no close() call', async () => {
    const target = await receiver()
    const child = Bun.spawn(['bun', new URL('./keepalive-child.ts', import.meta.url).pathname], {
      env: { PATH: process.env.PATH ?? '', TARGET: target.url },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exit = await Promise.race([child.exited, Bun.sleep(8_000).then(() => 'hung' as const)])
    if (exit === 'hung') {
      child.kill()
    }
    expect(exit).toBe(0)
    expect(target.requests()).toBe(1)
  }, 15_000)
})

describe('close()', () => {
  test('destroys the connections and refuses later calls', async () => {
    const target = await receiver()
    const { client } = clientFor(target)
    await client.request({ method: 'GET', path: '/' })
    client.close()
    client.close()
    await Bun.sleep(100)
    expect(target.closed()).toBe(1)
    await expect(client.request({ method: 'GET', path: '/' })).rejects.toThrow(TypeError)
  })

  test('fails a call in flight and a call waiting for a connection with aborted', async () => {
    const target = await receiver(() => undefined)
    const { client } = clientFor(target, { maxSockets: 1, retry: { maxAttempts: 3 } })
    const running = failureOf(client.request({ method: 'GET', path: '/a', timeoutMs: 5_000 }))
    const waiting = failureOf(client.request({ method: 'GET', path: '/b', timeoutMs: 5_000 }))
    await Bun.sleep(100)
    client.close()
    expect((await running).failure).toBe('aborted')
    expect((await waiting).failure).toBe('aborted')
    expect(target.requests()).toBe(1)
  })
})

describe('options', () => {
  test.each([
    [{ maxSockets: 0 }],
    [{ maxSockets: 1.5 }],
    [{ maxSockets: Number.NaN }],
    [{ maxFreeSockets: 0 }],
    [{ maxFreeSockets: -1 }],
    [{ maxFreeSockets: 1.5 }],
    [{ maxSockets: 2, maxFreeSockets: 3 }],
    [{ idleTimeoutMs: 0 }],
    [{ idleTimeoutMs: Number.POSITIVE_INFINITY }],
  ] as const)('%o is refused', (extra) => {
    expect(() =>
      createInternalClient({
        baseUrl: 'http://127.0.0.1:1',
        secret: 'x',
        environment: 'local',
        ...extra,
      })
    ).toThrow(TypeError)
  })

  test('a small maxSockets lowers the default maxFreeSockets', async () => {
    const target = await receiver()
    const small = clientFor(target, { maxSockets: 2 })
    expect((await small.client.request({ method: 'GET', path: '/' })).status).toBe(200)
  })
})

describe('https', () => {
  let dir = ''
  let secure: ReturnType<typeof createHttpsServer> | undefined
  let tlsConnections = 0
  let cert = ''
  let url = ''

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kit-tls-reuse-'))
    const made = Bun.spawnSync([
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '2',
      '-keyout',
      join(dir, 'k.pem'),
      '-out',
      join(dir, 'c.pem'),
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ])
    if (made.exitCode !== 0) {
      throw new Error('openssl is needed to make a test certificate')
    }
    cert = readFileSync(join(dir, 'c.pem'), 'utf8')
    secure = createHttpsServer(
      { cert, key: readFileSync(join(dir, 'k.pem'), 'utf8') },
      (_request, response) => {
        response.end('{"tls":true}')
      }
    )
    secure.on('secureConnection', () => {
      tlsConnections += 1
    })
    await new Promise<void>((resolve) => secure?.listen(0, '127.0.0.1', resolve))
    url = `https://127.0.0.1:${(secure.address() as AddressInfo).port}`
  })
  afterAll(() => {
    secure?.closeAllConnections()
    secure?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('sequential calls share one TLS connection, and verification stays on', async () => {
    const { client } = clientFor({ url }, { ca: cert })
    for (let i = 0; i < 10; i += 1) {
      expect((await client.request({ method: 'GET', path: '/' })).json).toEqual({ tls: true })
    }
    expect(tlsConnections).toBe(1)
    const untrusting = clientFor({ url }, { retry: { maxAttempts: 1 } })
    expect((await failureOf(untrusting.client.request({ method: 'GET', path: '/' }))).failure).toBe(
      'connection'
    )
  })
})
