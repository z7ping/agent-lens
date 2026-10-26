import { basename as invocationBaseName } from 'node:path'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditNativeSessionOriginal } from '@agent-lens/core-services'
import { SqliteSlimStorage } from '@agent-lens/storage-sqlite'
import { resolveCapturePolicyPluginState } from '@agent-lens/capture-policy'
import type { NativeSessionCatalogEntry } from '@agent-lens/core'
import { NATIVE_REINDEX_SOURCES } from './slim-reindex-native'

export interface OriginalsAuditOptions {
  stagingPath:string
  sourceId?:string
  maxSessions:number
  maxPages:number
}

export function parseOriginalsAuditOptions(args:readonly string[]):OriginalsAuditOptions {
  const options=new Map<string,string>()
  for(let i=0;i<args.length;i++){
    const key=args[i]
    if(!key || !['--staging','--source','--max-sessions','--max-pages'].includes(key)
      || options.has(key)) throw new TypeError('Unsupported or duplicated original audit field: '+key)
    const value=args[++i]
    if(!value || value.startsWith('--')) throw new TypeError('Missing original audit field: '+key)
    options.set(key,value)
  }
  const stagingPath=options.get('--staging')
  if(!stagingPath)throw new Error('Original audit requires --staging')
  const sourceId=options.get('--source')
  if(sourceId&&!NATIVE_REINDEX_SOURCES.has(sourceId))throw new Error('Unsupported original audit source')
  const maxSessions=options.has('--max-sessions')
    ? Number(options.get('--max-sessions')):200
  const maxPages=options.has('--max-pages')
    ? Number(options.get('--max-pages')):256
  if(!Number.isSafeInteger(maxSessions)||maxSessions<1||maxSessions>5000) {
    throw new RangeError('Original audit session budget is 1-5000')
  }
  if(!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>16384) {
    throw new RangeError('Original audit page budget is 1-16384')
  }
  return {stagingPath,maxSessions,maxPages,...(sourceId?{sourceId}:{})}
}

export interface OriginalsAuditReport {
  scanned:number
  verified:number
  partial:number
  drifted:number
  unavailable:number
  unsupported:number
  /** Opaque samples only; never leak path/payload/native session ID. */
  samples:readonly {opaqueId:string;reason:string}[]
  catalogEnumerationComplete:boolean
  /** This is current Source content, not deleted revisions or Hook completeness. */
  allCurrentOriginalsVerified:boolean
  fullHistoricalAndHookCoverageCertified:false
  readyToSwitch:false
}

/** Read-only, explicit full-source verification of every indexed session.
 * No SourceRecords, Observation/Evidence copy, rewrite or upgrade. Scans can
 * be long-running; budget exhaustion is reported, never silently accepted.
 */
export async function runOriginalsAudit(args:readonly string[]):Promise<OriginalsAuditReport> {
  const input=parseOriginalsAuditOptions(args)
  const enabled=new Set(resolveCapturePolicyPluginState().settings.enabledSources)
  const storage=SqliteSlimStorage.openExisting(input.stagingPath,true)
  try{
    const report:OriginalsAuditReport={
      scanned:0,verified:0,partial:0,drifted:0,unavailable:0,unsupported:0,
      samples:[],catalogEnumerationComplete:false,
      allCurrentOriginalsVerified:false,
      fullHistoricalAndHookCoverageCertified:false,
      readyToSwitch:false,
    }
    const counts={scanned:0,verified:0,partial:0,drifted:0,unavailable:0,unsupported:0}
    const samples:Array<{opaqueId:string;reason:string}>=[]
    let before:NonNullable<Parameters<typeof storage.nativeSessionCatalog.query>[0]>['before']
    let complete=false
    while(counts.scanned<input.maxSessions){
      const remaining=input.maxSessions-counts.scanned
      const page=await storage.nativeSessionCatalog.query({
        locationKind:'native',
        ...(input.sourceId?{sourceId:input.sourceId}:{}),
        limit:Math.min(remaining,100),
        ...(before?{before}:{})
      })
      if(!page.items.length){complete=true;break}
      for(const entry of page.items as NativeSessionCatalogEntry[]){
        counts.scanned++
        const source=NATIVE_REINDEX_SOURCES.get(entry.sourceId)
        const install=await storage.repositories.installations.get(entry.installationId)
        const host=install?await storage.repositories.hosts.get(install.hostId):null
        const context=await storage.nativeSessionContexts.get(entry)
        const profile=context?.runtimeProfileId
          ?await storage.runtimeProfiles.get(context.runtimeProfileId):undefined
        let state:'verified'|'partial'|'drifted'|'unavailable'|'unsupported'
        let reason:string
        if(!enabled.has(entry.sourceId)){
          state='unsupported';reason='source-disabled-by-capture-policy'
        }else if(!source || !install || !host || (context?.runtimeProfileId&&!profile)){
          state='unavailable';reason='source-or-installation-metadata-missing'
        }else{
          const result=await auditNativeSessionOriginal({
            source,entry,host,installation:install,
            ...(profile?{runtimeProfile:profile}:{}),
            signal:new AbortController().signal,
            maxPages:input.maxPages,
          })
          state=result.state
          reason=result.state==='verified'?'':result.reason
        }
        counts[state]++
        if(state!=='verified'&&samples.length<32) {
          samples.push({
            opaqueId:createHash('sha256')
              .update(JSON.stringify([entry.sourceId,entry.installationId,
                entry.nativeSessionId])).digest('hex').slice(0,20),
            reason,
          })
        }
        if((counts.scanned&7)===0)await new Promise<void>(resolve=>setImmediate(resolve))
      }
      const last=page.items.at(-1)!
      before={
        lastActivityAt:last.lastActivityAt,sourceId:last.sourceId,
        installationId:last.installationId,nativeSessionId:last.nativeSessionId,
        locationKind:last.locationKind,
      }
      if(!page.hasMore){complete=true;break}
    }
    return {
      ...counts,samples,
      catalogEnumerationComplete:complete,
      allCurrentOriginalsVerified:complete&&counts.scanned>0
        &&counts.verified===counts.scanned,
      fullHistoricalAndHookCoverageCertified:false,
      readyToSwitch:false,
    }
  }finally{await storage.close()}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)
  &&["slim-audit-originals.ts","slim-audit-originals.js","slim-audit-originals.mjs"].includes(invocationBaseName(process.argv[1]))){
  runOriginalsAudit(process.argv.slice(2)).then(report=>{
    process.stdout.write(JSON.stringify(report,null,2)+'\n')
  }).catch(error=>{
    process.stderr.write('Native originals audit refused: '+
      (error instanceof Error?error.message:String(error))+'\n')
    process.exitCode=1
  })
}
