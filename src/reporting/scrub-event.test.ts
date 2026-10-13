import { describe, expect, test } from 'bun:test'
import { scrubEvent } from './scrub-event'

function dirtyEvent(): Record<string, unknown> {
  return {
    event_id: '4bf92f3577b34da6a3ce929d0e0e4736',
    message: 'failed password=hunter2',
    transaction: 'POST /hooks/Bearer abc123def456',
    exception: {
      values: [
        {
          type: 'Error',
          value: 'token=zzz999 rejected',
          stacktrace: {
            frames: [
              {
                filename: '/app/dist/index.js',
                function: 'run',
                lineno: 3,
                vars: { password: 'v-secret', other: 'v-other' },
                pre_context: ['const k = "pre-secret"'],
                context_line: 'const k = "line-secret"',
                post_context: ['post-secret'],
              },
            ],
          },
        },
      ],
    },
    request: {
      method: 'POST',
      url: 'https://api.example.com/cb?code=q-secret&state=s#frag-secret',
      data: { card: 'body-secret' },
      cookies: { sid: 'cookie-secret' },
      query_string: 'code=q-secret',
      headers: {
        authorization: 'Bearer auth-secret',
        Cookie: 'sid=cookie-secret',
        'set-cookie': 'sid=cookie-secret',
        'x-api-key': 'key-secret',
        'x-request-id': 'req_01',
      },
    },
    user: { id: 'u1', email: 'a@b.co', ip_address: '10.0.0.1' },
    extra: {
      password: 'extra-secret',
      note: 'ok',
      nested: { token: 'nested-secret', text: 'api_key=text-secret' },
    },
    tags: { service: 'core', sessionToken: 'tag-secret', note: 'secret=tag-text-secret' },
    contexts: { closeline: { path: '/x' }, custom: { authorization: 'ctx-secret' } },
    breadcrumbs: [
      {
        message: 'GET https://u:crumb-secret@h.example/?token=crumb-q',
        data: { body: 'crumb-body', url: 'https://h/' },
      },
    ],
    sdkProcessingMetadata: { keep: 'this-object' },
  }
}

const SECRETS = [
  'hunter2',
  'abc123def456',
  'zzz999',
  'v-secret',
  'v-other',
  'pre-secret',
  'line-secret',
  'post-secret',
  'q-secret',
  'frag-secret',
  'body-secret',
  'cookie-secret',
  'auth-secret',
  'key-secret',
  'a@b.co',
  '10.0.0.1',
  'extra-secret',
  'nested-secret',
  'text-secret',
  'tag-secret',
  'tag-text-secret',
  'ctx-secret',
  'crumb-secret',
  'crumb-q',
  'crumb-body',
]

describe('scrubEvent', () => {
  test('removes every secret from every part of an event', () => {
    const out = scrubEvent(dirtyEvent())
    const text = JSON.stringify(out)
    for (const secret of SECRETS) {
      expect(text).not.toContain(secret)
    }
  })

  test('removes request bodies, cookies, the query string and the authorization header outright', () => {
    const out = scrubEvent(dirtyEvent()) as { request: Record<string, unknown> }
    expect(out.request).not.toHaveProperty('data')
    expect(out.request).not.toHaveProperty('cookies')
    expect(out.request).not.toHaveProperty('query_string')
    const headers = out.request.headers as Record<string, string>
    expect(Object.keys(headers)).toEqual(['x-request-id'])
    expect(out.request.url).toBe('https://api.example.com/cb')
    expect(out.request.method).toBe('POST')
  })

  test('drops the user and the source and local variables of frames, and keeps the frames', () => {
    const out = scrubEvent(dirtyEvent()) as {
      user?: unknown
      exception: { values: Array<{ stacktrace: { frames: Array<Record<string, unknown>> } }> }
    }
    expect(out.user).toBeUndefined()
    const frame = out.exception.values[0]?.stacktrace.frames[0]
    expect(frame).toEqual({ filename: '/app/dist/index.js', function: 'run', lineno: 3 })
  })

  test('keeps what is not secret', () => {
    const out = scrubEvent(dirtyEvent()) as Record<string, unknown>
    expect(out.event_id).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
    expect((out.extra as Record<string, unknown>).note).toBe('ok')
    expect((out.tags as Record<string, unknown>).service).toBe('core')
    expect((out.contexts as Record<string, unknown>).closeline).toEqual({ path: '/x' })
  })

  test('does not change the event it is given, and hands back the SDK metadata untouched', () => {
    const event = dirtyEvent()
    const metadata = event.sdkProcessingMetadata
    const before = JSON.stringify(event)
    const out = scrubEvent(event) as Record<string, unknown>
    expect(JSON.stringify(event)).toBe(before)
    expect(out.sdkProcessingMetadata).toBe(metadata)
  })

  test('a circular or hostile event is scrubbed or dropped, never thrown', () => {
    const event = dirtyEvent()
    const extra = event.extra as Record<string, unknown>
    extra.self = extra
    expect(() => scrubEvent(event)).not.toThrow()
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('no')
        },
        get: () => {
          throw new Error('no')
        },
      }
    )
    expect(() => scrubEvent(hostile)).not.toThrow()
    const result = scrubEvent(hostile)
    expect(result === null || typeof result === 'object').toBe(true)
  })
})
