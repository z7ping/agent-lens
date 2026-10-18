import type {
  LiveAdapter, LiveAdapterManifest, LiveCapabilityName, LiveMessageInput,
  LiveRuntimeState, LiveRuntimeEvent, LiveSendOptions, LiveSnapshotWindow,
  LiveModelControl, LiveThinkingControl, StorageService,
} from '@agent-lens/core'
import {
  createLiveCapabilitySet, createLiveInputCapabilities,
  LiveEventChannel, liveMessageToPlainText, normalizeLiveMessage,
} from '@agent-lens/live-support'
import {
  defineAgentLensPlugin, type AgentLensContext,
} from '@agent-lens/runtime-cordis'
import { CodexRpc, type RpcMessage } from './transport.js'
import { CheckpointCodexRecoveryStore, type CodexRecoveryStore } from './recovery.js'
import { normalizeCodexEvent, codexRecord, codexText, codexSnapshotEntries } from './events.js'

const CAPABILITIES = ['create', 'send', 'stream', 'interrupt', 'extension-ui', 'model-switching', 'thinking-control', 'resume', 'recovery'] as const satisfies readonly LiveCapabilityName[]
export const codexLiveManifest: LiveAdapterManifest = {
  pluginId: '@agent-lens/live-codex',
  pluginVersion: '1.0.0-alpha.7',
  apiVersion: '1.0',
  pluginType: 'live',
  displayName: 'Codex Live',
  liveId: 'codex',
  productId: 'codex',
  capabilities: [...CAPABILITIES],
}
interface Session {
  id: string
  cwd: string
  title?: string
  status: LiveRuntimeState['status']
  streaming: boolean
  activeTurn?: string | undefined
  model?: string
  effort?: string | undefined
  channel: LiveEventChannel
  attached: boolean
  attaching?: Promise<void> | undefined
  approvals: Map<string, number | string>
  approvalEvents: Map<string, LiveRuntimeEvent>
}
const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
])

export class CodexLiveAdapter implements LiveAdapter {
  readonly manifest = codexLiveManifest
  readonly capabilities = createLiveCapabilitySet(CAPABILITIES)
  readonly inputCapabilities = createLiveInputCapabilities({
    text: 'native', largeText: 'transform', image: 'unsupported',
    file: 'unsupported', multiline: 'native',
  })
  readonly startCapabilities = { workspace: 'required', title: 'optional' } as const
  private sessions = new Map<string, Session>()
  private restored: Promise<void> | undefined
  private unsubscribe: () => void

  constructor(
    readonly rpc = new CodexRpc(),
    private readonly recovery?: CodexRecoveryStore,
    private readonly storage?: StorageService,
  ) {
    this.unsubscribe = rpc.subscribe(message => this.receive(message))
  }


  private async hydrate(): Promise<void> {
    if (!this.recovery) return
    if (!this.restored) this.restored = (async () => {
      const records = await this.recovery!.list()
      for (const saved of records) {
        if (this.sessions.has(saved.id)) continue
        this.sessions.set(saved.id, {
          id: saved.id, cwd: saved.cwd,
          ...(saved.title ? { title: saved.title } : {}),
          ...(saved.model ? { model: saved.model } : {}),
          ...(saved.effort ? { effort: saved.effort } : {}),
          status: 'ready', streaming: false, attached: false,
          channel: new LiveEventChannel(saved.id), approvals: new Map(), approvalEvents: new Map(),
        })
      }
    })()
    await this.restored
  }

  private async persist(session: Session): Promise<void> {
    await this.recovery?.put({
      id: session.id, cwd: session.cwd,
      ...(session.title ? { title: session.title } : {}),
      ...(session.model ? { model: session.model } : {}),
      ...(session.effort ? { effort: session.effort } : {}),
      updatedAt: new Date().toISOString(),
    })
  }

  private async attach(session: Session): Promise<void> {
    if (session.attached) return
    if (!session.attaching) {
      session.attaching = this.rpc.request('thread/resume', {
        threadId: session.id, excludeTurns: true, approvalPolicy: 'on-request',
      }).then(response => {
        session.attached = true
        session.status = 'ready'
        if (codexText(response.model)) session.model = codexText(response.model)
        if (codexText(response.reasoningEffort)) session.effort = codexText(response.reasoningEffort)
      }).catch(error => {
        session.status = 'failed'
        throw error
      }).finally(() => { session.attaching = undefined })
    }
    await session.attaching
  }

  async availability() {
    return await this.rpc.available()
      ? { available: true }
      : { available: false, reason: 'Codex CLI is not installed or discoverable' }
  }

