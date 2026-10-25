import assert from 'node:assert/strict'
import test from 'node:test'
import type { ObservationCandidate } from '@agent-lens/core'
import { projectNativeReviewWindow, nativeReviewObservationId } from './native-window'

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
