import assert from 'node:assert/strict'
import test from 'node:test'
import type { SourceRecord } from '@agent-lens/core'
import { SqliteStorageService } from './storage'

async function setup() {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  const now = '2026-09-05T00:00:00.000Z'
  await storage.repositories.hosts.put({
    id: 'host', name: 'host', platform: 'test', arch: 'x64', createdAt: now, lastSeenAt: now,
  })
  await storage.repositories.installations.putProduct({ id: 'codex', name: 'Codex' })
  await storage.repositories.installations.put({
    id: 'install', hostId: 'host', productId: 'codex', firstSeenAt: now, lastSeenAt: now,
  })
  return storage
}

function record(id: string, parserVersion: string): SourceRecord {
  return {
    id,
    sourceId: 'codex',
    installationId: 'install',
    nativeType: 'response_item/message',
    nativeId: id,
    capturedAt: '2026-09-05T00:00:00.000Z',
    locator: { kind: 'file', path: `/tmp/${id}.jsonl` },
    payload: { id },
    parserVersion,
  }
}

test('writing a stale parser record marks completed replay checkpoints pending and clears the cursor', async () => {
  const storage = await setup()
  try {
    const completed = {
      sourceId: 'codex',
      installationId: 'install',
      targetParserVersion: '5',
      window: 'all',
      state: 'completed',
      dirty: false,
      cursor: {
        parserVersion: '1',
        capturedAt: '2026-09-01T00:00:00.000Z',
        id: 'old-cursor',
      },
      updatedAt: '2026-09-05T00:00:00.000Z',
      completedAt: '2026-09-05T00:00:00.000Z',
    }
    await storage.checkpoints.set('parser-replay', 'codex:install:5:all', completed)

    await storage.repositories.sourceRecords.put(record('current', '5'))
    const afterCurrent = await storage.checkpoints.get<any>('parser-replay', 'codex:install:5:all')
    assert.equal(afterCurrent.state, 'completed')
    assert.equal(afterCurrent.dirty, false)
    assert.equal(afterCurrent.cursor.id, 'old-cursor')

    await storage.repositories.sourceRecords.put(record('stale', '1'))
    const afterStale = await storage.checkpoints.get<any>('parser-replay', 'codex:install:5:all')
    assert.equal(afterStale.state, 'pending')
    assert.equal(afterStale.dirty, true)
    assert.equal(afterStale.cursor, undefined)
    assert.equal(afterStale.completedAt, undefined)
  } finally {
    await storage.close()
  }
})
