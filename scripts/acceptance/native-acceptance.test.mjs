import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { nativeMetricSnapshot, readableNativeWindow, readNativeCatalog } from './native-acceptance.mjs'

test('原生统计保留 partial，不接受缺失或矛盾计数', () => {
  const totals = { eligibleSessions: 2, readySessions: 1, partialSessions: 1, missingSessions: 0, staleSessions: 0 }
  assert.equal(nativeMetricSnapshot({ state: 'available', coverage: 'partial', items: [], totals }).coverage, 'partial')
  assert.equal(nativeMetricSnapshot({ state: 'unsupported' }), null)
  assert.equal(nativeMetricSnapshot({ state: 'available', items: [], totals: { ...totals, readySessions: 2 } }), null)
  assert.equal(readableNativeWindow({ state: 'available', interactions: [{}], boundaryIntegrity: 'partial', pendingTail: false }), false)
  assert.equal(readableNativeWindow({ state: 'available', interactions: [{}], boundaryIntegrity: 'complete', pendingTail: false }), true)
})

test('原生目录验收拒绝空样本、重复分页和游标停滞', async () => {
  let mode = 'empty'
  const id = `native:${'a'.repeat(32)}`
  const server = createServer((request, response) => {
    const second = new URL(request.url, 'http://local').searchParams.has('cursor')
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(mode === 'empty' ? { items: [], hasMore: false }
      : { items: [{ id: second && mode === 'good' ? `native:${'b'.repeat(32)}` : id }],
          hasMore: !second, ...(!second ? { nextCursor: 'next' } : {}) }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const base = `http://127.0.0.1:${server.address().port}`
    await assert.rejects(readNativeCatalog(base), /样本不足/)
    mode = 'duplicate'
    await assert.rejects(readNativeCatalog(base), /分页重复/)
    mode = 'good'
    assert.equal((await readNativeCatalog(base, { minSessions: 2 })).length, 2)
    await assert.rejects(readNativeCatalog(base, { maxPages: 1 }), /页预算/)
  } finally { await new Promise(resolve => server.close(resolve)) }
})
