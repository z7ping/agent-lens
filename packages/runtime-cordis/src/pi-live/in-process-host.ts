import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { PiExtensionUiBridge } from './extension-ui-bridge'
import { assertPiSdkSession, type PiSdkSessionManager } from './pi-sdk-adapter'
import { toPiLiveWireEvent } from './sdk-event'
import type { PiSdkLoader, PiSdkModel, PiSdkSession, PiSdkThinkingLevel } from './sdk-loader'
import type { PiLiveControls, PiLiveQueueState, PiLiveRuntimeState, PiLiveSnapshot, PiLiveStartInput, PiLiveStartupResources, PiLiveStreamingBehavior } from './types'
import type { PiRuntimeHandle, PiRuntimeHost } from './worker-host'

export function resolvePiLiveRuntimeSessionDir(cwd: string, value: string | undefined): string | undefined {
  const raw = value?.trim()
  if (!raw) return undefined
  if (raw === '~') return homedir()
  if (raw.startsWith('~/') || (process.platform === 'win32' && raw.startsWith('~\\'))) {
    return resolve(homedir(), raw.slice(2))
  }
  return isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw)
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function resultItems(value: unknown, key: string): unknown[] {
  const row = record(value)
  return Array.isArray(row[key]) ? row[key] as unknown[] : []
}

function resourceLabel(value: unknown): string | undefined {
  const row = record(value)
  for (const key of ['name', 'filePath', 'sourcePath', 'path', 'resolvedPath']) {
    const item = row[key]
    if (typeof item === 'string' && item.trim()) return item.trim()
  }
  return undefined
}

function runtimeResourceSnapshot(session: PiSdkSession): PiLiveStartupResources | undefined {
  const loader = session.resourceLoader
  if (!loader) return undefined
  const call = (method: keyof NonNullable<PiSdkSession['resourceLoader']>) => {
    const fn = loader[method]
    try { return typeof fn === 'function' ? fn.call(loader) : undefined } catch { return undefined }
  }
  const extensions = resultItems(call('getExtensions'), 'extensions').map(resourceLabel).filter((value): value is string => Boolean(value))
  const skills = resultItems(call('getSkills'), 'skills').map(resourceLabel).filter((value): value is string => Boolean(value))
  const prompts = resultItems(call('getPrompts'), 'prompts').map(resourceLabel).filter((value): value is string => Boolean(value))
  const themes = resultItems(call('getThemes'), 'themes').map(resourceLabel).filter((value): value is string => Boolean(value))
  const contexts = resultItems(call('getAgentsFiles'), 'agentsFiles').map(resourceLabel).filter((value): value is string => Boolean(value))
  const unique = (values: string[]) => [...new Set(values)]
  const result: PiLiveStartupResources = {
    contexts: unique(contexts),
    skills: unique(skills),
    prompts: unique(prompts),
    extensions: unique(extensions),
    themes: unique(themes),
    diagnostics: [],
  }
  return Object.values(result).some(values => values.length) ? result : undefined
}

function forkSessionManager(manager: PiSdkSessionManager): PiSdkSessionManager {
  if (typeof manager.createBranchedSession !== 'function') {
    throw new Error('Installed Pi SDK does not support createBranchedSession; cannot fork this history session')
  }
  const leafId = manager.getLeafId()
  if (!leafId) throw new Error('该 Pi 历史会话没有可分叉的当前节点')
  const forkedSessionPath = manager.createBranchedSession(leafId)
  if (!forkedSessionPath) throw new Error('Pi 未能从当前节点创建新的 Session')
  return manager
}

class InProcessHandle implements PiRuntimeHandle {
  constructor(private readonly id: string, private readonly session: PiSdkSession, private readonly extensionUi: PiExtensionUiBridge, private readonly unsubscribe: () => void) {}

  async state(): Promise<PiLiveRuntimeState> {
    const resources = runtimeResourceSnapshot(this.session)
    return { runtimeSessionId: this.id, status: 'ready', initializationStage: 'ready', nativeSessionId: this.session.sessionId,
      ...(this.session.sessionFile ? { sessionFile: this.session.sessionFile } : {}), ...(this.session.sessionName ? { sessionName: this.session.sessionName } : {}),
      ...(this.session.model ? { model: this.session.model } : {}), thinkingLevel: this.session.thinkingLevel, isStreaming: this.session.isStreaming,
      isCompacting: this.session.isCompacting, pendingMessageCount: this.session.pendingMessageCount, leafId: this.session.sessionManager.getLeafId(),
      ...(resources ? { startupResources: resources } : {}) }
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
  async abort(restoreQueue = true): Promise<PiLiveQueueState> { const queue = restoreQueue ? this.session.clearQueue() : { steering: [], followUp: [] }; this.session.abortBash?.(); await this.session.abort(); return queue }
  async respondToExtension(requestId: string, response: unknown): Promise<void> { this.extensionUi.respond(requestId, response) }
  async terminate(): Promise<void> { this.unsubscribe(); this.extensionUi.dispose(); if (this.session.isStreaming) { this.session.abortBash?.(); await this.session.abort().catch(() => undefined) } this.session.dispose() }
}

/** 仅用于 SDK 契约测试；生产默认使用独立 Worker。 */
export class InProcessPiRuntimeHost implements PiRuntimeHost {
  constructor(private readonly loadSdk: PiSdkLoader) {}
  async start(id: string, input: PiLiveStartInput, _signal: AbortSignal, onEvent: (event: Record<string, unknown>) => void): Promise<PiRuntimeHandle> {
    const installed = await this.loadSdk(input.executable)
    const sessionDir = resolvePiLiveRuntimeSessionDir(input.cwd, input.sessionDir)
    let manager = input.sessionPath ? installed.module.SessionManager.open(input.sessionPath, sessionDir, input.cwd) : installed.module.SessionManager.create(input.cwd, sessionDir)
    if (input.sessionPath && input.historyAction === 'fork') manager = forkSessionManager(manager)
    const created = await installed.module.createAgentSession({ cwd: input.cwd, sessionManager: manager })
    assertPiSdkSession(created.session, installed.sdkEntry, installed.version)
    const session = created.session
    const extensionUi = new PiExtensionUiBridge({ publish: onEvent })
    const unsubscribe = session.subscribe(event => onEvent(toPiLiveWireEvent(record(event))))
    try {
      await session.bindExtensions({ uiContext: extensionUi.context, mode: 'rpc', abortHandler: () => { void session.abort() }, onError: value => onEvent({ type: 'extension_error', error: String(record(value).error ?? 'Unknown extension error') }) })
      const resources = runtimeResourceSnapshot(session)
      if (resources) onEvent({ type: 'runtime_resources', resources })
      if (input.name) session.setSessionName(input.name)
      if (input.provider || input.model) { const snapshot = session.modelRuntime.getAvailableSnapshot(); const models = snapshot.length ? snapshot : await session.modelRuntime.getAvailable(input.provider); const model = models.find(item => (!input.provider || item.provider === input.provider) && (!input.model || item.id === input.model || item.name === input.model)); if (!model) throw new Error(`Pi model is not available: ${[input.provider, input.model].filter(Boolean).join('/')}`); await session.setModel(model) }
      return new InProcessHandle(id, session, extensionUi, unsubscribe)
    } catch (error) { unsubscribe(); extensionUi.dispose(); session.dispose(); throw error }
  }
}
