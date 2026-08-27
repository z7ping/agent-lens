import assert from 'node:assert/strict'
import test from 'node:test'
import {
  REPLICATION_PROTOCOL,
  ReplicationProtocolError,
  assertEntityEnvelope,
  assertEntityVersionSupported,
  assertProtocolCompatible,
  assertWireEntityRef,
  canonicalHash,
  canonicalJson,
  computeBatchContentHash,
  computeEntityContentHash,
  evaluateSequence,
  sha256Hex,
  type ReplicationBatch,
  type WireEntityEnvelope,
} from './index'

function projectEntity(): WireEntityEnvelope {
  const base = {
    entityType: 'Project',
    scope: 'node' as const,
    originEntityId: 'project-local-1',
    entityVersion: 1,
    body: { name: 'AgentLens' },
    references: {
      product: { kind: 'shared' as const, entityType: 'AgentProduct' as const, sharedKey: 'shared-root-r1-abc' },
    },
    sharedIdentity: {
      identityAlgorithm: 'project-repository-v1',
      normalizedPortableIdentity: 'github.com/z7ping/agent-lens',
      claimedSharedKey: 'shared-group-r1-abc',
    },
  }
  return { ...base, contentHash: computeEntityContentHash(base) }
}

test('SHA-256 and canonical JSON are deterministic', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}')
  assert.equal(canonicalHash({ a: 1, b: 2 }), canonicalHash({ b: 2, a: 1 }))
})

test('protocol and entity versions fail closed', () => {
  assert.doesNotThrow(() => assertProtocolCompatible(REPLICATION_PROTOCOL))
  assert.throws(() => assertProtocolCompatible({ major: 2, minor: 0 }), (error: unknown) => error instanceof ReplicationProtocolError && error.code === 'PROTOCOL_VERSION_UNSUPPORTED')
  assert.throws(() => assertEntityVersionSupported('FutureEntity', 1), (error: unknown) => error instanceof ReplicationProtocolError && error.code === 'ENTITY_TYPE_UNSUPPORTED')
  assert.throws(() => assertEntityVersionSupported('Project', 2), (error: unknown) => error instanceof ReplicationProtocolError && error.code === 'ENTITY_VERSION_UNSUPPORTED')
})

test('Project and AssetDefinition stay node scoped on R1 wire', () => {
  const project = projectEntity()
  assert.doesNotThrow(() => assertEntityEnvelope(project))
  const invalidBase = { ...project, scope: 'shared' as const }
  const { contentHash: _old, ...withoutHash } = invalidBase
  const invalid = { ...withoutHash, contentHash: computeEntityContentHash(withoutHash) }
  assert.throws(() => assertEntityEnvelope(invalid), (error: unknown) => error instanceof ReplicationProtocolError && error.code === 'ENTITY_SCOPE_INVALID')
})

test('R1 shared refs target AgentProduct only', () => {
  assert.doesNotThrow(() => assertWireEntityRef({ kind: 'shared', entityType: 'AgentProduct', sharedKey: 'shared-root-r1-x' }))
  assert.throws(
    () => assertWireEntityRef({ kind: 'shared', entityType: 'Project' as 'AgentProduct', sharedKey: 'x' }),
    (error: unknown) => error instanceof ReplicationProtocolError && error.code === 'ENTITY_REFERENCE_INVALID',
  )
})

test('entity hash detects semantic mutation', () => {
  const entity = projectEntity()
  assert.doesNotThrow(() => assertEntityEnvelope(entity))
  const tampered = { ...entity, body: { name: 'Other' } }
  assert.throws(() => assertEntityEnvelope(tampered), (error: unknown) => error instanceof ReplicationProtocolError && error.code === 'ENTITY_HASH_MISMATCH')
})

test('sequence semantics distinguish next, retry, reuse conflict and gap', () => {
  assert.deepEqual(evaluateSequence({ ackSequence: 3, incomingSequence: 4, incomingHash: 'h4' }), { action: 'process' })
  assert.deepEqual(evaluateSequence({ ackSequence: 3, incomingSequence: 3, incomingHash: 'h3', committedHash: 'h3' }), { action: 'retry-ack' })
  assert.deepEqual(evaluateSequence({ ackSequence: 3, incomingSequence: 3, incomingHash: 'changed', committedHash: 'h3' }), { action: 'reject', errorCode: 'SEQUENCE_REUSE_CONFLICT' })
  assert.deepEqual(evaluateSequence({ ackSequence: 3, incomingSequence: 5, incomingHash: 'h5' }), { action: 'reject', errorCode: 'SEQUENCE_GAP' })
})

test('batch hash binds entity hashes and replication metadata', () => {
  const entity = projectEntity()
  const base: Omit<ReplicationBatch, 'contentHash'> = {
    protocol: REPLICATION_PROTOCOL,
    nodeId: 'node-a',
    hubId: 'hub-a',
    streamId: 'stream-a',
    generationId: 'gen-a',
    sequence: 1,
    batchId: 'batch-1',
    phase: 'bootstrap',
    policyRevision: 'policy-1',
    historyRevision: 'history-1',
    entities: [entity],
    identityPromotions: [],
  }
  const hash = computeBatchContentHash(base)
  assert.equal(hash, computeBatchContentHash({ ...base, entities: [entity] }))
  assert.notEqual(hash, computeBatchContentHash({ ...base, sequence: 2 }))
})
