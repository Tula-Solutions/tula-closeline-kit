import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { callIdSchema, organizationIdSchema } from 'tula-closeline-contract'
import { createAssemblyAiStreamingTranscribe } from './assemblyai'
import type { StreamEvent } from './port'

/**
 * Streams a recording to AssemblyAI in real time and records the median delay between the end of
 * the last word of a final turn and the moment that turn arrived, on stderr. Needs
 * `ASSEMBLYAI_TEST_API_KEY` and `ASSEMBLYAI_TEST_AUDIO` (a raw 16 kHz mono signed 16-bit
 * little-endian PCM file of speech, at least a few seconds long); `ASSEMBLYAI_TEST_REGION=eu`
 * selects the EU endpoint. Run it with `bun run test:integration`. The shared behaviour suite
 * needs scripted failures, so it runs against a fake vendor in `assemblyai.behaviour.test.ts`.
 * Without the variables this file is skipped and says so on stderr.
 */
const apiKey = process.env.ASSEMBLYAI_TEST_API_KEY
const audioPath = process.env.ASSEMBLYAI_TEST_AUDIO
const region = process.env.ASSEMBLYAI_TEST_REGION === 'eu' ? 'eu' : 'us'

if (!apiKey || !audioPath) {
  process.stderr.write(
    'SKIPPED: the AssemblyAI adapter was not run against AssemblyAI. Set ASSEMBLYAI_TEST_API_KEY and ASSEMBLYAI_TEST_AUDIO and run `bun run test:integration`.\n'
  )
  describe.skip('Streaming transcribe integration: AssemblyAI adapter (ASSEMBLYAI_TEST_* not set)', () => {
    test('skipped', () => undefined)
  })
} else {
  setDefaultTimeout(120_000)
  describe('Streaming transcribe integration: AssemblyAI adapter', () => {
    test('transcribes a recording and reports the final-turn delay', async () => {
      const audio = new Uint8Array(readFileSync(audioPath))
      const port = createAssemblyAiStreamingTranscribe({ apiKey, region })
      const started = performance.now()
      const delays: number[] = []
      const finals: string[] = []
      let failed = false
      const stream = await port.open({
        organizationId: organizationIdSchema.parse(`org_${'a'.repeat(32)}`),
        callId: callIdSchema.parse(`call_${'a'.repeat(32)}`),
        track: 'prospect',
        encoding: 'pcm_s16le',
        sampleRate: 16000,
        onEvent: (event: StreamEvent) => {
          if (event.type === 'failed') {
            failed = true
          }
          if (event.type === 'turn' && event.isFinal) {
            const last = event.words.at(-1)
            if (last !== undefined) {
              delays.push(performance.now() - started - last.endMs)
            }
            finals.push(event.text)
          }
        },
      })
      // 100 ms chunks of 16 kHz 16-bit mono, paced in real time.
      const chunk = 3200
      for (let at = 0; at < audio.length; at += chunk) {
        stream.sendAudio(audio.slice(at, at + chunk))
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      await stream.close()
      delays.sort((a, b) => a - b)
      const median = delays[Math.floor(delays.length / 2)] ?? Number.NaN
      process.stderr.write(
        `AssemblyAI (${region}) median final-turn delay: ${Math.round(median)} ms over ${delays.length} final turns\n`
      )
      expect(failed).toBe(false)
      expect(finals.length).toBeGreaterThan(0)
    })
  })
}
