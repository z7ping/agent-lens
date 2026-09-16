import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  SourceDefinition,
  SourceService,
  StorageService,
} from '@agent-lens/core'
import { startHttpSurface } from './server'

const definition: SourceDefinition = {
  manifest: {
    pluginId: '@test/source',
    pluginVersion: '1',
    apiVersion: '1.0',
    pluginType: 'source',
    displayName: 'Test Source',
    sourceId: 'test',
    productId: 'test' as never,
    parserVersion: '1',
  },
  detect: async () => [],
  declareCapabilities: async () => [],
  rawRecovery: {
    describe: () => ({
      authority: 'native-store',
      locatorStability: 'stable',
      mutability: 'append-oriented',
      verification: 'fingerprint',
      canReread: true,
      canReparse: true,
      replayable: true,
      persistencePreference: 'reference',
    }),
    verify: async () => ({
      state: 'verified',
      checkedAt: '2026-09-16T00:00:00.000Z',
      currentFingerprint: 'fingerprint',
    }),
  },
  normalize: async () => ({ observations: [], evidenceCandidates: [] }),
}

test('GET source raw recovery audit 返回结构化 dry-run 结果', async () => {
  const storage = {
    sourceRawAudit: {
      async list() {
        return {
          items: [{
            record: {
              id: 'raw-1',
              sourceId: 'test',
              installationId: 'installation-1',
              nativeType: 'history/message',
              capturedAt: '2026-09-16T00:00:00.000Z',
              locator: { kind: 'file', path: '/tmp/session.jsonl', offset: 0 },
              fingerprint: 'fingerprint',
              payload: { raw: true },
              parserVersion: '1',
            },
            canonicalStable: true,
            evidenceStable: true,
            pinned: false,
          }],
          cursor: 'raw-1',
          hasMore: false,
        }
      },
    },
    async health() {
      return { ok: true }
    },
  } as unknown as StorageService
  const sources = {
    list: () => [definition],
  } as Pick<SourceService, 'list'> as SourceService

  const surface = await startHttpSurface(storage, { port: 0, sources })
  try {
    const response = await fetch(
      `http://${surface.host}:${surface.port}/api/v1/storage/source-raw-recovery-audit?limit=10`,
    )
    assert.equal(response.status, 200)
    const body = await response.json() as {
      summary: { scanned: number, eligible: number }
      items: Array<{
        recordId: string
        recovery: { state: string }
        decision: { autoReclaimEligible: boolean }
      }>
    }
    assert.equal(body.summary.scanned, 1)
    assert.equal(body.summary.eligible, 1)
    assert.equal(body.items[0]?.recordId, 'raw-1')
    assert.equal(body.items[0]?.recovery.state, 'verified')
    assert.equal(body.items[0]?.decision.autoReclaimEligible, true)
  } finally {
    await surface.dispose()
  }
})

test('Raw recovery audit 能力缺失时返回 501，而不是空审计结果', async () => {
  const storage = {
    async health() {
      return { ok: true }
    },
  } as unknown as StorageService
  const surface = await startHttpSurface(storage, { port: 0 })
  try {
    const response = await fetch(
      `http://${surface.host}:${surface.port}/api/v1/storage/source-raw-recovery-audit`,
    )
    assert.equal(response.status, 501)
    assert.deepEqual(await response.json(), {
      error: 'source_raw_recovery_audit_unavailable',
    })
  } finally {
    await surface.dispose()
  }
})
