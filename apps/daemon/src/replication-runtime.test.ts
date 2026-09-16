import assert from 'node:assert/strict'
import test from 'node:test'
import type { DataRuntimeStorageService } from './data-runtime/storage-proxy.js'
import { runReplicationMaintenanceLoop } from './replication-runtime.js'

function fakeStorage(onReclaim: () => void): DataRuntimeStorageService {
  const empty = async () => null
  return {
    repositories: {
      hosts: { get: empty },
      installations: { get: empty, getProduct: empty },
      sessions: {
        getProject: empty,
        getWorkspace: empty,
        getLogicalSession: empty,
        getSourceSession: empty,
        getActor: empty,
      },
      sourceRecords: { get: empty },
      observations: { get: empty },
      evidence: { get: empty },
    },
    runtimeProfiles: { get: empty },
    replication: {},
    replicationRuntimeControl: {
      listRunnableStreams: async () => [],
    },
    replicationJournalLifecycle: {
      reclaimBatch: async () => {
        onReclaim()
        return {
          deletedChanges: 1,
          deletedThroughRevision: 1,
          highWaterRevision: 1,
          safeJournalRevision: 1,
        }
      },
    },
  } as unknown as DataRuntimeStorageService
}

test('daemon replication maintenance keeps destructive journal GC disabled by default', async () => {
  const controller = new AbortController()
  let reclaims = 0
  const storage = fakeStorage(() => { reclaims += 1 })

  const abort = setTimeout(() => controller.abort(), 10)
  try {
    await runReplicationMaintenanceLoop({
      storage,
      nodeId: 'node-1',
      replicationUpstream: false,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(abort)
  }

  assert.equal(reclaims, 0)
})

test('daemon replication maintenance only reclaims journal after explicit gate enablement', async () => {
  const controller = new AbortController()
  let reclaims = 0
  const storage = fakeStorage(() => {
    reclaims += 1
    controller.abort()
  })

  await runReplicationMaintenanceLoop({
    storage,
    nodeId: 'node-1',
    replicationUpstream: false,
    signal: controller.signal,
    journalGcEnabled: true,
  })

  assert.equal(reclaims, 1)
})
