import { PiExtensionUiBridge } from './extension-ui-bridge'
import { assertPiSdkSession } from './pi-sdk-adapter'
import { toPiLiveWireEvent } from './sdk-event'
import type { PiSdkLoader, PiSdkModel, PiSdkSession, PiSdkThinkingLevel } from './sdk-loader'
import type { PiLiveControls, PiLiveQueueState, PiLiveRuntimeState, PiLiveSnapshot, PiLiveStartInput, PiLiveStreamingBehavior } from './types'
import type { PiRuntimeHandle, PiRuntimeHost } from './worker-host'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

class InProcessHandle implements PiRuntimeHandle {
  constructor(private readonly id: string, private readonly session: PiSdkSession, private readonly extensionUi: PiExtensionUiBridge, private readonly unsubscribe: () => void) {}

  async state(): Promise<PiLiveRuntimeState> {
    return { runtimeSessionId: this.id, status: 'ready', initializationStage: 'ready', nativeSessionId: this.session.sessionId,
      ...(this.session.sessionFile ? { sessionFile: this.session.sessionFile } : {}), ...(this.session.sessionName ? { sessionName: this.session.sessionName } : {}),
      ...(this.session.model ? { model: this.session.model } : {}), thinkingLevel: this.session.thinkingLevel, isStreaming: this.session.isStreaming,
      isCompacting: this.session.isCompacting, pendingMessageCount: this.session.pendingMessageCount, leafId: this.session.sessionManager.getLeafId() }
  }
  async snapshot(since?: string): Promise<PiLiveSnapshot> { const all = this.session.sessionManager.getEntries(); const index = since ? all.findIndex(entry => record(entry).id === since) : -1; return { state: await this.state(), entries: since && index >= 0 ? all.slice(index + 1) : all, leafId: this.session.sessionManager.getLeafId() } }
  private async models(provider?: string): Promise<readonly PiSdkModel[]> { const snapshot = this.session.modelRuntime.getAvailableSnapshot(); const filtered = provider ? snapshot.filter(model => model.provider === provider) : snapshot; return filtered.length ? filtered : await this.session.modelRuntime.getAvailable(provider) }
  async controls(): Promise<PiLiveControls> { return { models: (await this.models()).map(({ provider, id, name, reasoning }) => ({ provider, id, ...(name ? { name } : {}), ...(typeof reasoning === 'boolean' ? { reasoning } : {}) })), thinkingLevels: this.session.getAvailableThinkingLevels() } }
  async setModel(provider: string, modelId: string): Promise<PiLiveRuntimeState> { const model = (await this.models(provider)).find(item => item.provider === provider && item.id === modelId); if (!model) throw new Error(`Pi model is not available: ${provider}/${modelId}`); await this.session.setModel(model); return this.state() }
  async setThinkingLevel(level: string): Promise<PiLiveRuntimeState> { this.session.setThinkingLevel(level as PiSdkThinkingLevel); return this.state() }
  async prompt(message: string, behavior?: PiLiveStreamingBehavior): Promise<void> { await new Promise<void>((resolve, reject) => { let accepted = false; const accept = () => { if (!accepted) { accepted = true; resolve() } }; void this.session.prompt(message, { ...(behavior ? { streamingBehavior: behavior } : {}), source: 'rpc', preflightResult: success => { if (success) accept() } }).then(accept, error => { if (!accepted) reject(error) }) }) }
  async steer(message: string): Promise<void> { await this.session.steer(message) }
  async followUp(message: string): Promise<void> { await this.session.followUp(message) }
  async clearQueue(): Promise<PiLiveQueueState> { return this.session.clearQueue() }
  async abort(restoreQueue = true): Promise<PiLiveQueueState> { const queue = restoreQueue ? this.session.clearQueue() : { steering: [], followUp: [] }; await this.session.abort(); return queue }
  async respondToExtension(requestId: string, response: unknown): Promise<void> { this.extensionUi.respond(requestId, response) }
  async terminate(): Promise<void> { this.unsubscribe(); this.extensionUi.dispose(); if (this.session.isStreaming) await this.session.abort().catch(() => undefined); this.session.dispose() }
}

/** 仅用于 SDK 契约测试；生产默认使用独立 Worker。 */
export class InProcessPiRuntimeHost implements PiRuntimeHost {
  constructor(private readonly loadSdk: PiSdkLoader) {}
  async start(id: string, input: PiLiveStartInput, _signal: AbortSignal, onEvent: (event: Record<string, unknown>) => void): Promise<PiRuntimeHandle> {
    const installed = await this.loadSdk(input.executable)
    const manager = input.sessionPath ? installed.module.SessionManager.open(input.sessionPath, input.sessionDir, input.cwd) : installed.module.SessionManager.create(input.cwd, input.sessionDir)
    const created = await installed.module.createAgentSession({ cwd: input.cwd, sessionManager: manager })
    assertPiSdkSession(created.session, installed.sdkEntry, installed.version)
    const session = created.session
    const extensionUi = new PiExtensionUiBridge({ publish: onEvent })
    const unsubscribe = session.subscribe(event => onEvent(toPiLiveWireEvent(record(event))))
    try {
      await session.bindExtensions({ uiContext: extensionUi.context, mode: 'rpc', abortHandler: () => { void session.abort() }, onError: value => onEvent({ type: 'extension_error', error: String(record(value).error ?? 'Unknown extension error') }) })
      if (input.name) session.setSessionName(input.name)
      if (input.provider || input.model) { const snapshot = session.modelRuntime.getAvailableSnapshot(); const models = snapshot.length ? snapshot : await session.modelRuntime.getAvailable(input.provider); const model = models.find(item => (!input.provider || item.provider === input.provider) && (!input.model || item.id === input.model || item.name === input.model)); if (!model) throw new Error(`Pi model is not available: ${[input.provider, input.model].filter(Boolean).join('/')}`); await session.setModel(model) }
      return new InProcessHandle(id, session, extensionUi, unsubscribe)
    } catch (error) { unsubscribe(); extensionUi.dispose(); session.dispose(); throw error }
  }
}
