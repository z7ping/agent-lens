import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  SourceDefinition,
} from '../contracts/source'
import type {
  SourceRawAuditCandidate,
  SourceService,
  StorageService,
} from './index'
import { auditSourceRawRecoveryBatch } from './source-raw-recovery-audit'

function candidate(
  id: string,
  sourceId: string,
  overrides: Partial<SourceRawAuditCandidate> = {},
): SourceRawAuditCandidate {
  return {
    record: {
      id,
      sourceId,
      installationId: 'installation-1',
      nativeType: 'history/message',
      capturedAt: '2026-09-16T00:00:00.000Z',
      locator: { kind: 'file', path: '/tmp/session.jsonl', offset: 0 },
      fingerprint: id + '-fingerprint',
      payload: { raw: true },
      parserVersion: '1',
    },
    canonicalStable: true,
    evidenceStable: true,
    pinned: false,
    ...overrides,
  }
}

function source(
  sourceId: string,
  state: 'verified' | 'drifted' | 'preserved',
): SourceDefinition {
  return {
    manifest: {
      pluginId: '@test/' + sourceId,
      pluginVersion: '1',
      apiVersion: '1.0',
      pluginType: 'source',
      displayName: sourceId,
      sourceId,
      productId: sourceId as never,
      parserVersion: '1',
    },
    detect: async () => [],
    declareCapabilities: async () => [],
    rawRecovery: {
      describe: () => state === 'preserved'
        ? {
            authority: 'agent-lens-only',
            locatorStability: 'none',
            mutability: 'ephemeral',
            verification: 'none',
            canReread: false,
            canReparse: false,
            replayable: false,
            persistencePreference: 'preserve',
          }
        : {
            authority: 'native-store',
            locatorStability: 'stable',
            mutability: 'append-oriented',
            verification: 'fingerprint',
            canReread: true,
            canReparse: true,
            replayable: true,
            persistencePreference: 'reference',
          },
      verify: async () => ({
        state: state === 'drifted' ? 'drifted' : 'verified',
        checkedAt: '2026-09-16T00:00:00.000Z',
      }),
    },
    normalize: async () => ({ observations: [], evidenceCandidates: [] }),
  }
}

test('Raw recovery audit 只把 verified + Canonical/Evidence 稳定记录判为 eligible', async () => {
  const items = [
    candidate('raw-verified', 'verified'),
    candidate('raw-drifted', 'drifted'),
    candidate('raw-preserved', 'preserved'),
    candidate('raw-evidence-only', 'verified', { canonicalStable: false }),
    candidate('raw-unknown-source', 'missing'),
  ]
  const sources = {
    list: () => [
      source('verified', 'verified'),
      source('drifted', 'drifted'),
      source('preserved', 'preserved'),
    ],
  } as Pick<SourceService, 'list'>
  const storage = {
    sourceRawAudit: {
      async list() {
        return { items, cursor: 'raw-unknown-source', hasMore: false }
      },
    },
  } as Pick<StorageService, 'sourceRawAudit'>

  const result = await auditSourceRawRecoveryBatch({ sources, storage, limit: 10 })
  assert.equal(result.summary.scanned, 5)
  assert.equal(result.summary.eligible, 1)
  assert.equal(result.summary.drifted, 1)
  assert.equal(result.summary.preserved, 1)
  assert.equal(result.summary.unknown, 1)

  assert.equal(
    result.items.find(item => item.recordId === 'raw-verified')?.decision.autoReclaimEligible,
    true,
  )
  assert.equal(
    result.items.find(item => item.recordId === 'raw-drifted')?.decision.autoReclaimEligible,
    false,
  )
  assert.ok(
    result.items.find(item => item.recordId === 'raw-evidence-only')
      ?.decision.reasons.includes('canonical-not-stable'),
  )
  assert.ok(
    result.items.find(item => item.recordId === 'raw-unknown-source')
      ?.decision.reasons.includes('recovery-capability-unknown'),
  )
})
