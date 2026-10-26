import type { CapturePolicyService, LiveAdapter, LiveRuntimeState, NativeSessionListReader, SourceService } from '@agent-lens/core'
import type { LiveRuntimeRefDto } from '@agent-lens/protocol'

type HistoryReference = Pick<LiveRuntimeRefDto, 'historySessionId' | 'projectId' | 'projectName' | 'startedAt' | 'lastActivityAt'>

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
