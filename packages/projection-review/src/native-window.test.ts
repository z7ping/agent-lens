import assert from 'node:assert/strict'
import test from 'node:test'
import type { ObservationCandidate } from '@agent-lens/core'
import { projectNativeReviewWindow, overlayNativeHookEvents, nativeReviewObservationId } from './native-window'

const at = '2026-10-25T04:00:00Z'
const candidate = (kind: ObservationCandidate['kind'], sourceSequence: number,
  payload: unknown): ObservationCandidate => ({
  kind, capturedAt: at, sourceSequence,
  identityHints: { nativeSessionId: 'original-session' },
  payload,
})
const page = {
  sourceId: 'pi', installationId: 'pi-one', nativeSessionId: 'original-session',
  hasMore: false, pendingTail: false, hasPrevious: false,
  nextCursor: 'opaque-cursor',
}

test('native page reuses actual Review grouping and tool-call/result pairing, no stored evidence IDs', () => {
  const observations = [
    candidate('message.user', 1000, { text: 'run test' }),
    candidate('tool.call', 2000, { callId: 'call-1', nativeToolName: 'shell', input: { command: 'npm test' } }),
    candidate('tool.result', 3000, { callId: 'call-1', success: true, output: 'passed' }),
    candidate('message.assistant', 4000, { text: 'all tests passed' }),
  ]
  const original = projectNativeReviewWindow({
    ...page, observations, observationRecordIds: ['r1','r2','r3','r4'],
  })
  assert.equal(original.state, 'available')
  assert.equal(original.boundaryIntegrity, 'complete')
  assert.equal(original.observationCount, 4)
  assert.equal(original.interactions.length, 1)
  const interaction = original.interactions[0]!
  assert.equal(interaction.trigger, 'user')
  assert.equal(interaction.nodes.length, 3)
  const tool = interaction.nodes.find(node => node.type === 'tool')
  assert.equal(tool?.type, 'tool')
  if (tool?.type !== 'tool') return
  assert.equal(tool.name, 'shell')
  assert.equal(tool.status, 'success')
  assert.deepEqual(tool.input, { command: 'npm test' })
  assert.equal(tool.output, 'passed')
  assert.equal(tool.observationIds.length, 2)
  assert.deepEqual(tool.evidence, [])

  const reopened = projectNativeReviewWindow({
    ...page, observations, observationRecordIds: ['r1','r2','r3','r4'],
    hasMore: true,
  })
  assert.equal(reopened.sessionId, original.sessionId)
  assert.equal(reopened.interactions[0]?.nodes[1]?.id, interaction.nodes[1]?.id)
  assert.equal(reopened.boundaryIntegrity, 'partial')
})

test('native Review page explicitly flags cross-window tool pairing as partial, never invents success', () => {
  const left = projectNativeReviewWindow({
    ...page, observations: [
      candidate('message.user', 1000, { text: 'run' }),
      candidate('tool.call', 2000, { callId: 'split', nativeToolName: 'shell' }),
    ],
    observationRecordIds: ['a','b'],
    hasMore: true,
  })
  const right = projectNativeReviewWindow({
    ...page, observations: [candidate('tool.result', 3000, { callId: 'split', success: true })],
    observationRecordIds: ['c'], hasPrevious: true,
  })
  assert.equal(left.boundaryIntegrity, 'partial')
  assert.equal(right.boundaryIntegrity, 'partial')
  assert.notEqual(left.interactions[0]?.id, right.interactions[0]?.id)
  const leftTool = left.interactions.flatMap(turn => turn.nodes).find(node => node.type === 'tool')
  assert.equal(leftTool?.type, 'tool')
  if (leftTool?.type === 'tool') assert.equal(leftTool.status, 'unknown')
  const rightNodes = right.interactions.flatMap(turn => turn.nodes)
  assert.equal(rightNodes[0]?.type, 'event')
  assert.notEqual(rightNodes[0]?.id, leftTool?.id)
})

