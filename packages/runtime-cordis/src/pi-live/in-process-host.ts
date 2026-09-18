import { homedir } from 'node:os'
import { LIVE_HISTORY_INDEX_QUERY_MAX_LIMIT, LIVE_SNAPSHOT_DEFAULT_LIMIT, LIVE_SNAPSHOT_MAX_LIMIT, isLiveThinkingControl, type LiveHistoryIndex, type LiveHistoryIndexQuery, type LiveSnapshotWindow } from '@agent-lens/core'
import { formatLiveError } from '@agent-lens/live-support'
import { isAbsolute, resolve } from 'node:path'
import { PiExtensionUiBridge } from './extension-ui-bridge'
import {
  assertPiSdkSession,
  piSdkCommands,
  resolvePiSdkPackageUpdateApi,
  type PiSdkSessionManager,
} from './pi-sdk-adapter'
import { toPiLiveWireEvent } from './sdk-event'
import type { PiSdkLoader, PiSdkModel, PiSdkSession, PiSdkThinkingLevel } from './sdk-loader'
import type {
  PiLiveControls,
  PiLiveImageInput,
  PiLivePackageUpdate,
  PiLivePackageUpdateCheckStatus,
  PiLiveQueueState,
  PiLiveRuntimeCapabilities,
  PiLiveRuntimeState,
  PiLiveSnapshot,
  PiLiveStartInput,
  PiLiveStartupResources,
  PiLiveStreamingBehavior,
} from './types'
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
  const diagnostics: string[] = []
  const call = (method: keyof NonNullable<PiSdkSession['resourceLoader']>) => {
    const fn = loader[method]
    try {
      return typeof fn === 'function' ? fn.call(loader) : undefined
    } catch (error) {
      diagnostics.push(`${String(method)}: ${formatLiveError(error, 1_000)}`)
      return undefined
    }
  }
  const extensions = resultItems(call('getExtensions'), 'extensions').map(resourceLabel).filter((value): value is string => Boolean(value))
  const skills = resultItems(call('getSkills'), 'skills').map(resourceLabel).filter((value): value is string => Boolean(value))
  const prompts = resultItems(call('getPrompts'), 'prompts').map(resourceLabel).filter((value): value is string => Boolean(value))
  const themes = resultItems(call('getThemes'), 'themes').map(resourceLabel).filter((value): value is string => Boolean(value))
  const contexts = resultItems(call('getAgentsFiles'), 'agentsFiles').map(resourceLabel).filter((value): value is string => Boolean(value))
  const unique = (values: string[]) => [...new Set(values)]
  return {
    contexts: unique(contexts),
    skills: unique(skills),
    prompts: unique(prompts),
    extensions: unique(extensions),
    themes: unique(themes),
    diagnostics: diagnostics.slice(0, 80),
  }
}

interface PackageUpdateState {
  status: PiLivePackageUpdateCheckStatus
  updates: PiLivePackageUpdate[]
}

function piOfflineModeEnabled(): boolean {
  return Boolean(process.env.PI_OFFLINE)
}

function normalizePackageUpdates(value: unknown): PiLivePackageUpdate[] {
  if (!Array.isArray(value)) return []
  const result: PiLivePackageUpdate[] = []
  for (const item of value) {
    const row = record(item)
    if (typeof row.displayName !== 'string') continue
    if (row.type !== 'npm' && row.type !== 'git') continue
    if (row.scope !== 'user' && row.scope !== 'project') continue
    result.push({
      displayName: row.displayName,
      type: row.type,
      scope: row.scope,
    })
  }
  return result
}

async function checkPackageUpdates(
  module: Parameters<typeof resolvePiSdkPackageUpdateApi>[0],
  session: PiSdkSession,
  cwd: string,
): Promise<PackageUpdateState> {
  if (piOfflineModeEnabled()) return { status: 'unavailable', updates: [] }
  const api = resolvePiSdkPackageUpdateApi(module)
  const settingsManager = session.settingsManager
  if (!api || !settingsManager) return { status: 'unavailable', updates: [] }
  try {
    const manager = new api.DefaultPackageManager({
      cwd,
      agentDir: api.getAgentDir(),
      settingsManager,
    })
    if (typeof manager.checkForAvailableUpdates !== 'function') {
      return { status: 'unavailable', updates: [] }
    }
    const updates = normalizePackageUpdates(await manager.checkForAvailableUpdates())
    return { status: 'complete', updates }
  } catch {
    return { status: 'failed', updates: [] }
  }
}

