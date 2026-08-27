import assert from 'node:assert/strict'
import test from 'node:test'
import { generateWireEntity } from './entity-generator'
import {
  pendingCandidateForWireEntity,
  pendingCandidatesForWireGraph,
} from './pending-candidate'

function entity(name = 'devbox') {
  const result = generateWireEntity({
    nodeId: 'node-a',
    entityType: 'Host',
    originEntityId: 'host-1',
    body: {
      id: 'host-1',
      name,
      platform: 'linux',
      arch: 'x64',
      createdAt: '2026-08-01T00:00:00.000Z',
      lastSeenAt: '2026-08-28T00:00:00.000Z',
    },
    capturedAt: '2026-08-01T00:00:00.000Z',
    phase: 'incremental',
    policy: { mode: 'full', revision: 'policy-1' },
    history: { mode: 'include-existing', revision: 'history-1' },
  })
  assert.equal(result.kind, 'entity')
  if (result.kind !== 'entity') throw new Error('expected entity')
  return result.entity
}

test('same wire entity maps to the same durable pending identity', () => {
  const wire = entity()
  const first = pendingCandidateForWireEntity({
    streamId: 'stream-1',
    generationId: 'generation-1',
    phase: 'incremental',
    policyRevision: 'policy-1',
    historyRevision: 'history-1',
    entity: wire,
  })
  const second = pendingCandidateForWireEntity({
    streamId: 'stream-1',
    generationId: 'generation-1',
    phase: 'incremental',
    policyRevision: 'policy-1',
    historyRevision: 'history-1',
    entity: wire,
  })
  assert.deepEqual(first, second)
  assert.equal(first.candidateHash, wire.contentHash)
  assert.deepEqual(first.payload, wire)
})

test('content change preserves dedup key but changes pending id and candidate hash', () => {
  const before = pendingCandidateForWireEntity({
    streamId: 'stream-1',
    generationId: 'generation-1',
    phase: 'incremental',
    policyRevision: 'policy-1',
    historyRevision: 'history-1',
    entity: entity('before'),
  })
  const after = pendingCandidateForWireEntity({
    streamId: 'stream-1',
    generationId: 'generation-1',
    phase: 'incremental',
    policyRevision: 'policy-1',
    historyRevision: 'history-1',
    entity: entity('after'),
  })
  assert.equal(before.dedupKey, after.dedupKey)
  assert.notEqual(before.candidateHash, after.candidateHash)
  assert.notEqual(before.id, after.id)
})

test('stream or generation change isolates pending identity without changing entity dedup identity', () => {
  const wire = entity()
  const first = pendingCandidateForWireEntity({
    streamId: 'stream-1',
    generationId: 'generation-1',
    phase: 'bootstrap',
    policyRevision: 'policy-1',
    historyRevision: 'history-1',
    entity: wire,
  })
  const second = pendingCandidateForWireEntity({
    streamId: 'stream-2',
    generationId: 'generation-2',
    phase: 'bootstrap',
    policyRevision: 'policy-1',
    historyRevision: 'history-1',
    entity: wire,
  })
  assert.equal(first.dedupKey, second.dedupKey)
  assert.notEqual(first.id, second.id)
})

test('graph mapping preserves dependency-first entity order', () => {
  const host = entity()
  const projectResult = generateWireEntity({
    nodeId: 'node-a',
    entityType: 'Project',
    originEntityId: 'project-1',
    body: {
      id: 'project-1',
      repositoryIdentity: 'git@github.com:z7ping/agent-lens.git',
      createdAt: '2026-08-01T00:00:00.000Z',
      lastSeenAt: '2026-08-28T00:00:00.000Z',
    },
    capturedAt: '2026-08-01T00:00:00.000Z',
    phase: 'bootstrap',
    policy: { mode: 'full', revision: 'policy-1' },
    history: { mode: 'include-existing', revision: 'history-1' },
  })
  assert.equal(projectResult.kind, 'entity')
  if (projectResult.kind !== 'entity') throw new Error('expected project entity')

  const candidates = pendingCandidatesForWireGraph({
    streamId: 'stream-1',
    generationId: 'generation-1',
    phase: 'bootstrap',
    policyRevision: 'policy-1',
    historyRevision: 'history-1',
    entities: [host, projectResult.entity],
  })
  assert.deepEqual(candidates.map(item => item.entityType), ['Host', 'Project'])
})