test('native Review nodes use source record identity rather than page-local indices', () => {
  const observations = [candidate('message.user', 1000, { text: 'repeat' })]
  const first = projectNativeReviewWindow({
    ...page, observations, observationRecordIds: ['same-record'],
  })
  const second = projectNativeReviewWindow({
    ...page, observations, observationRecordIds: ['same-record'],
    hasPrevious: true,
  })
  assert.equal(first.interactions[0]?.nodes[0]?.id, second.interactions[0]?.nodes[0]?.id)
  assert.throws(() => projectNativeReviewWindow({
    ...page, observations, observationRecordIds: [],
  }), /identity counts disagree/)
  const circular: { self?: unknown } = {}
  circular.self = circular
  const safe = projectNativeReviewWindow({
    ...page,
    observations: [candidate('message.assistant', 1000, circular)],
    observationRecordIds: ['circle'],
  })
  assert.equal(JSON.stringify(safe).includes('[circular]'), true)
})

test('native Review file changes reuse mutation evidence projection without stored SQL events', () => {
  const result = projectNativeReviewWindow({
    ...page,
    completeBoundaries: true,
    observations: [
      candidate('message.user', 1, { text:'Edit file' }),
      candidate('tool.call', 2, {callId:'write-1',nativeToolName:'write_file',input:{path:'src/main.ts',content:'hello'}}),
      candidate('tool.result',3, {callId:'write-1',status:'success'}),
      candidate('tool.call',4, {callId:'shell-1',nativeToolName:'shell',input:{command:'rm src/secret.ts'}}),
      candidate('tool.result',5, {callId:'shell-1',status:'success'}),
      candidate('tool.call',6, {callId:'delete-1',nativeToolName:'delete_file',input:{path:'src/unused.ts'}}),
      candidate('tool.result',7, {callId:'delete-1',status:'error'}),
    ],
    observationRecordIds:['a','b','c','d','e','f','g'],
  })
  assert.equal(result.pagingUnit,'interaction')
  assert.deepEqual(result.observedFileChanges?.map(item=>item.path),['src/main.ts'])
  assert.equal(result.observedFileChanges?.[0]?.confidence,'medium')
  assert.equal(result.observedFileChanges?.[0]?.changeType,'unknown')
  assert.equal(result.fileChangesTruncated,undefined)
  assert.equal(JSON.stringify(result).includes('evidenceRefs'),false)
})

test('native attachment cursor binds to canonical observation ID without exposing image bytes in Review',()=>{
  const c=candidate('message.user',1,{text:'image',attachments:[
    {type:'image',mimeType:'image/png',data:'aGVsbG8='},
  ]})
  const result=projectNativeReviewWindow({
    ...page,observations:[c],observationRecordIds:['record-id'],
    observationCursors:['opaque-exact-record-cursor'],completeBoundaries:true,
  })
  const message=result.interactions[0]?.nodes.find(node=>node.type==='message')
  assert.equal(message?.type,'message')
  if(message?.type!=='message')return
  assert.equal(message.id,nativeReviewObservationId('pi','pi-one','original-session',c,'record-id',0))
  assert.equal(message.nativeAttachmentCursor,'opaque-exact-record-cursor')
  assert.equal(message.attachments?.length,1)
  assert.equal(JSON.stringify(result).includes('aGVsbG8='),false)
  assert.throws(()=>projectNativeReviewWindow({
    ...page,observations:[c],observationRecordIds:['record-id'],observationCursors:[],
  }),/rewind cursor identity counts disagree/)
})
test('native tool pairing uses normalized nativeCallId when payload has no alias', () => {
  const observations: ObservationCandidate[] = [
    candidate('message.user', 1, { text: 'run' }),
    { ...candidate('tool.call', 2, {nativeToolName:'shell',input:{command:'ls'}}), nativeCallId:'native-call-7' },
    { ...candidate('tool.result', 3, {success:true,output:'done'}), nativeCallId:'native-call-7' },
  ]
  const projected = projectNativeReviewWindow({
    ...page, observations, observationRecordIds:['user','call','result'],
    completeBoundaries:true,
  })
  const tool = projected.interactions[0]?.nodes.find(node => node.type === 'tool')
  assert.equal(tool?.type, 'tool')
  if (tool?.type !== 'tool') return
  assert.equal(tool.callId, 'native-call-7')
  assert.equal(tool.status, 'success')
  assert.deepEqual(tool.observationIds.length, 2)
  assert.equal(tool.output, 'done')
})

