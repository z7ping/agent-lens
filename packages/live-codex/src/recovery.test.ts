import test from 'node:test'
import assert from 'node:assert/strict'
import type { CheckpointRepository, StorageService } from '@agent-lens/core'
import { CheckpointCodexRecoveryStore } from './recovery.js'
import { CodexLiveAdapter } from './index.js'
import type { CodexRpc, RpcMessage } from './transport.js'

class MemoryCheckpoints {
  private data = new Map<string, unknown>()
  async get<T>(scope: string, key: string): Promise<T | null> {
    return this.data.get(scope + ':' + key) as T ?? null
  }
  async set(scope: string, key: string, value: unknown) {
    this.data.set(scope + ':' + key, value)
  }
  async clear(scope: string, key: string) {
    this.data.delete(scope + ':' + key)
  }
}

class FakeRpc {
  listener: ((message: RpcMessage) => void) | undefined = undefined
  requests: string[] = []
  async available() { return true }
  subscribe(listener: (message: RpcMessage) => void) {
    this.listener = listener
    return () => { this.listener = undefined }
  }
  async request(method: string) {
    this.requests.push(method)
    if (method === 'thread/start') return { thread: { id: 'native-1' }, model: 'model-a' }
    if (method === 'thread/resume') return { thread: { id: 'native-1' }, model: 'model-a' }
    if (method === 'thread/items/list') return {
      data: [{ turnId: 'turn-1', item: { id: 'msg-1', type: 'agentMessage', text: 'restored reply' } }],
      nextCursor: 'older', backwardsCursor: 'newest',
    }
    if (method === 'turn/start') return { turn: { id: 'turn-1' } }
    return {}
  }
  respond() {}
  reject() {}
  dispose() {}
}

test('Checkpoint stores only recoverable Codex references', async () => {
  const repo = new MemoryCheckpoints()
  const recovery = new CheckpointCodexRecoveryStore(repo as unknown as CheckpointRepository)
  await recovery.put({ id: 'native-1', cwd: '/repo', title: 'Task', updatedAt: new Date().toISOString() })
  assert.equal((await recovery.list())[0]?.id, 'native-1')
  await recovery.remove('native-1')
  assert.deepEqual(await recovery.list(), [])
})

test('Restart reattaches native Thread and reads bounded App Server history', async () => {
  const repo = new MemoryCheckpoints()
  const recovery = new CheckpointCodexRecoveryStore(repo as unknown as CheckpointRepository)
  const first = new CodexLiveAdapter(new FakeRpc() as unknown as CodexRpc, recovery)
  await first.start({ workspacePath: '/repo' })
  await first.dispose()
  const rpc = new FakeRpc()
  const second = new CodexLiveAdapter(rpc as unknown as CodexRpc, recovery)
  const sessions = await second.list()
  assert.equal(sessions.length, 1)
  await second.state('native-1')
  assert.ok(rpc.requests.includes('thread/resume'))
  const snapshot = await second.snapshot('native-1', undefined, { limit: 10 })
  assert.equal(snapshot.entries.length, 1)
  assert.equal(snapshot.page?.hasEarlier, true)
  assert.equal(snapshot.page?.before, 'older')
  assert.equal(snapshot.page?.hasLater, false, 'the initial latest page is not an older-history window')
  await second.dispose()
})

test('Native history resolution rejects ambiguity and resumes only canonical Codex sessions', async () => {
  const rpc = new FakeRpc()
  const storage = { repositories: { sessions: {
    listSourceSessionsByLogicalSession: async () => [{ nativeSessionId: 'native-1' }],
    getLogicalSession: async () => ({ workspaceId: 'w1' }),
    getWorkspace: async () => ({ path: '/repo' }),
  } } } as unknown as StorageService
  const adapter = new CodexLiveAdapter(rpc as unknown as CodexRpc, undefined, storage)
  const state = await adapter.resume('logical-1')
  assert.equal(state.nativeSessionId, 'native-1')
  assert.ok(rpc.requests.includes('thread/resume'))
  await adapter.dispose()
})

test('Pending Codex approval remains visible after Live SSE reconnection', async () => {
  const rpc = new FakeRpc()
  const adapter = new CodexLiveAdapter(rpc as unknown as CodexRpc)
  const state = await adapter.start({ workspacePath: '/repo' })
  rpc.listener?.({
    id: 11, method: 'item/commandExecution/requestApproval',
    params: { threadId: 'native-1', command: 'git status' },
  })
  const received: string[] = []
  const unsubscribe = adapter.subscribe(state.runtimeSessionId, event => {
    if (event.normalizedEvent?.type === 'ui.request') received.push(event.normalizedEvent.requestId)
  })
  assert.deepEqual(received, ['11'])
  unsubscribe()
  await adapter.dispose()
})
