import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInternalClient, InternalCallError, type InternalClientOptions } from './internal'

const SECRET = 'sekret-marker-7f3a9c'
const BODY_MARKER = 'body-marker-51e2'
const ANSWER_MARKER = 'answer-marker-88d0'

type Seen = { method: string; url: string; headers: Headers; body: string }
type Stand = {
  url: string
  seen: Seen[]
  stop: () => Promise<void>
}
type Responder = (request: Request, count: number) => Response | Promise<Response>

const stands: Stand[] = []
afterAll(async () => {
  await Promise.all(stands.map((stand) => stand.stop()))
})

/** A receiver on a loopback port; `respond` decides each answer. */
function stand(respond: Responder = () => Response.json({ ok: true }), hostname = '127.0.0.1') {
  const seen: Seen[] = []
  const server = Bun.serve({
    hostname,
    port: 0,
    async fetch(request) {
      seen.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: await request.clone().text(),
      })
      return respond(request, seen.length)
    },
  })
  const host = hostname.includes(':') ? `[${hostname}]` : hostname
  const made: Stand = {
    url: `http://${host}:${server.port}`,
    seen,
    stop: async () => {
      await server.stop(true)
    },
  }
  stands.push(made)
  return made
}

/** Records the pauses and returns fixed random numbers, so no test waits or depends on a clock. */
function harness(random = 0.5) {
  const pauses: number[] = []
  const warnings: string[] = []
  return {
    pauses,
    warnings,
    options: {
      environment: 'local',
      secret: SECRET,
      sleep: async (ms: number) => {
        pauses.push(ms)
      },
      random: () => random,
      logger: {
        warn: (message: string, fields?: Record<string, unknown>) => {
          warnings.push(JSON.stringify({ message, fields }))
        },
      },
    } satisfies Omit<InternalClientOptions, 'baseUrl'>,
  }
}

function clientFor(target: { url: string }, extra: Partial<InternalClientOptions> = {}) {
  const h = harness()
  return {
    h,
    client: createInternalClient({ ...h.options, baseUrl: target.url, ...extra }),
  }
}

/** The error a promise rejects with. */
async function failure(promise: Promise<unknown>): Promise<InternalCallError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(InternalCallError)
    return error as InternalCallError
  }
  throw new Error('the call did not fail')
}

/** Everything an error shows, as text: message, name, enumerable fields, stack and cause. */
function everything(error: Error): string {
  const parts = [
    error.message,
    error.name,
    String(error.stack),
    JSON.stringify(error),
    JSON.stringify(Object.getOwnPropertyDescriptors(error), (_k, v) =>
      typeof v === 'function' ? undefined : v
    ),
    String(error.cause),
  ]
  return parts.join('\n')
}

describe('the request', () => {
  test('sends the secret as a bearer, the JSON body, the key and the extra headers', async () => {
    const receiver = stand()
    const { client } = clientFor(receiver, { userAgent: 'closeline-auth' })

    const answer = await client.request({
      method: 'POST',
      path: '/internal/organizations?x=1',
      body: { name: BODY_MARKER },
      idempotencyKey: 'key-1',
      headers: { 'X-Request-Id': 'req-1' },
    })

    expect(answer).toEqual({ status: 200, json: { ok: true }, attempts: 1 })
    const [seen] = receiver.seen
    expect(seen?.method).toBe('POST')
    expect(new URL(seen?.url ?? '').pathname + new URL(seen?.url ?? '').search).toBe(
      '/internal/organizations?x=1'
    )
    expect(seen?.headers.get('authorization')).toBe(`Bearer ${SECRET}`)
    expect(seen?.headers.get('content-type')).toBe('application/json')
    expect(seen?.headers.get('idempotency-key')).toBe('key-1')
    expect(seen?.headers.get('x-request-id')).toBe('req-1')
    expect(seen?.headers.get('user-agent')).toBe('closeline-auth')
    expect(JSON.parse(seen?.body ?? '')).toEqual({ name: BODY_MARKER })
  })

  test('a base URL with a path prefix and a trailing slash is joined once', async () => {
    const receiver = stand()
    const { client } = clientFor({ url: `${receiver.url}/api/` })
    await client.request({ method: 'GET', path: '/x' })
    expect(new URL(receiver.seen[0]?.url ?? '').pathname).toBe('/api/x')
  })

  test('a caller cannot override the Authorization header or send a body on GET', async () => {
    const receiver = stand()
    const { client } = clientFor(receiver)
    expect(() =>
      client.request({ method: 'GET', path: '/x', headers: { Authorization: 'Bearer other' } })
    ).toThrow(TypeError)
    expect(client.request({ method: 'GET', path: '/x', body: {} })).rejects.toThrow(TypeError)
    expect(receiver.seen).toHaveLength(0)
  })

  test.each(['x', '//evil.test/x', '/a b', '/a#b'])('refuses the path %j', async (path) => {
    const receiver = stand()
    const { client } = clientFor(receiver)
    expect(client.request({ method: 'GET', path })).rejects.toThrow(TypeError)
    expect(receiver.seen).toHaveLength(0)
  })

  test('works against an IPv6 loopback base URL', async () => {
    const receiver = stand(() => Response.json({ v6: true }), '::1')
    const { client } = clientFor(receiver, { environment: 'prod' })
    const answer = await client.request({ method: 'GET', path: '/x' })
    expect(answer.json).toEqual({ v6: true })
  })
})

