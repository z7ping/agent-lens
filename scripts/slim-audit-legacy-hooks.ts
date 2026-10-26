import { basename as invocationBaseName } from 'node:path'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import type { SourceCheckpointService } from '@agent-lens/core'
import { resolveCapturePolicyPluginState } from '@agent-lens/capture-policy'
import { SqliteSlimStorage } from '@agent-lens/storage-sqlite'
import { mapSourceRecord } from '../packages/storage-sqlite/src/repository-row-mappers'
import { NATIVE_REINDEX_SOURCES } from './slim-reindex-native'

interface AuditOptions {legacyPath:string;stagingPath:string;maxRecords:number}
export function parseHookAuditArgs(args:readonly string[]):AuditOptions{
  const options=new Map<string,string>()
  for(let i=0;i<args.length;i++){
    const key=args[i]
    if(!key||!['--legacy','--staging','--max-records'].includes(key)
      || options.has(key))throw new Error('Invalid legacy Hook audit argument')
    const value=args[++i]
    if(!value||value.startsWith('--'))throw new Error('Missing legacy Hook audit field')
    options.set(key,value)
  }
  if(!options.get('--legacy')||!options.get('--staging')){
    throw new Error('Legacy Hook audit needs explicit --legacy and --staging')
  }
  const maxRecords=options.has('--max-records')?Number(options.get('--max-records')):5000
  if(!Number.isSafeInteger(maxRecords)||maxRecords<1||maxRecords>5000){
    throw new RangeError('Legacy Hook audit budget must be 1-5000')
  }
  const legacyPath=resolve(options.get('--legacy')!)
  const stagingPath=resolve(options.get('--staging')!)
  if(legacyPath===stagingPath)throw new Error('Legacy Hook audit database paths must be distinct')
  return {legacyPath,stagingPath,maxRecords}
}
export interface LegacyHookAuditReport {
  found:number
  verified:number
  drifted:number
  unavailable:number
  unsupported:number
  scanComplete:boolean
  /** Opaque IDs only. Never report locators, Hook payload or session IDs. */
  samples:readonly {opaqueId:string;reason:string}[]
  /** A no-Hook v38 instance is vacuously verified; sources still have their
   * own independent runtime capability/partial coverage limitations. */
  allLegacyHookOriginalsVerified:boolean
  readyToSwitch:false
}
const readonlyCheckpoint:SourceCheckpointService={
  get:async()=>null,
  set:async()=>{throw Error('Hook audit must not write a checkpoint')},
  clear:async()=>{throw Error('Hook audit must not clear a checkpoint')},
}
/** Offline verified archive audit for old Hook facts that the transcript
 * Catalog cannot recover. SQL reads LOCATOR METADATA only; the Hook source
 * proves scoped archive path, checksum and original inode independently.
 * Never copies or normalizes the stored Legacy SourceRecord payload.
 */
export async function auditLegacyHookOriginals(args:readonly string[]):Promise<LegacyHookAuditReport>{
  const input=parseHookAuditArgs(args)
  const old=new Database(input.legacyPath,{readonly:true,fileMustExist:true})
  try{
    const version=old.prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as {version:number|null}
    if(version.version!==38)throw Error('Legacy Hook audit requires v38')
    const slim=SqliteSlimStorage.openExisting(input.stagingPath,true)
    try{
      const enabled=new Set(resolveCapturePolicyPluginState().settings.enabledSources)
      const report={found:0,verified:0,drifted:0,unavailable:0,unsupported:0,
        scanComplete:false,samples:[] as Array<{opaqueId:string;reason:string}>,
        allLegacyHookOriginalsVerified:false as boolean,readyToSwitch:false as const}
      const statement=old.prepare(`SELECT r.rowid AS audit_rowid,
        r.id,r.source_id,r.installation_id,r.source_session_native_id,
        r.native_type,r.native_id,r.source_sequence,r.occurred_at,r.captured_at,
        r.locator_json,r.fingerprint,'null' AS payload_json,r.parser_version
        FROM source_records AS r WHERE r.rowid > ? AND (
          LOWER(COALESCE(r.native_type,'')) LIKE '%hook%'
          OR CASE WHEN json_valid(r.locator_json)
              THEN json_extract(r.locator_json,'$.kind')='runtime-hook'
              ELSE 0 END
        ) ORDER BY r.rowid LIMIT ?`)
      let rowid=0
      while(report.found<input.maxRecords){
        const rows=statement.all(rowid,Math.min(100,input.maxRecords-report.found)) as
          Array<Record<string,unknown>&{audit_rowid:number;id:string;source_id:string;installation_id:string}>
        if(rows.length===0){report.scanComplete=true;break}
        for(const row of rows){
          rowid=row.audit_rowid
          report.found++
          let state:'verified'|'drifted'|'unavailable'|'unsupported'='unsupported'
          let reason='invalid-or-unrecoverable-hook-locator'
          try{
            const record=mapSourceRecord(row)
            const source=NATIVE_REINDEX_SOURCES.get(record.sourceId)
            const installation=await slim.repositories.installations.get(record.installationId)
            const host=installation
              ?await slim.repositories.hosts.get(installation.hostId):null
            if(!source?.rawRecovery?.verify||!installation||!host
              ||!enabled.has(record.sourceId)
              ||record.locator.kind!=='runtime-hook'){
              reason='hook-source-disabled-or-identity-unavailable'
            }else{
              const result=await source.rawRecovery.verify(record,{
                host,installation,abortSignal:new AbortController().signal,
                checkpoint:readonlyCheckpoint,
              })
              state=result.state==='verified'?'verified'
                :result.state==='drifted'?'drifted'
                :result.state==='unavailable'?'unavailable':'unsupported'
              reason=result.reason??('hook-original-'+state)
            }
          }catch(error){
            state='unsupported'
            reason='legacy-hook-metadata-invalid'
          }
          report[state]++
          if(state!=='verified'&&report.samples.length<32){
            report.samples.push({opaqueId:createHash('sha256')
              .update(JSON.stringify([row.source_id,row.installation_id,row.id]))
              .digest('hex').slice(0,20),reason})
          }
          if((report.found&7)===0)await new Promise<void>(done=>setImmediate(done))
        }
        if(rows.length<100){report.scanComplete=true;break}
      }
      report.allLegacyHookOriginalsVerified=report.scanComplete
        &&report.found===report.verified
      return report
    }finally{await slim.close()}
  }finally{old.close()}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)
  &&["slim-audit-legacy-hooks.ts","slim-audit-legacy-hooks.js","slim-audit-legacy-hooks.mjs"].includes(invocationBaseName(process.argv[1]))){
  auditLegacyHookOriginals(process.argv.slice(2)).then(report=>{
    process.stdout.write(JSON.stringify(report,null,2)+'\n')
  }).catch(error=>{
    process.stderr.write('Legacy Hook audit refused: '+
      (error instanceof Error?error.message:String(error))+'\n')
    process.exitCode=1
  })
}
