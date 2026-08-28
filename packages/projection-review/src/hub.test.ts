import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  UnifiedCanonicalObservation,
  UnifiedLogicalSession,
  UnifiedLogicalSessionReader,
  UnifiedObservationReader,
} from '@agent-lens/core/replication'
import { HubReviewProjection } from './hub'

const session: UnifiedLogicalSession = {
  publicId: 'replica-session',
  entityType: 'LogicalSession',
  origin: {
    kind: 'remote',
    nodeId: 'node-a',
    entityId: 'session-1',
    generationId: 'gen-1',
  },
  body: {
    title: { state: 'redacted' },
  },
  references: {
    installation: { entityType: 'AgentInstallation', publicId: 'replica-installation' },
  },
}

const observations: UnifiedCanonicalObservation[] = [
  {
    publicId: 'replica-observation-1',
    entityType: 'CanonicalObservation',
    origin: {
      kind: 'remote',
      nodeId: 'node-a',
      entityId: 'observation-1',
      generationId: 'gen-1',
    },
    body: {
      kind: { state: 'value', value: 'message.user' },
      capturedAt: { state: 'value', value: '2026-08-28T00:00:00.000Z' },
      occurredAt: { state: 'null' },
      payload: { state: 'omitted', reason: 'policy' },
    },
    references: {
      logicalSession: { entityType: 'LogicalSession', publicId: 'replica-session' },
      sourceSession: { entityType: 'SourceSession', publicId: 'replica-source-session' },
    },
  },
  {
    publicId: 'replica-observation-2',
    entityType: 'CanonicalObservation',
    origin: {
      kind: 'remote',
      nodeId: 'node-a',
      entityId: 'observation-2',
      generationId: 'gen-1',
    },
    body: {
      kind: { state: 'value', value: 'message.assistant' },
      capturedAt: { state: 'value', value: '2026-08-28T00:00:01.000Z' },
      occurredAt: { state: 'value', value: '2026-08-28T00:00:01.000Z' },
      payload: { state: 'redacted' },
    },
    references: {
      logicalSession: { entityType: 'LogicalSession', publicId: 'replica-session' },
    },
  },
]

const sessions: UnifiedLogicalSessionReader = {
  async get(publicId) {
    return publicId === session.publicId ? session : undefined
  },
}

const observationReader: UnifiedObservationReader = {
  async queryForLogicalSession(publicId) {
    return publicId === session.publicId ? observations : []
  },
}

test('H9 Hub Review preserves omitted/redacted content instead of fabricating Local payload', async () => {
  const projection = new HubReviewProjection(sessions, observationReader)
  const detail = await projection.get('replica-session')

  assert.ok(detail)
  assert.equal(detail.logicalSessionId, 'replica-session')
  assert.deepEqual(detail.title, { state: 'redacted' })
  assert.deepEqual(detail.items[0]?.payload, { state: 'omitted', reason: 'policy' })
  assert.deepEqual(detail.items[1]?.payload, { state: 'redacted' })
  assert.notDeepEqual(detail.items[0]?.payload, { state: 'value', value: '' })
  assert.notDeepEqual(detail.items[0]?.payload, { state: 'value', value: {} })
})

test('H9 Hub Review preserves opaque public references and remote origin metadata', async () => {
  const projection = new HubReviewProjection(sessions, observationReader)
  const detail = await projection.get('replica-session')

  assert.deepEqual(detail?.origin, {
    kind: 'remote',
    nodeId: 'node-a',
    entityId: 'session-1',
    generationId: 'gen-1',
  })
  assert.deepEqual(detail?.items[0]?.references.logicalSession, {
    entityType: 'LogicalSession',
    publicId: 'replica-session',
  })
  assert.deepEqual(detail?.items[0]?.references.sourceSession, {
    entityType: 'SourceSession',
    publicId: 'replica-source-session',
  })
})