describe('the base URL', () => {
  const make = (baseUrl: string, environment: InternalClientOptions['environment'] = 'prod') =>
    createInternalClient({ baseUrl, secret: SECRET, environment })

  test.each([
    'not a url',
    'ftp://core.internal',
    'https://user:pw@core.internal',
    'https://user@core.internal',
    'https://core.internal/?a=1',
    'https://core.internal/#frag',
    'https://core.internal?',
    'http://core.internal',
    'http://localhost:3000',
    'http://10.0.0.5:3000',
  ])('is refused outside local: %s', (baseUrl) => {
    expect(() => make(baseUrl)).toThrow(TypeError)
  })

  test.each([
    'https://core.internal',
    'https://core.internal:8443/api',
    'http://127.0.0.1:3000',
    'http://127.5.5.5',
    'http://[::1]:3000',
  ])('is accepted in prod: %s', (baseUrl) => {
    expect(() => make(baseUrl)).not.toThrow()
  })

  test('plain http to a named host is accepted only when ENVIRONMENT is local', () => {
    expect(() => make('http://core:3000', 'local')).not.toThrow()
    for (const environment of ['dev', 'staging', 'prod'] as const) {
      expect(() => make('http://core:3000', environment)).toThrow(TypeError)
    }
  })

  test.each(['', 'has space', 'line\nbreak', 'tab\t'])('a secret of %j is refused', (secret) => {
    expect(() =>
      createInternalClient({ baseUrl: 'https://core.internal', secret, environment: 'prod' })
    ).toThrow(TypeError)
  })

  test('the refusal does not repeat the URL', () => {
    try {
      make('https://user:hunter2@core.internal')
    } catch (error) {
      expect(String(error)).not.toContain('hunter2')
    }
  })
})

describe('redirects', () => {
  test('a redirect is an error and the secret never reaches the target', async () => {
    const elsewhere = stand()
    const receiver = stand(
      () => new Response(null, { status: 302, headers: { location: `${elsewhere.url}/steal` } })
    )
    const { client } = clientFor(receiver)

    const error = await failure(client.request({ method: 'GET', path: '/x' }))

    expect(error.failure).toBe('redirect')
    expect(error.status).toBe(302)
    expect(error.attempts).toBe(1)
    expect(elsewhere.seen).toHaveLength(0)
    expect(receiver.seen).toHaveLength(1)
  })

  test.each([301, 303, 307, 308])('status %d is refused too', async (status) => {
    const receiver = stand(() => new Response(null, { status, headers: { location: '/y' } }))
    const { client } = clientFor(receiver)
    const error = await failure(client.request({ method: 'POST', path: '/x', body: {} }))
    expect(error.failure).toBe('redirect')
  })
})

