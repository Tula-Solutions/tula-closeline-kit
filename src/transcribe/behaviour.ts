import { afterEach, describe, expect, test } from 'bun:test'
import type { TranscribeRequest, Transcriber } from './port'

/** What the behaviour suite needs from an adapter under test. */
export interface TranscriberSubject {
  /** The transcriber under test, with no sends for the Organizations below. */
  transcriber: Transcriber
  /** Three Organization ids the transcriber accepts: B is unrelated, and `aExtended` starts with `a`. */
  organizations: { a: string; b: string; aExtended: string }
  /** Removes what the subject created, including every vendor copy. */
  close(): Promise<void>
}

/**
 * The behaviour every {@link Transcriber} must show. Run it with {@link transcriberBehaviour}
 * against the memory adapter and against any real adapter (which has no local stand-in, so it runs
 * in an integration test against a dev account with short sample audio and cleans up with `close`).
 * It never assumes how fast a send finishes: a result may be pending, done or failed.
 */
export function transcriberBehaviour(
  name: string,
  make: () => Promise<TranscriberSubject>,
  skip = false
): void {
  const run = skip ? describe.skip : describe
  run(`Transcriber behaviour: ${name}`, () => {
    const open: TranscriberSubject[] = []
    afterEach(async () => {
      await Promise.all(open.splice(0).map((subject) => subject.close()))
    })
    async function subject(): Promise<TranscriberSubject> {
      const made = await make()
      open.push(made)
      return made
    }
    const invalid = { code: 'transcriber.invalid_request' }
    const send = (
      reference: string,
      extra: Partial<TranscribeRequest> = {}
    ): TranscribeRequest => ({
      clientReference: reference,
      audio: { url: `https://audio.example.test/${reference}.mp3?sig=abc` },
      speakers: 'diarize',
      ...extra,
    })
    const references = async (s: TranscriberSubject, org: string, prefix?: string) => {
      const found: string[] = []
      let cursor: string | undefined
      for (let page = 0; page < 50; page++) {
        const got = await s.transcriber.list(org, {
          limit: 2,
          ...(prefix === undefined ? {} : { prefix }),
          ...(cursor === undefined ? {} : { cursor }),
        })
        found.push(...got.items.map((item) => item.clientReference))
        cursor = got.nextCursor
        if (cursor === undefined) {
          break
        }
      }
      return found
    }

    test('a send is created once and repeating it creates nothing', async () => {
      const s = await subject()
      const { a } = s.organizations

      expect(await s.transcriber.submit(a, send('call_1:1'))).toEqual({
        clientReference: 'call_1:1',
        created: true,
      })
      expect(await s.transcriber.submit(a, send('call_1:1'))).toEqual({
        clientReference: 'call_1:1',
        created: false,
      })
      expect(await references(s, a)).toEqual(['call_1:1'])
    })

    test('the same reference with another mode, speaker cap or audio key is a conflict', async () => {
      const s = await subject()
      const { a } = s.organizations
      await s.transcriber.submit(a, send('call_1:1', { maxSpeakers: 2, audioKey: 'rec/1:abc' }))
      const conflict = { code: 'transcriber.conflict' }

      await expect(
        s.transcriber.submit(
          a,
          send('call_1:1', { speakers: 'split_channels', audioKey: 'rec/1:abc' })
        )
      ).rejects.toMatchObject(conflict)
      await expect(
        s.transcriber.submit(a, send('call_1:1', { maxSpeakers: 3, audioKey: 'rec/1:abc' }))
      ).rejects.toMatchObject(conflict)
      await expect(
        s.transcriber.submit(a, send('call_1:1', { maxSpeakers: 2, audioKey: 'rec/2:def' }))
      ).rejects.toMatchObject(conflict)
      expect(await references(s, a)).toEqual(['call_1:1'])
    })

    test('a retry with a freshly presigned URL is the same send, not a conflict', async () => {
      const s = await subject()
      const { a } = s.organizations
      await s.transcriber.submit(a, send('call_1:1', { audioKey: 'rec/1:abc' }))

      const again = await s.transcriber.submit(
        a,
        send('call_1:1', {
          audio: { url: 'https://audio.example.test/call_1.mp3?sig=NEWSIGNATURE&expires=2' },
          audioKey: 'rec/1:abc',
        })
      )

      expect(again.created).toBe(false)
      expect(await references(s, a)).toEqual(['call_1:1'])
    })

    test('a result is pending, done with ordered turns, or failed with a listed reason', async () => {
      const s = await subject()
      const { a } = s.organizations
      await s.transcriber.submit(a, send('call_1:1'))
      const reasons = [
        'audio_unreachable',
        'audio_invalid',
        'no_speech',
        'too_long',
        'vendor_failed',
        'timed_out',
      ]

      const result = await s.transcriber.getResult(a, 'call_1:1')

      expect(['pending', 'done', 'failed']).toContain(result?.status as string)
      if (result?.status === 'done') {
        expect(result.durationMs).toBeGreaterThanOrEqual(0)
        let previous = 0
        for (const turn of result.turns) {
          expect(typeof turn.speaker).toBe('string')
          expect(turn.endMs).toBeGreaterThanOrEqual(turn.startMs)
          expect(turn.startMs).toBeGreaterThanOrEqual(previous)
          expect(typeof turn.text).toBe('string')
          previous = turn.startMs
        }
      }
      if (result?.status === 'failed') {
        expect(reasons).toContain(result.reason)
      }
    })

    test('a send that was never made, or was deleted, has no result', async () => {
      const s = await subject()
      const { a } = s.organizations

      expect(await s.transcriber.getResult(a, 'nope')).toBeUndefined()
      await s.transcriber.submit(a, send('call_1:1'))
      await s.transcriber.delete(a, 'call_1:1')
      expect(await s.transcriber.getResult(a, 'call_1:1')).toBeUndefined()
    })

    test('delete reports whether a copy existed and can be repeated', async () => {
      const s = await subject()
      const { a } = s.organizations
      await s.transcriber.submit(a, send('call_1:1'))

      expect(await s.transcriber.delete(a, 'call_1:1')).toEqual({ existed: true })
      expect(await s.transcriber.delete(a, 'call_1:1')).toEqual({ existed: false })
      expect(await s.transcriber.delete(a, 'never_sent:1')).toEqual({ existed: false })
      expect(await references(s, a)).toEqual([])
    })

    test('a deleted reference can be sent again as a new send', async () => {
      const s = await subject()
      const { a } = s.organizations
      await s.transcriber.submit(a, send('call_1:1'))
      await s.transcriber.delete(a, 'call_1:1')

      expect((await s.transcriber.submit(a, send('call_1:1'))).created).toBe(true)
    })

    test('list finds sends by reference prefix, in order, in pages', async () => {
      const s = await subject()
      const { a } = s.organizations
      for (const reference of ['call_2:1', 'call_1:2', 'call_1:1', 'call_1:3', 'other']) {
        await s.transcriber.submit(a, send(reference))
      }

      expect(await references(s, a, 'call_1:')).toEqual(['call_1:1', 'call_1:2', 'call_1:3'])
      expect(await references(s, a)).toEqual([
        'call_1:1',
        'call_1:2',
        'call_1:3',
        'call_2:1',
        'other',
      ])
      const first = await s.transcriber.list(a, { prefix: 'call_1:', limit: 2 })
      expect(first.items).toHaveLength(2)
      expect(first.nextCursor).toBeDefined()
      expect(['pending', 'done', 'failed']).toContain(first.items[0]?.status as string)
    })

    test('a purge by prefix removes sends the caller kept no record of', async () => {
      const s = await subject()
      const { a } = s.organizations
      for (const reference of ['call_1:1', 'call_1:2', 'call_9:1']) {
        await s.transcriber.submit(a, send(reference))
      }

      for (const reference of await references(s, a, 'call_1:')) {
        await s.transcriber.delete(a, reference)
      }

      expect(await references(s, a)).toEqual(['call_9:1'])
    })

    test("a second Organization cannot read, delete or list the first one's sends, and may reuse a reference", async () => {
      const s = await subject()
      const { a, b } = s.organizations
      await s.transcriber.submit(a, send('call_1:1'))

      expect(await s.transcriber.getResult(b, 'call_1:1')).toBeUndefined()
      expect(await s.transcriber.delete(b, 'call_1:1')).toEqual({ existed: false })
      expect(await references(s, b)).toEqual([])
      expect(
        (await s.transcriber.submit(b, send('call_1:1', { speakers: 'split_channels' }))).created
      ).toBe(true)
      expect(await references(s, a)).toEqual(['call_1:1'])
      await s.transcriber.delete(b, 'call_1:1')
      expect(await s.transcriber.getResult(a, 'call_1:1')).toBeDefined()
    })

    test('an Organization whose id starts with another id is a different Organization', async () => {
      const s = await subject()
      const { a, aExtended } = s.organizations
      await s.transcriber.submit(a, send('call_1:1'))

      expect(await references(s, aExtended)).toEqual([])
      expect(await s.transcriber.getResult(aExtended, 'call_1:1')).toBeUndefined()
    })

    test.each([
      ['an empty reference', { clientReference: '' }],
      ['a reference with a space', { clientReference: 'call 1' }],
      ['a reference with a slash', { clientReference: 'org/call' }],
      ['a reference over 128 characters', { clientReference: 'a'.repeat(129) }],
      ['no audio', { audio: undefined as unknown as { url: string } }],
      ['a URL that is not a URL', { audio: { url: 'not a url' } }],
      ['a file URL', { audio: { url: 'file:///etc/passwd' } }],
      ['a URL with user information', { audio: { url: 'https://user:pw@example.test/a' } }],
      [
        'a URL over 4096 characters',
        { audio: { url: `https://example.test/${'a'.repeat(4100)}` } },
      ],
      ['an unknown speaker mode', { speakers: 'both' as unknown as 'diarize' }],
      ['an audio key with a space', { audioKey: 'rec 1' }],
      ['an audio key over 256 characters', { audioKey: 'a'.repeat(257) }],
      ['a speaker cap of 0', { maxSpeakers: 0 }],
      ['a speaker cap of 11', { maxSpeakers: 11 }],
      ['a fractional speaker cap', { maxSpeakers: 1.5 }],
      [
        'a speaker cap with split channels',
        { speakers: 'split_channels' as const, maxSpeakers: 2 },
      ],
      ['a callback that is not a URL', { callbackUrl: 'nope' }],
    ])('a send with %s is refused and nothing is made', async (_label, change) => {
      const s = await subject()
      const { a } = s.organizations

      await expect(
        s.transcriber.submit(a, { ...send('call_1:1'), ...change })
      ).rejects.toMatchObject(invalid)
      expect(await references(s, a)).toEqual([])
    })

    test('the refusal of a bad send never repeats the audio URL', async () => {
      const s = await subject()
      const { a } = s.organizations
      const secret = 'https://user:SECRETPASSWORD@example.test/a?sig=SECRETSIG'

      try {
        await s.transcriber.submit(a, { ...send('call_1:1'), audio: { url: secret } })
        throw new Error('the send was accepted')
      } catch (error) {
        expect(JSON.stringify(error)).not.toContain('SECRET')
        expect(String((error as Error).message)).not.toContain('SECRET')
      }
    })

    test.each([
      ['a bad Organization id', 'bad/org', 'call_1:1'],
      ['a bad reference', undefined, 'bad ref'],
    ])('reads and deletes with %s are refused', async (_label, org, reference) => {
      const s = await subject()
      const id = org ?? s.organizations.a

      await expect(s.transcriber.getResult(id, reference)).rejects.toMatchObject(invalid)
      await expect(s.transcriber.delete(id, reference)).rejects.toMatchObject(invalid)
    })

    test.each([
      [{ limit: 0 }],
      [{ limit: 1001 }],
      [{ limit: 1.5 }],
      [{ prefix: 'bad prefix' }],
      [{ cursor: '!!!' }],
    ])('list options %p are refused', async (options) => {
      const s = await subject()

      await expect(s.transcriber.list(s.organizations.a, options)).rejects.toMatchObject(invalid)
    })
  })
}
