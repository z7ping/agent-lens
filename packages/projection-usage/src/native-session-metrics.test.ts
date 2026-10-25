import assert from 'node:assert/strict'
import test from 'node:test'
import type { ObservationCandidate } from '@agent-lens/core'
import { NativeSessionMetricAccumulator } from './native-session-metrics'

const at='2026-10-25T00:00:00Z'
function candidate(kind:ObservationCandidate['kind'],payload:unknown,extra:Partial<ObservationCandidate>={}):ObservationCandidate{
  return {kind,capturedAt:at,occurredAt:at,payload,identityHints:{nativeSessionId:'native-1'},...extra}
}
const input={
  sourceId:'pi',installationId:'pi-local',nativeSessionId:'native-1',
  fileIdentity:'inode',fileSize:1200,fileMtimeMs:100,
  parserVersion:'pi-v1',projectionVersion:'native-source-metrics-v1',
  computedAt:at,complete:true,
}

test('native metric aggregation reuses normalized Tool/Usage semantics across pages',()=>{
  const accumulator=new NativeSessionMetricAccumulator()
  for(const row of [
    candidate('message.user',{text:'Private prompt: never persist'}),
    candidate('tool.call',{nativeToolName:'shell',callId:'c-1',input:{secret:'hidden'}}),
    candidate('tool.call',{nativeToolName:'read',callId:'c-2',input:{file:'/private/data'}}),
    candidate('usage',{inputTokens:120,outputTokens:30,output:'secret'}),
  ])accumulator.add(row)
  for(const row of [
    candidate('tool.result',{callId:'c-1',success:false,durationMs:22,output:'private stdout'}),
    candidate('tool.result',{callId:'c-2',success:true,durationMs:9}),
    candidate('usage',{inputTokens:7,outputTokens:11}),
    candidate('session.lifecycle',{event:'turn.error',error:'private provider error'}),
    candidate('message.user',{text:'another prompt'}),
  ])accumulator.add(row)
  const snapshot=accumulator.snapshot(input)
  assert.deepEqual({
    coverage:snapshot.coverage,interactions:snapshot.interactionCount,calls:snapshot.toolCallCount,
    results:snapshot.toolResultCount,toolErrors:snapshot.toolErrorCount,errors:snapshot.errorCount,
    input:snapshot.inputTokens,output:snapshot.outputTokens,
  },{coverage:'complete',interactions:2,calls:2,results:2,toolErrors:1,errors:2,input:127,output:41})
  assert.deepEqual(snapshot.tools,[
    {nativeToolName:'read',callCount:1,resultCount:1,errorCount:0,totalDurationMs:9},
    {nativeToolName:'shell',callCount:1,resultCount:1,errorCount:1,totalDurationMs:22},
  ])
  for(const secret of ['Private prompt','secret','/private','private stdout','private provider error']){
    assert.equal(JSON.stringify(snapshot).includes(secret),false)
  }
})

test('partial Token usage does not misreport a sum as fully observed',()=>{
  const a=new NativeSessionMetricAccumulator()
  a.add(candidate('usage',{inputTokens:10,outputTokens:20}))
  a.add(candidate('usage',{outputTokens:30}))
  const snapshot=a.snapshot(input)
  assert.equal(snapshot.inputTokens,null,'missing input in any usage record means unknown')
  assert.equal(snapshot.outputTokens,50)
  const overflow=new NativeSessionMetricAccumulator()
  overflow.add(candidate('usage',{inputTokens:Number.MAX_SAFE_INTEGER,outputTokens:1}))
  overflow.add(candidate('usage',{inputTokens:1,outputTokens:2}))
  const result=overflow.snapshot(input)
  assert.equal(result.inputTokens,null,'overflow must never persist an imprecise integer')
  assert.equal(result.outputTokens,3)
})

test('native coverage is explicitly partial when source tool attribution is missing',()=>{
  const a=new NativeSessionMetricAccumulator()
  a.add(candidate('tool.call',{input:'private secret'}))
  a.add(candidate('usage',{inputTokens:0}))
  const value=a.snapshot(input)
  assert.equal(value.coverage,'partial')
  assert.equal(value.toolCallCount,1)
  assert.equal(value.tools.length,0)
  assert.equal(value.inputTokens,0)
  assert.equal(value.outputTokens,null,
    'Unknown output Token usage must not silently become zero')
  assert.equal(a.snapshot({...input,complete:false}).coverage,'partial')
})