function forkSessionManager(manager: PiSdkSessionManager, targetLeafId?: string): PiSdkSessionManager {
  if (typeof manager.createBranchedSession !== 'function') {
    throw new Error('Installed Pi SDK does not support createBranchedSession; cannot fork this history session')
  }
  const leafId = targetLeafId ?? manager.getLeafId()
  if (!leafId) throw new Error('该 Pi 历史会话没有可分叉的目标节点')
  const forkedSessionPath = manager.createBranchedSession(leafId)
  if (!forkedSessionPath) throw new Error('Pi 未能从当前节点创建新的 Session')
  return manager
}

interface PiRoundIndexRow {
  cursor: string
  ordinal: number
  entryIndex: number
  preview?: string
}

class InProcessHandle implements PiRuntimeHandle {
  readonly capabilities: PiLiveRuntimeCapabilities
  private roundIndexCache: { entryCount: number; lastEntryId?: string; leafId?: string | null; rows: PiRoundIndexRow[] } | undefined

  constructor(
    private readonly id: string,
    private readonly session: PiSdkSession,
    private readonly extensionUi: PiExtensionUiBridge,
    private readonly unsubscribe: () => void,
    private readonly packageUpdateState: PackageUpdateState,
  ) {
    this.capabilities = {
      protocolVersion: 1,
      sessionRuntime: false,
      modelSwitching: typeof session.setModel === 'function',
      thinkingLevelControl: typeof session.setThinkingLevel === 'function'
        && typeof session.getAvailableThinkingLevels === 'function',
      extensionUi: typeof session.bindExtensions === 'function',
      treeNavigation: typeof session.navigateTree === 'function',
      messageFork: typeof session.sessionManager.createBranchedSession === 'function'
        && typeof session.sessionManager.newSession === 'function',
    }
  }

  private roundIndex(all = this.session.sessionManager.getEntries()): PiRoundIndexRow[] {
    const lastEntryId = all.length ? String(record(all.at(-1)).id ?? '') || undefined : undefined
    const leafId = this.session.sessionManager.getLeafId()
    const cached = this.roundIndexCache
    if (cached && cached.entryCount === all.length && cached.lastEntryId === lastEntryId && cached.leafId === leafId) return cached.rows

    const appendOnly = cached
      && all.length >= cached.entryCount
      && (cached.entryCount === 0
        || String(record(all[cached.entryCount - 1]).id ?? '') === cached.lastEntryId)
    const rows = appendOnly ? [...cached.rows] : []
    const start = appendOnly ? cached.entryCount : 0

    for (let entryIndex = start; entryIndex < all.length; entryIndex += 1) {
      const entry = record(all[entryIndex])
      const message = record(entry.message)
      if (entry.type !== 'message' || message.role !== 'user' || typeof entry.id !== 'string' || !entry.id) continue
      const content = message.content ?? entry.content
      const preview = Array.isArray(content)
        ? content.map(part => typeof part === 'string'
          ? part
          : typeof record(part).text === 'string' ? String(record(part).text) : '').join(' ')
        : typeof content === 'string' ? content : ''
      rows.push({
        cursor: entry.id,
        ordinal: rows.length + 1,
        entryIndex,
        ...(preview.trim() ? { preview: preview.replace(/\s+/g, ' ').trim().slice(0, 86) } : {}),
      })
    }

    this.roundIndexCache = {
      entryCount: all.length,
      ...(lastEntryId ? { lastEntryId } : {}),
      leafId,
      rows,
    }
    return rows
  }

  private roundPage(all: unknown[], start: number, end: number) {
    const rows = this.roundIndex(all)
    let first: PiRoundIndexRow | undefined
    let last: PiRoundIndexRow | undefined
    for (const row of rows) {
      if (row.entryIndex < start) continue
      if (row.entryIndex >= end) break
      first ??= row
      last = row
    }
    return {
      total: rows.length,
      ...(first ? { firstOrdinal: first.ordinal } : {}),
      ...(last ? { lastOrdinal: last.ordinal } : {}),
    }
  }

