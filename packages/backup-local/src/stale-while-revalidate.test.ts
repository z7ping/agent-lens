import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  BackupCreateInput,
  BackupOverview,
  BackupRestorePreview,
  BackupService,
  BackupSnapshotManifest,
  BackupSnapshotSummary,
  BackupVerifyResult,
} from '@agent-lens/core'
import { StaleWhileRevalidateBackupService } from './stale-while-revalidate'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function sourceOverview(sourceId: string, generatedAt: string, fileCount: number): BackupOverview {
  return {
    vaultPath: 'vault',
    sources: [{
      sourceId,
      productId: sourceId,
      displayName: sourceId === 'pi' ? 'Pi' : 'Codex',
      detected: true,
      fileCount,
      excludedCount: 0,
      kinds: { session: fileCount },
    }],
    snapshots: [],
    index: { generatedAt, refreshing: false },
  }
}

function combinedOverview(generatedAt: string, counts: Record<string, number>): BackupOverview {
  return {
    vaultPath: 'vault',
    sources: Object.entries(counts).map(([sourceId, fileCount]) => ({
      sourceId,
      productId: sourceId,
      displayName: sourceId,
      detected: true,
      fileCount,
      excludedCount: 0,
      kinds: { session: fileCount },
    })),
    snapshots: [],
    index: { generatedAt, refreshing: false },
  }
}

function fakeService(options: {
  cached?: BackupOverview | null
  refresh(sourceId: string): Promise<BackupOverview>
  refreshCalls: string[]
}): BackupService {
  return {
    async overview(_input?: BackupCreateInput) {
      throw new Error('progressive SWR should not call blocking overview for cold cache loading')
    },
    async peekOverview() { return options.cached ?? null },
    refreshIndex(input: BackupCreateInput = {}) {
      const sourceId = input.sourceIds?.[0]
      if (!sourceId) throw new Error('expected one source per progressive refresh')
      options.refreshCalls.push(sourceId)
      return options.refresh(sourceId)
    },
    async listSnapshots(): Promise<BackupSnapshotSummary[]> { return [] },
    async getSnapshot(): Promise<BackupSnapshotManifest | null> { return null },
    async createSnapshot(): Promise<BackupSnapshotManifest> { throw new Error('not used') },
    async verifySnapshot(): Promise<BackupVerifyResult> { throw new Error('not used') },
    async exportSnapshot(): Promise<Uint8Array> { throw new Error('not used') },
    async importSnapshot(): Promise<BackupSnapshotManifest> { throw new Error('not used') },
    async previewRestore(): Promise<BackupRestorePreview> { throw new Error('not used') },
  }
}

async function nextTurn(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
}

test('冷启动按用户配置顺序逐个扫描，前一个完成后立即可见', async () => {
  const pi = deferred<BackupOverview>()
  const codex = deferred<BackupOverview>()
  const refreshCalls: string[] = []
  const service = new StaleWhileRevalidateBackupService(
    fakeService({
      refreshCalls,
      refresh(sourceId) {
        if (sourceId === 'pi') return pi.promise
        if (sourceId === 'codex') return codex.promise
        throw new Error(`unexpected source ${sourceId}`)
      },
    }),
    { vaultPath: 'vault', sourceOrder: ['pi', 'codex'], accessStaleMs: 60_000, safetyRefreshMs: 0 },
  )

  const pending = await service.overview()
  assert.equal(pending.index?.ready, false)
  assert.equal(pending.index?.refreshing, true)
  assert.deepEqual(refreshCalls, ['pi'])

  pi.resolve(sourceOverview('pi', '2026-08-31T00:00:00.000Z', 3))
  await nextTurn()
  assert.deepEqual(refreshCalls, ['pi', 'codex'])

  const partial = await service.overview()
  assert.equal(partial.index?.ready, true)
  assert.equal(partial.index?.refreshing, true)
  assert.deepEqual(partial.sources.map(item => item.sourceId), ['pi'])
  assert.equal(partial.sources[0]?.fileCount, 3)

  codex.resolve(sourceOverview('codex', '2026-08-31T00:00:01.000Z', 5))
  await nextTurn()
  const complete = await service.overview()
  assert.equal(complete.index?.ready, true)
  assert.equal(complete.index?.refreshing, false)
  assert.deepEqual(complete.sources.map(item => item.sourceId), ['pi', 'codex'])
  assert.deepEqual(complete.sources.map(item => item.fileCount), [3, 5])
})

test('旧索引立即可用，后台仍按配置顺序渐进替换各智能体', async () => {
  const staleTime = new Date(Date.now() - 10 * 60_000).toISOString()
  const pi = deferred<BackupOverview>()
  const codex = deferred<BackupOverview>()
  const refreshCalls: string[] = []
  const service = new StaleWhileRevalidateBackupService(
    fakeService({
      cached: combinedOverview(staleTime, { pi: 2, codex: 4 }),
      refreshCalls,
      refresh(sourceId) { return sourceId === 'pi' ? pi.promise : codex.promise },
    }),
    { vaultPath: 'vault', sourceOrder: ['pi', 'codex'], accessStaleMs: 1_000, safetyRefreshMs: 0 },
  )

  const stale = await service.overview()
  assert.equal(stale.index?.ready, true)
  assert.equal(stale.index?.stale, true)
  assert.equal(stale.index?.refreshing, true)
  assert.deepEqual(stale.sources.map(item => item.fileCount), [2, 4])
  assert.deepEqual(refreshCalls, ['pi'])

  pi.resolve(sourceOverview('pi', new Date().toISOString(), 7))
  await nextTurn()
  const partial = await service.overview()
  assert.deepEqual(partial.sources.map(item => item.fileCount), [7, 4])
  assert.equal(partial.index?.refreshing, true)

  codex.resolve(sourceOverview('codex', new Date().toISOString(), 9))
  await nextTurn()
  const fresh = await service.overview()
  assert.deepEqual(fresh.sources.map(item => item.fileCount), [7, 9])
  assert.equal(fresh.index?.refreshing, false)
})

test('服务启动只读取本地缓存，不主动触发冷目录扫描', async () => {
  const refreshCalls: string[] = []
  const service = new StaleWhileRevalidateBackupService(
    fakeService({
      cached: null,
      refreshCalls,
      refresh(sourceId) { return Promise.resolve(sourceOverview(sourceId, new Date().toISOString(), 1)) },
    }),
    { vaultPath: 'vault', sourceOrder: ['pi', 'codex'], safetyRefreshMs: 0 },
  )

  service.start()
  await nextTurn()
  assert.deepEqual(refreshCalls, [])
  service.stop()
})
