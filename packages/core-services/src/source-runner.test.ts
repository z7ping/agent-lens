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
import { SourceHistoryRunner, sourceRunnerInternals } from './source-runner'

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

test('后台来源处理达到时间预算后主动让出事件循环', async () => {
  let currentTime = 0
  let yields = 0
  const schedule = sourceRunnerInternals.createCooperativeScheduler({
    budgetMs: 8,
    now: () => currentTime,
    yieldControl: async () => { yields += 1 },
  })

  assert.equal(await schedule(), false)
  currentTime = 8
  assert.equal(await schedule(), true)
  currentTime = 15
  assert.equal(await schedule(), false)
  currentTime = 16
  assert.equal(await schedule(), true)
  assert.equal(yields, 2)
})

test('History Coverage 只覆盖 history 能力并引用首尾 Source Evidence', async () => {
  const first = record('first', '2026-08-24T01:00:00.000Z')
  const last = record('last', '2026-08-24T03:00:00.000Z')
  const declarations: CoverageDeclaration[] = []
  const persisted: string[] = []
  let receivedActiveSince: string | undefined

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
    async *ingestHistory(ctx) {
      receivedActiveSince = ctx.historyWindow?.activeSince
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
      async transaction(operation: () => Promise<unknown>) { return operation() },
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
    historyWindow: { activeSince: '2026-08-18T00:00:00.000Z' },
  })

  assert.equal(result.records, 2)
  assert.equal(receivedActiveSince, '2026-08-18T00:00:00.000Z')
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

test('渐进历史窗口把 parser replay 限定到同一批 Session', async () => {
  let replayReads = 0
  let replayWindow: unknown
  const source: SourceDefinition = {
    manifest: {
      pluginId: 'test-source-plugin',
      pluginVersion: '1.0.0',
      apiVersion: '1.0',
      pluginType: 'source',
      displayName: 'Test Source',
      sourceId: 'test-source',
      productId: 'test-product',
      parserVersion: '2',
    },
    async detect() { return [detected] },
    async declareCapabilities() { return [] },
    async *ingestHistory() {},
    async normalize(value) { return normalized(value) },
  }
  const runner = new SourceHistoryRunner(
    {
      repositories: {
        sourceRecords: {
          async put() {},
          async listForParserReplay(...args: any[]) {
            replayReads += 1
            replayWindow = args[5]
            return []
          },
        },
      },
      async transaction(operation: () => Promise<unknown>) { return operation() },
      checkpoints: { async get() { return null }, async set() {}, async clear() {} },
    } as any,
    { async resolveInstallation() { return installation } } as any,
    { async commit() { throw new Error('No observations expected') } } as any,
    { registerSourceCapabilities() { return { dispose() {} } } } as any,
    { async declare() { return {} as any } } as any,
    capturePolicy,
  )

  await runner.sync({
    source,
    host,
    detected,
    abortSignal: new AbortController().signal,
    historyWindow: { sessionLimit: 1 },
  })

  assert.equal(replayReads, 1)
  assert.deepEqual(replayWindow, { sessionLimit: 1 })
})

test('独立 parser replay 只重放持久化记录且可覆盖全部历史', async () => {
  const staleRecords = Array.from({ length: 51 }, (_, index) => ({
    ...record(`stale-${index}`, `2026-08-20T00:${String(index).padStart(2, '0')}:00.000Z`),
    parserVersion: '1',
  }))
  let ingestReads = 0
  let replayWindow: unknown = 'unset'
  const persistedVersions: string[] = []
  let transactionDepth = 0
  let replayTransactions = 0
  const source: SourceDefinition = {
    manifest: {
      pluginId: 'test-source-plugin',
      pluginVersion: '1.0.0',
      apiVersion: '1.0',
      pluginType: 'source',
      displayName: 'Test Source',
      sourceId: 'test-source',
      productId: 'test-product',
      parserVersion: '2',
    },
    async detect() { return [detected] },
    async declareCapabilities() { return [] },
    async *ingestHistory() { ingestReads += 1 },
    async normalize(value) { return normalized(value) },
  }
  const runner = new SourceHistoryRunner(
    {
      repositories: {
        sourceRecords: {
          async put(value: SourceRecord) { persistedVersions.push(value.parserVersion) },
          async listForParserReplay(...args: any[]) {
            replayWindow = args[5]
            return args[3] ? [] : staleRecords
          },
        },
      },
      async transaction(operation: () => Promise<unknown>) {
        if (transactionDepth === 0) replayTransactions += 1
        transactionDepth += 1
        try {
          return await operation()
        } finally {
          transactionDepth -= 1
        }
      },
      checkpoints: { async get() { return null }, async set() {}, async clear() {} },
    } as any,
    { async resolveInstallation() { return installation } } as any,
    { async commit() { throw new Error('No observations expected') } } as any,
    { registerSourceCapabilities() { return { dispose() {} } } } as any,
    { async declare() { return {} as any } } as any,
    capturePolicy,
  )

  const result = await runner.replay({
    source,
    host,
    detected,
    abortSignal: new AbortController().signal,
  })

  assert.equal(result.records, 51)
  assert.equal(ingestReads, 0)
  assert.equal(replayWindow, undefined)
  assert.equal(replayTransactions, 2)
  assert.deepEqual(new Set(persistedVersions), new Set(['2']))
  assert.equal(persistedVersions.length, 51)
})
