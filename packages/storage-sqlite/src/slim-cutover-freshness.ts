import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import Database from 'better-sqlite3'
import { resolve } from 'node:path'
import { assertSlimSchema } from './slim-schema'

/** Explicit offline comparison of a *consistent v38 backup* against the
 * possibly evolving old DB. No user prompt, payload or source path is logged.
 * This does NOT substitute for stopping/locking the old daemon.
 */
export interface SlimCutoverFreshness {
  legacySchemaVersion:38
  backupSchemaVersion:38
  stagingSchemaVerified:true
  /** Hashes computed in memory and discarded; no source data exported. */
  unchangedSinceBackup:boolean
  checkedTables:number
  changedTables:Array<{table:string;backupRows:number;currentRows:number}>
  /** WAL can contain post-snapshot changes that are not in the main DB file. */
  activeWalDetected:boolean
  missingOriginalFiles:'not-checked'
  readyToSwitch:false
}

const TABLES=[
  'hosts','agent_products','agent_installations','runtime_profiles',
  'projects','workspaces','source_sessions','source_records',
  'observations','native_session_catalog','native_session_write_claims',
  'asset_definitions','asset_bindings','asset_current_state',
  'source_checkpoints','launchable_project_index','launchable_workspace_index',
] as const

function schemaVersion(db:Database.Database):number{
  const row=db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as
    {v:number|null}
  return row.v??0
}

function hashTable(db:Database.Database,name:string):{digest:string;rows:number}{
  // All identifiers are compile-time allowlisted, never from a URL or user.
  const fingerprint=createHash('sha256')
  const columns=db.prepare(`PRAGMA table_info("${name}")`).all() as
    Array<{name:string;pk:number}>
  if(!columns.length)throw new Error('Old snapshot is missing required table: '+name)
  const keys=columns.filter(col=>col.pk>0)
    .sort((a,b)=>a.pk-b.pk).map(col=>`"${col.name}"`)
  const order=keys.length?keys.join(','):'rowid'
  let rows=0
  for(const row of db.prepare(`SELECT * FROM "${name}" ORDER BY ${order}`).iterate()){
    fingerprint.update(JSON.stringify(row))
    fingerprint.update('\n')
    rows++
  }
  return {digest:fingerprint.digest('hex'),rows}
}

async function walPresent(dbPath:string):Promise<boolean>{
  for(const suffix of ['-wal','-journal']){
    try{if((await stat(dbPath+suffix)).size>0)return true}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error
    }
  }
  return false
}

export async function auditSlimCutoverFreshness(input:{
  legacyPath:string;backupPath:string;stagingPath:string
}):Promise<SlimCutoverFreshness>{
  const legacyPath=resolve(input.legacyPath)
  const backupPath=resolve(input.backupPath)
  const stagingPath=resolve(input.stagingPath)
  if(new Set([legacyPath,backupPath,stagingPath]).size!==3){
    throw new Error('Freshness audit requires three distinct database files')
  }
  const old=new Database(legacyPath,{readonly:true,fileMustExist:true})
  try{
    const snapshot=new Database(backupPath,{readonly:true,fileMustExist:true})
    try{
      const stage=new Database(stagingPath,{readonly:true,fileMustExist:true})
      try{
        assertSlimSchema(stage)
        if(schemaVersion(old)!==38||schemaVersion(snapshot)!==38){
          throw new Error('Freshness audit requires two v38 SQLite databases')
        }
        const differences:SlimCutoverFreshness['changedTables']=[]
        for(const table of TABLES){
          const backup=hashTable(snapshot,table)
          const current=hashTable(old,table)
          if(backup.digest!==current.digest || backup.rows!==current.rows){
            differences.push({table,backupRows:backup.rows,currentRows:current.rows})
          }
        }
        const activeWalDetected=await walPresent(legacyPath)
        return {
          legacySchemaVersion:38,backupSchemaVersion:38,stagingSchemaVerified:true,
          unchangedSinceBackup:differences.length===0&&!activeWalDetected,
          checkedTables:TABLES.length,changedTables:differences,
          activeWalDetected,missingOriginalFiles:'not-checked',
          readyToSwitch:false,
        }
      }finally{stage.close()}
    }finally{snapshot.close()}
  }finally{old.close()}
}
