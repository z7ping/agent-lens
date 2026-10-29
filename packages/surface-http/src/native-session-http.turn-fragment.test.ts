import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import type { ObservationCandidate } from '@agent-lens/core'
import type { NativeReviewWindowDto } from '@agent-lens/protocol'
import { handleNativeSessionWindowRequest, type NativeSessionWindowReader } from './native-session-http'

const timestamp = '2026-10-29T00:00:00Z'
const fileIdentity = 'fixture:inode'
const rows = Array.from({ length: 94 }, (_, index) => ({
  kind: index === 0 || index === 91 ? 'message.user'
    : index === 31 ? 'tool.call' : index === 80 ? 'tool.result' : 'message.commentary',
  nativeCallId: index === 31 || index === 80 ? 'cross-fragment-call' : undefined,
  payload: index === 31 ? {callId:'cross-fragment-call',name:'read_file',input:{path:'README.md'}}
    : index === 80 ? {callId:'cross-fragment-call',success:true,output:'verified'}
    : {text:'record '+index},
  occurredAt: timestamp, capturedAt: timestamp,
} as ObservationCandidate))

test('native Review returns resumable, stable one-turn fragments beyond eight source pages', async () => {
  const reader: NativeSessionWindowReader = {
    async read(query) {
      const start = query.cursor?.offset ?? 0
      const end = Math.min(start + (query.limit ?? 8), rows.length)
      return {
        state: 'available',
        observations: rows.slice(start, end),
        observationRecordIds: rows.slice(start, end).map((_, index) => 'record-' + (start + index)),
        observationCursors: rows.slice(start, end).map((_, index) => ({
          offset: start + index, sequence: start + index, fileIdentity,
        })),
        evidenceCandidates: [],
        nextCursor: {offset:end,sequence:end,fileIdentity},
        hasMore: end < rows.length,
        pendingTail: false,
      }
    },
  }
  const server = createServer((request, response) => {
    void handleNativeSessionWindowRequest(
      request,response,new URL(request.url ?? '/', 'http://127.0.0.1'),reader,
    ).catch(error => { response.statusCode = 500; response.end(String(error)) })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const addr = server.address()
    assert(addr && typeof addr !== 'string')
    const base = 'http://127.0.0.1:' + addr.port
      + '/api/v1/native-sessions/window?sourceId=codex&installationId=inst'
      + '&nativeSessionId=session&format=review-turns&turnLimit=1'
    const firstResponse = await fetch(base)
    assert.equal(firstResponse.status, 200)
    const first = await firstResponse.json() as NativeReviewWindowDto
    assert.equal(first.state, 'available')
    assert.equal(first.pagingUnit, 'interaction')
    assert.equal(first.boundaryIntegrity, 'partial')
    assert.equal(first.turnFragment, 'partial')
    assert.equal(first.interactions.length, 1)
    assert.equal(first.interactions[0]?.ordinal, 1)
    const nextResponse = await fetch(base + '&cursor=' + encodeURIComponent(first.nextCursor))
    assert.equal(nextResponse.status, 200)
    const next = await nextResponse.json() as NativeReviewWindowDto
    assert.equal(next.state, 'available')
    assert.equal(next.pagingUnit, 'interaction')
    assert.equal(next.boundaryIntegrity, 'complete')
    assert.equal(next.turnFragment, 'complete')
    assert.equal(next.interactions.length, 1)
    assert.equal(next.interactions[0]?.id, first.interactions[0]?.id)
    assert.equal(next.interactions[0]?.ordinal, 1)
    assert.notEqual(next.nextCursor, first.nextCursor)
    assert.equal(next.interactions[0]?.nodes.some(node => node.type === 'event'
      && node.kind === 'tool.result'), true,
      'the result must remain evidence-bearing even before client reconciliation')
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
