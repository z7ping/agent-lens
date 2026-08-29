import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { BackupOverview, BackupService } from '@agent-lens/core'
import { ExplainableBackupService } from './explainability'

test('从现有备份索引汇总大小、目录树和时间分布，不把文件数冒充逻辑资产数', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-backup-explain-'))
  try {
    const configRoot = join(root, 'config')
    const dataRoot = join(root, 'data')
    const inventoryPath = join(root, 'inventory-v1.json')
    const now = Date.now()
    await writeFile(inventoryPath, JSON.stringify({
      version: 1,
      generatedAt: new Date(now).toISOString(),
      sources: [],
      excluded: [],
      files: [
        {
          sourceId: 'hermes', productId: 'hermes', installationId: 'one',
          originalPath: join(configRoot, 'settings.json'), sourceScope: 'config', sourceRelativePath: 'settings.json', archivePath: 'hermes/one/config/settings.json',
          kinds: ['mcp'], size: 50, mtimeMs: now - 10 * 86_400_000, ctimeMs: now - 10 * 86_400_000,
        },
        {
          sourceId: 'hermes', productId: 'hermes', installationId: 'one',
          originalPath: join(dataRoot, 'sessions', 'recent', 'recent.jsonl'), sourceScope: 'data', sourceRelativePath: 'sessions/recent/recent.jsonl', archivePath: 'hermes/one/data/sessions/recent/recent.jsonl',
          kinds: ['session'], size: 100, mtimeMs: now - 20 * 86_400_000, ctimeMs: now - 20 * 86_400_000,
        },
        {
          sourceId: 'hermes', productId: 'hermes', installationId: 'one',
          originalPath: join(dataRoot, 'sessions', 'archive', 'old.jsonl'), sourceScope: 'data', sourceRelativePath: 'sessions/archive/old.jsonl', archivePath: 'hermes/one/data/sessions/archive/old.jsonl',
          kinds: ['session'], size: 200, mtimeMs: now - 220 * 86_400_000, ctimeMs: now - 220 * 86_400_000,
        },
      ],
    }))

    const overview: BackupOverview = {
      vaultPath: root,
      sources: [{
        sourceId: 'hermes', productId: 'hermes', displayName: 'Hermes', detected: true,
        fileCount: 3, excludedCount: 0, kinds: { mcp: 1, session: 2 },
      }],
      snapshots: [],
    }
    const base = {
      async overview() { return overview },
      async listSnapshots() { return [] },
      async getSnapshot() { return null },
      async createSnapshot() { throw new Error('not used') },
      async verifySnapshot() { throw new Error('not used') },
      async exportSnapshot() { throw new Error('not used') },
      async importSnapshot() { throw new Error('not used') },
      async previewRestore() { throw new Error('not used') },
    } as BackupService

    const service = new ExplainableBackupService(base, inventoryPath)
    const result = await service.overview()
    const source = result.sources[0]!

    assert.equal(source.totalBytes, 350)
    assert.equal(source.logicalAssetCount, undefined)
    assert.deepEqual(source.kindDetails?.mcp, { fileCount: 1, totalBytes: 50 })
    assert.deepEqual(source.kindDetails?.session, { fileCount: 2, totalBytes: 300 })
    assert.equal(source.roots?.length, 2)
    assert.ok(source.roots?.some(item => item.scope === 'config' && item.path === configRoot && item.fileCount === 1))
    const data = source.roots?.find(item => item.scope === 'data')
    assert.equal(data?.path, dataRoot)
    assert.equal(data?.fileCount, 2)
    assert.equal(data?.tree?.[0]?.name, 'sessions')
    assert.equal(data?.tree?.[0]?.fileCount, 2)
    assert.deepEqual(data?.tree?.[0]?.children?.map(item => item.name), ['archive', 'recent'])
    assert.equal(data?.tree?.[0]?.children?.[0]?.fileCount, 1)
    assert.equal(source.ageBuckets?.recent30Days.fileCount, 2)
    assert.equal(source.ageBuckets?.olderThan180Days.fileCount, 1)
    assert.ok(source.oldestModifiedAt)
    assert.ok(source.latestModifiedAt)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
