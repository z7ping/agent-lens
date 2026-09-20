import assert from 'node:assert/strict'
import test from 'node:test'
import type { TaskFileChangeRecord } from '@agent-lens/core'
import { SqliteStorageService } from './storage'

function change(
  logicalSessionId: string,
  path: string,
  changeType: TaskFileChangeRecord['changeType'],
  additions?: number,
  deletions?: number,
): TaskFileChangeRecord {
  return {
    logicalSessionId,
    path,
    changeType,
    ...(additions === undefined ? {} : { additions }),
    ...(deletions === undefined ? {} : { deletions }),
    firstChangedAt: '2026-09-20T00:01:00.000Z',
    lastChangedAt: '2026-09-20T00:02:00.000Z',
    evidence: ['git'],
    confidence: 'exact',
  }
}

test('task file baseline is immutable for the same runtime id', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    await storage.taskFileChanges.putBaseline({
      runtimeSessionId: 'runtime:1',
      workspacePath: '/workspace/one',
      gitRootPath: '/workspace/one',
      baselineTreeSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      baselineCapturedAt: '2026-09-20T00:00:00.000Z',
    })
    await storage.taskFileChanges.putBaseline({
      runtimeSessionId: 'runtime:1',
      workspacePath: '/workspace/changed',
      gitRootPath: '/workspace/changed',
      baselineTreeSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      baselineCapturedAt: '2026-09-20T00:10:00.000Z',
    })

    const capture = await storage.taskFileChanges.getByRuntime('runtime:1')
    assert.equal(capture?.workspacePath, '/workspace/one')
    assert.equal(capture?.baselineTreeSha, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    assert.equal(capture?.baselineCapturedAt, '2026-09-20T00:00:00.000Z')
  } finally {
    storage.close()
  }
})

test('finalize persists capture evidence and replaces the session projection atomically', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    await storage.taskFileChanges.putBaseline({
      runtimeSessionId: 'runtime:2',
      workspacePath: '/workspace/project',
      gitRootPath: '/workspace/project',
      baselineTreeSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      baselineCapturedAt: '2026-09-20T00:00:00.000Z',
    })

    const first = [
      change('session:2', 'src/a.ts', 'modified', 4, 1),
      change('session:2', 'src/new.ts', 'added', 8, 0),
    ]
    await storage.taskFileChanges.finalizeRuntime('runtime:2', {
      logicalSessionId: 'session:2',
      finalTreeSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      finalizedAt: '2026-09-20T00:03:00.000Z',
      changes: first,
    })

    assert.deepEqual(
      (await storage.taskFileChanges.listBySession('session:2')).map(item => [
        item.path,
        item.changeType,
        item.additions,
        item.deletions,
        item.confidence,
      ]),
      [
        ['src/a.ts', 'modified', 4, 1, 'exact'],
        ['src/new.ts', 'added', 8, 0, 'exact'],
      ],
    )

    const capture = await storage.taskFileChanges.getByRuntime('runtime:2')
    assert.equal(capture?.logicalSessionId, 'session:2')
    assert.equal(capture?.finalTreeSha, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    assert.equal(capture?.finalizedAt, '2026-09-20T00:03:00.000Z')
    assert.deepEqual(capture?.changes?.map(item => item.path), ['src/a.ts', 'src/new.ts'])
  } finally {
    storage.close()
  }
})

test('projection rebuild restores the latest finalized capture for a session', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    await storage.taskFileChanges.putBaseline({
      runtimeSessionId: 'runtime:old',
      workspacePath: '/workspace/project',
      baselineCapturedAt: '2026-09-20T00:00:00.000Z',
    })
    await storage.taskFileChanges.finalizeRuntime('runtime:old', {
      logicalSessionId: 'session:rebuild',
      finalizedAt: '2026-09-20T00:05:00.000Z',
      changes: [change('session:rebuild', 'old.ts', 'modified', 1, 0)],
    })

    await storage.taskFileChanges.putBaseline({
      runtimeSessionId: 'runtime:new',
      workspacePath: '/workspace/project',
      baselineCapturedAt: '2026-09-20T01:00:00.000Z',
    })
    await storage.taskFileChanges.finalizeRuntime('runtime:new', {
      logicalSessionId: 'session:rebuild',
      finalizedAt: '2026-09-20T01:05:00.000Z',
      changes: [change('session:rebuild', 'new.ts', 'added', 3, 0)],
    })

    storage.db.prepare(`
      DELETE FROM task_file_change_projection
      WHERE logical_session_id = 'session:rebuild'
    `).run()
    assert.deepEqual(await storage.taskFileChanges.listBySession('session:rebuild'), [])

    await storage.taskFileChanges.rebuild({ logicalSessionId: 'session:rebuild' })
    const rebuilt = await storage.taskFileChanges.listBySession('session:rebuild')
    assert.deepEqual(rebuilt.map(item => [item.path, item.changeType]), [
      ['new.ts', 'added'],
    ])

    await storage.taskFileChanges.rebuild({ logicalSessionId: 'session:rebuild' })
    assert.deepEqual(
      (await storage.taskFileChanges.listBySession('session:rebuild'))
        .map(item => [item.path, item.changeType]),
      [['new.ts', 'added']],
    )
  } finally {
    storage.close()
  }
})

test('binding a runtime rejects conflicting logical session identities', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    await storage.taskFileChanges.putBaseline({
      runtimeSessionId: 'runtime:bind',
      workspacePath: '/workspace/project',
      baselineCapturedAt: '2026-09-20T00:00:00.000Z',
    })
    await storage.taskFileChanges.bindRuntime('runtime:bind', 'session:one')
    await assert.rejects(
      () => storage.taskFileChanges.bindRuntime('runtime:bind', 'session:two'),
      /already bound/,
    )
  } finally {
    storage.close()
  }
})