  async list(): Promise<LiveRuntimeState[]> {
    await this.hydrate()
    return [...this.sessions.values()].map(session => this.view(session))
  }

  async start(value: unknown): Promise<LiveRuntimeState> {
    await this.hydrate()
    const input = codexRecord(value)
    const cwd = codexText(input.workspacePath).trim()
    if (!cwd) throw new TypeError('Codex Live requires workspacePath')
    const response = await this.rpc.request('thread/start', {
      cwd, approvalPolicy: 'on-request',
    })
    const thread = codexRecord(response.thread)
    const id = codexText(thread.id)
    if (!id) throw new Error('Codex thread/start returned no thread id')
    const title = codexText(input.title).trim() || undefined
    const session: Session = {
      id, cwd, ...(title ? { title } : {}),
      ...(codexText(response.model) ? { model: codexText(response.model) } : {}),
      ...(codexText(response.reasoningEffort) ? { effort: codexText(response.reasoningEffort) } : {}),
      status: 'ready',
      streaming: false, attached: true, channel: new LiveEventChannel(id),
      approvals: new Map(), approvalEvents: new Map(),
    }
    this.sessions.set(id, session)
    await this.persist(session)
    if (title) {
      await this.rpc.request('thread/name/set', { threadId: id, name: title }).catch(() => undefined)
    }
    return this.view(session)
  }

  private session(id: string): Session {
    const session = this.sessions.get(id)
    if (!session) throw new Error('Unknown Codex Live runtime session: ' + id)
    return session
  }

  private view(s: Session): LiveRuntimeState {
    return {
      runtimeSessionId: s.id,
      nativeSessionId: s.id,
      workspacePath: s.cwd,
      ...(s.title ? { title: s.title } : {}),
      status: s.status,
      isStreaming: s.streaming,
      pendingMessageCount: 0,
    }
  }

  async state(id: string): Promise<LiveRuntimeState> {
    await this.hydrate()
    const session = this.session(id)
    await this.attach(session)
    return this.view(session)
  }

  async resume(logicalSessionId: string): Promise<LiveRuntimeState> {
    if (!this.storage) throw new Error('Codex history continuation requires canonical storage')
    await this.hydrate()
    const sourceSessions = this.storage.repositories.sessions.listSourceSessionsByLogicalSession
    if (!sourceSessions) throw new Error('Codex historical session lookup is unavailable')
    const [logical, sources] = await Promise.all([
      this.storage.repositories.sessions.getLogicalSession(logicalSessionId),
      sourceSessions(logicalSessionId, { sourceId: 'codex', limit: 8 }),
    ])
    if (!logical || !sources.length) throw new Error('No local Codex source session for this history')
    const nativeIds = [...new Set(sources.map(source => source.nativeSessionId))]
    if (nativeIds.length !== 1) throw new Error('Ambiguous Codex native history; refusing to select a thread')
    const nativeId = nativeIds[0]!
    const workspace = logical.workspaceId
      ? await this.storage.repositories.sessions.getWorkspace(logical.workspaceId) : null
    const saved = this.sessions.get(nativeId)
    if (!saved && !workspace?.path) throw new Error('Codex history has no verified working directory')
    const session = saved ?? {
      id: nativeId, cwd: workspace?.path ?? '',
      status: 'ready' as const, streaming: false, attached: false,
      channel: new LiveEventChannel(nativeId), approvals: new Map(), approvalEvents: new Map(),
    }
    if (!saved) this.sessions.set(nativeId, session)
    await this.attach(session)
    await this.persist(session)
    return this.view(session)
  }

  async snapshot(id: string, _since?: string, window?: LiveSnapshotWindow) {
    await this.hydrate()
    const session = this.session(id)
    await this.attach(session)
    const limit = Math.max(1, Math.min(500, window?.limit ?? 120))
    const response = await this.rpc.request('thread/turns/list', {
      threadId: session.id,
      limit: Math.min(limit, 40),
      sortDirection: 'desc',
      itemsView: 'full',
      ...(window?.before ? { cursor: window.before } : {}),
    })
    const turns = Array.isArray(response.data) ? [...response.data].reverse() : []
    const { entries } = codexSnapshotEntries(turns, limit)
    const before = codexText(response.nextCursor)
    return {
      state: this.view(session), entries,
      page: { hasEarlier: Boolean(before), ...(before ? { before } : {}) },
    }
  }


  private async nativeModels(): Promise<Record<string, unknown>[]> {
    const response = await this.rpc.request('model/list', {})
    return Array.isArray(response.data) ? response.data.map(codexRecord) : []
  }

