import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanonicalObservation, StorageService } from '@agent-lens/core'
import {
  canonicalHistoryCursor,
  canonicalPiLiveSnapshot,
  isCanonicalHistoryCursor,
} from './canonical-history'
import type { PiLiveRuntimeState } from './types'

function observation(
  id: string,
  kind: CanonicalObservation['kind'],
  at: string,
  payload: unknown,
): CanonicalObservation {
  return {
    id,
    hostId: 'host-1',
    installationId: 'install-1',
    logicalSessionId: 'logical-1',
    sourceSessionId: 'source-1',
    kind,
    occurredAt: at,
    capturedAt: at,
    payload,
    evidenceRefs: [],
  }
}

function storage(values: CanonicalObservation[]): StorageService {
  const ordered = [...values].sort((left, right) =>
    (left.occurredAt ?? left.capturedAt).localeCompare(right.occurredAt ?? right.capturedAt))
  const byId = new Map(ordered.map(item => [item.id, item]))

  return {
    repositories: {
      sessions: {
        listSourceSessionsByLogicalSession: async () => [{
          id: 'source-1',
          sourceId: 'pi',
        }],
      },
      observations: {
        get: async id => byId.get(id) ?? null,
        query: async query => {
          let items = ordered.filter(item => item.logicalSessionId === query.logicalSessionId)
          const afterId = query.after?.id
          const beforeId = query.before?.id
          if (afterId) {
            const index = items.findIndex(item => item.id === afterId)
            items = index >= 0 ? items.slice(index + 1) : []
          }
          if (beforeId) {
            const index = items.findIndex(item => item.id === beforeId)
            items = index >= 0 ? items.slice(0, index) : []
          }
          if (query.order === 'desc') items = [...items].reverse()
          return items.slice(0, query.limit ?? items.length)
        },
      },
    },
  } as unknown as StorageService
}

const state: PiLiveRuntimeState = {
  runtimeSessionId: 'runtime-1',
  logicalSessionId: 'logical-1',
  status: 'initializing',
  initializationStage: 'loading_sdk',
  isStreaming: false,
  isCompacting: false,
  pendingMessageCount: 0,
}

const observations = [
  observation('o1', 'message.user', '2026-09-19T01:00:00.000Z', { text: 'one' }),
  observation('o2', 'message.assistant', '2026-09-19T01:00:01.000Z', { text: 'answer one' }),
  observation('o3', 'message.user', '2026-09-19T01:00:02.000Z', { text: 'two' }),
  observation('o4', 'message.reasoning', '2026-09-19T01:00:03.000Z', { text: 'thinking' }),
  observation('o5', 'tool.call', '2026-09-19T01:00:04.000Z', {
    callId: 'call-1',
    nativeToolName: 'read',
    input: { path: 'README.md' },
  }),
  observation('o6', 'tool.result', '2026-09-19T01:00:05.000Z', {
    callId: 'call-1',
    nativeToolName: 'read',
    success: true,
    output: 'done',
  }),
  observation('o7', 'message.assistant', '2026-09-19T01:00:06.000Z', { text: 'answer two' }),
]

test('canonical history exposes a bounded latest window without Pi-native message action ids', async () => {
  const snapshot = await canonicalPiLiveSnapshot(storage(observations), state, 'logical-1', undefined, { limit: 3 })

  assert.equal(snapshot.state.status, 'initializing')
  assert.equal(snapshot.entries.length, 3)
  assert.equal(snapshot.page?.hasEarlier, true)
  assert.ok(isCanonicalHistoryCursor(snapshot.page?.before))
  assert.deepEqual(snapshot.entries.map(item => (item as Record<string, unknown>).id), [
    canonicalHistoryCursor('o5'),
    canonicalHistoryCursor('o6'),
    canonicalHistoryCursor('o7'),
  ])
  assert.ok(snapshot.entries.every(item => (item as Record<string, unknown>).type !== 'message'))
})

test('canonical history can page older and newer without Worker cursors', async () => {
  const store = storage(observations)
  const latest = await canonicalPiLiveSnapshot(store, state, 'logical-1', undefined, { limit: 3 })
  const older = await canonicalPiLiveSnapshot(store, state, 'logical-1', undefined, {
    before: latest.page?.before,
    limit: 3,
  })

  assert.deepEqual(older.entries.map(item => (item as Record<string, unknown>).id), [
    canonicalHistoryCursor('o2'),
    canonicalHistoryCursor('o3'),
    canonicalHistoryCursor('o4'),
  ])
  assert.equal(older.page?.hasEarlier, true)
  assert.equal(older.page?.hasLater, true)
  assert.ok(isCanonicalHistoryCursor(older.page?.after))

  const newer = await canonicalPiLiveSnapshot(store, state, 'logical-1', undefined, {
    after: older.page?.after,
    limit: 3,
  })
  assert.deepEqual(newer.entries.map(item => (item as Record<string, unknown>).id), [
    canonicalHistoryCursor('o5'),
    canonicalHistoryCursor('o6'),
    canonicalHistoryCursor('o7'),
  ])
})
