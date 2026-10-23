import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { organizationIdSchema } from 'tula-closeline-contract'
import { createCartesiaTts } from './cartesia'

/**
 * Speaks one sentence through Cartesia for real and records the time to first audio on stderr.
 * Needs `CARTESIA_TEST_API_KEY` and `CARTESIA_TEST_VOICE` (a Cartesia voice id); run it with
 * `bun run test:integration`. The shared `TtsPort` behaviour suite needs scripted failures, so it
 * runs against a fake vendor in `cartesia.behaviour.test.ts`. Without the variables this file is
 * skipped and says so on stderr; CI never fails for want of credentials.
 */
const apiKey = process.env.CARTESIA_TEST_API_KEY
const voice = process.env.CARTESIA_TEST_VOICE

if (!apiKey || !voice) {
  process.stderr.write(
    'SKIPPED: the Cartesia adapter was not run against Cartesia. Set CARTESIA_TEST_API_KEY and CARTESIA_TEST_VOICE and run `bun run test:integration`.\n'
  )
  describe.skip('TTS integration: Cartesia adapter (CARTESIA_TEST_* not set)', () => {
    test('skipped', () => undefined)
  })
} else {
  setDefaultTimeout(30_000)
  const port = createCartesiaTts({ apiKey })
  const request = {
    organizationId: organizationIdSchema.parse(`org_${'a'.repeat(32)}`),
    voice,
    encoding: 'pcm_s16le' as const,
    sampleRate: 24000 as const,
  }
  describe('TTS integration: Cartesia adapter', () => {
    test('speaks a sentence and reports the time to first audio', async () => {
      const stream = port.open(request)
      const started = performance.now()
      stream.write('Hello, this is a short test of the voice.')
      stream.finish()
      let firstMs = -1
      let bytes = 0
      for await (const chunk of stream) {
        if (firstMs < 0) {
          firstMs = performance.now() - started
        }
        bytes += chunk.byteLength
      }
      process.stderr.write(
        `Cartesia time to first audio: ${Math.round(firstMs)} ms, ${bytes} bytes\n`
      )
      expect(bytes).toBeGreaterThan(0)
    })

    test('a cancel after the first chunk stops the stream', async () => {
      const stream = port.open(request)
      stream.write('This is a longer sentence that we will interrupt before it finishes speaking.')
      const it = stream[Symbol.asyncIterator]()
      expect((await it.next()).done).toBe(false)
      stream.cancel()
      expect((await it.next()).done).toBe(true)
    })
  })
}
