import assert from 'node:assert/strict'
import test from 'node:test'
import {
  sharedRootKeyFor,
  type FrozenReplicationBatch,
  type PendingReplicationEntity,
  type ReplicationStreamState,
} from '@agent-lens/core/replication'
import {
  computeEntityContentHash,
  type WireEntityEnvelope,
  type WireEntityRef,
} from '@agent-lens/protocol/replication'
import {
  freezeNextReplicationBatch,
  type BatchFreezeStore,
  type PendingDependencyLookup,
} from './batch-builder'

function entity(input: {
  entityType: 'AgentProduct' | 'AgentInstallation' | 'CanonicalObservation'
  originEntityId: string
  references?: Record<string, WireEntityRef>
}): WireEntityEnvelope {
  const base: Omit<WireEntityEnvelope, 'contentHash'> = {
    entityType: input.entityType,
    scope: input.entityType === 'AgentProduct' ? 'shared' : 'node',
    originEntityId: input.originEntityId,
    entityVersion: 1,
    body: {},
    ...(input.references ? { references: input.references } : {}),
  }
  return { ...base, contentHash: computeEntityContentHash(base) }
}

function pending(wire: WireEntityEnvelope, id: string): PendingReplicationEntity {
  return {
    id,
    streamId: 'stream-1',
    generationId: 'gen-1',
    dedupKey: `dedup-${id}`,
    entityType: wire.entityType as PendingReplicationEntity['entityType'],
    originEntityId: wire.originEntityId,
    candidateHash: wire.contentHash,
    phase: 'bootstrap',
    policyRevision: 'policy-1',
    historyRevision: 'history-1',
    payload: wire as never,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  }
}

const stream: ReplicationStreamState = {
  relationshipId: 'rel-1', hubId: 'hub-1', streamId: 'stream-1', generationId: 'gen-1',
  status: 'active', nextSequence: 1, ackSequence: 0,
  policyRevision: 'policy-1', historyRevision: 'history-1',
  createdAt: '2026-08-28T00:00:00.000Z', updatedAt: '2026-08-28T00:00:00.000Z',
}

const productWire = entity({ entityType: 'AgentProduct', originEntityId: 'claude-code' })
const installationWire = entity({
  entityType: 'AgentInstallation', originEntityId: 'installation-1',
  references: {
    product: {
      kind: 'shared', entityType: 'AgentProduct',
      sharedKey: sharedRootKeyFor('AgentProduct', 'claude-code'),
    },
  },
})
const observationWire = entity({
  entityType: 'CanonicalObservation', originEntityId: 'observation-1',
  references: {
    installation: { kind: 'node', entityType: 'AgentInstallation', originEntityId: 'installation-1' },
  },
})
const productPending = pending(productWire, 'pending-product')
const installationPending = pending(installationWire, 'pending-installation')
const observationPending = pending(observationWire, 'pending-observation')

test('freezer pulls open dependencies outside the initial Pending page before freezing', async () => {
  let frozenInput: Parameters<BatchFreezeStore['freezeBatch']>[0] | undefined
  const store: BatchFreezeStore = {
    getStream: async () => stream,
    listPending: async () => [observationPending],
    freezeBatch: async input => {
      frozenInput = input
      return {
        streamId: input.streamId,
        generationId: input.generationId,
        sequence: input.sequence,
        batchId: input.batchId,
        contentHash: input.contentHash,
        phase: input.phase,
        policyRevision: input.policyRevision,
        historyRevision: input.historyRevision,
        payload: input.payload,
        status: 'frozen',
        frozenAt: '2026-08-28T00:01:00.000Z',
        pendingItemIds: input.pendingItemIds,
      } satisfies FrozenReplicationBatch
    },
  }
  const dependencies: PendingDependencyLookup = {
    findOpen: async input =>
      input.entityType === 'AgentInstallation' && input.originEntityId === 'installation-1'
        ? installationPending
        : undefined,
    findOpenAgentProductSharedRoot: async input =>
      input.sharedKey === sharedRootKeyFor('AgentProduct', 'claude-code')
        ? productPending
        : undefined,
  }

  const frozen = await freezeNextReplicationBatch({
    store, dependencies, nodeId: 'node-1', hubId: 'hub-1', streamId: 'stream-1', scanLimit: 1,
  })

  assert.ok(frozen)
  assert.deepEqual(frozenInput?.pendingItemIds, [
    'pending-product',
    'pending-installation',
    'pending-observation',
  ])
  const batch = frozen.payload as unknown as { entities: Array<{ entityType: string; originEntityId: string }> }
  assert.deepEqual(batch.entities.map(item => `${item.entityType}:${item.originEntityId}`), [
    'AgentProduct:claude-code',
    'AgentInstallation:installation-1',
    'CanonicalObservation:observation-1',
  ])
})

test('freezer rejects an open dependency under a different policy/history group', async () => {
  const mismatched = { ...installationPending, policyRevision: 'policy-2' }
  const store: BatchFreezeStore = {
    getStream: async () => stream,
    listPending: async () => [observationPending],
    freezeBatch: async () => { throw new Error('must not freeze') },
  }
  const dependencies: PendingDependencyLookup = {
    findOpen: async () => mismatched,
    findOpenAgentProductSharedRoot: async () => undefined,
  }

  await assert.rejects(freezeNextReplicationBatch({
    store, dependencies, nodeId: 'node-1', hubId: 'hub-1', streamId: 'stream-1', scanLimit: 1,
  }), /different replication batch group/)
})
