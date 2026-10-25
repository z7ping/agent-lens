import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  CapturePolicyService, NativeSessionMetricOverview,
  NativeSessionMetricsStore, SourceService,
} from '@agent-lens/core'
import {nativeMetricContribution} from './native-metrics-contribution'

const overview=(sourceId:string,ready=1):NativeSessionMetricOverview=>({
  sourceId,eligibleSessions:2,readySessions:ready,
  missingSessions:2-ready,staleSessions:0,partialSessions:0,
  totals:{
    interactionCount:ready*3,toolCallCount:ready*2,toolResultCount:ready*2,
    toolErrorCount:0,errorCount:ready,inputTokens:null,outputTokens:ready*10,
  },
  tools:[],toolsTruncated:false,
})
const sources={
  list:()=>[
    {manifest:{sourceId:'pi',parserVersion:'pi-v2'}},
    {manifest:{sourceId:'codex',parserVersion:'codex-v2'}},
  ],
} as unknown as SourceService
const policy={isSourceEnabled:(sourceId:string)=>sourceId==='pi'}
  as unknown as CapturePolicyService

test('Native-only totals are returned separately with incomplete/unknown coverage',async()=>{
  const called:string[]=[]
  const metrics={
    async overview(q:{sourceId:string;parserVersion:string}){
      called.push(q.sourceId)
      return overview(q.sourceId)
    },
  } as unknown as NativeSessionMetricsStore
  const response=await nativeMetricContribution(metrics,sources,policy,{})
  assert.deepEqual(called,['pi'])
  assert.deepEqual(response,{
    state:'available',coverage:'partial',eligibleSessions:2,readySessions:1,
    missingSessions:1,staleSessions:0,partialSessions:0,
    interactionCount:3,toolCallCount:2,errorCount:1,
    inputTokens:null,outputTokens:10,
  })
  assert.deepEqual(await nativeMetricContribution(metrics,sources,policy,{
    sourceIds:[],
  }),{
    state:'available',coverage:'complete',eligibleSessions:0,readySessions:0,
    missingSessions:0,staleSessions:0,partialSessions:0,
    interactionCount:0,toolCallCount:0,errorCount:0,
    inputTokens:null,outputTokens:null,
  })
})

test('selected disabled or unavailable Source never looks like a verified empty aggregate',async()=>{
  const metrics={overview:async()=>{
    throw Error('Unknown source must not query the metrics store')
  }} as unknown as NativeSessionMetricsStore
  for(const sourceIds of [['codex'],['missing-agent'],['pi','codex']]){
    assert.deepEqual(await nativeMetricContribution(metrics,sources,policy,{sourceIds}),{
      state:'unsupported',reason:'native-metrics-source-scope-unavailable',
    })
  }
})

test('unsupported project and tool filters must not appear as complete aggregates',async()=>{
  const metrics={
    async overview(){throw Error('not accessed')},
  } as unknown as NativeSessionMetricsStore
  for(const filter of [
    {projectId:'proj-1'},{logicalSessionId:'session-1'},{toolName:'shell'},
  ]){
    assert.deepEqual(await nativeMetricContribution(metrics,sources,policy,filter),{
      state:'unsupported',reason:'native-metrics-filter-not-indexed',
    })
  }
})

test('Native-only metrics provider failure cannot silently become zero',async()=>{
  const metrics={
    async overview(){throw Error('db offline')},
  } as unknown as NativeSessionMetricsStore
  assert.deepEqual(await nativeMetricContribution(metrics,sources,policy,{}),{
    state:'unavailable',reason:'native-metrics-contribution-query-failed',
  })
})
