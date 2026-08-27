import assert from 'node:assert/strict'
import test from 'node:test'
import {
  sharedRootKeyFor,
  type PendingReplicationEntity,
  type ReplicationStreamState,
} from '@agent-lens/core/replication'
import {
  computeEntityContentHash,
  type WireEntityEnvelope,
  type WireEntityRef,
} from '@agent-lens/protocol/replication'
import { buildReplicationBatch } from './batch-builder'

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

function pending(entity: WireEntityEnvelope, id: string): PendingReplicationEntity {
  return {
    id,
    streamId: 'stream-1',
    generationId: 'gen-1',
    dedupKey: `dedup-${id}`,
    entityType: entity.entityType as PendingReplicationEntity['entityType'],
    originEntityId: entity.originEntityId,
    candidateHash: entity.contentHash,
    phase: 'bootstrap',
    policyRevision: 'policy-1',
    historyRevision: 'history-1',
    payload: entity as never,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  }
}

const stream: ReplicationStreamState = {
  relationshipId: 'rel-1',
  hubId: 'hub-1',
  streamId: 'stream-1',
  generationId: 'gen-1',
  status: 'active',
  nextSequence: 1,
  ackSequence: 0,
  policyRevision: 'policy-1',
  historyRevision: 'history-1',
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
}

function graph(): PendingReplicationEntity[] {
  const product = entity({ entityType: 'AgentProduct', originEntityId: 'claude-code' })
  const installation = entity({
    entityType: 'AgentInstallation',
    originEntityId: 'installation-1',
    references: {
      product: {
        kind: 'shared',
        entityType: 'AgentProduct',
        sharedKey: sharedRootKeyFor('AgentProduct', 'claude-code'),
      },
    },
  })
  const observation = entity({
    entityType: 'CanonicalObservation',
    originEntityId: 'observation-1',
    references: {
      installation: {
        kind: 'node',
        entityType: 'AgentInstallation',
        originEntityId: 'installation-1',
      },
    },
  })
  return [
    pending(observation, 'pending-observation'),
    pending(installation, 'pending-installation'),
    pending(product, 'pending-product'),
  ]
}

test('batch builder topologically orders dependencies even when Pending order is reversed', () => {
  const built = buildReplicationBatch({
    nodeId: 'node-1',
    hubId: 'hub-1',
    stream,
    pending: graph(),
  })
  assert.ok(built)
  assert.deepEqual(
    built.batch.entities.map(item => `${item.entityType}:${item.originEntityId}`),
    [
      'AgentProduct:claude-code',
      'AgentInstallation:installation-1',
      'CanonicalObservation:observation-1',
    ],
  )
})

test('same Pending set produces the same batchId and contentHash regardless of input order', () => {
  const firstPending = graph()
  const first = buildReplicationBatch({ nodeId: 'node-1', hubId: 'hub-1', stream, pending: firstPending })
  const second = buildReplicationBatch({ nodeId: 'node-1', hubId: 'hub-1', stream, pending: [...firstPending].reverse() })
  assert.ok(first)
  assert.ok(second)
  assert.equal(second.batch.batchId, first.batch.batchId)
  assert.equal(second.batch.contentHash, first.batch.contentHash)
  assert.deepEqual(second.pendingItemIds, first.pendingItemIds)
})

test('dependency cycles fail closed before a batch can be frozen', () => {
  const a = entity({
    entityType: 'AgentInstallation',
    originEntityId: 'a',
    references: { other: { kind: 'node', entityType: 'AgentInstallation', originEntityId: 'b' } },
  })
  const b = entity({
    entityType: 'AgentInstallation',
    originEntityId: 'b',
    references: { other: { kind: 'node', entityType: 'AgentInstallation', originEntityId: 'a' } },
  })
  assert.throws(() => buildReplicationBatch({
    nodeId: 'node-1',
    hubId: 'hub-1',
    stream,
    pending: [pending(a, 'pending-a'), pending(b, 'pending-b')],
  }), /dependency cycle/)
})
