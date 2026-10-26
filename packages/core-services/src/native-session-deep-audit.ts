import { stat } from 'node:fs/promises'
import type {
  AgentInstallation, Host, NativeSessionCatalogEntry, RuntimeProfile,
  SourceCheckpointService, SourceDefinition, SourceNativeSessionCursor,
} from '@agent-lens/core'
import { nativeSqliteRevision } from '@agent-lens/source-support'

export interface NativeSessionDeepAuditInput {
  source: SourceDefinition
  entry: NativeSessionCatalogEntry
  host: Host
  installation: AgentInstallation
  runtimeProfile?: RuntimeProfile
  signal: AbortSignal
  /** Original Source rows per page, max 64. */
  pageSize?: number
  /** Bounded audit: a partial scan is never reported as verified. */
  maxPages?: number
}

export type NativeSessionDeepAuditResult =
  | { state:'verified'; pages:number; records:number; nativeContentVerified:true }
  | { state:'partial'|'unavailable'|'drifted'|'unsupported'; pages:number; records:number;
      nativeContentVerified:false; reason:string }

const readOnlyCheckpoint: SourceCheckpointService = {
  async get() { return null },
  async set() { throw new Error('Native content audit must not persist checkpoints') },
  async clear() { throw new Error('Native content audit must not advance checkpoints') },
}

function incomplete(
  state:'partial'|'unavailable'|'drifted'|'unsupported',
  reason:string,pages:number,records:number,
):NativeSessionDeepAuditResult {
  return {state,reason,pages,records,nativeContentVerified:false}
}

/** Thorough original-source replay, including per-record fingerprint recovery.
 * Never normalizes, stores or logs the SourceRecord payload, and never invokes
 * any Legacy ingestion/Observation/Evidence writer. This only proves CURRENT
 * original content, not overwritten/deleted revisions or Hook-only events.
 */
export async function auditNativeSessionOriginal(
  input:NativeSessionDeepAuditInput,
):Promise<NativeSessionDeepAuditResult> {
  const {source,entry,host,installation,signal}=input
  const pageSize=input.pageSize??32
  const maxPages=input.maxPages??256
  if (!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>64
    || !Number.isSafeInteger(maxPages)||maxPages<1||maxPages>16384) {
    throw new RangeError('Invalid bounded native recovery scan budget')
  }
  if (!source.readNativeSessionPage || !source.rawRecovery?.verify) {
    return incomplete('unsupported','source-has-no-authorized-native-reader',0,0)
  }
  if (entry.sourceId!==source.manifest.sourceId
    || installation.id!==entry.installationId
    || installation.productId!==source.manifest.productId
    || installation.hostId!==host.id
    || (input.runtimeProfile && input.runtimeProfile.installationId!==installation.id)
    || entry.locationKind!=='native') {
    return incomplete('drifted','source-or-installation-identity-mismatch',0,0)
  }
  const activeInstallation=input.runtimeProfile
    ? {...installation,
      configRoot:input.runtimeProfile.configRoot??installation.configRoot,
      dataRoot:input.runtimeProfile.dataRoot??installation.dataRoot}
    : installation
  const context={
    host,installation:activeInstallation,
    ...(input.runtimeProfile?{runtimeProfile:input.runtimeProfile}:{}),
    abortSignal:signal,checkpoint:readOnlyCheckpoint,
  }
  let pages=0,records=0
  let cursor:SourceNativeSessionCursor|undefined
  for(let i=0;i<maxPages;i++) {
    signal.throwIfAborted()
    let result:Awaited<ReturnType<NonNullable<SourceDefinition['readNativeSessionPage']>>>
    try{
      result=await source.readNativeSessionPage({
        filePath:entry.filePath,nativeSessionId:entry.nativeSessionId,
        limit:pageSize,...(cursor?{cursor}:{})
      },context)
    }catch(error){
      if(signal.aborted)throw error
      return incomplete('unavailable','source-read-exception',pages,records)
    }
    if(result.state!=='available')return incomplete(result.state,result.reason,pages,records)
    pages++
    if(result.nextCursor.fileIdentity!==entry.fileIdentity){
      return incomplete('drifted','native-file-identity-changed',pages,records)
    }
    if (result.pendingTail) {
      return incomplete('partial','native-source-pending-tail',pages,records)
    }
    if(result.records.length>pageSize
      || (result.hasMore&&result.records.length===0)) {
      return incomplete('unsupported','source-page-size-or-empty-loop',pages,records)
    }
    for(const record of result.records){
      signal.throwIfAborted()
      if(record.sourceId!==entry.sourceId
        || record.installationId!==entry.installationId
        || record.sourceSessionNativeId!==entry.nativeSessionId
        || record.locator.path!==entry.filePath || !record.fingerprint){
        return incomplete('drifted','native-record-identity-changed',pages,records)
      }
      let recovery:Awaited<ReturnType<NonNullable<NonNullable<SourceDefinition['rawRecovery']>['verify']>>>
      try{recovery=await source.rawRecovery.verify(record,context)}
      catch(error){
        if(signal.aborted)throw error
        return incomplete('unavailable','original-recovery-exception',pages,records)
      }
      if(recovery.state!=='verified') {
        return incomplete('drifted','original-fingerprint-not-verified',pages,records)
      }
      records++
    }
    const next=result.nextCursor
    if(result.hasMore
      && cursor && next.offset<=cursor.offset && next.sequence<=cursor.sequence
      || result.hasMore && next.offset===0 && next.sequence===0) {
      return incomplete('unsupported','native-cursor-not-advancing',pages,records)
    }
    if(!result.hasMore){
      if(records===0)return incomplete('partial','native-session-empty',pages,records)
      // Identity alone is insufficient: Source SQLite may change WAL pages
      // without altering the main .db stat, so use the same revision method
      // as numerical projection refresh.
      try{
        if(/\.(?:db|sqlite)$/i.test(entry.filePath)){
          const current=await nativeSqliteRevision(entry.filePath)
          if(current.fileIdentity!==entry.fileIdentity
            || current.fileSize!==entry.fileSize
            || current.fileMtimeMs!==entry.fileMtimeMs){
            return incomplete('drifted','native-database-revision-changed',pages,records)
          }
        }else{
          const current=await stat(entry.filePath)
          if(!current.isFile()||`${current.dev}:${current.ino}`!==entry.fileIdentity
            || current.size!==entry.fileSize||current.mtimeMs!==entry.fileMtimeMs) {
            return incomplete('drifted','native-file-revision-changed',pages,records)
          }
        }
      }catch(error){
        if(signal.aborted)throw error
        return incomplete('unavailable','native-file-revision-unavailable',pages,records)
      }
      return {state:'verified',pages,records,nativeContentVerified:true}
    }
    cursor=next
    if((i&7)===7)await new Promise<void>(resolve=>setImmediate(resolve))
  }
  return incomplete('partial','native-audit-page-budget-exhausted',pages,records)
}
