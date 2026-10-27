import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'

const MAX_REDIRECTS = 5
const NULL_BODY = new Set([101, 204, 205, 304])
const SENSITIVE = ['authorization', 'cookie', 'proxy-authorization']

/**
 * `fetch` for adapters that send credentials, and it never uses a proxy named in the environment
 * (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and their lower-case forms). Bun's `fetch` follows
 * them, and Bun 1.4.2 has no per-request opt-out (`proxy: false` arrived in 1.4.3), so this goes
 * through `node:http(s)` with `agent: false`, which reads no proxy variable. `proxy.test.ts` pins it.
 * It takes string, `URLSearchParams` or byte bodies, answers uncompressed (no `Accept-Encoding`),
 * and follows redirects itself only for `redirect: 'follow'`, dropping credentials on a new origin.
 */
export async function directFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (!headers.has('accept-encoding')) {
    headers.set('accept-encoding', 'identity')
  }
  let body: string | Uint8Array | undefined
  if (init.body instanceof URLSearchParams) {
    body = init.body.toString()
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8')
    }
  } else if (typeof init.body === 'string' || init.body instanceof Uint8Array) {
    body = init.body
  } else if (init.body !== undefined && init.body !== null) {
    throw new TypeError('directFetch takes a string, URLSearchParams or Uint8Array body')
  }
  let url = new URL(input)
  let method = init.method ?? 'GET'
  for (let hops = 0; ; hops++) {
    const response = await send(url, method, headers, body, init.signal ?? undefined)
    const location = response.headers.get('location')
    const redirect = response.status >= 300 && response.status < 400 && location !== null
    if (!redirect || (init.redirect ?? 'follow') !== 'follow') {
      return response
    }
    void response.body?.cancel().catch(() => undefined)
    if (hops >= MAX_REDIRECTS) {
      throw new TypeError('too many redirects')
    }
    const next = new URL(location, url)
    if (next.origin !== url.origin) {
      for (const name of SENSITIVE) {
        headers.delete(name)
      }
    }
    if (response.status !== 307 && response.status !== 308) {
      method = method === 'HEAD' ? 'HEAD' : 'GET'
      body = undefined
      headers.delete('content-type')
    }
    url = next
  }
}

/** One request over `node:http(s)` with no agent (so no proxy), answered as a web `Response`. */
function send(
  url: URL,
  method: string,
  headers: Headers,
  body: string | Uint8Array | undefined,
  signal: AbortSignal | undefined
): Promise<Response> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`unsupported protocol ${url.protocol}`)
  }
  const open = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const outgoing = open(
      url,
      { method, headers: Object.fromEntries(headers), agent: false, signal },
      (incoming) => {
        const answer = new Headers()
        for (const [name, value] of Object.entries(incoming.headers)) {
          for (const item of Array.isArray(value) ? value : [value ?? '']) {
            answer.append(name, item)
          }
        }
        const status = incoming.statusCode ?? 0
        resolve(
          new Response(
            NULL_BODY.has(status) ? null : (Readable.toWeb(incoming) as ReadableStream),
            {
              status,
              headers: answer,
            }
          )
        )
      }
    )
    outgoing.on('error', reject)
    outgoing.end(body)
  })
}
