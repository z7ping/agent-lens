import assert from 'node:assert/strict'
import test from 'node:test'
import type { BackupService, BackupSnapshotManifest } from '@agent-lens/core'
import type {
  BackupOverviewResponseDto,
  BackupRestorePreviewResponseDto,
  BackupSnapshotResponseDto,
  BackupVerifyResponseDto,
} from '@agent-lens/protocol'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import { startHttpSurface } from './server'

const manifest: BackupSnapshotManifest = {
  schemaVersion: 1,
  id: 'snapshot-test',
  createdAt: '2026-08-22T10:00:00.000Z',
  files: [],
  excluded: [],
  manifestSha256: 'abc123',
}

function stubBackup(): BackupService {
  return {
    async overview() {
      return {
        vaultPath: '/tmp/vault',
        sources: [{
          sourceId: 'codex',
          productId: 'codex',
          displayName: 'Codex',
          detected: true,
          fileCount: 3,
          excludedCount: 1,
          kinds: { skill: 1, session: 2 },
        }],
        snapshots: [{
          id: manifest.id,
          createdAt: manifest.createdAt,
          sourceIds: ['codex'],
          fileCount: 0,
          excludedCount: 0,
          totalBytes: 0,
          manifestSha256: manifest.manifestSha256,
        }],
      }
    },
    async listSnapshots() { return [] },
    async getSnapshot(id) { return id === manifest.id ? manifest : null },
    async createSnapshot() { return manifest },
    async verifySnapshot(id) {
      return {
        snapshotId: id,
        valid: true,
        manifestMatches: true,
        checkedFiles: 0,
        missingFiles: [],
        mismatchedFiles: [],
      }
    },
    async exportSnapshot() { return new TextEncoder().encode('bundle') },
    async importSnapshot() { return manifest },
    async previewRestore(id) {
      return {
        snapshotId: id,
        generatedAt: '2026-08-22T10:01:00.000Z',
        items: [],
        unchanged: 0,
        missing: 0,
        modified: 0,
        blocked: 0,
      }
    },
  }
}

test('HTTP backup surface exposes snapshot lifecycle without a restore write endpoint', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  const surface = await startHttpSurface(storage, { port: 0, backup: stubBackup() })
  const base = `http://${surface.host}:${surface.port}`
  try {
    const overviewResponse = await fetch(`${base}/api/v1/backups`)
    assert.equal(overviewResponse.status, 200)
    const overview = await overviewResponse.json() as BackupOverviewResponseDto
    assert.equal(overview.sources[0]?.fileCount, 3)
    assert.equal(overview.meta.protocolVersion, '1.0')

    const createResponse = await fetch(`${base}/api/v1/backups`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceIds: ['codex'], kinds: ['skill', 'session'] }),
    })
    assert.equal(createResponse.status, 201)
    const created = await createResponse.json() as BackupSnapshotResponseDto
    assert.equal(created.snapshot.id, manifest.id)

    const verifyResponse = await fetch(`${base}/api/v1/backups/${manifest.id}/verify`, { method: 'POST' })
    assert.equal(verifyResponse.status, 200)
    const verified = await verifyResponse.json() as BackupVerifyResponseDto
    assert.equal(verified.valid, true)

    const exportResponse = await fetch(`${base}/api/v1/backups/${manifest.id}/export`)
    assert.equal(exportResponse.status, 200)
    assert.equal(exportResponse.headers.get('content-type'), 'application/vnd.agentlens.backup')
    assert.equal(await exportResponse.text(), 'bundle')

    const importResponse = await fetch(`${base}/api/v1/backups/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/vnd.agentlens.backup' },
      body: new Uint8Array([1, 2, 3]),
    })
    assert.equal(importResponse.status, 201)

    const previewResponse = await fetch(`${base}/api/v1/backups/${manifest.id}/restore-preview`)
    assert.equal(previewResponse.status, 200)
    const preview = await previewResponse.json() as BackupRestorePreviewResponseDto
    assert.equal(preview.blocked, 0)

    const unsafeWrite = await fetch(`${base}/api/v1/backups/${manifest.id}/restore`, { method: 'POST' })
    assert.equal(unsafeWrite.status, 405)
  } finally {
    await surface.dispose()
    storage.close()
  }
})
