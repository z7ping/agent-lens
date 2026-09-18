import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  AgentInstallation,
  CapabilityService,
  CapturePolicyService,
  CoverageDeclaration,
  CoverageService,
  DetectedSource,
  Host,
  IdentityService,
  NormalizedSourceOutput,
  ObservationService,
  SourceDefinition,
  SourceRecord,
  SourceRecordReplayCursor,
  SourceHistoryWindow,
  StorageService,
} from '@agent-lens/core'
import { SourceAssetRunner, SourceHistoryRunner, sourceRunnerInternals } from './source-runner'

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

test('Asset Runner persists structured package identity and only marks coverage after a successful scan', async () => {
  const bindingInputs: Array<Record<string, unknown>> = []
  const runtimeStatuses: Array<Record<string, unknown>> = []
  const source: SourceDefinition = {
    manifest: {
      pluginId: 'test-assets-plugin',
      pluginVersion: '1.0.0',
      apiVersion: '1.0',
      pluginType: 'source',
      displayName: 'Test Assets',
      sourceId: 'test-source',
      productId: 'test-product',
      parserVersion: '1',
    },
    async detect() { return [detected] },
    async declareCapabilities() { return [] },
    async *discoverAssets() {
      yield {
        definition: { type: 'skill', canonicalName: 'reviewer' },
        binding: {
          source: 'opaque-native-source',
          packageIdentity: 'npm:@example/pi-tools',
          version: '2.1.0',
        },
        states: [],
      }
    },
    async describeAssetDiscoveryCoverage() {
      return { packageIdentity: 'complete' }
    },
    async normalize(value) { return normalized(value) },
  }

  const runner = new SourceAssetRunner(
    {
      sourceRuntimeStatus: {
        async put(status: Record<string, unknown>) { runtimeStatuses.push(structuredClone(status)) },
      },
      checkpoints: {
        async get() { return null },
        async set() {},
        async clear() {},
      },
    } as unknown as StorageService,
    { async resolveInstallation() { return installation } } as unknown as IdentityService,
    { registerSourceCapabilities() { return { dispose() {} } } } as unknown as CapabilityService,
    {
      async resolveDefinition(input: Record<string, unknown>) {
        return { id: 'asset:reviewer', ...input }
      },
      async resolveBinding(input: Record<string, unknown>) {
        bindingInputs.push(structuredClone(input))
        return { id: 'binding:reviewer', ...input }
      },
      async recordState() { throw new Error('No states expected') },
    } as any,
    { async create() { throw new Error('No evidence expected') } } as any,
    {
      isEnabled() { return true },
      sanitizeDiscoveredAsset(value: unknown) { return value },
    } as unknown as CapturePolicyService,
  )

  await runner.scan({
    source,
    host,
    detected,
    abortSignal: new AbortController().signal,
  })

  assert.equal(bindingInputs[0]?.packageIdentity, 'npm:@example/pi-tools')
  assert.equal(bindingInputs[0]?.source, 'opaque-native-source')
  assert.equal(runtimeStatuses.at(-1)?.state, 'healthy')
  assert.equal(runtimeStatuses.at(-1)?.packageIdentityCoverage, 'complete')
})

test('History Coverage 只覆盖 history 能力并引用首尾 Source Evidence', async () => {
  const first = record('first', '2026-08-24T01:00:00.000Z')
  const last = record('last', '2026-08-24T03:00:00.000Z')
  const declarations: CoverageDeclaration[] = []
  const persisted: string[] = []
  let receivedActiveSince: string | undefined
  let cooperateCalls = 0

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
    } as unknown as StorageService,
    { async resolveInstallation() { return installation } } as unknown as IdentityService,
    { async commit() { throw new Error('No observations expected') } } as unknown as ObservationService,
    { registerSourceCapabilities() { return { dispose() {} } } } as unknown as CapabilityService,
    {
      async declare(value: CoverageDeclaration) {
        declarations.push(value)
        return {}
      },
    } as unknown as CoverageService,
    capturePolicy,
  )

  const result = await runner.sync({
    source,
    host,
    detected,
    abortSignal: new AbortController().signal,
    historyWindow: { activeSince: '2026-08-18T00:00:00.000Z' },
    cooperate: async () => { cooperateCalls += 1 },
  })

  assert.equal(result.records, 2)
  assert.equal(cooperateCalls, 2)
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

