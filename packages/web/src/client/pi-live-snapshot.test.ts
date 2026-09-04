import assert from 'node:assert/strict'
import test from 'node:test'
import type { JsonValue, PiLiveSnapshotDto } from '@agent-lens/protocol'
import { PiLiveApi } from './pi-live'

function snapshot(entries: JsonValue[], leafId: string): PiLiveSnapshotDto {
  return {
    state: {
      runtimeSessionId: 'runtime',
      status: 'ready',
      initializationStage: 'ready',
      isStreaming: false,
      isCompacting: false,
      pendingMessageCount: 0,
      leafId,
    },
    entries,
    leafId,
  }
}

function response(value: PiLiveSnapshotDto): Response {
  return { ok: true, status: 200, json: async () => value } as Response
}

test('Pi Live snapshot 对调用方保持全局历史，增量传输不会重置轮次编号', async () => {
  const previousFetch = globalThis.fetch
  const requests: string[] = []
  const values = [
    snapshot([{ id: 'round-1-user', text: '第一轮' }], 'round-1-user'),
    snapshot([{ id: 'round-2-user', text: '第二轮' }], 'round-2-user'),
  ]
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (input: RequestInfo | URL) => {
      requests.push(String(input))
      const value = values.shift()
      assert.ok(value)
      return response(value)
    },
  })

  try {
    const api = new PiLiveApi()
    const first = await api.snapshot('runtime')
    const second = await api.snapshot('runtime', first.leafId ?? undefined)

    assert.deepEqual(second.entries, [
      { id: 'round-1-user', text: '第一轮' },
      { id: 'round-2-user', text: '第二轮' },
    ])
    assert.equal(requests[0], '/api/v1/pi-live/runtime/snapshot')
    assert.equal(requests[1], '/api/v1/pi-live/runtime/snapshot?since=round-1-user')
  } finally {
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: previousFetch })
  }
})

test('Pi Live 没有本地基线时忽略 since 并重新获取完整 snapshot', async () => {
  const previousFetch = globalThis.fetch
  const requests: string[] = []
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (input: RequestInfo | URL) => {
      requests.push(String(input))
      return response(snapshot([{ id: 'round-1-user', text: '第一轮' }], 'round-1-user'))
    },
  })

  try {
    const api = new PiLiveApi()
    const value = await api.snapshot('runtime', 'unknown-local-leaf')
    assert.equal(value.entries.length, 1)
    assert.equal(requests[0], '/api/v1/pi-live/runtime/snapshot')
  } finally {
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: previousFetch })
  }
})
