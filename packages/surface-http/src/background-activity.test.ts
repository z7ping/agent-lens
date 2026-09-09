import assert from 'node:assert/strict'
import test from 'node:test'
import type { MaintenanceJob, StorageService } from '@agent-lens/core'
import { readBackgroundActivity } from './background-activity'

function maintenanceJob(overrides: Partial<MaintenanceJob> = {}): MaintenanceJob {
  return {
    id: 'parser-replay:recent',
    type: 'parser-replay',
    scope: 'recent',
    priority: 50,
    state: 'running',
    revision: 1,
    createdAt: '2026-09-09T10:00:00.000Z',
    updatedAt: '2026-09-09T10:01:00.000Z',
    startedAt: '2026-09-09T10:00:30.000Z',
    ...overrides,
  }
}

test('background activity combines source loading and maintenance jobs without exposing raw progress', async () => {
  const storage = {
    maintenanceJobs: {
      list: async () => [
        maintenanceJob(),
        maintenanceJob({
          id: 'source-record:compression',
          type: 'source-record-compression',
          scope: 'legacy-json',
          state: 'completed',
          progress: { cursor: 'private-internal-cursor', scanned: 120 },
          updatedAt: '2026-09-09T09:59:00.000Z',
          completedAt: '2026-09-09T09:59:00.000Z',
        }),
      ],
    },
    sourceRuntimeStatus: {
      list: async () => [{
        sourceId: 'pi',
        installationId: 'pi-local',
        stage: 'history' as const,
        state: 'running' as const,
        lastStartedAt: '2026-09-09T10:00:45.000Z',
        errorCount: 0,
      }],
    },
  } as unknown as StorageService

  const result = await readBackgroundActivity(storage)

  assert.deepEqual(result.active.map(item => [item.kind, item.sourceId]), [
    ['source-history', 'pi'],
    ['parser-replay', undefined],
  ])
  assert.equal(result.recent[0]?.kind, 'source-record-compression')
  assert.equal('progress' in result.recent[0]!, false)
})

test('background activity keeps recent failures ahead of older successful work', async () => {
  const storage = {
    maintenanceJobs: {
      list: async () => [
        maintenanceJob({
          id: 'projection:done',
          type: 'projection-rebuild',
          scope: 'session-summary',
          state: 'completed',
          updatedAt: '2026-09-09T09:00:00.000Z',
          completedAt: '2026-09-09T09:00:00.000Z',
        }),
      ],
    },
    sourceRuntimeStatus: {
      list: async () => [{
        sourceId: 'codex',
        installationId: 'codex-local',
        stage: 'assets' as const,
        state: 'failed' as const,
        lastStartedAt: '2026-09-09T10:00:00.000Z',
        lastErrorAt: '2026-09-09T10:02:00.000Z',
        lastErrorSummary: 'asset scan failed',
        errorCount: 1,
      }],
    },
  } as unknown as StorageService

  const result = await readBackgroundActivity(storage)

  assert.equal(result.active.length, 0)
  assert.equal(result.recent[0]?.state, 'failed')
  assert.equal(result.recent[0]?.kind, 'source-assets')
  assert.equal(result.recent[0]?.errorSummary, 'asset scan failed')
})

test('healthy long-lived runtime capture is not reported as a recently completed task', async () => {
  const storage = {
    maintenanceJobs: { list: async () => [] },
    sourceRuntimeStatus: {
      list: async () => [{
        sourceId: 'pi',
        installationId: 'pi-local',
        stage: 'runtime' as const,
        state: 'healthy' as const,
        lastStartedAt: '2026-09-09T10:00:00.000Z',
        lastSuccessAt: '2026-09-09T10:05:00.000Z',
        errorCount: 0,
      }],
    },
  } as unknown as StorageService

  const result = await readBackgroundActivity(storage)
  assert.deepEqual(result.active, [])
  assert.deepEqual(result.recent, [])
})
