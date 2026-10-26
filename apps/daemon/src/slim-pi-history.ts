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
  return {
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
  }
}
