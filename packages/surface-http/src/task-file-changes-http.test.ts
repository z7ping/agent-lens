import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanonicalObservation, StorageService, TaskFileChangeRecord } from '@agent-lens/core'
import { backfillLegacySessionFileChanges, taskFileChangesResponse } from './task-file-changes-http'

test('session-level exact Git counts remain distinct from per-round observed changes', () => {
  const final = taskFileChangesResponse('session-1', [{
    logicalSessionId: 'session-1',
    path: 'src/a.ts',
    changeType: 'modified',
    additions: 7,
    deletions: 2,
    firstChangedAt: '2026-10-16T00:00:00Z',
    lastChangedAt: '2026-10-16T00:02:00Z',
    evidence: ['git'],
    confidence: 'exact',
  }], { workspacePath: '/repo', gitRootPath: '/repo' })
  assert.equal(final.summary.additions, 7)
  assert.equal(final.summary.deletions, 2)
  assert.equal(final.summary.exactCount, 1)

  const round = taskFileChangesResponse('session-1', [{
    logicalSessionId: 'session-1',
    path: 'src/a.ts',
    changeType: 'unknown',
    firstChangedAt: '2026-10-16T00:00:10Z',
    lastChangedAt: '2026-10-16T00:00:10Z',
    evidence: ['tool'],
    confidence: 'medium',
  }], null, { interactionId: 'turn-1', truncated: true })
  assert.equal(round.interactionId, 'turn-1')
  assert.equal(round.summary.additions, undefined)
  assert.equal(round.summary.deletions, undefined)
  assert.equal(round.summary.exactCount, 0)
  assert.equal(round.summary.observedCount, 1)
  assert.equal(round.meta.truncated, true)
})

function historicalObservation(id: string, kind: CanonicalObservation['kind'], payload: unknown): CanonicalObservation {
  return {
    id,
    hostId: 'host',
    installationId: 'install',
    logicalSessionId: 'legacy-session',
    sourceSessionId: 'legacy-source-session',
    kind,
    capturedAt: '2026-09-01T10:00:00.000Z',
    payload,
    evidenceRefs: [],
  }
}

function fakeLegacyStorage(observations: CanonicalObservation[]) {
  let queried = 0
  const persisted: TaskFileChangeRecord[][] = []
  const storage = {
    repositories: {
      observations: {
        async query(params: { after?: { id: string }; limit: number }) {
          queried += 1
          const first = params.after
            ? observations.findIndex(item => item.id === params.after?.id) + 1
            : 0
          return observations.slice(first, first + params.limit)
        },
      },
    },
    taskFileChanges: {
      async replaceObservedSession(_id: string, changes: TaskFileChangeRecord[]) {
        persisted.push(changes)
        return true
      },
    },
  } as unknown as StorageService
  return { storage, persisted, queryCount: () => queried }
}

test('legacy review session backfills only confirmed native tool writes and persists observed evidence', async () => {
  const { storage, persisted } = fakeLegacyStorage([
    historicalObservation('1', 'tool.call', { nativeToolName: 'write_file', callId: 'write', input: { path: 'src/a.ts' } }),
    historicalObservation('2', 'tool.result', { callId: 'write', status: 'success' }),
    historicalObservation('3', 'tool.call', { nativeToolName: 'bash', input: { command: 'echo > src/unsafe.ts' } }),
    historicalObservation('4', 'tool.call', { nativeToolName: 'write_file', callId: 'failed', input: { path: 'src/failed.ts' } }),
    historicalObservation('5', 'tool.result', { callId: 'failed', status: 'error' }),
  ])
  const result = await backfillLegacySessionFileChanges(storage, 'legacy-session')
  assert.equal(result.truncated, false)
  assert.deepEqual(result.items.map(item => item.path), ['src/a.ts'])
  assert.equal(result.items[0]?.changeType, 'unknown')
  assert.equal(result.items[0]?.confidence, 'medium')
  assert.equal(result.items[0]?.additions, undefined)
  assert.equal(persisted.length, 1)
  assert.deepEqual(persisted[0], result.items)
})

test('legacy session with no writes is negatively cached to avoid repeated full reads', async () => {
  const { storage, persisted, queryCount } = fakeLegacyStorage([
    historicalObservation('read', 'tool.call', { nativeToolName: 'read', input: { path: 'src/a.ts' } }),
  ])
  assert.deepEqual((await backfillLegacySessionFileChanges(storage, 'legacy-session')).items, [])
  const firstCount = queryCount()
  assert.deepEqual((await backfillLegacySessionFileChanges(storage, 'legacy-session')).items, [])
  assert.equal(queryCount(), firstCount)
  assert.equal(persisted.length, 0)
})

test('legacy replay limits scan size and never persists an incomplete reconstruction', async () => {
  const observations = Array.from({ length: 5_050 }, (_, index) =>
    historicalObservation(String(index).padStart(5, '0'), 'tool.call', {
      nativeToolName: 'shell',
      input: { command: 'touch src/a.ts' },
    }),
  )
  const { storage, persisted } = fakeLegacyStorage(observations)
  const result = await backfillLegacySessionFileChanges(storage, 'legacy-session')
  assert.equal(result.truncated, true)
  assert.equal(result.items.length, 0)
  assert.equal(persisted.length, 0)
})
