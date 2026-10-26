import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type {
  CapturePolicyService, NativeSessionCatalogStore,
} from '@agent-lens/core'
import type { NativeSessionReader } from '@agent-lens/core-services'
import type { NativePiLiveHistoryResolver } from '@agent-lens/runtime-cordis'

const MAX_HEADER_BYTES=64*1024
const NATIVE_REVIEW_ID=/^native:[0-9a-f]{32}$/

function unavailable(message:string):Error{
  const error=new Error(message) as Error & {code?:string}
  error.code='live_interaction_unavailable'
  return error
}

/**
 * Pi resume/fork from ORIGINAL native JSONL, without LogicalSession or
 * SourceRecord tables. Catalog ID is resolved server-side; the existing
 * NativeSessionReader MUST first verify Source roots, the installed Profile,
 * current inode and parser. No raw path enters through HTTP.
 */
export function createSlimPiHistoryResolver(
  catalog:Pick<NativeSessionCatalogStore,'getByReviewSessionId'>,
  reader:Pick<NativeSessionReader,'read'>,
  policy:Pick<CapturePolicyService,'isSourceEnabled'>,
):NativePiLiveHistoryResolver{
  const resolver:NativePiLiveHistoryResolver={
    async resolve(sessionId,action){
      if(!NATIVE_REVIEW_ID.test(sessionId))throw unavailable('无效的原生 Pi 会话身份')
      if(!policy.isSourceEnabled('pi'))throw unavailable('Pi 来源已禁用，拒绝访问原生会话')
      const entry=await catalog.getByReviewSessionId(sessionId)
      if(!entry||entry.sourceId!=='pi'||entry.locationKind!=='native'){
        throw unavailable('未找到可继续的本机 Pi 原生会话')
      }
      const checked=await reader.read({
        sourceId:entry.sourceId,
        installationId:entry.installationId,
        nativeSessionId:entry.nativeSessionId,
        limit:1,
        signal:new AbortController().signal,
      })
      if(checked.state!=='available'){
        throw unavailable('原生 Pi 会话身份或来源读取不可用：'+checked.reason)
      }
      // Read one bounded header through a *single file handle*. The Catalog
      // file path comes only from trusted local Slim metadata and has already
      // passed the Source-owned root/identity checks above. Recheck the inode
      // before constructing a continuation input, then use Pi's original file.
      const file=await open(entry.filePath,'r').catch(()=>null)
      if(!file)throw unavailable('Pi 原生会话文件不可达')
      try{
        const before=await file.stat()
        if(!before.isFile()||`${before.dev}:${before.ino}`!==entry.fileIdentity){
          throw unavailable('Pi 原生会话文件身份发生变化')
        }
        const bytes=Buffer.alloc(MAX_HEADER_BYTES)
        const {bytesRead}=await file.read(bytes,0,bytes.length,0)
        const first=bytes.subarray(0,bytesRead).toString('utf8')
          .replace(/^\uFEFF/,'').split(/\r?\n/,1)[0]?.trim()
        if(!first)throw unavailable('Pi 原生会话头缺失')
        let header:unknown
        try{header=JSON.parse(first)}catch{throw unavailable('Pi 原生会话头无法验证')}
        if(!header||typeof header!=='object'||Array.isArray(header)){
          throw unavailable('Pi 原生会话头格式无效')
        }
        const data=header as Record<string,unknown>
        if(data.type!=='session'||data.id!==entry.nativeSessionId){
          throw unavailable('Pi 原生会话 ID 与 Catalog 不一致')
        }
        const cwd=typeof data.cwd==='string'?data.cwd.trim():''
        if(!cwd||cwd.length>4096||!isAbsolute(cwd)){
          throw unavailable('Pi 原生会话缺少可信的绝对工作目录')
        }
        const after=await file.stat()
        if(!after.isFile()||`${after.dev}:${after.ino}`!==entry.fileIdentity){
          throw unavailable('Pi 原生会话在读取期间发生替换')
        }
        return {
          cwd,sessionPath:entry.filePath,
          historyAction:action,
          logicalSessionId:sessionId,
        }
      }finally{
        await file.close().catch(()=>undefined)
      }
    },
    async resolveForkAt(sessionId,nativeEventId){
      if(typeof nativeEventId!=='string'||!nativeEventId.trim()
        || nativeEventId.length>256){
        throw unavailable('原生 Pi 分叉锚点无效')
      }
      // Authorize the requested Source and original Pi session before even
      // inspecting an attacker-supplied event ID.
      const input=await resolver.resolve(sessionId,'fork')
      const entry=await catalog.getByReviewSessionId(sessionId)
      if(!entry||entry.sourceId!=='pi'||entry.locationKind!=='native'){
        throw unavailable('原生 Pi 会话已失联，不能从消息分叉')
      }
      const signal=AbortSignal.timeout(30_000)
      const MAX_PAGES=128
      const PAGE_SIZE=32
      let matches=0
      let cursor:import('@agent-lens/core').SourceNativeSessionCursor|undefined
      for(let page=0;page<MAX_PAGES;page++){
        signal.throwIfAborted()
        const window=await reader.read({
          sourceId:'pi',installationId:entry.installationId,
          nativeSessionId:entry.nativeSessionId,
          ...(cursor?{cursor}:{}),
          limit:PAGE_SIZE,signal,
        })
        if(window.state!=='available'){
          throw unavailable('原生 Pi 消息锚点验证失败：'+window.reason)
        }
        for(const fact of window.observations){
          if(fact.kind==='message.assistant' && fact.nativeEventId===nativeEventId){
            matches++
            if(matches>1)throw unavailable('原生 Pi 助手消息锚点不唯一')
          }
        }
        if(window.pendingTail){
          throw unavailable('原生 Pi 消息尾部尚未完整，拒绝分叉')
        }
        if(!window.hasMore){
          if(matches!==1)throw unavailable('未验证到唯一的 Pi 助手消息分叉点')
          return {...input,branchFromEntryId:nativeEventId}
        }
        if(!window.nextCursor
          || window.nextCursor.offset<=(cursor?.offset??0)){
          throw unavailable('原生 Pi 记录游标无进展，拒绝分叉')
        }
        cursor=window.nextCursor
      }
      throw unavailable('Pi 原生消息超过有界扫描预算，无法证明分叉点唯一')
    },
  }
  return resolver
}
