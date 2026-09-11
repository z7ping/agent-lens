import assert from 'node:assert/strict'
import test from 'node:test'
import { DefaultPiLiveService } from './service'
import type { PiRuntimeHandle, PiRuntimeHost } from './worker-host'
import type { PiLiveRuntimeState, PiLiveStartInput } from './types'

interface StartCall {
  runtimeSessionId: string
  input: PiLiveStartInput
  exit(error: Error): void
}

function readyState(runtimeSessionId: string, sessionFile: string): PiLiveRuntimeState {
  return {
    runtimeSessionId,
    status: 'ready',
    nativeSessionId: sessionFile.includes('forked') ? 'forked-native' : 'original-native',
    sessionFile,
    isStreaming: false,
    isCompacting: false,
    pendingMessageCount: 0,
    leafId: 'leaf-1',
  }
}

type SessionResolver = (input: PiLiveStartInput) => string

class HistoryHost implements PiRuntimeHost {
  readonly starts: StartCall[] = []
  entries: unknown[] = []

  constructor(private readonly resolveSession: SessionResolver = input => input.historyAction === 'fork'
    ? '/sessions/forked.jsonl'
    : input.sessionPath ?? '/sessions/new.jsonl') {}

  async start(
    runtimeSessionId: string,
    input: PiLiveStartInput,
    _signal: AbortSignal,
    _onEvent: (event: Record<string, unknown>) => void,
    onExit: (error: Error) => void,
  ): Promise<PiRuntimeHandle> {
    const snapshot = { ...input }
    this.starts.push({ runtimeSessionId, input: snapshot, exit: onExit })
    const sessionFile = this.resolveSession(input)
    const state = () => readyState(runtimeSessionId, sessionFile)
    return {
      state: async () => state(),
      snapshot: async () => ({ state: state(), entries: [...this.entries], leafId: 'leaf-1' }),
      controls: async () => ({ models: [], thinkingLevels: [] }),
      setModel: async () => state(),
      setThinkingLevel: async () => state(),
      prompt: async () => {},
      steer: async () => {},
      followUp: async () => {},
      clearQueue: async () => ({ steering: [], followUp: [] }),
      abort: async () => ({ steering: [], followUp: [] }),
      respondToExtension: async () => {},
      terminate: async () => {},
    }
  }
}

async function waitForStatus(service: DefaultPiLiveService, id: string, status: PiLiveRuntimeState['status']): Promise<PiLiveRuntimeState> {
  for (let index = 0; index < 100; index += 1) {
    const state = await service.state(id)
    if (state.status === status) return state
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error(`runtime ${id} did not reach ${status}`)
}

test('继续会话只有确认 Worker 仍持有目标 Session 后才 ready', async () => {
  const host = new HistoryHost()
  const service = new DefaultPiLiveService(host)
  try {
    const originalPath = '/sessions/original.jsonl'
    const continued = await service.start({ cwd: '/workspace', sessionPath: originalPath, historyAction: 'continue' })
    const ready = await waitForStatus(service, continued.runtimeSessionId, 'ready')
    assert.equal(ready.sessionFile, originalPath)
    assert.equal(host.starts.length, 1)
  } finally {
    await service.dispose()
  }
})

test('继续会话的 Snapshot 保留原 Session 历史供 Live 页面恢复', async () => {
  const host = new HistoryHost()
  host.entries = [
    { type: 'message', id: 'history-user', message: { role: 'user', content: [{ type: 'text', text: '旧问题' }] } },
    { type: 'message', id: 'history-assistant', message: { role: 'assistant', content: [{ type: 'text', text: '旧回答' }] } },
  ]
  const service = new DefaultPiLiveService(host)
  try {
    const continued = await service.start({ cwd: '/workspace', sessionPath: '/sessions/original.jsonl', historyAction: 'continue' })
    await waitForStatus(service, continued.runtimeSessionId, 'ready')
    const snapshot = await service.snapshot(continued.runtimeSessionId)

    assert.deepEqual(snapshot.entries, host.entries)
    assert.equal(snapshot.leafId, 'leaf-1')
  } finally {
    await service.dispose()
  }
})

test('继续会话返回其他 Session 时拒绝 ready，避免续错会话', async () => {
  const host = new HistoryHost(() => '/sessions/other.jsonl')
  const service = new DefaultPiLiveService(host)
  try {
    const continued = await service.start({ cwd: '/workspace', sessionPath: '/sessions/original.jsonl', historyAction: 'continue' })
    const failed = await waitForStatus(service, continued.runtimeSessionId, 'failed')
    assert.match(failed.error ?? '', /未保持目标 Session/)
  } finally {
    await service.dispose()
  }
})

test('分叉只有确认新 Session 与原 Session 不同时才 ready', async () => {
  const originalPath = '/sessions/original.jsonl'
  const host = new HistoryHost(input => input.sessionPath ?? originalPath)
  const service = new DefaultPiLiveService(host)
  try {
    const forked = await service.start({ cwd: '/workspace', sessionPath: originalPath, historyAction: 'fork' })
    const failed = await waitForStatus(service, forked.runtimeSessionId, 'failed')
    assert.match(failed.error ?? '', /未切换到新的 Session/)
  } finally {
    await service.dispose()
  }
})

test('分叉成功后锁转移到新 Session，原 Session 可再次启动且重试不会重复分叉', async () => {
  const host = new HistoryHost()
  const service = new DefaultPiLiveService(host)
  try {
    const originalPath = '/sessions/original.jsonl'
    const forked = await service.start({ cwd: '/workspace', sessionPath: originalPath, historyAction: 'fork' })
    await waitForStatus(service, forked.runtimeSessionId, 'ready')

    const repeatedFork = await service.start({ cwd: '/workspace', sessionPath: '/sessions/forked.jsonl', historyAction: 'continue' })
    assert.equal(repeatedFork.runtimeSessionId, forked.runtimeSessionId)

    const original = await service.start({ cwd: '/workspace', sessionPath: originalPath, historyAction: 'continue' })
    await waitForStatus(service, original.runtimeSessionId, 'ready')
    await service.terminate(original.runtimeSessionId)

    const firstForkStart = host.starts.find(item => item.runtimeSessionId === forked.runtimeSessionId)
    assert.ok(firstForkStart)
    firstForkStart.exit(new Error('worker exited'))
    await waitForStatus(service, forked.runtimeSessionId, 'failed')
    await service.retry(forked.runtimeSessionId)
    await waitForStatus(service, forked.runtimeSessionId, 'ready')

    const retryStarts = host.starts.filter(item => item.runtimeSessionId === forked.runtimeSessionId)
    assert.equal(retryStarts.length, 2)
    assert.equal(retryStarts[0]?.input.sessionPath, originalPath)
    assert.equal(retryStarts[0]?.input.historyAction, 'fork')
    assert.equal(retryStarts[1]?.input.sessionPath, '/sessions/forked.jsonl')
    assert.equal(retryStarts[1]?.input.historyAction, 'continue')
  } finally {
    await service.dispose()
  }
})

test('同一 runtimeSessionId 反复读取状态只重新挂载，不重复启动 Worker', async () => {
  const host = new HistoryHost()
  const service = new DefaultPiLiveService(host)
  try {
    const started = await service.start({ cwd: '/workspace' })
    await waitForStatus(service, started.runtimeSessionId, 'ready')
    await service.state(started.runtimeSessionId)
    await service.state(started.runtimeSessionId)
    await service.snapshot(started.runtimeSessionId)
    assert.equal(host.starts.filter(item => item.runtimeSessionId === started.runtimeSessionId).length, 1)
  } finally {
    await service.dispose()
  }
})
