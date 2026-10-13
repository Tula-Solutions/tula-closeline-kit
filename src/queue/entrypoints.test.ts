import { describe, expect, test } from 'bun:test'

const ROOT = new URL('../index.ts', import.meta.url).pathname
const QUEUE = new URL('../queue.ts', import.meta.url).pathname
const TESTING = new URL('../testing.ts', import.meta.url).pathname
const BEHAVIOUR = new URL('../behaviour.ts', import.meta.url).pathname

/**
 * Follows the imports of `entry` through the kit's own source and returns every package it names,
 * without loading any package: the import graph decides what a process would load.
 */
async function packagesImportedBy(entry: string): Promise<string[]> {
  return (await analyse(entry)).packages
}

async function analyse(entry: string): Promise<{ packages: string[]; output: string }> {
  const seen = new Set<string>()
  const result = await Bun.build({
    entrypoints: [entry],
    target: 'bun',
    plugins: [
      {
        name: 'record-packages',
        setup(build) {
          build.onResolve({ filter: /^[^./]/ }, (args) => {
            seen.add(args.path)
            return { path: args.path, external: true }
          })
        },
      },
    ],
  })
  expect(result.success).toBe(true)
  return { packages: [...seen], output: (await result.outputs[0]?.text()) ?? '' }
}

describe('importing the kit does not load the AWS SDK unless the queue entry is asked for', () => {
  test('the control: the queue entry names it', async () => {
    expect(await packagesImportedBy(QUEUE)).toContain('@aws-sdk/client-sqs')
  })

  test.each([
    ['root', ROOT],
    ['testing', TESTING],
  ])('the %s entry does not', async (_name, entry) => {
    const packages = await packagesImportedBy(entry)
    expect(packages.length).toBeGreaterThan(0)
    expect(packages.filter((name) => name.startsWith('@aws-sdk/'))).toEqual([])
  })

  test('only the behaviour entry names bun:test', async () => {
    expect((await analyse(BEHAVIOUR)).output).toContain('bun:test')
    for (const entry of [ROOT, TESTING, QUEUE]) {
      expect((await analyse(entry)).output).not.toContain('bun:test')
    }
  })
})
