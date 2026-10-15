import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReviewSessionDetailDto } from '@agent-lens/protocol'
import type { AgentLensApi } from './api'
import { AgentLensClientModel } from './model'

interface PendingCall {
  id: string
  signal: AbortSignal | undefined
}

function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (!signal) {
      reject(new Error('Review selection must propagate an AbortSignal'))
      return
    }
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
  })
}

test('switching Review sessions cancels previous detail, file changes and relationships without stale UI errors', async () => {
  const detailCalls: PendingCall[] = []
  const fileCalls: PendingCall[] = []
  const relationshipCalls: PendingCall[] = []
  const api = {
    reviewDetail: async (id: string, options: { signal?: AbortSignal }) => {
      detailCalls.push({ id, signal: options.signal })
      return { id } as ReviewSessionDetailDto
    },
    reviewFileChanges: (id: string, signal?: AbortSignal) => {
      fileCalls.push({ id, signal })
      return untilAborted(signal)
    },
    relationships: (id: string, signal?: AbortSignal) => {
      relationshipCalls.push({ id, signal })
      return untilAborted(signal)
    },
  } as unknown as AgentLensApi
  const model = new AgentLensClientModel(api)

  await model.selectReviewSession('session-A')
  assert.equal(relationshipCalls.length, 1, 'first detail completion must request relationships')
  assert.equal(fileCalls.length, 1)
  assert.equal(detailCalls.length, 1)
  assert.equal(detailCalls[0]?.signal, fileCalls[0]?.signal)
  assert.equal(detailCalls[0]?.signal, relationshipCalls[0]?.signal)

  await model.selectReviewSession('session-B')
  assert.equal(detailCalls[0]?.signal?.aborted, true)
  assert.equal(fileCalls[0]?.signal?.aborted, true)
  assert.equal(relationshipCalls[0]?.signal?.aborted, true)
  assert.equal(detailCalls[1]?.signal?.aborted, false)
  assert.equal(detailCalls[1]?.signal, fileCalls[1]?.signal)
  assert.equal(detailCalls[1]?.signal, relationshipCalls[1]?.signal)
  assert.equal(model.getSnapshot().review.selectedId, 'session-B')
  assert.equal(model.getSnapshot().review.detail?.id, 'session-B')

  // An aborted, superseded read is not a user-visible source failure.
  await Promise.resolve()
  assert.equal(model.getSnapshot().review.fileChangesError, '')
  assert.equal(model.getSnapshot().review.relationshipError, '')

  model.stop()
  assert.equal(detailCalls[1]?.signal?.aborted, true, 'disposing the model must release current requests')
  await Promise.resolve()
  assert.equal(model.getSnapshot().review.fileChangesError, '')
  assert.equal(model.getSnapshot().review.relationshipError, '')
})
