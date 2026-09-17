import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  IndependentReplicationRootSnapshot,
  IndependentReplicationRootSnapshotSource,
} from '@agent-lens/core/replication'
import type { CanonicalReplicationReader } from './canonical-dependency-graph'
import { generateIndependentRootReplicaGraph } from './independent-root-graph'

const NOW = '2026-09-17T02:00:00.000Z'

function dependencies(): CanonicalReplicationReader {
  return {
    getHost: async id => id === 'host-1'
      ? {
          id,
          name: 'host',
          platform: 'linux',
          arch: 'x64',
          createdAt: '2026-09-01T00:00:00.000Z',
          lastSeenAt: NOW,
        }
      : null,
    getInstallation: async id => id === 'install-1'
      ? {
          id,
          hostId: 'host-1',
          productId: 'product-1',
          firstSeenAt: '2026-09-01T00:00:00.000Z',
          lastSeenAt: NOW,
        }
      : null,
    getAgentProduct: async id => id === 'product-1'
      ? { id, name: 'Product' }
      : null,
    getProject: async () => null,
    getWorkspace: async () => null,
    getRuntimeProfile: async () => null,
    getLogicalSession: async () => null,
    getSourceSession: async () => null,
    getActor: async () => null,
    getEvidence: async () => null,
    getSourceRecord: async () => null,
  }
}

function roots(
  values: readonly IndependentReplicationRootSnapshot[],
): IndependentReplicationRootSnapshotSource {
  const map = new Map(values.map(value => [
    `${value.entityType}:\u0000${value.originEntityId}`,
    value,
  ]))
  return {
    async get(entityType, originEntityId) {
      return map.get(`${entityType}:\u0000${originEntityId}`) ?? null
    },
    async scan({ entityType, afterId = '', changedAtOnOrAfter, limit = 100 }) {
      const items = values
        .filter(value => value.entityType === entityType)
        .filter(value => value.originEntityId > afterId)
        .filter(value => !changedAtOnOrAfter || value.firstChangedAt >= changedAtOnOrAfter)
        .sort((a, b) => a.originEntityId.localeCompare(b.originEntityId))
        .slice(0, limit)
      return {
        items,
        ...(items.length ? { nextCursor: items.at(-1)!.originEntityId } : {}),
        done: items.length < limit,
      }
    },
  }
}

test('AssetBinding Root reuses Canonical dependency graph and AssetDefinition shared identity', async () => {
  const asset: IndependentReplicationRootSnapshot = {
    entityType: 'AssetDefinition',
    originEntityId: 'asset-1',
    firstRevision: 10,
    firstChangedAt: '2026-09-17T01:00:00.000Z',
    latestRevision: 10,
    latestChangedAt: '2026-09-17T01:00:00.000Z',
    historyCapturedAt: '2026-09-17T01:00:00.000Z',
    entity: {
      id: 'asset-1',
      type: 'skill',
      canonicalName: 'agent-skill',
      upstreamIdentity: 'npm:@acme/agent-skill',
    },
  }
  const binding: IndependentReplicationRootSnapshot = {
    entityType: 'AssetBinding',
    originEntityId: 'binding-1',
    firstRevision: 11,
    firstChangedAt: NOW,
    latestRevision: 11,
    latestChangedAt: NOW,
    historyCapturedAt: NOW,
    entity: {
      id: 'binding-1',
      assetId: 'asset-1',
      installationId: 'install-1',
      scope: 'user',
    },
  }

  const result = await generateIndependentRootReplicaGraph({
    nodeId: '11111111-1111-4111-8111-111111111111',
    dependencies: dependencies(),
    roots: roots([asset, binding]),
    root: binding,
    phase: 'bootstrap',
    policy: { mode: 'full', revision: 'policy-1' },
    history: { mode: 'include-existing', revision: 'history-1' },
  })
  assert.equal(result.kind, 'graph')
  if (result.kind !== 'graph') return

  assert.deepEqual(
    result.entities.map(entity => entity.entityType),
    [
      'AssetDefinition',
      'Host',
      'AgentProduct',
      'AgentInstallation',
      'AssetBinding',
    ],
  )
  const assetWire = result.entities.find(entity => entity.entityType === 'AssetDefinition')
  assert.equal(assetWire?.sharedIdentity?.identityAlgorithm, 'asset-upstream-v1')
  assert.equal(result.entities.at(-1)?.originEntityId, 'binding-1')
})

test('Current-State Root from-now authorization uses first history time even after later updates', async () => {
  const coverage: IndependentReplicationRootSnapshot = {
    entityType: 'Coverage',
    originEntityId: 'coverage-old',
    firstRevision: 7,
    firstChangedAt: '2026-09-17T00:00:00.000Z',
    latestRevision: 9,
    latestChangedAt: '2026-09-17T02:00:00.000Z',
    historyCapturedAt: '2026-09-17T00:00:00.000Z',
    entity: {
      id: 'coverage-old',
      subjectType: 'host',
      subjectId: 'host-1',
      capability: 'history',
      status: 'complete',
      evidenceRefs: [],
    },
  }

  const result = await generateIndependentRootReplicaGraph({
    nodeId: '11111111-1111-4111-8111-111111111111',
    dependencies: dependencies(),
    roots: roots([coverage]),
    root: coverage,
    phase: 'bootstrap',
    policy: { mode: 'full', revision: 'policy-1' },
    history: {
      mode: 'from-now',
      revision: 'history-1',
      boundaryCapturedAt: '2026-09-17T01:00:00.000Z',
    },
  })
  assert.deepEqual(result, { kind: 'blocked', reason: 'history-boundary' })
})
