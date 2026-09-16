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

  assert.ok(node?.type === 'message')
  assert.equal(node.text, '看看图片')
  assert.equal(node.attachments?.[0]?.type, 'image')
  assert.equal(node.attachments?.[0]?.dataUrl, undefined)
})

test('Review pure-image legacy Pi messages do not fall back to no-displayable-text copy', () => {
  const [node] = buildNodes([message({
    nonTextContent: [{ type: 'image', mimeType: 'image/jpeg', data: 'ZmFrZQ==' }],
  })])

  assert.ok(node?.type === 'message')
  assert.equal(node.text, '')
  assert.equal(node.attachments?.[0]?.dataUrl, undefined)
})