describe('timeout', () => {
  test('an answer that never comes fails as a timeout', async () => {
    const receiver = stand(() => new Promise<Response>(() => undefined))
    const { client } = clientFor(receiver, { timeoutMs: 40, retry: { maxAttempts: 1 } })
    const error = await failure(client.request({ method: 'GET', path: '/x' }))
    expect(error.failure).toBe('timeout')
    expect(error.attempts).toBe(1)
  })

  test('a body that stalls halfway fails as a timeout', async () => {
    const receiver = stand(() => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"a":'))
        },
      })
      return new Response(stream, { headers: { 'content-type': 'application/json' } })
    })
    const { client } = clientFor(receiver, { timeoutMs: 60, retry: { maxAttempts: 1 } })
    const error = await failure(client.request({ method: 'GET', path: '/x' }))
    expect(error.failure).toBe('timeout')
  })

  test('a timeout is retried for an idempotent call', async () => {
    const receiver = stand((_r, count) =>
      count === 1 ? new Promise<Response>(() => undefined) : Response.json({ ok: 1 })
    )
    const { client, h } = clientFor(receiver, { timeoutMs: 40 })
    const answer = await client.request({ method: 'GET', path: '/x' })
    expect(answer.attempts).toBe(2)
    expect(h.pauses).toHaveLength(1)
  })

  test('the caller can abort, and no retry follows', async () => {
    const receiver = stand(() => new Promise<Response>(() => undefined))
    const { client } = clientFor(receiver, { timeoutMs: 5_000 })
    const controller = new AbortController()
    const pending = client.request({ method: 'GET', path: '/x', signal: controller.signal })
    setTimeout(() => controller.abort(), 30)
    const error = await failure(pending)
    expect(error.failure).toBe('aborted')
    expect(receiver.seen.length).toBeLessThanOrEqual(1)
  })
})

