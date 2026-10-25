import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  CapturePolicyService, NativeSessionCatalogEntry, NativeSessionCatalogStore,
  NativeSessionMetricSnapshot, NativeSessionMetricsStore, SourceService,
} from '@agent-lens/core'
import type { NativeSessionWindowReader } from './native-session-http'
import { NativeMetricsAutoRefresh } from './native-metrics-auto-refresh'

const at='2026-10-25T00:00:00Z'
const entry:NativeSessionCatalogEntry={
  sourceId:'pi',installationId:'pi-local',nativeSessionId:'session-1',
  locationKind:'native',filePath:'/private/session.jsonl',
  fileIdentity:'dev:1',fileSize:42,fileMtimeMs:10,
  lastActivityAt:at,updatedAt:at,
}
const catalog={
  getByReviewSessionId:async(id:string)=>id==='native:0123456789abcdef0123456789abcdef'?entry:null,
} as unknown as NativeSessionCatalogStore
const source={
  list:()=>[{manifest:{sourceId:'pi',parserVersion:'pi-v1'},
    nativeSessionCoverageComplete:true,
    readNativeSessionPage:async()=>{throw Error('must use reader worker')}}],
} as unknown as SourceService
const policy={isSourceEnabled:(id:string)=>id==='pi'} as unknown as CapturePolicyService
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve))

test('no startup scan; first Insights trigger lazily builds numerical Pi metrics',async()=>{
  let queried=0
  const persisted:NativeSessionMetricSnapshot[]=[]
  const metrics={
    findRebuildCandidates:async()=>{
      queried++
      return [{reviewSessionId:'native:0123456789abcdef0123456789abcdef',
        sourceId:'pi',installationId:'pi-local',nativeSessionId:'session-1'}]
    },
    replace:async(snapshot:NativeSessionMetricSnapshot)=>{
      persisted.push(snapshot);return true
    },
  } as unknown as NativeSessionMetricsStore
  let reads=0
  const reader={
    read:async()=>{reads++;return {
      state:'available' as const,
      observations:[{kind:'message.user' as const,capturedAt:at,
        identityHints:{nativeSessionId:'session-1'},payload:{text:'private question'}}],
      observationRecordIds:['source-record-private'],
      evidenceCandidates:[],
      nextCursor:{offset:42,sequence:1,fileIdentity:'dev:1'},
      hasMore:false,pendingTail:false,
    }},
  } as NativeSessionWindowReader
  const refresh=new NativeMetricsAutoRefresh(catalog,metrics,reader,source,policy)
  try{
    assert.equal(queried,0)
    assert.equal(reads,0)
    refresh.schedule()
    refresh.schedule() // Single-flight; do not duplicate the concurrent work.
    await flush()
    assert.equal(queried,1)
    assert.equal(reads,1)
    assert.equal(persisted.length,1)
    assert.equal(persisted[0]!.coverage,'complete')
    assert.equal(persisted[0]!.interactionCount,1)
    assert.equal(JSON.stringify(persisted).includes('private question'),false)
    assert.equal(JSON.stringify(persisted).includes('/private'),false)
    refresh.schedule()
    await flush()
    assert.equal(reads,1) // Retry cooldown prevents repeated body re-reads.
  }finally{refresh.dispose()}
})

test('disabled Source and disposal cannot start an opportunistic native scan',async()=>{
  let selected=0
  const metrics={
    findRebuildCandidates:async()=>{selected++;return []},
  } as unknown as NativeSessionMetricsStore
  const disabled={isSourceEnabled:()=>false} as unknown as CapturePolicyService
  const reader={read:async()=>{throw Error('disabled Source must never read')}} as unknown as NativeSessionWindowReader
  const refresh=new NativeMetricsAutoRefresh(catalog,metrics,reader,source,disabled)
  refresh.schedule()
  await flush()
  assert.equal(selected,0)
  refresh.dispose()
  refresh.schedule()
  assert.equal(selected,0)
})

test('withdrawing Source coverage attestation prevents background Native-only scans',async()=>{
  let candidates=0
  let reads=0
  const uncertified={
    list:()=>[{manifest:{sourceId:'pi',parserVersion:'pi-v1'},
      nativeSessionCoverageComplete:false,
      readNativeSessionPage:async()=>{throw Error('not used')}}],
  } as unknown as SourceService
  const metrics={
    findRebuildCandidates:async()=>{candidates++;return []},
  } as unknown as NativeSessionMetricsStore
  const reader={read:async()=>{reads++;throw Error('not used')}}
    as unknown as NativeSessionWindowReader
  const refresh=new NativeMetricsAutoRefresh(catalog,metrics,reader,uncertified,policy)
  try{
    refresh.schedule()
    await flush()
    assert.equal(candidates,0)
    assert.equal(reads,0)
  }finally{refresh.dispose()}
})