  async state(): Promise<PiLiveRuntimeState> {
    const resources = runtimeResourceSnapshot(this.session)
    return { runtimeSessionId: this.id, status: 'ready', initializationStage: 'ready', capabilities: this.capabilities, nativeSessionId: this.session.sessionId,
      ...(this.session.sessionFile ? { sessionFile: this.session.sessionFile } : {}), ...(this.session.sessionName ? { sessionName: this.session.sessionName } : {}),
      ...(this.session.model ? { model: this.session.model } : {}), thinkingLevel: this.session.thinkingLevel, isStreaming: this.session.isStreaming,
      isCompacting: this.session.isCompacting, pendingMessageCount: this.session.pendingMessageCount, leafId: this.session.sessionManager.getLeafId(),
      ...(resources ? { startupResources: resources } : {}),
      packageUpdateCheck: this.packageUpdateState.status,
      ...(this.packageUpdateState.updates.length ? { packageUpdates: [...this.packageUpdateState.updates] } : {}) }
  }
  async snapshot(since?: string, window?: LiveSnapshotWindow): Promise<PiLiveSnapshot> {
    const selectors = [since, window?.before, window?.after, window?.edge, window?.around].filter(Boolean)
    if (selectors.length > 1) throw new Error('Live snapshot accepts only one cursor or edge selector')
    const all = this.session.sessionManager.getEntries()
    const requested = window?.limit
    const limit = Number.isInteger(requested)
      ? Math.max(1, Math.min(LIVE_SNAPSHOT_MAX_LIMIT, requested!))
      : LIVE_SNAPSHOT_DEFAULT_LIMIT

    let start = 0
    let end = all.length
    if (since || window?.after) {
      const cursor = since ?? window?.after
      const index = all.findIndex(entry => record(entry).id === cursor)
      if (index < 0 && window?.after) throw new Error('Live snapshot after cursor was not found')
      start = index >= 0 ? index + 1 : Math.max(0, all.length - limit)
      end = Math.min(all.length, start + limit)
    } else if (window?.edge === 'earliest') {
      start = 0
      end = Math.min(all.length, limit)
    } else if (window?.around) {
      const aroundIndex = all.findIndex(entry => record(entry).id === window.around)
      if (aroundIndex < 0) throw new Error('Live snapshot around cursor was not found')
      start = Math.max(0, aroundIndex - Math.floor(limit * .3))
      end = Math.min(all.length, start + limit)
      start = Math.max(0, end - limit)
    } else {
      if (window?.before) {
        const beforeIndex = all.findIndex(entry => record(entry).id === window.before)
        if (beforeIndex < 0) throw new Error('Live snapshot before cursor was not found')
        end = beforeIndex
      }
      start = Math.max(0, end - limit)
    }

    const entries = all.slice(start, end)
    const first = entries.length ? record(entries[0]).id : undefined
    const last = entries.length ? record(entries.at(-1)).id : undefined
    const before = start > 0 ? first : undefined
    const after = end < all.length ? last : undefined
    return {
      state: await this.state(),
      entries,
      leafId: this.session.sessionManager.getLeafId(),
      page: {
        hasEarlier: start > 0,
        ...(start > 0 && typeof before === 'string' ? { before } : {}),
        ...(typeof first === 'string' ? { first } : {}),
        ...(typeof last === 'string' ? { last } : {}),
        rounds: this.roundPage(all, start, end),
        ...(end < all.length ? { hasLater: true, ...(typeof after === 'string' ? { after } : {}) } : {}),
      },
    }
  }
  async historyIndex(query: LiveHistoryIndexQuery = {}): Promise<LiveHistoryIndex> {
    const rows = this.roundIndex()
    const cursor = query.cursor?.trim()
    if (cursor) {
      const row = rows.find(item => item.cursor === cursor)
      return { total: rows.length, items: row ? [{ cursor: row.cursor, ordinal: row.ordinal, ...(row.preview ? { preview: row.preview } : {}) }] : [] }
    }

    const limit = Number.isInteger(query.limit)
      ? Math.max(0, Math.min(LIVE_HISTORY_INDEX_QUERY_MAX_LIMIT, query.limit!))
      : 0
    if (limit === 0) return { total: rows.length, items: [] }

    const fromOrdinal = Number.isInteger(query.fromOrdinal) && query.fromOrdinal! > 0
      ? query.fromOrdinal!
      : 1
    const start = Math.min(rows.length, fromOrdinal - 1)
    return {
      total: rows.length,
      items: rows.slice(start, start + limit).map(({ entryIndex: _entryIndex, ...item }) => item),
    }
  }