test('普通历史同步不再隐式触发 parser replay', async () => {
  let replayReads = 0
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
          async listForParserReplay() {
            replayReads += 1
            return []
          },
        },
      },
      async transaction(operation: () => Promise<unknown>) { return operation() },
      checkpoints: { async get() { return null }, async set() {}, async clear() {} },
    } as unknown as StorageService,
    { async resolveInstallation() { return installation } } as unknown as IdentityService,
    { async commit() { throw new Error('No observations expected') } } as unknown as ObservationService,
    { registerSourceCapabilities() { return { dispose() {} } } } as unknown as CapabilityService,
    { async declare() { return {} } } as unknown as CoverageService,
    capturePolicy,
  )

  await runner.sync({
    source,
    host,
    detected,
    abortSignal: new AbortController().signal,
    historyWindow: { sessionLimit: 1 },
  })

  assert.equal(replayReads, 0)
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
  let checkpoint: unknown
  let checkpointRevision = 0
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
          async listForParserReplay(
            _sourceId: string,
            _installationId: string,
            _targetParserVersion: string,
            after: SourceRecordReplayCursor | undefined,
            _limit: number,
            window: SourceHistoryWindow | undefined,
          ) {
            replayWindow = window
            return after ? [] : staleRecords
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
      checkpoints: {
        async get<T>() { return (checkpoint as T | undefined) ?? null },
        async getWithRevision<T>() {
          return checkpoint === undefined ? null : { value: checkpoint as T, revision: checkpointRevision }
        },
        async compareAndSet<T>(_scope: string, _key: string, expectedRevision: number | null, value: T) {
          if ((checkpoint === undefined ? null : checkpointRevision) !== expectedRevision) return false
          checkpoint = structuredClone(value)
          checkpointRevision += 1
          return true
        },
        async set<T>(_scope: string, _key: string, value: T) {
          checkpoint = structuredClone(value)
          checkpointRevision += 1
        },
        async clear() { checkpoint = undefined },
      },
    } as unknown as StorageService,
    { async resolveInstallation() { return installation } } as unknown as IdentityService,
    { async commit() { throw new Error('No observations expected') } } as unknown as ObservationService,
    { registerSourceCapabilities() { return { dispose() {} } } } as unknown as CapabilityService,
    { async declare() { return {} } } as unknown as CoverageService,
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


test('profiled source runners preserve installation root and isolate checkpoints by RuntimeProfile', async () => {
  const installationHints: Array<Record<string, unknown>> = []
  const profileHints: Array<Record<string, unknown>> = []
  const checkpointScopes: string[] = []
  const profiledDetected: DetectedSource = {
    sourceId: 'dsh',
    productId: 'dsh',
    configRoot: '/dsh',
    dataRoot: '/dsh',
    runtimeProfile: {
      nativeProfileId: 'writer',
      name: 'writer',
      configRoot: '/dsh/profiles/writer',
      dataRoot: '/dsh/profiles/writer',
    },
    confidence: 'exact',
  }
  const source: SourceDefinition = {
    manifest: {
      pluginId: '@agent-lens/source-dsh',
      pluginVersion: '1.0.0',
      apiVersion: '1.0',
      pluginType: 'source',
      displayName: 'DeepSeek Harness Source',
      sourceId: 'dsh',
      productId: 'dsh',
      parserVersion: '2',
    },
    async detect() { return [profiledDetected] },
    async declareCapabilities() { return [] },
    async *ingestHistory(ctx) {
      await ctx.checkpoint.set('probe', true)
    },
    async normalize(value) { return normalized(value) },
  }
  const profiledInstallation: AgentInstallation = {
    ...installation,
    productId: 'dsh',
    configRoot: '/dsh',
    dataRoot: '/dsh',
  }
  const storage = {
    repositories: { sourceRecords: { async put() {} } },
    runtimeProfiles: {
      async resolve(hint: Record<string, unknown>) {
        profileHints.push(hint)
        return {
          id: 'profile-writer',
          installationId: profiledInstallation.id,
          nativeProfileId: 'writer',
          name: 'writer',
          configRoot: '/dsh/profiles/writer',
          dataRoot: '/dsh/profiles/writer',
          firstSeenAt: '2026-09-17T00:00:00.000Z',
          lastSeenAt: '2026-09-17T00:00:00.000Z',
        }
      },
    },
    sourceRuntimeStatus: { async put() {} },
    async transaction(operation: () => Promise<unknown>) { return operation() },
    checkpoints: {
      async get() { return null },
      async set(scope: string) { checkpointScopes.push(scope) },
      async clear() {},
    },
  } as unknown as StorageService
  const runner = new SourceHistoryRunner(
    storage,
    {
      async resolveInstallation(hint: Record<string, unknown>) {
        installationHints.push(hint)
        return profiledInstallation
      },
    } as unknown as IdentityService,
    { async commit() { throw new Error('No observations expected') } } as unknown as ObservationService,
    { registerSourceCapabilities() { return { dispose() {} } } } as unknown as CapabilityService,
    { async declare() { return {} } } as unknown as CoverageService,
    capturePolicy,
  )

  await runner.sync({
    source,
    host,
    detected: profiledDetected,
    abortSignal: new AbortController().signal,
  })

  assert.deepEqual(installationHints[0], {
    hostId: host.id,
    productId: 'dsh',
    configRoot: '/dsh',
    dataRoot: '/dsh',
  })
  assert.deepEqual(profileHints[0], {
    installationId: profiledInstallation.id,
    nativeProfileId: 'writer',
    name: 'writer',
    configRoot: '/dsh/profiles/writer',
    dataRoot: '/dsh/profiles/writer',
  })
  assert.deepEqual(checkpointScopes, ['dsh:installation-1:profile-writer'])
})
