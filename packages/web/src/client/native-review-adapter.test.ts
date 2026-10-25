import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentLensApi } from './api'
import type { NativeReviewWindowDto, NativeSessionSummaryDto } from '@agent-lens/protocol'
import { AgentLensClientModel } from './model'
import { nativeReviewDetail, nativeReviewNextPage, nativeReviewObservedFileChanges } from './native-review-adapter'

const id='native:1234567890abcdef1234567890abcdef'
const at='2026-10-25T00:00:00Z'
const summary:NativeSessionSummaryDto={
  id,sourceId:'pi',installationId:'inst',nativeSessionId:'session-1',
  locationKind:'native',lastActivityAt:at,title:'Native Pi task',
}
const page=(ordinal:number,hasMore:boolean):NativeReviewWindowDto=>({
  state:'available',sourceId:'pi',installationId:'inst',nativeSessionId:'session-1',
  sessionId:id,pagingUnit:'interaction',boundaryIntegrity:'complete',
  observationCount:2,hasMore,pendingTail:false,nextCursor:'opaque-cursor-'+ordinal,
  interactions:[{
    id:'turn-'+ordinal,ordinal,trigger:'user',startedAt:at,endedAt:at,
    nodes:[{
      type:'message',id:'message-'+ordinal,role:'user',
      at,sourceId:'pi',capturedAt:at,text:'Prompt '+ordinal,
      payload:{text:'Prompt '+ordinal},evidence:[],observationIds:['native-observation-'+ordinal],
    }],
  }],
})

test('native adapter keeps the shared Review interactions and labels statistics as window-only',()=>{
  const first=nativeReviewDetail(summary,page(1,true))
  assert.equal(first.id,id)
  assert.equal(first.title,'Native Pi task')
  assert.equal(first.statisticsCompleteness,'window')
  assert.equal(nativeReviewDetail(summary,{...page(1,true),hookEventsTruncated:true}).nativeHookEventsTruncated,true)
  assert.equal(nativeReviewDetail(summary,{...page(1,true),hookFactsPartial:true}).nativeHookEventsTruncated,true)
  assert.equal(first.page.direction,'forward')
  assert.equal(first.page.nextCursor,'opaque-cursor-1')
  assert.deepEqual(first.interactions.map(x=>x.ordinal),[1])
  assert.equal(first.toolCount,0)
  assert.equal(first.page.hasMore,true)
  const second=nativeReviewNextPage(first,page(2,false))
  assert.equal(second.page.hasMore,false)
  assert.deepEqual(second.interactions.map(x=>x.ordinal),[2])
  assert.equal(nativeReviewNextPage(
    {...first,nativeHookEventsTruncated:true},page(2,false),
  ).nativeHookEventsTruncated,undefined,'per-page completeness must not be invented by adapter')
  assert.throws(()=>nativeReviewDetail(summary,{...page(1,true),sessionId:'different'}))
  assert.throws(()=>nativeReviewDetail(summary,{...page(1,true),boundaryIntegrity:'partial'}))
})

test('native deep-linked Review uses shared model, never SQL file changes or relationships',async()=>{
  const calls:string[]=[]
  const api={
    async nativeSession(value:string){
      calls.push('catalog:'+value)
      return summary
    },
    async nativeReviewById(value:string,options:{cursor?:string}){
      calls.push('native:'+value+(options.cursor?':next':''))
      return options.cursor?page(2,false):page(1,true)
    },
    reviewDetail(){throw Error('Native detail must not use persisted SQL Review')},
    reviewFileChanges(){throw Error('Native detail has no SQL file change projection')},
    relationships(){throw Error('Native detail has no legacy relationships')},
  } as unknown as AgentLensApi
  const model=new AgentLensClientModel(api)
  try{
    await model.selectReviewSession(id)
    const first=model.getSnapshot().review.detail
    assert.equal(first?.id,id)
    assert.equal(first?.statisticsCompleteness,'window')
    assert.equal(first?.page.hasMore,true)
    assert.deepEqual(first?.interactions.map(x=>x.ordinal),[1])
    assert.equal(model.getSnapshot().review.fileChanges?.logicalSessionId,id)
    assert.equal(model.getSnapshot().review.fileChanges?.summary.observedCount,0)
    assert.equal(model.getSnapshot().review.fileChanges?.summary.exactCount,0)
    assert.equal(model.getSnapshot().review.relationships,null)
    await model.loadMoreReviewDetail()
    const second=model.getSnapshot().review.detail
    assert.equal(second?.statisticsCompleteness,'window')
    assert.deepEqual(second?.interactions.map(x=>x.ordinal),[1,2])
    assert.equal(second?.page.hasMore,false)
    await model.selectReviewDetailFilter('errors')
    assert.deepEqual(model.getSnapshot().review.detail?.interactions.map(x=>x.ordinal),[1,2])
    await model.jumpToLatestReviewDetail()
    assert.deepEqual(model.getSnapshot().review.detail?.interactions.map(x=>x.ordinal),[1,2])
    assert.deepEqual(calls,[
      'catalog:'+id,'native:'+id,'native:'+id+':next',
    ])
  }finally{model.stop()}
})

test('native loaded file changes are evidence-only and incremental without SQL reads',()=>{
  const one={...page(1,true),observedFileChanges:[{
    path:'src/service.ts',changeType:'unknown' as const,
    firstChangedAt:at,lastChangedAt:at,evidence:['tool' as const],confidence:'medium' as const,
  }]}
  const first=nativeReviewObservedFileChanges(one)
  assert.equal(first.logicalSessionId,id)
  assert.equal(first.summary.observedCount,1)
  assert.equal(first.summary.exactCount,0)
  assert.equal(first.meta.truncated,true)
  const two={...page(2,false),observedFileChanges:[{
    path:'src/service.ts',changeType:'unknown' as const,
    firstChangedAt:at,lastChangedAt:at,evidence:['tool' as const],confidence:'medium' as const,
  },{
    path:'src/new.ts',changeType:'unknown' as const,
    firstChangedAt:at,lastChangedAt:at,evidence:['tool' as const],confidence:'medium' as const,
  }]}
  const second=nativeReviewObservedFileChanges(two,first)
  assert.deepEqual(second.items.map(item=>item.path),['src/service.ts','src/new.ts'])
  assert.equal(second.meta.truncated,undefined)
})