  async entry(entryId: string): Promise<unknown | null> {
    return this.session.sessionManager.getEntries().find(entry => record(entry).id === entryId) ?? null
  }
  private modelSnapshot(provider?: string): readonly PiSdkModel[] { const snapshot = [...this.session.modelRuntime.getAvailableSnapshot()]; const selected = this.session.model; const catalog = selected && !snapshot.some(model => model.provider === selected.provider && model.id === selected.id) ? [...snapshot, selected] : snapshot; return provider ? catalog.filter(model => model.provider === provider) : catalog }
  private async modelsForSelection(provider?: string): Promise<readonly PiSdkModel[]> { const snapshot = this.modelSnapshot(provider); return snapshot.length ? snapshot : await this.session.modelRuntime.getAvailable(provider) }
  private thinkingControl(): PiLiveControls['thinking'] {
    const levels = this.session.getAvailableThinkingLevels()
    const candidate = {
      capability: 'thinking-control' as const,
      value: this.session.thinkingLevel,
      options: levels.map(level => ({ value: level, label: level })),
    }
    return isLiveThinkingControl(candidate) ? candidate : undefined
  }
  async commands() { return piSdkCommands(this.session) }
  async navigateTree(entryId: string): Promise<{ cancelled: boolean; editorText?: string | undefined }> {
    if (this.session.isStreaming) throw new Error('Pi tree navigation requires an idle session')
    if (typeof this.session.navigateTree !== 'function') throw new Error('Installed Pi SDK does not support navigateTree')
    const result = await this.session.navigateTree(entryId)
    this.roundIndexCache = undefined
    return {
      cancelled: result.cancelled,
      ...(typeof result.editorText === 'string' ? { editorText: result.editorText } : {}),
    }
  }
  async controls(): Promise<PiLiveControls> {
    const thinking = this.thinkingControl()
    return {
      models: this.modelSnapshot().map(({ provider, id, name, reasoning }) => ({ provider, id, ...(name ? { name } : {}), ...(typeof reasoning === 'boolean' ? { reasoning } : {}) })),
      ...(thinking ? { thinking } : {}),
    }
  }
  async setModel(provider: string, modelId: string): Promise<PiLiveRuntimeState> { const model = (await this.modelsForSelection(provider)).find(item => item.provider === provider && item.id === modelId); if (!model) throw new Error(`Pi model is not available: ${provider}/${modelId}`); await this.session.setModel(model); return this.state() }
  async setThinkingLevel(level: string): Promise<PiLiveRuntimeState> {
    const available = this.session.getAvailableThinkingLevels()
    if (!available.includes(level as PiSdkThinkingLevel)) throw new Error(`Pi thinking level is not available: ${level}`)
    this.session.setThinkingLevel(level as PiSdkThinkingLevel)
    return this.state()
  }
  async prompt(message: string, behavior?: PiLiveStreamingBehavior, images?: readonly PiLiveImageInput[]): Promise<void> { await new Promise<void>((resolve, reject) => { let accepted = false; const accept = () => { if (!accepted) { accepted = true; resolve() } }; void this.session.prompt(message, { ...(images?.length ? { images: [...images] } : {}), ...(behavior ? { streamingBehavior: behavior } : {}), source: 'rpc', preflightResult: success => { if (success) accept() } }).then(accept, error => { if (!accepted) reject(error) }) }) }
  async steer(message: string, images?: readonly PiLiveImageInput[]): Promise<void> { await this.session.steer(message, images?.length ? [...images] : undefined) }
  async followUp(message: string, images?: readonly PiLiveImageInput[]): Promise<void> { await this.session.followUp(message, images?.length ? [...images] : undefined) }
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
    if (input.sessionPath && input.historyAction === 'fork') {
      if (Object.hasOwn(input, 'branchFromEntryId') && input.branchFromEntryId === null) {
        manager = installed.module.SessionManager.create(input.cwd, sessionDir)
        if (typeof manager.newSession !== 'function') {
          throw new Error('Installed Pi SDK does not support root message fork')
        }
        manager.newSession({ parentSession: input.sessionPath })
      } else {
        manager = forkSessionManager(
          manager,
          typeof input.branchFromEntryId === 'string' ? input.branchFromEntryId : undefined,
        )
      }
    }
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
      const packageUpdateState: PackageUpdateState = { status: 'checking', updates: [] }
      const handle = new InProcessHandle(id, session, extensionUi, unsubscribe, packageUpdateState)
      void checkPackageUpdates(installed.module, session, input.cwd).then(result => {
        packageUpdateState.status = result.status
        packageUpdateState.updates = result.updates
        onEvent({ type: 'package_updates', status: result.status, updates: result.updates })
      })
      return handle
    } catch (error) { unsubscribe(); extensionUi.dispose(); session.dispose(); throw error }
  }
}
