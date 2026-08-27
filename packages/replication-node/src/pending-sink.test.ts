import assert from 'node:assert/strict'
import test from 'node:test'
import { generateWireEntity } from './entity-generator'
import { enqueueWireGraph, type PendingCandidateSink } from './pending-sink'

function wire(entityType: 'Host' | 'Project', originEntityId: string) {
  const result = generateWireEntity({
    nodeId: 'node-a',
    entityType,
    originEntityId,
    body: entityType === 'Host'
      ? {
          id: originEntityId,
          name: 'devbox',
          platform: 'linux',
          arch: 'x64',
          createdAt: '2026-08-01T00:00:00.000Z',
          lastSeenAt: '2026-08-28T00:00:00.000Z',
        }
      : {
          id: originEntityId,
          repositoryIdentity: 'git@github.com:z7ping/agent-lens.git',
          createdAt: '2026-08-01T00:00:00.000Z',
          lastSeenAt: '2026-08-28T00:00:00.000Z',
        },
    capturedAt: '2026-08-28T00:00:00.000Z',
    phase: 'bootstrap',
    policy: { mode: 'full', revision: 'policy-1' },
    history: { mode: 'include-existing', revision: 'history-1' },
  })
  assert.equal(result.kind, 'entity')
  if (result.kind !== 'entity') throw new Error('expected entity')
  return result.entity
}

test('pending sink preserves graph order and counts durable outcomes', async () => {
  const seen: string[] = []
  const sink: PendingCandidateSink = {
    enqueuePending: async candidate => {
      seen.push(candidate.entityType)
      if (candidate.entityType === 'Host') return { created: true, replaced: false }
      return { created: false, replaced: true }
    },
  }

  const result = await enqueueWireGraph({
    sink,
    streamId: 'stream-1',
    generationId: 'generation-1',
    phase: 'bootstrap',
    policyRevision: 'policy-1',
    historyRevision: 'history-1',
    entities: [wire('Host', 'host-1'), wire('Project', 'project-1')],
  })

  assert.deepEqual(seen, ['Host', 'Project'])
  assert.deepEqual(result, { total: 2, created: 1, replaced: 1, unchanged: 0 })
})

test('mid-graph sink failure stops later items and leaves retry to H5 idempotency', async () => {
  const seen: string[] = []
  const sink: PendingCandidateSink = {
    enqueuePending: async candidate => {
      seen.push(candidate.entityType)
      if (candidate.entityType === 'Project') throw new Error('disk failure')
      return { created: true, replaced: false }
    },
  }

  await assert.rejects(
    enqueueWireGraph({
      sink,
      streamId: 'stream-1',
      generationId: 'generation-1',
      phase: 'bootstrap',
      policyRevision: 'policy-1',
      historyRevision: 'history-1',
      entities: [wire('Host', 'host-1'), wire('Project', 'project-1'), wire('Host', 'host-2')],
    }),
    /disk failure/,
  )
  assert.deepEqual(seen, ['Host', 'Project'])
})
