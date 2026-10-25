import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type {
  AgentInstallation, CapturePolicyService, CoverageService, Host,
  NativeSessionCatalogEntry, NativeSessionCatalogStore, ObservationService,
  SourceDefinition, SourceRecord, StorageService,
} from '@agent-lens/core'
import { NativeSessionCatalogTracker } from './native-session-catalog-tracker'
import { sourceRunnerInternals } from './source-runner'

const at='2026-10-25T00:00:00Z'

test('certified native-only Writer defaults to single-copy Source facts after durable claim',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-native-writer-'))
  const filePath=join(root,'session.jsonl')
  const host:Host={id:'host',name:'local',platform:process.platform,arch:process.arch,createdAt:at,lastSeenAt:at}
  const installation:AgentInstallation={
    id:'installation',hostId:host.id,productId:'pi',dataRoot:root,
    firstSeenAt:at,lastSeenAt:at,
  }
  const nativeKey={sourceId:'pi',installationId:'installation',nativeSessionId:'S1'}
  let catalog:NativeSessionCatalogEntry|undefined
  let claimed=false
  let committed=0
  let rawWrites=0
  let normalizations=0
  let ownershipReads=0
  let verificationCalls=0
  let verificationState:'verified'|'drifted'='verified'
  const claims:NativeSessionCatalogStore={
    async upsert(value){catalog=value},
    async get(){return catalog??null},
    async getByReviewSessionId(){return catalog??null},
    async query(){return {items:catalog?[catalog]:[],hasMore:false}},
    async hasNativeOnlyWriteClaim(){return claimed},
    async getSessionWriteMode(){ownershipReads++;return claimed ? 'native-only' : null},
    async claimLegacyWrite(){return claimed ? 'native-only' : 'legacy'},
    async claimNativeOnlyWrite(value){
      assert.equal(value.sourceId,nativeKey.sourceId)
      assert.equal(value.installationId,nativeKey.installationId)
      assert.equal(value.nativeSessionId,nativeKey.nativeSessionId)
      assert.equal(value.filePath,catalog?.filePath)
      assert.equal(value.fileIdentity,catalog?.fileIdentity)
      claimed=true
      return true
    },
  }
  const storage={
    nativeSessionCatalog:claims,
    repositories:{sourceRecords:{async put(){rawWrites++}}},
    async transaction<T>(action:()=>Promise<T>){return action()},
  } as unknown as StorageService
  const observations={async commit(){committed++;return {status:'created'}}} as unknown as ObservationService
  const coverage={async declare(){return {}}} as unknown as CoverageService
  const policy={
    sanitizeSourceRecord(value:SourceRecord){return value},
    sanitizeNormalizedOutput(value:unknown){return value},
  } as unknown as CapturePolicyService
  const source={
    manifest:{sourceId:'pi',productId:'pi',parserVersion:'1'},
    nativeSessionCoverageComplete:true,
    rawRecovery:{
      describe(){return {
        canReread:true,authority:'native-store',locatorStability:'stable',
        mutability:'append-oriented',verification:'fingerprint',
        canReparse:true,replayable:true,persistencePreference:'reference',
      }},
      async verify(){
        verificationCalls++
        return {state:verificationState,checkedAt:at}
      },
    },
    async normalize(){
      normalizations++
      return {observations:[],evidenceCandidates:[]}
    },
    async readNativeSessionPage(){
      const info=await stat(filePath)
      return {
        state:'available',records:[{}],
        nextCursor:{offset:64,sequence:1,fileIdentity:`${info.dev}:${info.ino}`},
        hasMore:false,pendingTail:false,
      }
    },
  } as unknown as SourceDefinition
  const tracker=new NativeSessionCatalogTracker(claims,Date.now,0)
  const record:SourceRecord={
    id:'record-1',...nativeKey,sourceSessionNativeId:'S1',
    nativeType:'message',nativeId:'m1',capturedAt:at,
    fingerprint:'sha256',parserVersion:'1',
    payload:{text:'PRIVATE_SOURCE_BODY'},
    locator:{kind:'file',path:filePath,offset:0},
  }
  try{
    await writeFile(filePath,'{"type":"message"}\n')
    const args=[
      storage, observations, coverage, policy, tracker,
      source, host, installation, undefined, record,
      new AbortController().signal,
    ] as const
    const first=await sourceRunnerInternals.processSourceRecordWithOwnership(...args)
    assert.equal(claimed,true)
    assert.equal(first.observationsCreated,0)
    assert.equal(normalizations,0)
    assert.equal(rawWrites,0)
    assert.equal(committed,0)
    assert.equal(catalog?.nativeSessionId,'S1')
    assert.equal(JSON.stringify(catalog).includes('PRIVATE_SOURCE_BODY'),false)
    // The immutable ownership claim continues to prevent duplicate SQL facts.
    await sourceRunnerInternals.processSourceRecordWithOwnership(...args)
    assert.equal(rawWrites,0)
    assert.equal(normalizations,0)
    assert.equal(ownershipReads,1, 'durable selected mode must be cached for next native event')
    assert.equal(verificationCalls,2,'each claimed record must still be verified against its original file')

    // An immutable native-only claim cannot silently swallow a changed,
    // truncated or replaced original even when its coverage flag remains true.
    verificationState='drifted'
    await assert.rejects(
      ()=>sourceRunnerInternals.processSourceRecordWithOwnership(...args),
      /native-only-source-record-recovery-drift/,
    )
    assert.equal(rawWrites,0)
    assert.equal(committed,0)
    verificationState='verified'
    await assert.rejects(
      ()=>sourceRunnerInternals.processSourceRecordWithOwnership(
        storage, observations, coverage, policy, tracker,
        source, host, installation, undefined,
        {...record,locator:{kind:'file' as const,path:join(root,'other.jsonl'),offset:0}},
        new AbortController().signal,
      ),
      /native-only-source-record-location-drift/,
    )
    // A preexisting experimental claim must not silently discard runtime-only
    // events when the Source coverage attestation is withdrawn after upgrade.
    source.nativeSessionCoverageComplete=false
    await assert.rejects(
      ()=>sourceRunnerInternals.processSourceRecordWithOwnership(...args),
      /native-only-source-recovery-coverage-drift/,
    )
    assert.equal(rawWrites,0)
  }finally{
    await rm(root,{recursive:true,force:true})
  }
})