  async modelControl(id: string): Promise<LiveModelControl | null> {
    const session = this.session(id)
    const models = (await this.nativeModels()).filter(model => !model.hidden && codexText(model.model || model.id))
    if (!models.length) return null
    const options = models.map(model => ({
      value: codexText(model.model || model.id),
      label: codexText(model.displayName) || codexText(model.model || model.id),
      ...(codexText(model.description) ? { description: codexText(model.description) } : {}),
    }))
    return {
      capability: 'model-switching', label: 'Model',
      ...(session.model && options.some(option => option.value === session.model) ? { value: session.model } : {}),
      options,
    }
  }

  async setModelControl(id: string, value: string): Promise<LiveRuntimeState> {
    const session = this.session(id)
    if (session.streaming) throw new Error('Cannot change model while Codex is running')
    const models = await this.nativeModels()
    const selected = models.find(model => !model.hidden && codexText(model.model || model.id) === value)
    if (!selected) throw new Error('Model not available in Codex model/list')
    session.model = value
    session.effort = codexText(selected.defaultReasoningEffort) || undefined
    await this.persist(session)
    session.channel.publish({
      method: 'control.changed', params: { control: 'model' },
      normalizedEvent: { type: 'control.changed', control: 'model' },
    })
    session.channel.publish({
      method: 'control.changed', params: { control: 'thinking' },
      normalizedEvent: { type: 'control.changed', control: 'thinking' },
    })
    return this.view(session)
  }

  async thinkingControl(id: string): Promise<LiveThinkingControl | null> {
    const session = this.session(id)
    const models = await this.nativeModels()
    const model = models.find(candidate => !candidate.hidden
      && codexText(candidate.model || candidate.id) === session.model)
    if (!model || !Array.isArray(model.supportedReasoningEfforts)) return null
    const options = model.supportedReasoningEfforts.map(codexRecord)
      .filter(option => codexText(option.reasoningEffort))
      .map(option => ({
        value: codexText(option.reasoningEffort),
        ...(codexText(option.description) ? { description: codexText(option.description) } : {}),
      }))
    if (!options.length) return null
    const effective = session.effort || codexText(model.defaultReasoningEffort)
    if (!options.some(option => option.value === effective)) return null
    return { capability: 'thinking-control', value: effective, options, label: 'Reasoning effort' }
  }

  async setThinkingControl(id: string, value: string): Promise<LiveRuntimeState> {
    const session = this.session(id)
    if (session.streaming) throw new Error('Cannot change reasoning effort while Codex is running')
    const control = await this.thinkingControl(id)
    if (!control || !control.options.some(option => option.value === value)) {
      throw new Error('Reasoning effort not offered by Codex')
    }
    session.effort = value
    await this.persist(session)
    session.channel.publish({
      method: 'control.changed', params: { control: 'thinking' },
      normalizedEvent: { type: 'control.changed', control: 'thinking' },
    })
    return this.view(session)
  }

  async send(id: string, message: LiveMessageInput, options: LiveSendOptions = {}): Promise<void> {
    await this.hydrate()
    const session = this.session(id)
    await this.attach(session)
    if (session.status !== 'ready') throw new Error('Codex runtime is not ready')
    if (session.streaming) throw new Error('Codex turn is already running')
    if (options.behavior && options.behavior !== 'normal') {
      throw new Error('Codex Live does not support steer or follow-up')
    }
    const text = liveMessageToPlainText(
      normalizeLiveMessage(message), this.inputCapabilities, this.manifest.displayName,
    ).trim()
    if (!text) throw new TypeError('Codex Live requires non-empty text')
    session.streaming = true
    try {
      const response = await this.rpc.request('turn/start', {
        threadId: session.id, input: [{ type: 'text', text }],
        ...(session.model ? { model: session.model } : {}),
        ...(session.effort ? { effort: session.effort } : {}),
      })
      session.activeTurn = codexText(codexRecord(response.turn).id) || undefined
    } catch (error) {
      session.streaming = false
      throw error
    }
  }

  subscribe(id: string, listener: (event: LiveRuntimeEvent) => void): () => void {
    const session = this.session(id)
    const unsubscribe = session.channel.subscribe(value => {
      const method = codexText(value.event.method)
      const params = codexRecord(value.event.params)
      const normalizedEvent = value.event.normalizedEvent
      if (normalizedEvent) {
        listener({ ...value, normalizedEvent: normalizedEvent as LiveRuntimeEvent['normalizedEvent'] })
      } else {
        const normalized = normalizeCodexEvent(method, params)
        listener(normalized ? { ...value, normalizedEvent: normalized } : value)
      }
    })
    for (const pending of session.approvalEvents.values()) {
      const normalizedEvent = pending.event.normalizedEvent as LiveRuntimeEvent['normalizedEvent']
      listener(normalizedEvent ? { ...pending, normalizedEvent } : pending)
    }
    return unsubscribe
  }

