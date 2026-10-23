import type { LiveAdapter, LiveRuntimeState, SourceService, StorageService } from '@agent-lens/core'
import type { LiveRuntimeRefDto } from '@agent-lens/protocol'

type HistoryReference = Pick<LiveRuntimeRefDto, 'historySessionId' | 'projectId' | 'projectName' | 'startedAt' | 'lastActivityAt'>
const cache = new WeakMap<StorageService, Map<string, { at: number; pending: Promise<HistoryReference> }>>()

/** 只读取身份索引，不读取正文，也不把 Runtime 元数据写为第二套历史事实。 */
export async function liveHistoryReference(
  storage: StorageService,
  sources: SourceService | undefined,
  adapter: LiveAdapter,
  state: LiveRuntimeState,
): Promise<HistoryReference> {
  let entries = cache.get(storage)
  if (!entries) { entries = new Map(); cache.set(storage, entries) }
  const key = JSON.stringify([adapter.manifest.liveId, state.logicalSessionId, state.nativeSessionId, state.workspacePath])
  let entry = entries.get(key)
  if (!entry || Date.now() - entry.at > 5_000) {
    const pending = resolveReference(storage, sources, adapter, state).catch(() => ({}))
    entry = { at: Date.now(), pending }
    if (entries.size >= 256) entries.delete(entries.keys().next().value!)
    entries.set(key, entry)
  }
  // 历史 Reader 忙碌不能阻塞 Live 入口；索引查询继续共享，后续刷新补齐。
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([entry.pending, new Promise<HistoryReference>(resolve => {
      timer = setTimeout(() => resolve({}), 1_000)
    })])
  } finally { if (timer) clearTimeout(timer) }
}

async function resolveReference(
  storage: StorageService, sources: SourceService | undefined, adapter: LiveAdapter, state: LiveRuntimeState,
): Promise<HistoryReference> {
  let logicalId = state.logicalSessionId
  if (!logicalId && state.nativeSessionId && sources) {
    const sourceIds = sources.list().filter(source => source.manifest.productId === adapter.manifest.productId)
      .map(source => source.manifest.sourceId)
    const installations = await storage.repositories.installations.listByProduct(adapter.manifest.productId)
    const sessions = await Promise.all(installations.flatMap(installation => sourceIds.map(sourceId =>
      storage.repositories.sessions.findSourceSession(sourceId, installation.id, state.nativeSessionId!),
    )))
    const ids = new Set(sessions.flatMap(session => session?.logicalSessionId ? [session.logicalSessionId] : []))
    // 跨安装/来源身份有歧义时保留独立入口，不能猜测或按标题合并。
    if (ids.size === 1) logicalId = [...ids][0]
  }
  if (!logicalId) {
    if (!state.workspacePath || !storage.launchableProjects) return {}
    const page = await storage.launchableProjects.query({ search: state.workspacePath, limit: 4 })
    const matches = page.items.filter(project => project.workspaces.some(workspace => workspace.workspacePath === state.workspacePath))
    if (matches.length !== 1) return {}
    const project = matches[0]!
    return {
      ...(project.projectId ? { projectId: project.projectId } : {}),
      ...(project.projectName ? { projectName: project.projectName } : {}),
    }
  }
  const logical = await storage.repositories.sessions.getLogicalSession(logicalId)
  if (!logical) return {}
  const installation = await storage.repositories.installations.get(logical.installationId)
  if (installation?.productId !== adapter.manifest.productId) return {}
  const [workspace, project] = await Promise.all([
    logical.workspaceId ? storage.repositories.sessions.getWorkspace(logical.workspaceId) : null,
    logical.projectId ? storage.repositories.sessions.getProject(logical.projectId) : null,
  ])
  // 原生 ID 相同而工作区不同，不建立导航关联。
  if (state.workspacePath && workspace && state.workspacePath !== workspace.path) return {}
  return {
    historySessionId: logical.id,
    ...(logical.projectId ? { projectId: logical.projectId } : {}),
    ...(project?.name ? { projectName: project.name } : {}),
    ...(logical.startedAt ? { startedAt: logical.startedAt } : {}),
    ...(logical.endedAt ? { lastActivityAt: logical.endedAt } : {}),
  }
}