test('default cutover preserves mutable SQLite legacy sessions even with a native reader',async()=>{
  const host:Host={id:'host',name:'local',platform:'linux',arch:'x64',createdAt:at,lastSeenAt:at}
  const installation:AgentInstallation={
    id:'inst',hostId:'host',productId:'test',firstSeenAt:at,lastSeenAt:at,
  }
  const record:SourceRecord={
    id:'legacy',sourceId:'test',installationId:'inst',
    sourceSessionNativeId:'old',nativeType:'message',capturedAt:at,
    locator:{kind:'database',path:'/tmp/state.db',table:'messages',rowId:'1'},
    fingerprint:'row-fingerprint',payload:{text:'legacy'},parserVersion:'1',
  }
  let persisted=0
  const storage={
    nativeSessionCatalog:{
      async getSessionWriteMode(){return null},
      async claimLegacyWrite(){return 'legacy'},
      async claimNativeOnlyWrite(){throw Error('Mutable database cannot be native-only')},
    },
    repositories:{sourceRecords:{async put(){persisted++}}},
    async transaction<T>(op:()=>Promise<T>){return op()},
  } as unknown as StorageService
  const source={
    manifest:{sourceId:'test'},
    nativeSessionCoverageComplete:true,
    rawRecovery:{
      describe(){return {
        authority:'native-store',canReread:true,locatorStability:'best-effort',
        mutability:'mutable',verification:'fingerprint',canReparse:true,
        replayable:true,persistencePreference:'preserve',
      }},
      async verify(){throw Error('Should never verify mutable SQLite as native-only')},
    },
    async readNativeSessionPage(){throw Error('Should never probe mutable SQLite')},
    async normalize(){return {observations:[],evidenceCandidates:[]}},
  } as unknown as SourceDefinition
  const policy={
    sanitizeSourceRecord(value:SourceRecord){return value},
    sanitizeNormalizedOutput(value:unknown){return value},
  } as unknown as CapturePolicyService
  await sourceRunnerInternals.processSourceRecordWithOwnership(
    storage,
    {async commit(){throw Error('none')}} as unknown as ObservationService,
    {async declare(){return {}}} as unknown as CoverageService,
    policy,new NativeSessionCatalogTracker(undefined),
    source,host,installation,undefined,record,new AbortController().signal,
  )
  assert.equal(persisted,1)
})

