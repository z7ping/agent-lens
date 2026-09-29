import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { watchSourceFiles } from './watch-source-files'

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await delay(20)
  }
}

test('watchSourceFiles is ready before returning and stops cleanly on dispose', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-watch-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const controller = new AbortController()
  const seen: Array<{ path: string; event: string }> = []

  const handle = await watchSourceFiles({
    paths: root,
    signal: controller.signal,
    debounceMs: 20,
    accept: filePath => basename(filePath) === 'state.db',
    onFile: async (filePath, event) => {
      seen.push({ path: filePath, event })
    },
  })

  const filePath = join(root, 'state.db')
  await writeFile(filePath, 'one', 'utf8')
  await waitFor(
    () => seen.some(item => item.path === filePath && item.event === 'add'),
    'watchSourceFiles did not observe a file created after readiness',
  )

  assert.equal(seen.filter(item => item.path === filePath && item.event === 'add').length, 1)

  await handle.dispose()
  const countAfterDispose = seen.length
  await writeFile(filePath, 'two', 'utf8')
  await delay(100)
  assert.equal(seen.length, countAfterDispose)
})

test('watchSourceFiles observes unlink and recreated files without duplicate storms', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-watch-rebuild-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const controller = new AbortController()
  const filePath = join(root, 'state.db')
  await writeFile(filePath, 'initial', 'utf8')

  const seen: Array<{ path: string; event: string }> = []
  const handle = await watchSourceFiles({
    paths: root,
    signal: controller.signal,
    debounceMs: 20,
    accept: candidate => basename(candidate) === 'state.db',
    onFile(file, event) {
      seen.push({ path: file, event })
    },
  })

  await unlink(filePath)
  await waitFor(
    () => seen.some(item => item.path === filePath && item.event === 'unlink'),
    'watchSourceFiles did not observe file removal',
  )

  await writeFile(filePath, 'rebuilt', 'utf8')
  await waitFor(
    () => seen.some(item => item.path === filePath && item.event === 'add'),
    'watchSourceFiles did not observe recreated file',
  )

  const relevant = seen.filter(item => item.path === filePath)
  assert.equal(relevant.filter(item => item.event === 'unlink').length, 1)
  assert.equal(relevant.filter(item => item.event === 'add').length, 1)

  await handle.dispose()
})

test('watchSourceFiles stops processing after AbortSignal aborts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-watch-abort-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const controller = new AbortController()
  const seen: string[] = []
  const handle = await watchSourceFiles({
    paths: root,
    signal: controller.signal,
    debounceMs: 20,
    onFile(filePath) {
      seen.push(filePath)
    },
  })

  controller.abort()
  await handle.dispose()

  await writeFile(join(root, 'after-abort.txt'), 'ignored', 'utf8')
  await delay(100)
  assert.deepEqual(seen, [])
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

test('数据库目录的非递归监听只观察当前目录，仍能观察数据库删除与重建', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-watch-db-'))
  const nested = join(root, 'plugins', 'cache')
  await mkdir(nested, { recursive: true })
  const controller = new AbortController()
  const seen: Array<{ path: string; event: string }> = []
  const handle = await watchSourceFiles({
    paths: root, signal: controller.signal, recursive: false, debounceMs: 20,
    accept: path => basename(path) === 'state.db',
    onFile(path, event) { seen.push({ path, event }) },
  })
  t.after(async () => { controller.abort(); await handle.dispose(); await rm(root, { recursive: true, force: true }) })
  const dbPath = join(root, 'state.db')
  await writeFile(join(nested, 'state.db'), '不能把子目录数据库当成当前来源')
  await writeFile(dbPath, 'one')
  await waitFor(() => seen.some(item => item.path === dbPath && item.event === 'add'), '未观察到当前目录数据库')
  await unlink(dbPath)
  await waitFor(() => seen.some(item => item.path === dbPath && item.event === 'unlink'), '未观察到数据库移除')
  await writeFile(dbPath, 'two')
  await waitFor(() => seen.filter(item => item.path === dbPath && item.event === 'add').length === 2, '未观察到数据库重建')
  assert.ok(seen.every(item => item.path === dbPath), '不能递归监听无关插件和缓存目录')
})
