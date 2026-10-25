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


test('metadata-only Source history stage updates Catalog, never ingests SourceRecord/Observation/Evidence', async () => {
  const indexed: Array<{nativeSessionId:string;fileSize:number}> = []
  let reads = 0
  let normalizeCalls = 0
  const source: SourceDefinition = {
    manifest: {
      pluginId:'test-catalog',pluginVersion:'1.0.0',apiVersion:'1.0',
      pluginType:'source',displayName:'Metadata only',
      sourceId:'test-source',productId:'test-product',parserVersion:'1',
    },
    async detect(){ return [detected] },
    async declareCapabilities(){ return [] },
    async *discoverNativeSessions(ctx) {
      assert.equal(ctx.historyWindow?.sessionLimit,2)
      yield {
        sourceId:'test-source', installationId:installation.id,
        nativeSessionId:'native-1',locationKind:'native',
        filePath:'/tmp/native-1.jsonl',fileIdentity:'10:20',fileSize:900,
        fileMtimeMs:100,lastActivityAt:'2026-10-25T00:00:00Z',
        updatedAt:'2026-10-25T00:00:00Z',
      }
    },
    async *ingestHistory(){ reads++;yield record('old','2026-10-25T00:00:00Z') },
    async normalize(value){ normalizeCalls++; return normalized(value) },
  }
  const storage = {
    nativeSessionCatalog: {
      async upsert(entry: {nativeSessionId:string;fileSize:number}) {
        indexed.push({nativeSessionId:entry.nativeSessionId,fileSize:entry.fileSize})
      },
    },
    checkpoints: {async get(){return null},async set(){},async clear(){}},
  } as unknown as StorageService
  const runner = new SourceHistoryRunner(storage,
    { async resolveInstallation(){ return installation } } as unknown as IdentityService,
    { async commit(){ throw Error('no event commit') } } as unknown as ObservationService,
    { registerSourceCapabilities(){ return {dispose(){}} } } as unknown as CapabilityService,
    { async declare(){ throw Error('no coverage write') } } as unknown as CoverageService,
    capturePolicy,
  )
  const result = await runner.sync({
    source,host,detected,abortSignal:new AbortController().signal,
    mode:'native-catalog',historyWindow:{sessionLimit:2},
  })
  assert.deepEqual(indexed,[{nativeSessionId:'native-1',fileSize:900}])
  assert.equal(result.nativeSessionsIndexed,1)
  assert.equal(result.records,0)
  assert.equal(reads,0)
  assert.equal(normalizeCalls,0)
})


test('verified new native session skips transcript ingestion, SourceRecord and Observation when both opt-ins enabled',async()=>{
  const filePath='/tmp/native-fast-pi.jsonl'
  const key={sourceId:'test-source',installationId:installation.id,nativeSessionId:'fast-new'}
  const recordForProbe:SourceRecord={
    id:'r1',...key,sourceSessionNativeId:'fast-new',
    nativeType:'session',capturedAt:'2026-10-25T00:00:00Z',
    parserVersion:'1',fingerprint:'sha256-hash',
    locator:{kind:'file',path:filePath,offset:0},payload:{},
  }
  const oldNative=process.env.AGENT_LENS_NATIVE_ONLY_NEW_SESSIONS
  const oldFast=process.env.AGENT_LENS_NATIVE_CATALOG_FAST_SCAN
  let verificationCount=0
  let ingested=0
  let committed=0
  let wroteRaw=0
  let metadata=0
  let catalogReady=0
  const source:SourceDefinition={
    manifest:{pluginId:'test-fast',pluginVersion:'1',apiVersion:'1.0',
      pluginType:'source',displayName:'Test',sourceId:'test-source',
      productId:'test-product',parserVersion:'1'},
    async detect(){return [detected]},
    async declareCapabilities(){return []},
    nativeSessionCoverageComplete:true,
    rawRecovery:{
      describe(){return {canReread:true,authority:'native-store',mutability:'append-oriented',
        locatorStability:'stable',verification:'fingerprint',canReparse:true,
        replayable:true,persistencePreference:'reference'}},
      async verify(){verificationCount++;return {state:'verified',checkedAt:'2026-10-25T00:00:00Z'}},
    },
    async *discoverNativeSessions(){
      yield {...key,locationKind:'native' as const,filePath,
        fileIdentity:'42:12',fileSize:256,fileMtimeMs:1000,
        lastActivityAt:'2026-10-25T00:00:00Z',updatedAt:'2026-10-25T00:00:00Z'}
    },
    async readNativeSessionPage(){
      return {state:'available',records:[recordForProbe],
        nextCursor:{offset:64,sequence:1,fileIdentity:'42:12'},
        hasMore:false,pendingTail:false}
    },
    async *ingestHistory(ctx){
      assert.equal(catalogReady,1,'runtime capture may start only after native claims')
      if (ctx.skipNativeSessionFile?.(filePath)) return
      ingested++
      yield recordForProbe
    },
    async normalize(value){return normalized(value)},
  }
  const storage={
    nativeSessionCatalog:{
      async upsert(){metadata++},
      async claimNativeOnlyWrite(){return true},
      async getSessionWriteMode(){return 'native-only'},
    },
    checkpoints:{async get(){return null},async set(){},async clear(){}},
    repositories:{sourceRecords:{async put(){wroteRaw++}}},
  } as unknown as StorageService
  const runner=new SourceHistoryRunner(storage,
    {async resolveInstallation(){return installation}} as unknown as IdentityService,
    {async commit(){committed++;return {status:'created'}}} as unknown as ObservationService,
    {registerSourceCapabilities(){return {dispose(){}}}} as unknown as CapabilityService,
    {async declare(){return {}}} as unknown as CoverageService,
    capturePolicy)
  try{
    process.env.AGENT_LENS_NATIVE_ONLY_NEW_SESSIONS='1'
    process.env.AGENT_LENS_NATIVE_CATALOG_FAST_SCAN='1'
    const result=await runner.sync({source,host,detected,
      abortSignal:new AbortController().signal,
      onNativeCatalogReady(){ catalogReady++; assert.equal(verificationCount,1) },
    })
    assert.equal(metadata,1)
    assert.equal(verificationCount,1)
    assert.equal(result.records,0)
    assert.equal(ingested,0)
    assert.equal(committed,0)
    assert.equal(wroteRaw,0)
  }finally{
    if(oldNative===undefined)delete process.env.AGENT_LENS_NATIVE_ONLY_NEW_SESSIONS
    else process.env.AGENT_LENS_NATIVE_ONLY_NEW_SESSIONS=oldNative
    if(oldFast===undefined)delete process.env.AGENT_LENS_NATIVE_CATALOG_FAST_SCAN
    else process.env.AGENT_LENS_NATIVE_CATALOG_FAST_SCAN=oldFast
  }
})

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
