import { createHash } from 'node:crypto'
import { createS3ObjectStore, type S3Sender } from '../src/storage/aws'

/**
 * Benchmark: a 500 MB streamed put through the S3 adapter (`putStream`), the size of a Recording
 * (ADR 0018), against a client stub that hashes and discards each part.
 *
 * Input: 500 MiB in 256 KiB chunks from a generator, one run, parts of 8 MiB, two at a time.
 * Expected complexity: O(object size) time (one SHA-256 and one copy per byte), O(part size)
 * memory: about four parts (the two uploading, one waiting, one filling) = 32 MiB whatever the
 * object size.
 *
 * Budgets: heap plus array buffers may grow at most 64 MiB above the start while the 500 MiB go
 * through (measured about 25 MiB; sampled after a forced garbage collection every 32 chunks, so
 * garbage not yet collected is not counted as growth), and the run takes at most 5 s (measured
 * about 0.6 s, mostly hashing). A change that buffers the object, or lets parts pile up, fails the
 * memory budget by a factor of ten.
 */
const MIB = 1024 * 1024
const TOTAL = 500 * MIB
const GROWTH_BUDGET = 64 * MIB
const TIME_BUDGET_MS = 5_000

const client: S3Sender = {
  send: async (command) => {
    const name = command.constructor.name
    const input = (command as unknown as { input: { Body?: Buffer; PartNumber?: number } }).input
    if (name === 'CreateMultipartUploadCommand') {
      return { UploadId: 'u' }
    }
    if (name === 'UploadPartCommand') {
      createHash('sha256')
        .update(input.Body as Buffer)
        .digest()
      await new Promise((resolve) => setTimeout(resolve, 1))
      return { ETag: `"${input.PartNumber}"` }
    }
    return {}
  },
}
const store = createS3ObjectStore({
  bucket: 'bench',
  region: 'eu-west-1',
  environment: 'dev',
  client,
})

const used = () => {
  const usage = process.memoryUsage()
  return usage.heapUsed + usage.arrayBuffers
}
Bun.gc(true)
const before = used()
let peak = before
async function* source(): AsyncGenerator<Uint8Array> {
  const chunk = new Uint8Array(256 * 1024).fill(3)
  let count = 0
  for (let sent = 0; sent < TOTAL; sent += chunk.byteLength) {
    count += 1
    if (count % 32 === 0) {
      Bun.gc(true)
      peak = Math.max(peak, used())
    }
    yield chunk
  }
}

const started = performance.now()
const result = await store.putStream(`org_${'1'.repeat(32)}`, 'bench/recording', source(), {
  maxBytes: 600 * MIB,
})
const elapsed = performance.now() - started
const growth = peak - before
process.stdout.write(
  `streamed put, 500 MiB: ${elapsed.toFixed(0)} ms (budget ${TIME_BUDGET_MS}), ` +
    `peak growth ${(growth / MIB).toFixed(1)} MiB (budget ${GROWTH_BUDGET / MIB})\n`
)
const failures: string[] = []
if (result.size !== TOTAL) {
  failures.push(`wrote ${result.size} bytes, expected ${TOTAL}`)
}
if (growth > GROWTH_BUDGET) {
  failures.push(`memory grew ${(growth / MIB).toFixed(1)} MiB > ${GROWTH_BUDGET / MIB} MiB`)
}
if (elapsed > TIME_BUDGET_MS) {
  failures.push(`took ${elapsed.toFixed(0)} ms > ${TIME_BUDGET_MS} ms`)
}
if (failures.length > 0) {
  process.stderr.write(`bench failed: ${failures.join('; ')}\n`)
  process.exit(1)
}