describe('retry', () => {
  const statuses = (...codes: number[]) =>
    stand((_r, count) => {
      const code = codes[Math.min(count, codes.length) - 1] ?? 200
      return code === 200 ? Response.json({ done: true }) : new Response('x', { status: code })
    })

  test.each([502, 503, 504, 429])('GET is retried on %d until it clears', async (code) => {
    const receiver = statuses(code, code, 200)
    const { client, h } = clientFor(receiver)
    const answer = await client.request({ method: 'GET', path: '/x' })
    expect(answer).toEqual({ status: 200, json: { done: true }, attempts: 3 })
    expect(receiver.seen).toHaveLength(3)
    expect(h.pauses).toHaveLength(2)
  })

  test.each([400, 401, 403, 404, 409, 422, 500, 501])(
    '%d is returned at once, never retried',
    async (code) => {
      const receiver = statuses(code)
      const { client, h } = clientFor(receiver)
      const answer = await client.request({ method: 'GET', path: '/x' })
      expect(answer.status).toBe(code)
      expect(answer.attempts).toBe(1)
      expect(receiver.seen).toHaveLength(1)
      expect(h.pauses).toEqual([])
    }
  )

  test('the last retryable answer is returned after the attempts are used', async () => {
    const receiver = statuses(503)
    const { client } = clientFor(receiver)
    const answer = await client.request({ method: 'GET', path: '/x' })
    expect(answer.status).toBe(503)
    expect(answer.attempts).toBe(3)
    expect(receiver.seen).toHaveLength(3)
  })

  test('a POST without a key is sent once, even when it fails with 503', async () => {
    const receiver = statuses(503, 200)
    const { client } = clientFor(receiver)
    const answer = await client.request({ method: 'POST', path: '/x', body: {} })
    expect(answer.status).toBe(503)
    expect(answer.attempts).toBe(1)
    expect(receiver.seen).toHaveLength(1)
  })

  test('a POST with an idempotency key is retried, with the same key each time', async () => {
    const receiver = statuses(503, 200)
    const { client } = clientFor(receiver)
    const answer = await client.request({
      method: 'POST',
      path: '/x',
      body: { a: 1 },
      idempotencyKey: 'k-77',
    })
    expect(answer.attempts).toBe(2)
    expect(receiver.seen.map((s) => s.headers.get('idempotency-key'))).toEqual(['k-77', 'k-77'])
    expect(receiver.seen.map((s) => s.body)).toEqual(['{"a":1}', '{"a":1}'])
  })

  test.each(['PUT', 'DELETE'] as const)('%s is idempotent by method', async (method) => {
    const receiver = statuses(502, 200)
    const { client } = clientFor(receiver)
    expect((await client.request({ method, path: '/x' })).attempts).toBe(2)
  })

  test('PATCH without a key is not retried', async () => {
    const receiver = statuses(502, 200)
    const { client } = clientFor(receiver)
    expect((await client.request({ method: 'PATCH', path: '/x', body: {} })).attempts).toBe(1)
  })

  test('a connection failure is retried for GET and not for a bare POST', async () => {
    const dead = stand()
    await dead.stop()
    const { client, h } = clientFor(dead)
    const get = await failure(client.request({ method: 'GET', path: '/x' }))
    expect(get.failure).toBe('connection')
    expect(get.attempts).toBe(3)
    expect(h.pauses).toHaveLength(2)
    const post = await failure(client.request({ method: 'POST', path: '/x', body: {} }))
    expect(post.attempts).toBe(1)
    const keyed = await failure(
      client.request({ method: 'POST', path: '/x', body: {}, idempotencyKey: 'k' })
    )
    expect(keyed.attempts).toBe(3)
  })

  test('maxAttempts bounds the tries and 1 turns retries off', async () => {
    const receiver = statuses(503)
    const two = clientFor(receiver, { retry: { maxAttempts: 2 } }).client
    expect((await two.request({ method: 'GET', path: '/x' })).attempts).toBe(2)
    const one = clientFor(receiver, { retry: { maxAttempts: 1 } }).client
    expect((await one.request({ method: 'GET', path: '/x' })).attempts).toBe(1)
  })

  test('pauses are full jitter: random times a doubling ceiling cut at the maximum', async () => {
    const receiver = statuses(503)
    const policy = { maxAttempts: 6, baseDelayMs: 100, maxDelayMs: 500 }
    for (const [random, expected] of [
      [0, [0, 0, 0, 0, 0]],
      [0.5, [50, 100, 200, 250, 250]],
      [0.999999, [99, 199, 399, 499, 499]],
    ] as const) {
      const h = harness(random)
      const client = createInternalClient({ ...h.options, baseUrl: receiver.url, retry: policy })
      await client.request({ method: 'GET', path: '/x' })
      expect(h.pauses).toEqual(expected as unknown as number[])
    }
  })

  test('Retry-After seconds are honoured, cut at the cap, and the date form falls back to jitter', async () => {
    const answer = (value: string) =>
      stand((_r, count) =>
        count === 1
          ? new Response('x', { status: 429, headers: { 'retry-after': value } })
          : Response.json({})
      )
    const run = async (value: string) => {
      const { client, h } = clientFor(answer(value), { retry: { retryAfterCapMs: 3_000 } })
      await client.request({ method: 'GET', path: '/x' })
      return h.pauses
    }
    expect(await run('2')).toEqual([2_000])
    expect(await run('0')).toEqual([0])
    expect(await run('3600')).toEqual([3_000])
    expect(await run('Wed, 21 Oct 2099 07:28:00 GMT')).toEqual([50])
    expect(await run('-5')).toEqual([50])
  })

  test('a retry is noted without the secret, a body or an answer', async () => {
    const receiver = stand((_r, count) =>
      count === 1 ? new Response(ANSWER_MARKER, { status: 503 }) : Response.json({})
    )
    const { client, h } = clientFor(receiver)
    await client.request({
      method: 'POST',
      path: '/x?q=private-marker',
      body: { a: BODY_MARKER },
      idempotencyKey: 'k',
    })
    const text = h.warnings.join('')
    expect(text).toContain('503')
    for (const secret of [SECRET, BODY_MARKER, ANSWER_MARKER, 'private-marker']) {
      expect(text).not.toContain(secret)
    }
  })
})

