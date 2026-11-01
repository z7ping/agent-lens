import assert from 'node:assert/strict'
import test from 'node:test'
import type { TimelineItemDto } from '@agent-lens/protocol'
import { buildNodes } from './nodes'

function message(payload: TimelineItemDto['payload']): TimelineItemDto {
  return {
    id: 'observation-1',
    kind: 'message.user',
    sourceId: 'pi',
    productId: 'pi',
    hostId: 'host-1',
    installationId: 'installation-1',
    logicalSessionId: 'session-1',
    sourceSessionId: 'source-session-1',
    capturedAt: '2026-09-16T00:00:00.000Z',
    effectiveAt: '2026-09-16T00:00:00.000Z',
    payload,
    evidence: [],
  }
}

test('Review message node exposes canonical historical image attachments', () => {
  const [node] = buildNodes([message({
    text: '看看图片',
    attachments: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }],
  })])

  if (node?.type !== 'message') throw new Error('Expected a message node')
  assert.equal(node.text, '看看图片')
  assert.equal(node.attachments?.[0]?.type, 'image')
  assert.equal(node.attachments?.[0]?.dataUrl, undefined)
  assert.doesNotMatch(JSON.stringify(node.payload), /aGVsbG8=/)
})

test('Review pure-image legacy Pi messages do not fall back to no-displayable-text copy', () => {
  const [node] = buildNodes([message({
    nonTextContent: [{ type: 'image', mimeType: 'image/jpeg', data: 'ZmFrZQ==' }],
  })])

  if (node?.type !== 'message') throw new Error('Expected a message node')
  assert.equal(node.text, '')
  assert.equal(node.attachments?.[0]?.dataUrl, undefined)
  assert.doesNotMatch(JSON.stringify(node.payload), /ZmFrZQ==/)
})

test('distinct same-MIME assistant image blocks with shared native ID never collapse into one attachment',()=>{
  const items=[1,3].map((nativeContentIndex,index):TimelineItemDto=>({
    ...message({text:'',attachments:[{
      type:'image',mimeType:'image/png',nativeContentIndex,
    }]}),
    id:'assistant-image-'+index,kind:'message.assistant',
    nativeEventId:'pi-original-assistant-message',
  }))
  const nodes=buildNodes(items)
  assert.equal(nodes.length,2,'different native content[] image facts must remain visible')
  assert.deepEqual(nodes.map(node=>node.type==='message'
    ?node.attachments?.[0]?.nativeContentIndex:undefined),[1,3])
  assert.deepEqual(nodes.map(node=>node.observationIds),[
    ['assistant-image-0'],['assistant-image-1'],
  ])
})

test('genuine duplicate assistant text without attachments still merges evidence owners',()=>{
  const a={...message({text:'same text'}),id:'assistant-text-a',
    kind:'message.assistant' as const,nativeEventId:'pi-message'}
  const b={...a,id:'assistant-text-b'}
  const nodes=buildNodes([a,b])
  assert.equal(nodes.length,1)
  assert.deepEqual(nodes[0]?.observationIds,['assistant-text-a','assistant-text-b'])
})
