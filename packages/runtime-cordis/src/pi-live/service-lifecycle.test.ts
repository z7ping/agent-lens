import assert from 'node:assert/strict'
import test from 'node:test'
import type { PiLiveRuntimeState } from './types'
import { DefaultPiLiveService } from './service'
import type { PiRuntimeHandle, PiRuntimeHost } from './worker-host'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function readyState(id: string): PiLiveRuntimeState {
  return { runtimeSessionId: id, status: 'ready', initializationStage: 'ready', isStreaming: false, isCompacting: false, pendingMessageCount: 0, leafId: null }
}

function handle(id: string): PiRuntimeHandle {
  return {
    processId: 1234,
    state: async () => readyState(id),
    snapshot: async () => ({ state: readyState(id), entries: [], leafId: null }),
    controls: async () => ({ models: [], thinkingLevels: [] }),
    setModel: async () => readyState(id), setThinkingLevel: async () => readyState(id),
    prompt: async () => {}, steer: async () => {}, followUp: async () => {},
    clearQueue: async () => ({ steering: [], followUp: [] }),
    abort: async () => ({ steering: [], followUp: [] }), respondToExtension: async () => {}, terminate: async () => {},
  }
}

test('Start 立即返回 initializing，后台就绪后原位切换为 ready', async () => {
  const gate = deferred<PiRuntimeHandle>()
  const host: PiRuntimeHost = { start: async () => gate.promise }
  const service = new DefaultPiLiveService(host)
  const before = performance.now()
  const initial = await service.start({ cwd: '/workspace', name: '异步任务' })
  assert.equal(initial.status, 'initializing')
  assert.ok(performance.now() - before < 200)
  gate.resolve(handle(initial.runtimeSessionId))
  await new Promise(resolve => setTimeout(resolve, 0))
  const ready = await service.state(initial.runtimeSessionId)
  assert.equal(ready.status, 'ready')
  assert.equal(ready.processId, 1234)
  await service.dispose()
})

test('initializing 期间 Terminate 会发出取消信号且不留下 Runtime', async () => {
  let aborted = false
  const host: PiRuntimeHost = {
    start: async (_id, _input, signal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true }))
      throw new Error('cancelled')
    },
  }
  const service = new DefaultPiLiveService(host)
  const initial = await service.start({ cwd: '/workspace' })
  await service.terminate(initial.runtimeSessionId)
  assert.equal(aborted, true)
  assert.deepEqual(await service.list(), [])
})

test('初始化失败保留可诊断状态，并且只允许显式 Retry', async () => {
  let calls = 0
  const host: PiRuntimeHost = {
    start: async id => {
      calls += 1
      if (calls === 1) throw new Error('token=secret initialization failed')
      return handle(id)
    },
  }
  const service = new DefaultPiLiveService(host)
  const initial = await service.start({ cwd: '/workspace' })
  await new Promise(resolve => setTimeout(resolve, 0))
  const failed = await service.state(initial.runtimeSessionId)
  assert.equal(failed.status, 'failed')
  assert.doesNotMatch(failed.error ?? '', /secret/)
  assert.equal((await service.retry(initial.runtimeSessionId)).status, 'initializing')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal((await service.state(initial.runtimeSessionId)).status, 'ready')
  assert.equal(calls, 2)
  await service.dispose()
})

test('同一 Pi 历史文件不能被两个 Runtime 同时继续', async () => {
  const host: PiRuntimeHost = {
    start: async (_id, _input, signal) => new Promise<PiRuntimeHandle>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    }),
  }
  const service = new DefaultPiLiveService(host)
  const first = await service.start({ cwd: '/workspace', sessionPath: '/sessions/history.jsonl' })

  await assert.rejects(
    () => service.start({ cwd: '/workspace', sessionPath: '/sessions/history.jsonl' }),
    /已经在进行中/,
  )

  await service.terminate(first.runtimeSessionId)
})
