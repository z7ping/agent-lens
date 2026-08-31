import assert from 'node:assert/strict'
import test from 'node:test'
import { DefaultPiLiveService } from './service'
import type {
  InstalledPiSdk,
  PiSdkModel,
  PiSdkSession,
  PiSdkSessionManager,
} from './sdk-loader'

class FakeSessionManager implements PiSdkSessionManager {
  readonly entries: unknown[] = [{ type: 'message', id: 'entry-1' }]
  getSessionId(): string { return 'native-session-1' }
  getSessionFile(): string { return '/sessions/native-session-1.jsonl' }
  getSessionName(): string { return 'SDK task' }
  getLeafId(): string { return 'entry-1' }
  getEntries(): unknown[] { return [...this.entries] }
}

test('Pi Live 通过官方 AgentSession SDK 驱动并保持现有事件/Extension UI Contract', async () => {
  const manager = new FakeSessionManager()
  const models: PiSdkModel[] = [{ provider: 'openai', id: 'gpt-test', name: 'GPT Test', reasoning: true }]
  let agentListener: ((event: Record<string, unknown>) => void) | undefined
  let bindings: Record<string, unknown> | undefined
  const calls: string[] = []
  let currentModel: PiSdkModel | undefined = models[0]
  let name = 'SDK task'
  let streaming = false

  const session: PiSdkSession = {
    sessionManager: manager,
    get sessionId() { return manager.getSessionId() },
    get sessionFile() { return manager.getSessionFile() },
    get sessionName() { return name },
    get model() { return currentModel },
    thinkingLevel: 'medium',
    get isStreaming() { return streaming },
    isCompacting: false,
    pendingMessageCount: 0,
    modelRuntime: {
      getAvailableSnapshot: () => models,
      getAvailable: async () => models,
    },
    bindExtensions: async value => { bindings = value },
    subscribe: listener => {
      agentListener = listener
      return () => { agentListener = undefined }
    },
    setSessionName: value => { name = value },
    setModel: async model => { currentModel = model; calls.push(`model:${model.provider}/${model.id}`) },
    setThinkingLevel: level => { calls.push(`thinking:${level}`) },
    getAvailableThinkingLevels: () => ['off', 'medium', 'high'],
    prompt: async (message, options) => { calls.push(`prompt:${message}:${options?.streamingBehavior ?? 'direct'}`) },
    steer: async message => { calls.push(`steer:${message}`) },
    followUp: async message => { calls.push(`follow:${message}`) },
    clearQueue: () => ({ steering: ['queued-steer'], followUp: ['queued-follow'] }),
    abort: async () => { streaming = false; calls.push('abort') },
    waitForIdle: async () => {},
    dispose: () => { calls.push('dispose') },
  }

  const installed: InstalledPiSdk = {
    executable: '/bin/pi',
    packageRoot: '/node_modules/@earendil-works/pi-coding-agent',
    sdkEntry: '/node_modules/@earendil-works/pi-coding-agent/dist/index.js',
    version: 'test',
    module: {
      createAgentSession: async () => ({ session }),
      SessionManager: {
        create: () => manager,
        open: () => manager,
      },
    },
  }

  const service = new DefaultPiLiveService(async () => installed)
  const state = await service.start({ cwd: '/workspace', provider: 'openai', model: 'gpt-test', name: 'AgentLens task' })
  assert.equal(state.nativeSessionId, 'native-session-1')
  assert.equal(state.sessionName, 'AgentLens task')
  assert.equal(state.processId, undefined)
  assert.equal(calls.includes('model:openai/gpt-test'), true)

  const events: Record<string, unknown>[] = []
  const unsubscribe = service.subscribe(state.runtimeSessionId, event => events.push(event.event))
  agentListener?.({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read' })
  assert.equal(events.some(event => event.type === 'tool_execution_start'), true)

  await service.prompt(state.runtimeSessionId, 'hello', 'followUp')
  await service.steer(state.runtimeSessionId, 'change direction')
  await service.followUp(state.runtimeSessionId, 'afterwards')
  assert.equal(calls.includes('prompt:hello:followUp'), true)
  assert.equal(calls.includes('steer:change direction'), true)
  assert.equal(calls.includes('follow:afterwards'), true)

  const ui = bindings?.uiContext as Record<string, unknown> | undefined
  assert.ok(ui)
  const confirm = ui.confirm as ((title: string, message: string) => Promise<boolean>) | undefined
  assert.ok(confirm)
  const confirmedPromise = confirm('Dangerous action', 'Continue?')
  const request = events.find(event => event.type === 'extension_ui_request' && event.method === 'confirm')
  assert.equal(typeof request?.id, 'string')
  await service.respondToExtension(state.runtimeSessionId, request!.id as string, { confirmed: true })
  assert.equal(await confirmedPromise, true)

  const queue = await service.abort(state.runtimeSessionId)
  assert.deepEqual(queue, { steering: ['queued-steer'], followUp: ['queued-follow'] })

  unsubscribe()
  await service.terminate(state.runtimeSessionId)
  assert.equal(calls.includes('dispose'), true)
})
