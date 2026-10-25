import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  CapturePolicyService, NativeSessionCatalogEntry, NativeSessionCatalogStore,
  NativeSessionMetricSnapshot, NativeSessionMetricsStore, SourceService,
} from '@agent-lens/core'
import type { NativeSessionWindowReader } from './native-session-http'
import { NativeMetricsAutoRefresh } from './native-metrics-auto-refresh'
import { rebuildNativeSessionMetrics } from './native-session-metrics-http'

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
  const reader={read:async()=>{reads++;throw Error('not used')}} as unknown as NativeSessionWindowReader
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

test('a changed native Catalog revision discards in-memory progress before any new counting',async()=>{
  const readOffsets:number[]=[]
  const snapshots:NativeSessionMetricSnapshot[]=[]
  const reader:NativeSessionWindowReader={
    async read(query){
      const index=query.cursor?.sequence??0
      readOffsets.push(index)
      return {
        state:'available',
        observations:[{kind:'message.user' as const,capturedAt:at,
          identityHints:{nativeSessionId:'session-1'},payload:{text:'private'}}],
        observationRecordIds:[`record-${index}`],evidenceCandidates:[],
        nextCursor:{offset:(index+1)*32,sequence:index+1,fileIdentity:'dev:1'},
        hasMore:index<64,pendingTail:false,
      }
    },
  }
  const metrics={
    replace:async(snapshot:NativeSessionMetricSnapshot)=>{snapshots.push(snapshot);return true},
  } as unknown as NativeSessionMetricsStore
  const nativeSource=source.list()[0]!
  const abort=new AbortController()
  const first=await rebuildNativeSessionMetrics(entry,metrics,reader,nativeSource,abort.signal,{enabled:true})
  if(first.state!=='in_progress')assert.fail('Expected first bounded read to pause')
  assert.equal(readOffsets.length,64)
  readOffsets.length=0
  const revised={...entry,fileSize:entry.fileSize+1}
  const second=await rebuildNativeSessionMetrics(revised,metrics,reader,nativeSource,abort.signal,{
    enabled:true,progress:first.progress,
  })
  if(second.state!=='in_progress')assert.fail('Expected re-read of changed Catalog revision')
  assert.equal(readOffsets[0],0,'never reuse an old revision cursor')
  assert.equal(readOffsets.length,64)
  readOffsets.length=0
  const done=await rebuildNativeSessionMetrics(revised,metrics,reader,nativeSource,abort.signal,{
    enabled:true,progress:second.progress,
  })
  assert.equal(done.state,'available')
  assert.deepEqual(readOffsets,[64])
  assert.equal(snapshots.length,1)
  assert.equal(snapshots[0]?.fileSize,revised.fileSize)
  assert.equal(snapshots[0]?.interactionCount,65)
})

test('lazy native metrics schedules all certified Sources fairly, never hardcoding Pi',async()=>{
  const picked:string[]=[]
  const readSources:string[]=[]
  const stored:NativeSessionMetricSnapshot[]=[]
  const definitions=[
    {manifest:{sourceId:'pi',parserVersion:'pi-v1'},nativeSessionCoverageComplete:true,
      readNativeSessionPage:async()=>{throw Error('Reader Worker owns Source bytes')}},
    {manifest:{sourceId:'codex',parserVersion:'codex-v2'},nativeSessionCoverageComplete:true,
      readNativeSessionPage:async()=>{throw Error('Reader Worker owns Source bytes')}},
    {manifest:{sourceId:'opencode',parserVersion:'db-v3'},nativeSessionCoverageComplete:false,
      readNativeSessionPage:async()=>{throw Error('Mutable DB must never be read')}},
  ]
  const sources={list:()=>definitions} as unknown as SourceService
  const enabled={isSourceEnabled:(sourceId:string)=>sourceId!=='opencode'} as unknown as CapturePolicyService
  const metrics={
    async findRebuildCandidates(query:{sourceId:string;parserVersion:string}){
      picked.push(query.sourceId)
      assert.equal(query.parserVersion,query.sourceId==='pi'?'pi-v1':'codex-v2')
      return [{
        reviewSessionId:`native:${query.sourceId}`,
        sourceId:query.sourceId,installationId:'installation',nativeSessionId:'S1',
        lastActivityAt:at,
      }]
    },
    async replace(snapshot:NativeSessionMetricSnapshot){stored.push(snapshot);return true},
  } as unknown as NativeSessionMetricsStore
  const nativeCatalog={
    async getByReviewSessionId(id:string){
      const sourceId=id.slice('native:'.length)
      return {...entry,sourceId,installationId:'installation',nativeSessionId:'S1'}
    },
  } as unknown as NativeSessionCatalogStore
  const reader={
    async read(query:{sourceId:string}){
      readSources.push(query.sourceId)
      return {
        state:'available' as const,
        observations:[{kind:'message.user' as const,capturedAt:at,
          identityHints:{nativeSessionId:'S1'},payload:{text:'secret'}}],
        observationRecordIds:['private-source-record'],evidenceCandidates:[],
        nextCursor:{offset:42,sequence:1,fileIdentity:'dev:1'},
        hasMore:false,pendingTail:false,
      }
    },
  } as unknown as NativeSessionWindowReader
  const refresh=new NativeMetricsAutoRefresh(nativeCatalog,metrics,reader,sources,enabled)
  try{
    assert.deepEqual(picked,[],'never scan at startup')
    for(let i=0;i<3;i++){refresh.schedule();await flush()}
    assert.deepEqual(picked,['codex','pi','codex'])
    assert.deepEqual(readSources,['codex','pi'])
    assert.deepEqual(stored.map(item=>item.sourceId),['codex','pi'])
    assert.equal(JSON.stringify(stored).includes('secret'),false)
    assert.equal(JSON.stringify(stored).includes('private-source-record'),false)
  }finally{refresh.dispose()}
})

test('per-Source metric pagination does not reuse a different Source keyset cursor',async()=>{
  const visited:Array<{sourceId:string;after:string|null}>=[]
  const sources={list:()=>['pi','codex'].map(sourceId=>({
    manifest:{sourceId,parserVersion:'1'},nativeSessionCoverageComplete:true,
    readNativeSessionPage:async()=>{throw Error('Reader Worker owns Source bytes')},
  }))} as unknown as SourceService
  const metrics={
    async findRebuildCandidates(scope:{sourceId:string},limit:number,
      before?:{nativeSessionId:string}){
      assert.equal(limit,4)
      visited.push({sourceId:scope.sourceId,after:before?.nativeSessionId??null})
      const start=before?4:0
      return Array.from({length:4},(_,i)=>({
        reviewSessionId:`native:${scope.sourceId}-${start+i}`,
        sourceId:scope.sourceId,installationId:'installation',
        nativeSessionId:`S${start+i}`,lastActivityAt:at,
      }))
    },
  } as unknown as NativeSessionMetricsStore
  const notFound={getByReviewSessionId:async()=>null} as unknown as NativeSessionCatalogStore
  const refresh=new NativeMetricsAutoRefresh(notFound,metrics,
    {read:async()=>{throw Error('No registered Catalog entry')}} as unknown as NativeSessionWindowReader,
    sources,{isSourceEnabled:()=>true} as unknown as CapturePolicyService)
  try{
    for(let i=0;i<4;i++){refresh.schedule();await flush()}
    assert.deepEqual(visited,[
      {sourceId:'codex',after:null},{sourceId:'pi',after:null},
      {sourceId:'codex',after:'S3'},{sourceId:'pi',after:'S3'},
    ])
  }finally{refresh.dispose()}
})
