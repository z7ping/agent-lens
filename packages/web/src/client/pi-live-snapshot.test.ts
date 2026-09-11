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


test('Pi Live 同一 Runtime 的并发 Snapshot 串行执行并让后续请求使用最新基线', async () => {
  const previousFetch = globalThis.fetch
  const requests: string[] = []
  let releaseFirst: ((value: Response) => void) | undefined
  const firstResponse = new Promise<Response>(resolve => { releaseFirst = resolve })

  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (input: RequestInfo | URL) => {
      const url = String(input)
      requests.push(url)
      if (requests.length === 1) return firstResponse
      return response(snapshot([{ id: 'round-2-user', text: '第二轮' }], 'round-2-user'))
    },
  })

  try {
    const api = new PiLiveApi()
    const first = api.snapshot('runtime')
    const second = api.snapshot('runtime', 'round-1-user')

    await Promise.resolve()
    assert.deepEqual(requests, ['/api/v1/pi-live/runtime/snapshot'])

    releaseFirst?.(response(snapshot([{ id: 'round-1-user', text: '第一轮' }], 'round-1-user')))
    const [firstValue, secondValue] = await Promise.all([first, second])

    assert.equal(firstValue.leafId, 'round-1-user')
    assert.deepEqual(requests, [
      '/api/v1/pi-live/runtime/snapshot',
      '/api/v1/pi-live/runtime/snapshot?since=round-1-user',
    ])
    assert.deepEqual(secondValue.entries, [
      { id: 'round-1-user', text: '第一轮' },
      { id: 'round-2-user', text: '第二轮' },
    ])
  } finally {
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: previousFetch })
  }
})

test('Pi Live 前一个 Snapshot 失败后不会阻塞同 Runtime 的后续对账', async () => {
  const previousFetch = globalThis.fetch
  let calls = 0
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async () => {
      calls += 1
      if (calls === 1) {
        return {
          ok: false,
          status: 502,
          json: async () => ({ message: 'Pi Live 历史快照加载失败' }),
        } as Response
      }
      return response(snapshot([{ id: 'recovered', text: '恢复' }], 'recovered'))
    },
  })

  try {
    const api = new PiLiveApi()
    await assert.rejects(api.snapshot('runtime'), /历史快照加载失败/)
    const recovered = await api.snapshot('runtime')
    assert.equal(calls, 2)
    assert.equal(recovered.leafId, 'recovered')
  } finally {
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: previousFetch })
  }
})