  async interrupt(id: string) {
    await this.hydrate()
    const session = this.session(id)
    if (session.streaming) await this.rpc.request('turn/interrupt', { threadId: session.id })
    return {}
  }

  async respondToExtension(id: string, requestId: string, response: unknown): Promise<void> {
    const session = this.session(id)
    const nativeId = session.approvals.get(requestId)
    if (nativeId === undefined) throw new Error('Codex approval request no longer pending')
    const accepted = codexRecord(response).confirmed === true
    this.rpc.respond(nativeId, { decision: accepted ? 'accept' : 'decline' })
    session.approvals.delete(requestId)
    session.approvalEvents.delete(requestId)
  }

  async terminate(id: string): Promise<void> {
    await this.hydrate()
    const session = this.session(id)
    if (session.streaming) await this.interrupt(id).catch(() => undefined)
    for (const nativeId of session.approvals.values()) {
      this.rpc.respond(nativeId, { decision: 'decline' })
    }
    session.approvals.clear()
    session.approvalEvents.clear()
    session.status = 'terminated'
    session.channel.publish({ method: 'runtime/status', params: { status: 'terminated' },
      normalizedEvent: { type: 'status', status: 'terminated' } })
    session.channel.clear()
    this.sessions.delete(id)
    await this.recovery?.remove(id)
  }

  private receive(message: RpcMessage): void {
    if (message.method === 'transport/disconnected') {
      for (const session of this.sessions.values()) {
        session.status = 'failed'
        session.attached = false
        session.streaming = false
        session.channel.publish({ method: message.method, params: message.params,
          normalizedEvent: { type: 'status', status: 'failed', message: 'Codex App Server disconnected' } })
        session.approvals.clear()
        session.approvalEvents.clear()
      }
      return
    }
    const id = codexText(message.params.threadId)
    const session = this.sessions.get(id)
    if (message.id !== undefined) {
      if (!session || !APPROVAL_METHODS.has(message.method)) {
        this.rpc.reject(message.id)
        return
      }
      const requestId = String(message.id)
      session.approvals.set(requestId, message.id)
      const detail = message.method === 'item/commandExecution/requestApproval'
        ? [
            'Command: ' + (codexText(message.params.command) || '[not provided]'),
            ...(codexText(message.params.cwd) ? ['Working directory: ' + codexText(message.params.cwd)] : []),
            ...(codexText(message.params.reason) ? ['Reason: ' + codexText(message.params.reason)] : []),
          ].join('\\n')
        : [
            'File modification requested',
            ...(codexText(message.params.reason) ? ['Reason: ' + codexText(message.params.reason)] : []),
            ...(codexText(message.params.grantRoot) ? ['Requested write root: ' + codexText(message.params.grantRoot)] : []),
          ].join('\\n')
      const approvalEvent = session.channel.publish({ method: message.method, params: message.params,
        normalizedEvent: {
          type: 'ui.request', requestId, method: 'confirm',
          title: 'Codex execution approval',
          message: detail.slice(0, 4000),
        },
      })
      session.approvalEvents.set(requestId, approvalEvent)
      return
    }
    if (!session) return
    if (message.method === 'turn/started') {
      session.streaming = true
      session.activeTurn = codexText(codexRecord(message.params.turn).id) || session.activeTurn
    }
    if (message.method === 'turn/completed') {
      session.streaming = false
      session.activeTurn = undefined
    }
    if (message.method === 'thread/name/updated' && codexText(message.params.name)) {
      session.title = codexText(message.params.name)
    }
    session.channel.publish({ method: message.method, params: message.params })
  }

  async dispose(): Promise<void> {
    this.unsubscribe()
    for (const session of this.sessions.values()) session.channel.clear()
    this.sessions.clear()
    this.rpc.dispose()
  }
}

const activate = Object.assign(
  (ctx: AgentLensContext) => {
    const adapter = new CodexLiveAdapter(
      new CodexRpc(), new CheckpointCodexRecoveryStore(ctx.storage.checkpoints), ctx.storage,
    )
    const registration = ctx.lives.register(adapter)
    return async () => {
      await registration.dispose()
      await adapter.dispose()
    }
  },
  { inject: ['lives', 'storage'] },
)
export const codexLivePlugin = defineAgentLensPlugin(codexLiveManifest, activate)
export * from './events.js'
export * from './transport.js'
export * from './recovery.js'
