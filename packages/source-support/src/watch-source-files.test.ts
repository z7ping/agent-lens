import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { watchSourceFiles } from './watch-source-files'

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

test('watchSourceFiles is ready before returning and stops cleanly on dispose', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-watch-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const controller = new AbortController()
  const seen: Array<{ path: string; event: string }> = []
  let resolveFirst: (() => void) | undefined
  const first = new Promise<void>(resolve => {
    resolveFirst = resolve
  })

  const handle = await watchSourceFiles({
    paths: root,
    signal: controller.signal,
    debounceMs: 20,
    accept: filePath => basename(filePath) === 'state.db',
    onFile: async (filePath, event) => {
      seen.push({ path: filePath, event })
      resolveFirst?.()
      resolveFirst = undefined
    },
  })

  const filePath = join(root, 'state.db')
  await writeFile(filePath, 'one', 'utf8')
  await Promise.race([
    first,
    delay(2_000).then(() => {
      throw new Error('watchSourceFiles did not observe a file created after readiness')
    }),
  ])

  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.path, filePath)
  assert.equal(seen[0]?.event, 'add')

  await handle.dispose()
  const countAfterDispose = seen.length
  await writeFile(filePath, 'two', 'utf8')
  await delay(100)
  assert.equal(seen.length, countAfterDispose)
})

test('watchSourceFiles accepts an already-aborted signal', async () => {
  const controller = new AbortController()
  controller.abort()
  const handle = await watchSourceFiles({
    paths: '.',
    signal: controller.signal,
    onFile() {
      throw new Error('aborted watcher must not process files')
    },
  })
  await handle.dispose()
})
