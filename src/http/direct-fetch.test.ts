import { afterAll, describe, expect, test } from 'bun:test'
import { directFetch } from './direct-fetch'

const other = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (request) => Response.json({ auth: request.headers.get('authorization') }),
})
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/hop') {
      return Response.redirect(`http://127.0.0.1:${other.port}/`, 302)
    }
    if (path === '/none') {
      return new Response(null, { status: 204 })
    }
    if (path === '/slow') {
      await Bun.sleep(2000)
    }
    return Response.json({
      method: request.method,
      type: request.headers.get('content-type'),
      auth: request.headers.get('authorization'),
      body: await request.text(),
    })
  },
})
afterAll(async () => {
  await server.stop(true)
  await other.stop(true)
})
const base = `http://127.0.0.1:${server.port}`

describe('directFetch', () => {
  test('sends headers and a form body, and reads the JSON answer', async () => {
    const response = await directFetch(`${base}/echo`, {
      method: 'POST',
      headers: { authorization: 'Bearer s' },
      body: new URLSearchParams({ a: '1' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      method: 'POST',
      type: 'application/x-www-form-urlencoded;charset=UTF-8',
      auth: 'Bearer s',
      body: 'a=1',
    })
  })

  test('redirect manual returns the redirect', async () => {
    const manual = await directFetch(`${base}/hop`, { redirect: 'manual' })
    expect(manual.status).toBe(302)
  })

  test('follow drops the authorization header on a cross-origin redirect (fetch behaviour, pinned)', async () => {
    const cross = await directFetch(`${base}/hop`, { headers: { authorization: 'Bearer s' } })
    expect(await cross.json()).toEqual({ auth: null })
  })

  test('answers 204 with no body and honours an abort signal', async () => {
    const none = await directFetch(`${base}/none`)
    expect(none.status).toBe(204)
    expect(none.body).toBeNull()
    await expect(
      directFetch(`${base}/slow`, { signal: AbortSignal.timeout(100) })
    ).rejects.toThrow()
  })
})
