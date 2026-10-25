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
