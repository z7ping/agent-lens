import { open, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { CapturePolicyService, NativeSessionCatalogStore } from '@agent-lens/core'
import type { NativeSessionReader } from '@agent-lens/core-services'
import type { CodexNativeHistoryResolver } from '@agent-lens/live-codex'

const NATIVE_ID=/^native:[0-9a-f]{32}$/
const MAX_HEADER=64*1024

function blocked(reason:string):Error{
  return Object.assign(new Error(reason),{code:'live_interaction_unavailable'})
}

/** Same Codex App Server, same original Source: no v38 LogicalSession,
 * SourceRecord, client-selected paths or duplicate transcript store.
 */
export function createSlimCodexHistoryResolver(
  catalog:Pick<NativeSessionCatalogStore,'getByReviewSessionId'>,
  reader:Pick<NativeSessionReader,'read'>,
  policy:Pick<CapturePolicyService,'isSourceEnabled'>,
):CodexNativeHistoryResolver{
  return {async resolve(reviewSessionId){
    if(!NATIVE_ID.test(reviewSessionId)){
      throw blocked('Codex 仅接受可验证的原生会话身份')
    }
    if(!policy.isSourceEnabled('codex'))throw blocked('Codex 来源已禁用')
    const entry=await catalog.getByReviewSessionId(reviewSessionId)
    if(!entry||entry.sourceId!=='codex'||entry.locationKind!=='native'){
      throw blocked('未找到可信的本地 Codex 会话')
    }
    const checked=await reader.read({
      sourceId:'codex',installationId:entry.installationId,
      nativeSessionId:entry.nativeSessionId,
      limit:1,signal:AbortSignal.timeout(30_000),
    })
    if(checked.state!=='available'){
      throw blocked('Codex 原生会话 Reader 验证失败：'+checked.reason)
    }
    const handle=await open(entry.filePath,'r').catch(()=>null)
    if(!handle)throw blocked('Codex 原生会话文件不可访问')
    try{
      const before=await handle.stat()
      if(!before.isFile()||`${before.dev}:${before.ino}`!==entry.fileIdentity){
        throw blocked('Codex 原生会话文件已发生替换')
      }
      const bytes=Buffer.alloc(MAX_HEADER)
      const {bytesRead}=await handle.read(bytes,0,bytes.length,0)
      const raw=bytes.subarray(0,bytesRead).toString('utf8')
      if(!raw.includes('\n'))throw blocked('Codex 原生会话头超过有界读取预算')
      const first=raw.replace(/^\uFEFF/,'').split(/\r?\n/,1)[0]?.trim()
      let envelope:unknown
      try{envelope=JSON.parse(first??'')}catch{throw blocked('Codex 原生会话头无法解析')}
      if(!envelope||typeof envelope!=='object'||Array.isArray(envelope)){
        throw blocked('Codex 原生会话头格式错误')
      }
      const header=envelope as Record<string,unknown>
      const meta=header.payload
      if(header.type!=='session_meta'||!meta||typeof meta!=='object'
        ||Array.isArray(meta)){
        throw blocked('Codex 原生会话缺少 session_meta')
      }
      const identity=meta as Record<string,unknown>
      if(identity.id!==entry.nativeSessionId){
        throw blocked('Codex 原生会话 ID 不匹配')
      }
      const cwd=typeof identity.cwd==='string'?identity.cwd.trim():''
      if(!cwd||cwd.length>4096||!isAbsolute(cwd)){
        throw blocked('Codex 原生会话缺少绝对工作目录')
      }
      const after=await handle.stat()
      const current=await stat(entry.filePath).catch(()=>null)
      if(!current||`${after.dev}:${after.ino}`!==entry.fileIdentity
        ||`${current.dev}:${current.ino}`!==entry.fileIdentity){
        throw blocked('Codex 原生会话读取期间被替换')
      }
      return {threadId:entry.nativeSessionId,cwd}
    }finally{await handle.close().catch(()=>undefined)}
  }}
}
