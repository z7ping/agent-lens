import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentLensApi } from './api'
import type { NativeReviewWindowDto, NativeSessionSummaryDto, ReviewNodeDto } from '@agent-lens/protocol'
import { AgentLensClientModel } from './model'
import { nativeReviewTitle, nativeReviewDetail, nativeReviewNextPage, nativeReviewObservedFileChanges, nativeVisibleWindowStatistics, nativeReviewNodeIsFailure } from './native-review-adapter'

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

test('Source native title provenance is not promoted to explicit or generated',()=>{
  assert.deepEqual(nativeReviewTitle({...summary,titleProvenance:'native'}),{
    title:'Native Pi task',titleKind:'unverified',
  })
  assert.deepEqual(nativeReviewTitle({...summary,titleProvenance:'generated'}),{
    title:'Native Pi task',titleKind:'generated',
  })
  assert.deepEqual(nativeReviewTitle({...summary,titleProvenance:'explicit'}),{
    title:'Native Pi task',titleKind:'explicit',
  })
  assert.deepEqual(nativeReviewTitle({title:''}),{})
})

test('native Review keeps project context when paging Source-owned windows',()=>{
  const context={...summary,projectId:'project-1',projectName:'Slowlight',
    workspacePath:'E:\\work\\Slowlight',titleProvenance:'native' as const}
  const first=nativeReviewDetail(context,page(1,true))
  assert.equal(first.projectId,'project-1')
  assert.equal(first.projectName,'Slowlight')
  assert.equal(first.workspacePath,'E:\\work\\Slowlight')
  assert.equal(first.titleKind,'unverified')
  const next=nativeReviewNextPage(first,page(2,false))
  assert.equal(next.projectId,first.projectId)
  assert.equal(next.projectName,first.projectName)
  assert.equal(next.workspacePath,first.workspacePath)
  assert.equal(next.titleKind,first.titleKind)
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


test('native visible statistics count each source fact once and include terminal lifecycle errors',()=>{
  const turn=page(1,true).interactions[0]!
  const nodes=[
    ...turn.nodes,
    {
      type:'tool' as const,id:'shell-1',at,sourceId:'pi',capturedAt:at,
      name:'shell',status:'error' as const,startedAt:at,endedAt:at,
      payload:{exitCode:1},evidence:[],observationIds:['call-1','result-1'],
    },
    {
      type:'event' as const,id:'turn-error',at,sourceId:'pi',capturedAt:at,
      kind:'session.lifecycle' as const,category:'lifecycle' as const,
      label:'Turn failed',payload:{event:'turn.error'},evidence:[],
      observationIds:['turn-failure'],
    },
  ]
  const statistics=nativeVisibleWindowStatistics([{...turn,nodes}])
  assert.deepEqual(statistics,{
    observationCount:4,interactionCount:1,toolCount:1,errorCount:2,hasErrors:true,
  })
  const detail=nativeReviewDetail(summary,{...page(1,true),interactions:[{...turn,nodes}]})
  assert.equal(detail.errorCount,2)
  assert.equal(detail.observationCount,4)
  assert.equal(detail.statisticsCompleteness,'window')
})

test('native Review pagination rebuilds bounded statistics without SQL totals',async()=>{
  const firstPage=page(1,true)
  const secondPage=page(2,false)
  const firstTurn=firstPage.interactions[0]!
  const secondTurn=secondPage.interactions[0]!
  const loadedFirst:NativeReviewWindowDto={
    ...firstPage,hookEventsTruncated:true,
    interactions:[{...firstTurn,nodes:[
      ...firstTurn.nodes,{
        type:'tool' as const,id:'tool-1',at,sourceId:'pi',capturedAt:at,
        name:'read',status:'error' as const,startedAt:at,
        payload:{},evidence:[],observationIds:['call-1','result-1'],
      },
    ]}],
  }
  const loadedSecond:NativeReviewWindowDto={
    ...secondPage,interactions:[{...secondTurn,nodes:[
      ...secondTurn.nodes,{
        type:'tool' as const,id:'tool-2',at,sourceId:'pi',capturedAt:at,
        name:'read',status:'success' as const,startedAt:at,endedAt:at,
        payload:{},evidence:[],observationIds:['call-2','result-2'],
      },
    ]}],
  }
  const api={
    async nativeSession(){return summary},
    async nativeReviewById(_id:string,options:{cursor?:string}){
      return options.cursor?loadedSecond:loadedFirst
    },
    reviewDetail(){throw Error('Native review must not read legacy SQL aggregates')},
    reviewFileChanges(){throw Error('Native review must not read legacy SQL changes')},
    relationships(){throw Error('Native review must not read legacy SQL relationships')},
  } as unknown as AgentLensApi
  const model=new AgentLensClientModel(api)
  try{
    await model.selectReviewSession(id)
    const first=model.getSnapshot().review.detail
    assert.equal(first?.toolCount,1)
    assert.equal(first?.errorCount,1)
    assert.equal(first?.observationCount,3)
    await model.loadMoreReviewDetail()
    const next=model.getSnapshot().review.detail
    assert.deepEqual(next?.interactions.map(item=>item.ordinal),[1,2])
    assert.equal(next?.interactionCount,2)
    assert.equal(next?.toolCount,2)
    assert.equal(next?.errorCount,1)
    assert.equal(next?.hasErrors,true)
    assert.equal(next?.observationCount,6)
    assert.equal(next?.nativeHookEventsTruncated,true)
    assert.equal(next?.statisticsCompleteness,'window')
  } finally { model.stop() }
})

test('native EOF keeps a safe cursor and incrementally fetches newly completed turns without SQL',async()=>{
  let stage:'waiting'|'new-turn'|'drifted'='waiting'
  const requests:string[]=[]
  const initial=page(1,false)
  const appended=page(2,false)
  const api={
    async nativeSession(){return summary},
    async nativeReviewById(_id:string,options:{cursor?:string}){
      requests.push(options.cursor??'initial')
      if(!options.cursor)return initial
      if(stage==='waiting')return {state:'unsupported',reason:'native-review-no-user-turn'} as const
      if(stage==='drifted')return {state:'drifted',reason:'native-catalog-file-identity-changed'} as const
      return appended
    },
    reviewDetail(){throw Error('Incremental native review must not query SQL detail')},
    reviewFileChanges(){throw Error('Incremental native review must not query SQL files')},
    relationships(){throw Error('Incremental native review must not query SQL relationships')},
  } as unknown as AgentLensApi
  const model=new AgentLensClientModel(api)
  try{
    await model.selectReviewSession(id)
    assert.equal(model.getSnapshot().review.detail?.page.hasMore,false)
    assert.equal(model.getSnapshot().review.detail?.page.nextCursor,'opaque-cursor-1',
      'Source-owned EOF cursor must be reusable after native file append')
    await model.refreshReviewTailIncremental()
    assert.deepEqual(model.getSnapshot().review.detail?.interactions.map(turn=>turn.ordinal),[1])
    assert.equal(model.getSnapshot().review.error,'')
    assert.equal(model.getSnapshot().review.detailLoadingMore,false)
    stage='new-turn'
    await model.refreshReviewTailIncremental()
    assert.deepEqual(model.getSnapshot().review.detail?.interactions.map(turn=>turn.ordinal),[1,2])
    assert.equal(model.getSnapshot().review.detail?.page.nextCursor,'opaque-cursor-2')
    assert.equal(model.getSnapshot().review.detail?.observationCount,2)
    assert.equal(model.getSnapshot().review.detail?.statisticsCompleteness,'window')
    stage='drifted'
    await model.refreshReviewTailIncremental()
    assert.deepEqual(model.getSnapshot().review.detail?.interactions.map(turn=>turn.ordinal),[1,2],
      'Drift must not silently mix records into the current projection')
    assert.match(model.getSnapshot().review.error,/identity|drift|source|原生/i)
    assert.deepEqual(requests,[
      'initial','opaque-cursor-1','opaque-cursor-1','opaque-cursor-2',
    ])
  }finally{model.stop()}
})



test('partial native turn preserves one rail identity and pairs an explicit cross-fragment tool result',async()=>{
  const user=page(1,true).interactions[0]!.nodes[0]!
  const partial:NativeReviewWindowDto={
    ...page(1,true),boundaryIntegrity:'partial',turnFragment:'partial',
    interactions:[{
      ...page(1,true).interactions[0]!,id:'stable-long-turn',
      nodes:[user,{
        type:'tool',id:'call-event',at,sourceId:'pi',capturedAt:at,
        name:'read_file',callId:'cross-chunk',status:'unknown',
        startedAt:at,payload:{name:'read_file'},evidence:[],observationIds:['call-event'],
      }],
    }],
  }
  const continuation:NativeReviewWindowDto={
    ...page(1,false),turnFragment:'complete',
    interactions:[{
      ...page(1,false).interactions[0]!,id:'stable-long-turn',
      nodes:[{
        type:'event',id:'result-event',at,sourceId:'pi',capturedAt:at,
        kind:'tool.result',category:'unknown',label:'tool.result',
        nativeCallId:'cross-chunk',
        payload:{success:true,output:'verified'},evidence:[],observationIds:['result-event'],
      }],
    }],
  }
  const first=nativeReviewDetail(summary,partial)
  assert.equal(first.nativeTurnIncomplete,true)
  const next=nativeReviewNextPage(first,continuation)
  assert.equal(next.nativeTurnIncomplete,undefined)
  assert.equal(next.interactions.length,1)
  assert.equal(next.interactions[0]?.id,'stable-long-turn')
  assert.equal(next.interactions[0]?.nodes.length,2)
  const tool=next.interactions[0]?.nodes[1]
  assert.equal(tool?.type,'tool')
  if(tool?.type!=='tool')return
  assert.equal(tool.status,'success')
  assert.equal(tool.output,'verified')
  assert.deepEqual(tool.observationIds,['call-event','result-event'])
  assert.equal(nativeVisibleWindowStatistics(next.interactions).toolCount,1)

  const api={
    async nativeSession(){return summary},
    async nativeReviewById(_id:string,opts:{cursor?:string}) {
      return opts.cursor?continuation:partial
    },
  } as unknown as AgentLensApi
  const model=new AgentLensClientModel(api)
  try {
    await model.selectReviewSession(id)
    await model.loadMoreReviewDetail()
    const loaded=model.getSnapshot().review.detail
    assert.equal(loaded?.interactions.length,1)
    assert.equal(loaded?.interactions[0]?.id,'stable-long-turn')
    assert.equal(loaded?.nativeTurnIncomplete,false)
    assert.equal(loaded?.toolCount,1)
  }finally{model.stop()}
})

test('unverified partial native windows without a fragment contract remain rejected',()=>{
  assert.throws(()=>nativeReviewDetail(summary,{...page(1,true),boundaryIntegrity:'partial'}))
})

test('indexed native Review opens the last window and jumps by ordinal without previous pages',async()=>{
  const calls:string[]=[]
  const api={
    async nativeSession(){return summary},
    async nativeReviewTurnIndex(_id:string,options:{ordinal?:number;tail?:number}){
      calls.push(options.ordinal?'index:'+options.ordinal:'index:tail')
      const ordinal=options.ordinal??8
      return {
        state:'available',coverage:'complete',knownTurns:10,totalTurns:10,
        scannedOffset:200,hasMore:false,
        items:[{ordinal,cursor:'cursor-'+ordinal}],
      }
    },
    async nativeReviewById(_id:string,options:{cursor?:string}){
      calls.push('review:'+(options.cursor??'first'))
      const ordinal=Number(options.cursor?.split('-').at(-1)??1)
      return page(ordinal,false)
    },
  } as unknown as AgentLensApi
  const model=new AgentLensClientModel(api)
  try{
    await model.selectReviewSession(id)
    assert.deepEqual(model.getSnapshot().review.detail?.interactions.map(x=>x.ordinal),[8])
    await model.jumpToReviewInteraction(3)
    assert.deepEqual(model.getSnapshot().review.detail?.interactions.map(x=>x.ordinal),[3])
    await model.jumpToLatestReviewDetail()
    assert.deepEqual(model.getSnapshot().review.detail?.interactions.map(x=>x.ordinal),[8])
    await model.showReviewFromStart()
    assert.deepEqual(model.getSnapshot().review.detail?.interactions.map(x=>x.ordinal),[1])
    assert.deepEqual(calls,[
      'index:tail','review:cursor-8','index:3','review:cursor-3',
      'index:tail','review:cursor-8','review:first',
    ])
  }finally{model.stop()}
})

test('cross-page native tool result keeps first terminal evidence and exposes conflicting follow-up',()=>{
  const turn=page(1,true).interactions[0]!
  const call:ReviewNodeDto={
    type:'tool',id:'call-one',at,sourceId:'pi',capturedAt:at,
    name:'run',callId:'native-one',status:'unknown',startedAt:at,
    payload:{},evidence:[],observationIds:['call-observation'],
  }
  const result=(id:string,success:boolean,output:string):ReviewNodeDto=>({
    type:'event',id,at,sourceId:'pi',capturedAt:at,
    nativeCallId:'native-one',kind:'tool.result',category:'unknown',
    label:'tool.result',payload:{success,output},
    evidence:[],observationIds:[id],
  })
  const window=(nodes:ReviewNodeDto[],complete:boolean):NativeReviewWindowDto=>({
    ...page(1,!complete),
    ...(complete?{turnFragment:'complete' as const,boundaryIntegrity:'complete' as const}
      :{turnFragment:'partial' as const,boundaryIntegrity:'partial' as const}),
    interactions:[{...turn,id:'same-native-turn',nodes}],
  })
  const first=nativeReviewDetail(summary,window([turn.nodes[0]!,call],false))
  const settled=nativeReviewNextPage(first,window([result('result-one',true,'ok')],false))
  assert.equal(settled.interactions[0]?.nodes.length,2)
  const duplicated=nativeReviewNextPage(settled,
    window([result('result-two',false,'different')],true))
  const nodes=duplicated.interactions[0]!.nodes
  const tool=nodes.find(node=>node.type==='tool')
  assert.equal(tool?.type,'tool')
  if(tool?.type!=='tool')return
  assert.equal(tool.status,'success')
  assert.equal(tool.output,'ok')
  assert.deepEqual(tool.observationIds,['call-observation','result-one'])
  assert.equal(nodes.find(node=>node.id==='result-two')?.type,'event')
  assert.equal(nativeVisibleWindowStatistics(duplicated.interactions).errorCount,1,
    'a contradictory second native result must remain visible as independent failure evidence')
})

test('reused native tool call IDs stay unpaired rather than associating with the wrong tool',()=>{
  const turn=page(1,true).interactions[0]!
  const call=(id:string):ReviewNodeDto=>({
    type:'tool',id,at,sourceId:'pi',capturedAt:at,
    name:id,callId:'recycled-call',status:'unknown',startedAt:at,
    payload:{},evidence:[],observationIds:[id],
  })
  const first:NativeReviewWindowDto={
    ...page(1,true),boundaryIntegrity:'partial',turnFragment:'partial',
    interactions:[{...turn,id:'same-native-turn',
      nodes:[turn.nodes[0]!,call('first-call'),call('second-call')]}],
  }
  const second:NativeReviewWindowDto={
    ...page(1,false),turnFragment:'complete',
    interactions:[{...turn,id:'same-native-turn',nodes:[{
      type:'event',id:'ambiguous-result',at,sourceId:'pi',capturedAt:at,
      nativeCallId:'recycled-call',kind:'tool.result',category:'unknown',
      label:'tool.result',payload:{success:false,output:'ambiguous'},
      evidence:[],observationIds:['ambiguous-result'],
    }]}],
  }
  const merged=nativeReviewNextPage(nativeReviewDetail(summary,first),second)
  const nodes=merged.interactions[0]!.nodes
  assert.deepEqual(nodes.filter(node=>node.type==='tool').map(node=>node.status),
    ['unknown','unknown'])
  assert.equal(nodes.find(node=>node.id==='ambiguous-result')?.type,'event')
  assert.equal(nativeVisibleWindowStatistics(merged.interactions).errorCount,1)
})

test('native Review failure statistics follow shared tool result status semantics',()=>{
  const turn=page(1,true).interactions[0]!
  const nodes:ReviewNodeDto[]=[
    turn.nodes[0]!,{
      type:'event',id:'flagged-error',at,sourceId:'pi',capturedAt:at,
      kind:'tool.result',category:'unknown',label:'tool.result',
      payload:{is_error:true},evidence:[],observationIds:['error'],
    },{
      type:'event',id:'flagged-success',at,sourceId:'pi',capturedAt:at,
      kind:'tool.result',category:'unknown',label:'tool.result',
      payload:{status:'completed'},evidence:[],observationIds:['success'],
    },
  ]
  assert.equal(nativeReviewNodeIsFailure(nodes[1]!),true)
  assert.equal(nativeReviewNodeIsFailure(nodes[2]!),false)
  assert.equal(nativeVisibleWindowStatistics([{...turn,nodes}]).errorCount,1)
})
