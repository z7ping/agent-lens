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

test('opt-in native-only Writer skips SourceRecord / Observation / Evidence only after source verification and durable claim',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-native-writer-'))
  const filePath=join(root,'session.jsonl')
  const oldEnv=process.env.AGENT_LENS_NATIVE_ONLY_NEW_SESSIONS
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
    rawRecovery:{
      describe(){return {
        canReread:true,authority:'native-store',locatorStability:'stable',
        mutability:'append-oriented',verification:'fingerprint',
        canReparse:true,replayable:true,persistencePreference:'reference',
      }},
      async verify(){return {state:'verified',checkedAt:at}},
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
    process.env.AGENT_LENS_NATIVE_ONLY_NEW_SESSIONS='1'
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
    // Removing the opt-in does NOT change a previously-claimed session back
    // to SQL/event persistence (both historical and runtime writers consult).
    delete process.env.AGENT_LENS_NATIVE_ONLY_NEW_SESSIONS
    await sourceRunnerInternals.processSourceRecordWithOwnership(...args)
    assert.equal(rawWrites,0)
    assert.equal(normalizations,0)
    assert.equal(ownershipReads,1, 'durable selected mode must be cached for next native event')
  }finally{
    if(oldEnv===undefined)delete process.env.AGENT_LENS_NATIVE_ONLY_NEW_SESSIONS
    else process.env.AGENT_LENS_NATIVE_ONLY_NEW_SESSIONS=oldEnv
    await rm(root,{recursive:true,force:true})
  }
})

test('opt-in keeps mutable database records legacy even when native reader can verify a row',async()=>{
  const oldEnv=process.env.AGENT_LENS_NATIVE_ONLY_NEW_SESSIONS
  process.env.AGENT_LENS_NATIVE_ONLY_NEW_SESSIONS='1'
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
  try{
    await sourceRunnerInternals.processSourceRecordWithOwnership(
      storage,
      {async commit(){throw Error('none')}} as unknown as ObservationService,
      {async declare(){return {}}} as unknown as CoverageService,
      policy,new NativeSessionCatalogTracker(undefined),
      source,host,installation,undefined,record,new AbortController().signal,
    )
    assert.equal(persisted,1)
  }finally{
    if(oldEnv===undefined)delete process.env.AGENT_LENS_NATIVE_ONLY_NEW_SESSIONS
    else process.env.AGENT_LENS_NATIVE_ONLY_NEW_SESSIONS=oldEnv
  }
})