test('failed or cooled-down recent sessions do not starve older Native-only metrics',async()=>{
  const all=Array.from({length:9},(_,index)=>({
    reviewSessionId:`native:${index.toString(16).padStart(32,'0')}`,
    sourceId:'pi',installationId:'pi-local',nativeSessionId:`item-${index}`,
    lastActivityAt:at,
  }))
  const seenPages:string[][]=[]
  const metrics={
    async findRebuildCandidates(_scope:unknown,limit:number,before?:{
      lastActivityAt:string;installationId:string;nativeSessionId:string
    }){
      const page=all.filter(row=>!before
        || row.lastActivityAt<before.lastActivityAt
        || (row.lastActivityAt===before.lastActivityAt
          && (row.installationId>before.installationId
            || (row.installationId===before.installationId
              && row.nativeSessionId>before.nativeSessionId))))
        .slice(0,limit)
      seenPages.push(page.map(row=>row.nativeSessionId))
      return page
    },
    async replace(){return true},
  } as unknown as NativeSessionMetricsStore
  const scopedCatalog={
    async getByReviewSessionId(id:string){
      const row=all.find(candidate=>candidate.reviewSessionId===id)
      return row?{...entry,nativeSessionId:row.nativeSessionId}:null
    },
  } as unknown as NativeSessionCatalogStore
  const readIds:string[]=[]
  const reader={
    async read(query:{nativeSessionId:string}){
      readIds.push(query.nativeSessionId)
      if(query.nativeSessionId==='item-0')return {
        state:'unavailable' as const,reason:'temporary-source-unavailable',
      }
      return {
        state:'available' as const,
        observations:[],observationRecordIds:[],evidenceCandidates:[],
        nextCursor:{offset:42,sequence:1,fileIdentity:'dev:1'},
        hasMore:false,pendingTail:false,
      }
    },
  } as unknown as NativeSessionWindowReader
  const refresh=new NativeMetricsAutoRefresh(scopedCatalog,metrics,reader,source,policy)
  try{
    for(let i=0;i<3;i++){
      refresh.schedule()
      await flush()
    }
    assert.deepEqual(seenPages,[
      ['item-0','item-1','item-2','item-3'],
      ['item-4','item-5','item-6','item-7'],
      ['item-8'],
    ])
    assert.deepEqual(readIds,all.map(row=>row.nativeSessionId))
    // The scan wraps, but the cooldown prevents a hot failure from rescanning.
    refresh.schedule()
    await flush()
    assert.deepEqual(readIds,all.map(row=>row.nativeSessionId))
  }finally{refresh.dispose()}
})

test('a 65-page native session resumes the numerical accumulator instead of rescanning page zero',async()=>{
  const key='native:0123456789abcdef0123456789abcdef'
  const pageCount=65
  let pages=0
  const readOffsets:number[]=[]
  const snapshots:NativeSessionMetricSnapshot[]=[]
  const metrics={
    findRebuildCandidates:async()=>[{
      reviewSessionId:key,sourceId:'pi',installationId:'pi-local',
      nativeSessionId:'session-1',lastActivityAt:at,
    }],
    replace:async(snapshot:NativeSessionMetricSnapshot)=>{
      snapshots.push(snapshot)
      return true
    },
  } as unknown as NativeSessionMetricsStore
  const reader:NativeSessionWindowReader={
    async read(query){
      const index=query.cursor?.sequence??0
      readOffsets.push(index)
      pages++
      return {
        state:'available',
        observations:[{kind:'message.user' as const,capturedAt:at,
          identityHints:{nativeSessionId:'session-1'},payload:{text:'private user text'}}],
        observationRecordIds:[`source-record-${index}`],
        evidenceCandidates:[],
        nextCursor:{offset:(index+1)*32,sequence:index+1,fileIdentity:'dev:1'},
        hasMore:index+1<pageCount,pendingTail:false,
      }
    },
  }
  const refresh=new NativeMetricsAutoRefresh(catalog,metrics,reader,source,policy)
  try{
    refresh.schedule()
    await flush()
    assert.equal(pages,64)
    assert.equal(snapshots.length,0,'never publish a 64-page prefix as full totals')
    refresh.schedule()
    await flush()
    assert.equal(pages,65,'second trigger reads only the remaining page')
    assert.deepEqual(readOffsets,Array.from({length:65},(_,i)=>i))
    assert.equal(snapshots.length,1)
    assert.equal(snapshots[0]?.coverage,'complete')
    assert.equal(snapshots[0]?.interactionCount,65)
    assert.equal(JSON.stringify(snapshots).includes('private user text'),false)
    assert.equal(JSON.stringify(snapshots).includes('source-record-'),false)
    refresh.schedule()
    await flush()
    assert.equal(pages,65,'cooldown prevents immediately scanning a completed session')
  }finally{refresh.dispose()}
})
