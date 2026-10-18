import type {
  LiveAdapter, LiveAdapterManifest, LiveCapabilityName, LiveMessageInput,
  LiveRuntimeState, LiveRuntimeEvent, LiveSendOptions, LiveSnapshotWindow,
} from '@agent-lens/core'
import {
  createLiveCapabilitySet, createLiveInputCapabilities,
  LiveEventChannel, liveMessageToPlainText, normalizeLiveMessage,
} from '@agent-lens/live-support'
import {
  defineAgentLensPlugin, type AgentLensContext,
} from '@agent-lens/runtime-cordis'
import { CodexRpc, type RpcMessage } from './transport.js'
import { normalizeCodexEvent, codexRecord, codexText, codexSnapshotEntries } from './events.js'

const CAPABILITIES = ['create', 'send', 'stream', 'interrupt', 'extension-ui'] as const satisfies readonly LiveCapabilityName[]
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
  channel: LiveEventChannel
  approvals: Map<string, number | string>
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
  private unsubscribe: () => void

  constructor(readonly rpc = new CodexRpc()) {
    this.unsubscribe = rpc.subscribe(message => this.receive(message))
  }

  async availability() {
    return await this.rpc.available()
      ? { available: true }
      : { available: false, reason: 'Codex CLI is not installed or discoverable' }
  }

  async list(): Promise<LiveRuntimeState[]> {
    return [...this.sessions.values()].map(session => this.view(session))
  }

  async start(value: unknown): Promise<LiveRuntimeState> {
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
      id, cwd, ...(title ? { title } : {}), status: 'ready',
      streaming: false, channel: new LiveEventChannel(id),
      approvals: new Map(),
    }
    this.sessions.set(id, session)
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
    return this.view(this.session(id))
  }

  async snapshot(id: string, _since?: string, window?: LiveSnapshotWindow) {
    const session = this.session(id)
    const response = await this.rpc.request('thread/read', {
      threadId: session.id, includeTurns: true,
    })
    const thread = codexRecord(response.thread)
    const turns = Array.isArray(thread.turns) ? thread.turns : []
    const limit = window?.limit ?? 120
    const { entries } = codexSnapshotEntries(turns, limit)
    return { state: this.view(session), entries }
  }

  async send(id: string, message: LiveMessageInput, options: LiveSendOptions = {}): Promise<void> {
    const session = this.session(id)
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
    return unsubscribe
  }

  async interrupt(id: string) {
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
  }

  async terminate(id: string): Promise<void> {
    const session = this.session(id)
    if (session.streaming) await this.interrupt(id).catch(() => undefined)
    for (const nativeId of session.approvals.values()) {
      this.rpc.respond(nativeId, { decision: 'decline' })
    }
    session.approvals.clear()
    session.status = 'terminated'
    session.channel.publish({ method: 'runtime/status', params: { status: 'terminated' },
      normalizedEvent: { type: 'status', status: 'terminated' } })
    session.channel.clear()
    this.sessions.delete(id)
  }

  private receive(message: RpcMessage): void {
    if (message.method === 'transport/disconnected') {
      for (const session of this.sessions.values()) {
        session.status = 'failed'
        session.streaming = false
        session.channel.publish({ method: message.method, params: message.params,
          normalizedEvent: { type: 'status', status: 'failed', message: 'Codex App Server disconnected' } })
        session.approvals.clear()
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
        ? codexText(message.params.command) || JSON.stringify(message.params.command) || ''
        : codexText(message.params.reason) || 'Codex requests permission to edit files'
      session.channel.publish({ method: message.method, params: message.params,
        normalizedEvent: {
          type: 'ui.request', requestId, method: 'confirm',
          title: 'Codex execution approval',
          message: detail.slice(0, 4000),
        },
      })
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
    const adapter = new CodexLiveAdapter()
    const registration = ctx.lives.register(adapter)
    return async () => {
      await registration.dispose()
      await adapter.dispose()
    }
  },
  { inject: ['lives'] },
)
export const codexLivePlugin = defineAgentLensPlugin(codexLiveManifest, activate)
export * from './events.js'
export * from './transport.js'