test('native Hook overlay only merges attested permission/subagent facts within complete native user turns',()=>{
  const earlier='2026-10-25T04:00:00Z'
  const later='2026-10-25T04:00:03Z'
  const native=projectNativeReviewWindow({
    ...page, completeBoundaries:true,
    observations:[
      {...candidate('message.user',1,{text:'task'}),occurredAt:earlier},
      {...candidate('message.assistant',2,{text:'done'}),occurredAt:later},
    ],
    observationRecordIds:['user-record','assistant-record'],
  })
  const hooks: ObservationCandidate[]=[
    {...candidate('permission.request',5,{toolName:'shell'}),occurredAt:'2026-10-25T04:00:01Z'},
    {...candidate('subagent.spawn',6,{nativeActorId:'A1'}),occurredAt:'2026-10-25T04:00:02Z'},
    // Do not duplicate user messages or tool chains without stable event linkage.
    {...candidate('message.user',7,{text:'task'}),occurredAt:earlier},
    {...candidate('tool.call',8,{callId:'hook-tool'}),occurredAt:'2026-10-25T04:00:01Z'},
    // A capture timestamp alone cannot locate a source fact in a user turn.
    candidate('permission.response',9,{decision:'allow'}),
    // Some Source adapters fill occurredAt from capture time when the Hook
    // lacks its own timestamp; never infer a user turn from that alone.
    {...candidate('permission.request',11,{decision:'unknown-clock'}),occurredAt:at},
    // Recorded after the complete turn: do not pull into a finished turn.
    {...candidate('context.injected',10,{text:'late'}),occurredAt:'2026-10-25T04:00:04Z'},
  ]
  const merged=overlayNativeHookEvents({
    window:native,observations:hooks,
    observationRecordIds:hooks.map((_,index)=>'hook-record-'+index),
    truncated:true,
  })
  const nodes=merged.interactions[0]?.nodes ?? []
  assert.deepEqual(nodes.map(n=>n.type==='event'?n.kind:n.type),[
    'message','permission.request','subagent.spawn','message',
  ])
  assert.equal(nodes[0]?.type,'message')
  assert.equal(merged.boundaryIntegrity,'complete')
  assert.equal(merged.observationCount,native.observationCount+2)
  assert.equal(merged.hookEventsTruncated,true)
  assert.equal(merged.hookFactsPartial,true)
  assert.equal(JSON.stringify(merged).includes('hook-tool'),false)
  const again=overlayNativeHookEvents({
    window:merged,observations:hooks,
    observationRecordIds:hooks.map((_,index)=>'hook-record-'+index),
    truncated:true,
  })
  assert.deepEqual(again.interactions,merged.interactions)
  assert.equal(again.observationCount,merged.observationCount)
})

test('Hook overlay rejects partial native turns and inconsistent record provenance',()=>{
  const observations=[candidate('permission.request',1,{decision:'prompt'})]
  const native=projectNativeReviewWindow({
    ...page,observations:[candidate('message.user',0,{text:'run'})],
    observationRecordIds:['user'],completeBoundaries:true,
  })
  assert.throws(()=>overlayNativeHookEvents({
    window:{...native,boundaryIntegrity:'partial'},
    observations,observationRecordIds:['h1'],truncated:false,
  }),/complete native user-turn/)
  assert.throws(()=>overlayNativeHookEvents({
    window:native,observations,observationRecordIds:[],truncated:false,
  }),/exact source record provenance/)
})

