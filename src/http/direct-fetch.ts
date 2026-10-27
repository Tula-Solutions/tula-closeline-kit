/**
 * `fetch` for adapters that send credentials, and it never uses a proxy named in the environment
 * (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and their lower-case forms): `proxy: false` is Bun's
 * per-request opt-out (Bun 1.4.3 and later). `proxy.test.ts` pins it for http and https.
 * Redirects, compression and credential stripping are `fetch`'s own; callers pass `redirect: 'manual'`.
 */
export async function directFetch(input: string, init: RequestInit = {}): Promise<Response> {
  // bun-types types `proxy` as a URL string only; the runtime takes `false` (probe-checked).
  return fetch(input, { ...init, proxy: false } as RequestInit)
}
