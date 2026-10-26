import type {
  CapturePolicyService, LiveAdapter, LiveRuntimeState,
  NativeSessionListReader, SourceService, StorageService,
} from '@agent-lens/core'
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

/** Slim link resolution consumes indexed native metadata only, not old SQL.
 * Identity must be unique across all enabled Source installations. A truncated
 * search is ambiguous even if its first page happens to contain one match.
 */
const nativeCache=new WeakMap<NativeSessionListReader,Map<string,{
  at:number;pending:Promise<HistoryReference>
}>>()

export async function nativeLiveHistoryReference(
  sessions:NativeSessionListReader,
  sources:SourceService,
  policy:Pick<CapturePolicyService,'isSourceEnabled'>,
  adapter:LiveAdapter,
  state:LiveRuntimeState,
):Promise<HistoryReference>{
  if(!state.nativeSessionId || state.nativeSessionId.length>256)return {}
  const enabledSourceIds=sources.list()
    .filter(source=>source.manifest.productId===adapter.manifest.productId
      && policy.isSourceEnabled(source.manifest.sourceId))
    .map(source=>source.manifest.sourceId).sort()
  if(!enabledSourceIds.length || enabledSourceIds.length>16)return {}
  let entries=nativeCache.get(sessions)
  if(!entries){entries=new Map();nativeCache.set(sessions,entries)}
  const key=JSON.stringify([
    enabledSourceIds,state.nativeSessionId,
    state.workspacePath,state.logicalSessionId,
  ])
  let entry=entries.get(key)
  if(!entry||Date.now()-entry.at>5_000){
    const pending=resolveNativeReference(sessions,sources,policy,adapter,state)
      .catch(()=>({} as HistoryReference))
    entry={at:Date.now(),pending}
    if(entries.size>=256)entries.delete(entries.keys().next().value!)
    entries.set(key,entry)
  }
  let timer:ReturnType<typeof setTimeout>|undefined
  try{
    return await Promise.race([entry.pending,new Promise<HistoryReference>(resolve=>{
      timer=setTimeout(()=>resolve({}),1_000)
    })])
  }finally{if(timer)clearTimeout(timer)}
}

async function resolveNativeReference(
  sessions:NativeSessionListReader,
  sources:SourceService,
  policy:Pick<CapturePolicyService,'isSourceEnabled'>,
  adapter:LiveAdapter,
  state:LiveRuntimeState,
):Promise<HistoryReference>{
  const nativeSessionId=state.nativeSessionId
  if(!nativeSessionId)return {}
  const eligible=sources.list().filter(source=>
    source.manifest.productId===adapter.manifest.productId
    && policy.isSourceEnabled(source.manifest.sourceId))
  if(!eligible.length||eligible.length>16)return {}
  const pages=await Promise.all(eligible.map(source=>sessions.query({
    sourceId:source.manifest.sourceId,search:nativeSessionId,limit:100,
  })))
  // Exact match + full search exhaustion: never guess an installation
  // from a native ID reused across installations, or a truncated page.
  if(pages.some(page=>page.hasMore))return {}
  const matches=pages.flatMap((page,index)=>page.items.filter(item=>
    item.sourceId===eligible[index]!.manifest.sourceId
    && item.nativeSessionId===nativeSessionId
    && (!state.workspacePath || item.workspacePath===state.workspacePath)
    && (!state.logicalSessionId?.startsWith('native:')
      || state.logicalSessionId===item.reviewSessionId)))
  if(matches.length!==1)return {}
  const item=matches[0]!
  return {
    historySessionId:item.reviewSessionId,
    ...(item.projectId?{projectId:item.projectId}:{}),
    ...(item.projectName?{projectName:item.projectName}:{}),
    lastActivityAt:item.lastActivityAt,
  }
}