test('Hook events sharing one native correlation ID retain distinct request and response facts',()=>{
  const native=projectNativeReviewWindow({
    ...page,completeBoundaries:true,
    observations:[
      {...candidate('message.user',1,{text:'run'}),occurredAt:'2026-10-25T04:00:00Z'},
      {...candidate('message.assistant',2,{text:'done'}),occurredAt:'2026-10-25T04:00:05Z'},
    ],
    observationRecordIds:['native-user','native-reply'],
  })
  const events:ObservationCandidate[]=[
    {...candidate('permission.request',3,{decision:'prompt'}),occurredAt:'2026-10-25T04:00:01Z',nativeEventId:'same-hook-id'},
    {...candidate('permission.response',4,{decision:'allow'}),occurredAt:'2026-10-25T04:00:02Z',nativeEventId:'same-hook-id'},
    {...candidate('permission.request',5,{decision:'prompt'}),occurredAt:'2026-10-25T04:00:03Z',nativeEventId:'same-hook-id'},
  ]
  const result=overlayNativeHookEvents({
    window:native,observations:events,
    observationRecordIds:['req-one','response','duplicate-request'],
    truncated:false,
  })
  assert.deepEqual(result.interactions[0]?.nodes.map(node=>node.type==='event'?node.kind:node.type),[
    'message','permission.request','permission.response','message',
  ])
  assert.equal(result.observationCount,native.observationCount+2)
  assert.equal(result.hookFactsPartial,true,'the ambiguous duplicate remains standalone')
})

test('empty Hook archive is not evidence of complete runtime capture history',()=>{
  const native=projectNativeReviewWindow({
    ...page,
    observations:[
      {...candidate('message.user',1,{text:'hello'}),occurredAt:'2026-10-25T04:00:00Z'},
      {...candidate('message.assistant',2,{text:'world'}),occurredAt:'2026-10-25T04:00:02Z'},
    ],
    observationRecordIds:['native-user','native-assistant'],
    completeBoundaries:true,
  })
  const overlaid=overlayNativeHookEvents({
    window:native,observations:[],observationRecordIds:[],truncated:false,
  })
  assert.equal(overlaid.boundaryIntegrity,'complete','original transcript turn is still verified')
  assert.equal(overlaid.hookFactsPartial,true,
    'no archived Hook events does not prove there were no historical Hook facts')
  assert.equal(overlaid.hookEventsTruncated,undefined,
    'no page truncated is independent of unknown historical capture coverage')
  assert.deepEqual(overlaid.interactions,native.interactions)
})

test('native Review Evidence attaches only exact SourceRecord provenance without leaking local paths',()=>{
  const session={
    ...page,
    completeBoundaries:true,
    observations:[
      candidate('message.user',1,{text:'please inspect'}),
      candidate('tool.call',2,{callId:'cmd-1',nativeToolName:'shell'}),
      candidate('tool.result',3,{callId:'cmd-1',success:true,output:'ok'}),
    ],
    observationRecordIds:['native-r1','native-r2','native-r2'],
    evidenceCandidates:[
      {captureMethod:'native-log' as const,derivation:'reported' as const,
        sourceRecordId:'native-r2',confidenceHint:'exact' as const,
        parserVersion:'1',capturedAt:at,
        sourceLocator:{kind:'file' as const,path:'/private/secret/native.jsonl',offset:123}},
      {captureMethod:'runtime-hook' as const,derivation:'observed' as const,
        sourceRecordId:'another-native-record',confidenceHint:'high' as const,
        capturedAt:at,missingReason:'secret:///host/hidden'},
      {captureMethod:'native-log' as const,derivation:'reported' as const,
        capturedAt:at,sourceLocator:{kind:'file' as const,path:'/private/unknown.jsonl'}},
    ],
  }
  const first=projectNativeReviewWindow(session)
  const nodes=first.interactions.flatMap(turn=>turn.nodes)
  const tool=nodes.find(node=>node.type==='tool')
  assert.equal(tool?.type,'tool')
  if(tool?.type!=='tool')return
  assert.equal(tool.evidence.length,2,
    'tool call/result from the same source record must retain exact provenance')
  assert.equal(tool.evidence[0]?.confidence,'exact')
  assert.equal(tool.evidence[0]?.captureMethod,'native-log')
  assert.equal(tool.evidence[0]?.id.startsWith('native-evidence:'),true)
  assert.equal(nodes.find(node=>node.type==='message')?.evidence.length,0,
    'one record must never claim evidence from a different SourceRecord')
  assert.deepEqual(projectNativeReviewWindow(session).interactions,first.interactions,
    'derived evidence identities must be stable across native rehydration')
  const serialized=JSON.stringify(first)
  assert.equal(serialized.includes('/private/'),false)
  assert.equal(serialized.includes('secret://'),false)
  assert.equal(serialized.includes('sourceLocator'),false)
  assert.equal(serialized.includes('another-native-record'),false)
})

