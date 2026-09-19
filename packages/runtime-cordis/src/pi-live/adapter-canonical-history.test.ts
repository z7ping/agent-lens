import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  CanonicalObservation,
  LiveAttachmentService,
  StorageService,
} from '@agent-lens/core'
import { PiLiveAdapter } from './adapter'
import { canonicalHistoryCursor } from './canonical-history'
import type { PiLiveRuntimeState, PiLiveService } from './types'

function attachments(): LiveAttachmentService {
  return {
    put: async () => { throw new Error('not used') },
    get: async () => null,
    remove: async () => {},
    dispose: async () => {},
  }
}

function canonicalStorage(): StorageService {
  const item: CanonicalObservation = {
    id: 'observation-1',
    hostId: 'host-1',
    installationId: 'install-1',
    logicalSessionId: 'logical-1',
    sourceSessionId: 'source-1',
    kind: 'message.user',
    occurredAt: '2026-09-19T01:00:00.000Z',
    capturedAt: '2026-09-19T01:00:00.000Z',
    payload: { text: 'cached history' },
    evidenceRefs: [],
  }
  return {
    repositories: {
      sessions: {
        listSourceSessionsByLogicalSession: async () => [{ id: 'source-1', sourceId: 'pi' }],
      },
      observations: {
        get: async id => id === item.id ? item : null,
        query: async query => {
          if (query.after?.id === item.id || query.before?.id === item.id) return []
          return [item]
        },
      },
    },
  } as unknown as StorageService
}

function initializingState(): PiLiveRuntimeState {
  return {
    runtimeSessionId: 'runtime-1',
    logicalSessionId: 'logical-1',
    status: 'initializing',
    initializationStage: 'loading_sdk',
    isStreaming: false,
    isCompacting: false,
    pendingMessageCount: 0,
  }
}

test('Pi Live Adapter serves canonical history while Worker-backed Snapshot is still initializing', async () => {
  const state = initializingState()
  let nativeSnapshots = 0
  const service = {
    snapshot: async () => {
      nativeSnapshots += 1
      return { state, entries: [], leafId: null, page: { hasEarlier: false } }
    },
    state: async () => state,
  } as unknown as PiLiveService

  const adapter = new PiLiveAdapter(service, attachments(), canonicalStorage())
  const snapshot = await adapter.snapshot('runtime-1', undefined, { limit: 20 })

  assert.equal(nativeSnapshots, 1)
  assert.equal(snapshot.entries.length, 1)
  assert.equal((snapshot.entries[0] as Record<string, unknown>).id, canonicalHistoryCursor('observation-1'))
})

test('Pi Live Adapter returns official Pi Snapshot after Worker is ready', async () => {
  const state: PiLiveRuntimeState = {
    ...initializingState(),
    status: 'ready',
    initializationStage: 'ready',
  }
  let storageQueries = 0
  const service = {
    snapshot: async () => ({
      state,
      entries: [{ type: 'message', id: 'native-1', message: { role: 'user', content: 'native' } }],
      leafId: 'native-1',
      page: { hasEarlier: false },
    }),
    state: async () => state,
  } as unknown as PiLiveService
  const storage = canonicalStorage()
  const originalQuery = storage.repositories.observations.query
  storage.repositories.observations.query = async query => {
    storageQueries += 1
    return originalQuery(query)
  }

  const adapter = new PiLiveAdapter(service, attachments(), storage)
  const snapshot = await adapter.snapshot('runtime-1', undefined, { limit: 20 })

  assert.equal((snapshot.entries[0] as Record<string, unknown>).id, 'native-1')
  assert.equal(storageQueries, 0)
})

test('canonical pagination cursors stay on readonly history even after Worker becomes ready', async () => {
  const state: PiLiveRuntimeState = {
    ...initializingState(),
    status: 'ready',
    initializationStage: 'ready',
  }
  let nativeSnapshots = 0
  const service = {
    state: async () => state,
    snapshot: async () => {
      nativeSnapshots += 1
      throw new Error('canonical cursor must not reach Pi SessionManager')
    },
  } as unknown as PiLiveService

  const adapter = new PiLiveAdapter(service, attachments(), canonicalStorage())
  const snapshot = await adapter.snapshot('runtime-1', undefined, {
    before: canonicalHistoryCursor('observation-1'),
    limit: 20,
  })

  assert.equal(nativeSnapshots, 0)
  assert.deepEqual(snapshot.entries, [])
})