test('a competing native-only claim never discards this writers unverified record',async()=>{
  const host:Host={id:'host',name:'local',platform:'linux',arch:'x64',
    createdAt:at,lastSeenAt:at}
  const installation:AgentInstallation={id:'inst',hostId:host.id,productId:'pi',
    dataRoot:'/native',firstSeenAt:at,lastSeenAt:at}
  const original:SourceRecord={
    id:'record',sourceId:'pi',installationId:'inst',sourceSessionNativeId:'S1',
    nativeType:'message',capturedAt:at,locator:{kind:'file',path:'/native/original.jsonl',offset:0},
    fingerprint:'sha256',payload:{text:'source owned'},parserVersion:'1',
  }
  const nativeCatalog:NativeSessionCatalogEntry={
    sourceId:'pi',installationId:'inst',nativeSessionId:'S1',
    locationKind:'native',filePath:'/native/original.jsonl',
    fileIdentity:'1:9',fileSize:42,fileMtimeMs:10,
    lastActivityAt:at,updatedAt:at,
  }
  let writes=0
  let verifications=0
  let verificationState:'verified'|'drifted'='verified'
  const catalog={
    async getSessionWriteMode(){return null},
    async claimLegacyWrite(){return 'native-only' as const},
    async get(){return nativeCatalog},
  } as unknown as NativeSessionCatalogStore
  const storage={
    nativeSessionCatalog:catalog,
    repositories:{sourceRecords:{async put(){writes++}}},
    async transaction<T>(action:()=>Promise<T>){return action()},
  } as unknown as StorageService
  const observations={async commit(){throw Error('Must never write duplicate observations')}} as unknown as ObservationService
  const coverage={async declare(){return {}}} as unknown as CoverageService
  const policy={
    sanitizeSourceRecord(value:SourceRecord){return value},
    sanitizeNormalizedOutput(value:unknown){return value},
  } as unknown as CapturePolicyService
  const source={
    manifest:{sourceId:'pi',productId:'pi',parserVersion:'1'},
    nativeSessionCoverageComplete:true,
    rawRecovery:{
      describe(){return {
        authority:'native-store',locatorStability:'stable',mutability:'append-oriented',
        verification:'fingerprint',canReread:true,canReparse:true,replayable:true,
        persistencePreference:'reference',
      }},
      async verify(){verifications++;return {state:verificationState,checkedAt:at}},
    },
    async normalize(){throw Error('No second normalizer on claimed native-only session')},
  } as unknown as SourceDefinition
  const run=(tracker=new NativeSessionCatalogTracker(catalog))=>
    sourceRunnerInternals.processSourceRecordWithOwnership(
      storage,observations,coverage,policy,tracker,
      source,host,installation,undefined,original,new AbortController().signal,
    )
  const done=await run()
    assert.equal(done.observationsCreated,0)
    assert.equal(verifications,1,'claimLegacyWrite reporting competing native-only must verify this record')
    assert.equal(writes,0)
    verificationState='drifted'
    await assert.rejects(run(),/native-only-source-record-recovery-drift/)
    assert.equal(verifications,2)
    assert.equal(writes,0)
    source.nativeSessionCoverageComplete=false
    await assert.rejects(run(),/native-only-source-recovery-coverage-drift/)
    assert.equal(writes,0)
})


test('preexisting Legacy claim continues to persist a verified Pi session after default Native-only cutover',async()=>{
  const previous:{sourceId:string;installationId:string;nativeSessionId:string}={
    sourceId:'pi',installationId:'pi-local',nativeSessionId:'old-session',
  }
  const record:SourceRecord={
    id:'old-original',sourceId:previous.sourceId,installationId:previous.installationId,
    sourceSessionNativeId:previous.nativeSessionId,
    nativeType:'message',capturedAt:at,parserVersion:'1',fingerprint:'hash',
    locator:{kind:'file',path:'/original/old-session.jsonl',offset:0},
    payload:{text:'ORIGINAL PRIVATE CONTENT'},
  }
  let rawWrites=0,normalizes=0,verifies=0,claims=0
  const storage={
    nativeSessionCatalog:{
      async getSessionWriteMode(){return 'legacy' as const},
      async claimNativeOnlyWrite(){claims++;return true},
      async claimLegacyWrite(){claims++;return 'legacy' as const},
    },
    repositories:{sourceRecords:{async put(){rawWrites++}}},
    async transaction<T>(action:()=>Promise<T>){return action()},
  } as unknown as StorageService
  const source={
    manifest:{sourceId:'pi',productId:'pi',parserVersion:'1'},
    nativeSessionCoverageComplete:true,
    rawRecovery:{
      describe(){return{
        authority:'native-store',locatorStability:'stable',mutability:'append-oriented',
        verification:'fingerprint',canReread:true,canReparse:true,
        replayable:true,persistencePreference:'reference',
      }},
      async verify(){verifies++;return {state:'verified',checkedAt:at}},
    },
    async readNativeSessionPage(){throw Error('Established Legacy sessions must not probe new claims')},
    async normalize(){
      normalizes++
      return {observations:[],evidenceCandidates:[]}
    },
  } as unknown as SourceDefinition
  const result=await sourceRunnerInternals.processSourceRecordWithOwnership(
    storage,
    {async commit(){throw Error('Unexpected observation')}} as unknown as ObservationService,
    {async declare(){throw Error('Unexpected coverage')}} as unknown as CoverageService,
    {sanitizeSourceRecord:(row:SourceRecord)=>row,
      sanitizeNormalizedOutput:(value:unknown)=>value} as unknown as CapturePolicyService,
    new NativeSessionCatalogTracker(storage.nativeSessionCatalog),
    source,{id:'host',name:'host',platform:'linux',arch:'x64',
      createdAt:at,lastSeenAt:at},
    {id:previous.installationId,hostId:'host',productId:'pi',
      firstSeenAt:at,lastSeenAt:at},
    undefined,record,new AbortController().signal,
  )
  assert.equal(result.observationsCreated,0)
  assert.equal(rawWrites,1,'Existing SQL history retains its original storage ownership')
  assert.equal(normalizes,1)
  assert.equal(verifies,0)
  assert.equal(claims,0)
})
