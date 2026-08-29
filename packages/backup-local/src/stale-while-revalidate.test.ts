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

function overview(generatedAt: string, fileCount: number): BackupOverview {
  return {
    vaultPath: 'vault',
    sources: [{
      sourceId: 'pi', productId: 'pi', displayName: 'Pi', detected: true,
      fileCount, excludedCount: 0, kinds: { session: fileCount },
    }],
    snapshots: [],
    index: { generatedAt, refreshing: false },
  }
}

function fakeService(
  first: Promise<BackupOverview>,
  refresh: () => Promise<BackupOverview>,
): BackupService {
  return {
    overview(_input?: BackupCreateInput) { return first },
    refreshIndex() { return refresh() },
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

test('首次索引生成不阻塞 overview，完成后自动切到 ready', async () => {
  const first = deferred<BackupOverview>()
  const service = new StaleWhileRevalidateBackupService(
    fakeService(first.promise, () => Promise.resolve(overview(new Date().toISOString(), 2))),
    { vaultPath: 'vault', accessStaleMs: 60_000, safetyRefreshMs: 0 },
  )

  const pending = await service.overview()
  assert.equal(pending.index?.ready, false)
  assert.equal(pending.index?.refreshing, true)
  assert.deepEqual(pending.sources, [])

  first.resolve(overview(new Date().toISOString(), 3))
  await nextTurn()

  const ready = await service.overview()
  assert.equal(ready.index?.ready, true)
  assert.equal(ready.index?.refreshing, false)
  assert.equal(ready.sources[0]?.fileCount, 3)
})

test('旧索引立即返回，同时后台刷新，不等待完整扫描', async () => {
  const staleTime = new Date(Date.now() - 10 * 60_000).toISOString()
  const first = Promise.resolve(overview(staleTime, 5))
  const refresh = deferred<BackupOverview>()
  const service = new StaleWhileRevalidateBackupService(
    fakeService(first, () => refresh.promise),
    { vaultPath: 'vault', accessStaleMs: 1_000, safetyRefreshMs: 0 },
  )

  service.start()
  await nextTurn()

  const stale = await service.overview()
  assert.equal(stale.index?.ready, true)
  assert.equal(stale.index?.stale, true)
  assert.equal(stale.index?.refreshing, true)
  assert.equal(stale.sources[0]?.fileCount, 5)

  refresh.resolve(overview(new Date().toISOString(), 8))
  await nextTurn()

  const fresh = await service.overview()
  assert.equal(fresh.index?.ready, true)
  assert.equal(fresh.index?.refreshing, false)
  assert.equal(fresh.index?.stale, false)
  assert.equal(fresh.sources[0]?.fileCount, 8)
  service.stop()
})
