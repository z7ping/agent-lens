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
  schemaChanged:boolean
  changedTables:Array<{table:string;backupRows:number;currentRows:number}>
  /** WAL can contain post-snapshot changes that are not in the main DB file. */
  activeWalDetected:boolean
  missingOriginalFiles:'not-checked'
  readyToSwitch:false
}

/** Every user-defined v38 table matters, including tables added after the
 * original allowlist. A changed event-only table cannot be allowed to hide
 * behind an unchanged Session Catalog. sqlite_ internal tables are excluded.
 */
function tableNames(db:Database.Database):string[]{
  return (db.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name`).all() as Array<{name:string}>).map(row=>row.name)
}

function schemaFingerprint(db:Database.Database):string{
  const rows=db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name,tbl_name`).all()
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}

function schemaVersion(db:Database.Database):number{
  const row=db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as
    {v:number|null}
  return row.v??0
}

function hashTable(db:Database.Database,name:string):{digest:string;rows:number}{
  // All identifiers are compile-time allowlisted, never from a URL or user.
  const fingerprint=createHash('sha256')
  const columns=db.prepare(`PRAGMA table_info("${name.replaceAll('"','""')}")`).all() as
    Array<{name:string;pk:number}>
  if(!columns.length)throw new Error('Old snapshot is missing required table: '+name)
  const keys=columns.filter(col=>col.pk>0)
    .sort((a,b)=>a.pk-b.pk).map(col=>`"${col.name}"`)
  const order=keys.length?keys.join(','):'rowid'
  let rows=0
  for(const row of db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY ${order}`).iterate()){
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
        const currentTables=tableNames(old)
        const backupTables=tableNames(snapshot)
        const schemaChanged=schemaFingerprint(old)!==schemaFingerprint(snapshot)
        const allTables=[...new Set([...currentTables,...backupTables])].sort()
        for(const table of allTables){
          // Table names originate only from trusted sqlite_master; safely quote.
          const backup=backupTables.includes(table)
            ?hashTable(snapshot,table):{digest:'missing',rows:0}
          const current=currentTables.includes(table)
            ?hashTable(old,table):{digest:'missing',rows:0}
          if(backup.digest!==current.digest || backup.rows!==current.rows){
            differences.push({table,backupRows:backup.rows,currentRows:current.rows})
          }
        }
        const activeWalDetected=await walPresent(legacyPath)
        return {
          legacySchemaVersion:38,backupSchemaVersion:38,stagingSchemaVerified:true,
          unchangedSinceBackup:!schemaChanged&&differences.length===0&&!activeWalDetected,
          checkedTables:allTables.length,schemaChanged,changedTables:differences,
          activeWalDetected,missingOriginalFiles:'not-checked',
          readyToSwitch:false,
        }
      }finally{stage.close()}
    }finally{snapshot.close()}
  }finally{old.close()}
}
