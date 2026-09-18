import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { startHistoryFileWatch } from './source-history-watch'

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await delay(10)
  }
}

test('periodic reconcile processes a file even when no watcher event arrives', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-history-reconcile-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })

  const controller = new AbortController()
  const candidate = join(root, 'missed.jsonl')
  const processed: string[] = []
  let listCalls = 0

  const handle = await startHistoryFileWatch({
    root,
    signal: controller.signal,
    debounceMs: 5,
    listFiles: async limit => {
      listCalls += 1
      assert.equal(limit, 20)
      return [candidate]
    },
    reconcilePollMs: 25,
    reconcileLimit: 20,
    initialReconcileLimit: 0,
    onFile: async filePath => { processed.push(filePath) },
  })

  try {
    await waitFor(
      () => processed.includes(candidate),
      'periodic reconcile did not recover a watcher-missed file',
    )
    assert.ok(listCalls >= 1)
  } finally {
    controller.abort()
    await handle.dispose()
  }
})
