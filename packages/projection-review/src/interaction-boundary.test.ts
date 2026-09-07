import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReviewInteractionDto, ReviewMessageNodeDto } from '@agent-lens/protocol'
import { reviewProjectionInternals } from './index'

function messageNode(index: number): ReviewMessageNodeDto {
  const id = `node-${String(index).padStart(4, '0')}`
  const at = new Date(Date.UTC(2026, 8, 5, 4, 0, 0, index)).toISOString()
  return {
    type: 'message',
    id,
    role: index === 0 ? 'user' : 'assistant',
    at,
    sourceId: 'codex',
    capturedAt: at,
    text: id,
    payload: { text: id },
    evidence: [],
    observationIds: [id],
  }
}

function interaction(nodeCount: number): ReviewInteractionDto {
  const nodes = Array.from({ length: nodeCount }, (_, index) => messageNode(index))
  return {
    id: 'session:review:1',
    ordinal: 1,
    trigger: 'user',
    startedAt: nodes[0]?.at ?? '2026-09-05T04:00:00.000Z',
    endedAt: nodes.at(-1)?.at ?? '2026-09-05T04:00:00.000Z',
    nodes,
  }
}

test('ReviewProjection keeps a bounded head/tail window for an oversized interaction', () => {
  const max = reviewProjectionInternals.maxReviewInteractionNodes
  const head = reviewProjectionInternals.reviewInteractionHeadNodes
  const total = max + 137
  const source = interaction(total)

  const bounded = reviewProjectionInternals.boundInteractionNodes(source)

  assert.equal(bounded.nodes.length, max)
  assert.equal(bounded.nodesTruncated, true)
  assert.equal(bounded.totalNodeCount, total)
  assert.equal(bounded.omittedNodeCount, total - max)
  assert.deepEqual(
    bounded.nodes.slice(0, head).map(node => node.id),
    source.nodes.slice(0, head).map(node => node.id),
  )
  assert.deepEqual(
    bounded.nodes.slice(head).map(node => node.id),
    source.nodes.slice(-reviewProjectionInternals.reviewInteractionTailNodes).map(node => node.id),
  )
  assert.equal(bounded.nodes[0]?.id, source.nodes[0]?.id)
  assert.equal(bounded.nodes.at(-1)?.id, source.nodes.at(-1)?.id)
})

test('ReviewProjection does not annotate interactions inside the stable node boundary', () => {
  const source = interaction(reviewProjectionInternals.maxReviewInteractionNodes)
  const bounded = reviewProjectionInternals.boundInteractionNodes(source)

  assert.equal(bounded, source)
  assert.equal(bounded.nodesTruncated, undefined)
  assert.equal(bounded.omittedNodeCount, undefined)
})