describe('the answer', () => {
  test('is parsed as JSON whatever the content type says', async () => {
    const receiver = stand(
      () => new Response('{"a":1}', { headers: { 'content-type': 'text/plain' } })
    )
    const { client } = clientFor(receiver)
    expect((await client.request({ method: 'GET', path: '/x' })).json).toEqual({ a: 1 })
  })

  test('is undefined when it is not JSON or is empty, even if the type says JSON', async () => {
    for (const text of ['<html>', '', '{"a":']) {
      const receiver = stand(
        () => new Response(text, { headers: { 'content-type': 'application/json' } })
      )
      const { client } = clientFor(receiver)
      const answer = await client.request({ method: 'GET', path: '/x' })
      expect(answer.status).toBe(200)
      expect(answer.json).toBeUndefined()
    }
  })

  test('a 4xx answer is returned with its parsed body', async () => {
    const receiver = stand(() => Response.json({ error: { code: 'a.b' } }, { status: 409 }))
    const { client } = clientFor(receiver)
    expect(await client.request({ method: 'POST', path: '/x', body: {} })).toEqual({
      status: 409,
      json: { error: { code: 'a.b' } },
      attempts: 1,
    })
  })

  test('over the size bound fails, by declared length and by streaming', async () => {
    const big = 'x'.repeat(2_000)
    const declared = stand(() => new Response(big))
    const streamed = stand(() => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(big.slice(0, 1_000)))
          controller.enqueue(new TextEncoder().encode(big.slice(1_000)))
          controller.close()
        },
      })
      return new Response(stream)
    })
    for (const receiver of [declared, streamed]) {
      const { client } = clientFor(receiver, { maxResponseBytes: 1_024 })
      const error = await failure(client.request({ method: 'GET', path: '/x' }))
      expect(error.failure).toBe('response_too_large')
      expect(error.attempts).toBe(1)
    }
  })

  test('exactly at the bound is read', async () => {
    const receiver = stand(() => new Response(JSON.stringify({ a: 'x'.repeat(10) })))
    const size = JSON.stringify({ a: 'x'.repeat(10) }).length
    const { client } = clientFor(receiver, { maxResponseBytes: size })
    expect((await client.request({ method: 'GET', path: '/x' })).status).toBe(200)
  })
})

describe('errors', () => {
  test('carry method, path without query, status and attempts, and never the secret or a body', async () => {
    const dead = stand()
    await dead.stop()
    const redirecting = stand(() => new Response(ANSWER_MARKER, { status: 301 }))
    const stalled = stand(() => new Promise<Response>(() => undefined))
    const large = stand(() => new Response(ANSWER_MARKER.repeat(500)))
    const errors: InternalCallError[] = []
    const call = {
      method: 'POST',
      path: '/internal/x?token=private-marker',
      body: { a: BODY_MARKER },
      idempotencyKey: 'k',
    } as const
    errors.push(await failure(clientFor(dead, { retry: { maxAttempts: 2 } }).client.request(call)))
    errors.push(await failure(clientFor(redirecting).client.request(call)))
    errors.push(
      await failure(
        clientFor(stalled, { timeoutMs: 30, retry: { maxAttempts: 1 } }).client.request(call)
      )
    )
    errors.push(await failure(clientFor(large, { maxResponseBytes: 100 }).client.request(call)))

    expect(errors.map((e) => e.failure)).toEqual([
      'connection',
      'redirect',
      'timeout',
      'response_too_large',
    ])
    for (const error of errors) {
      expect(error.method).toBe('POST')
      expect(error.path).toBe('/internal/x')
      const text = everything(error)
      for (const hidden of [SECRET, BODY_MARKER, ANSWER_MARKER, 'private-marker', '127.0.0.1']) {
        expect(text).not.toContain(hidden)
      }
    }
    expect(errors[0]?.attempts).toBe(2)
    expect(errors[1]?.status).toBe(301)
    expect(errors[1]?.message).toContain('POST /internal/x')
  })
})

describe('TLS', () => {
  let dir = ''
  let cert = ''
  let key = ''
  let secure: ReturnType<typeof Bun.serve> | undefined
  let usable = false

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kit-tls-'))
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
    usable = made.exitCode === 0
    if (!usable) {
      return
    }
    cert = readFileSync(join(dir, 'c.pem'), 'utf8')
    key = readFileSync(join(dir, 'k.pem'), 'utf8')
    secure = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      tls: { cert, key },
      fetch: () => Response.json({ tls: true }),
    })
  })
  afterAll(async () => {
    await secure?.stop(true)
    rmSync(dir, { recursive: true, force: true })
  })

  test('an untrusted certificate is refused, and trusted when its CA is given', async () => {
    if (!usable || secure === undefined) {
      throw new Error('openssl is needed to make a test certificate')
    }
    const baseUrl = `https://127.0.0.1:${secure.port}`
    const base = {
      baseUrl,
      secret: SECRET,
      environment: 'local',
      retry: { maxAttempts: 1 },
    } as const

    const refused = await failure(createInternalClient(base).request({ method: 'GET', path: '/' }))
    expect(refused.failure).toBe('connection')

    const trusted = createInternalClient({ ...base, ca: cert })
    expect((await trusted.request({ method: 'GET', path: '/' })).json).toEqual({ tls: true })
  })
})
