import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  AgentInstallation,
  CapturePolicyService,
  CoverageDeclaration,
  DetectedSource,
  Host,
  NormalizedSourceOutput,
  SourceDefinition,
  SourceRecord,
} from '@agent-lens/core'
import { SourceHistoryRunner } from './source-runner'

const host: Host = {
  id: 'host-1',
  name: 'test-host',
  platform: 'linux',
  arch: 'x64',
  createdAt: '2026-08-24T00:00:00.000Z',
  lastSeenAt: '2026-08-24T00:00:00.000Z',
}

const installation: AgentInstallation = {
  id: 'installation-1',
  hostId: host.id,
  productId: 'test-product',
  firstSeenAt: '2026-08-24T00:00:00.000Z',
  lastSeenAt: '2026-08-24T00:00:00.000Z',
}

const detected: DetectedSource = {
  sourceId: 'test-source',
  productId: 'test-product',
  confidence: 'exact',
}

function record(id: string, occurredAt: string): SourceRecord {
  return {
    id,
    sourceId: 'test-source',
    installationId: installation.id,
    nativeType: 'message',
    nativeId: id,
    occurredAt,
    capturedAt: occurredAt,
    locator: { kind: 'file', path: `/tmp/${id}.jsonl` },
    payload: { text: id },
    parserVersion: '1',
  }
}

function normalized(sourceRecord: SourceRecord): NormalizedSourceOutput {
  return {
    observations: [],
    evidenceCandidates: [{
      captureMethod: 'native-log',
      derivation: 'reported',
      sourceRecordId: sourceRecord.id,
      sourceLocator: sourceRecord.locator,
      ...(sourceRecord.nativeId ? { nativeStableId: sourceRecord.nativeId } : {}),
      ...(sourceRecord.occurredAt ? { eventTime: sourceRecord.occurredAt } : {}),
      capturedAt: sourceRecord.capturedAt,
      confidenceHint: 'exact',
    }],
  }
}

const capturePolicy = {
  sanitizeSourceRecord(value: SourceRecord) { return value },
  sanitizeNormalizedOutput(value: NormalizedSourceOutput) { return value },
} as unknown as CapturePolicyService

test('History Coverage 只覆盖 history 能力并引用首尾 Source Evidence', async () => {
  const first = record('first', '2026-08-24T01:00:00.000Z')
  const last = record('last', '2026-08-24T03:00:00.000Z')
  const declarations: CoverageDeclaration[] = []
  const persisted: string[] = []

  const source: SourceDefinition = {
    manifest: {
      pluginId: 'test-source-plugin',
      pluginVersion: '1.0.0',
      apiVersion: '1.0',
      pluginType: 'source',
      displayName: 'Test Source',
      sourceId: 'test-source',
      productId: 'test-product',
      parserVersion: '1',
    },
    async detect() { return [detected] },
    async declareCapabilities() {
      return [
        {
          sourceId: 'test-source',
          name: 'transcript',
          status: 'available',
          captureModes: ['history'],
        },
        {
          sourceId: 'test-source',
          name: 'permission',
          status: 'available',
          captureModes: ['runtime-hook'],
        },
        {
          sourceId: 'test-source',
          name: 'asset-discovery',
          status: 'available',
          captureModes: ['static-scan'],
        },
      ]
    },
    async *ingestHistory() {
      yield last
      yield first
    },
    async normalize(value) { return normalized(value) },
  }

  const runner = new SourceHistoryRunner(
    {
      repositories: {
        sourceRecords: { async put(value: SourceRecord) { persisted.push(value.id) } },
      },
      checkpoints: {
        async get() { return null },
        async set() {},
        async clear() {},
      },
    } as any,
    { async resolveInstallation() { return installation } } as any,
    { async commit() { throw new Error('No observations expected') } } as any,
    { registerSourceCapabilities() { return { dispose() {} } } } as any,
    {
      async declare(value: CoverageDeclaration) {
        declarations.push(value)
        return {} as any
      },
    } as any,
    capturePolicy,
  )

  const result = await runner.sync({
    source,
    host,
    detected,
    abortSignal: new AbortController().signal,
  })

  assert.equal(result.records, 2)
  assert.deepEqual(persisted, ['last', 'first'])
  assert.equal(declarations.length, 1)
  assert.equal(declarations[0]?.capability, 'transcript')
  assert.equal(declarations[0]?.from, first.occurredAt)
  assert.equal(declarations[0]?.to, last.occurredAt)
  assert.equal(declarations[0]?.status, 'complete')
  assert.deepEqual(
    declarations[0]?.evidenceCandidates?.map(item => item.sourceRecordId),
    ['first', 'last'],
  )
})
