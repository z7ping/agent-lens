import { resolve } from 'node:path'
import Database from 'better-sqlite3'

/** Holds SQLite's RESERVED/IMMEDIATE writer lock for one complete operation.
 * Other SQLite connections retain readonly access but cannot insert/update
 * v38 rows until this callback exits. A lock is transaction-level, never a
 * static boolean, a stale PID file, or an operator-provided assertion.
 *
 * Callers must still stop the old Daemon before allowing a new daemon to
 * write: the lock protects only the bounded finalization window.
 */
export async function withFrozenLegacyWriter<T>(
  path:string,operation:()=>Promise<T>,
):Promise<T>{
  const old=new Database(resolve(path),{fileMustExist:true,timeout:0})
  let frozen=false
  try{
    old.pragma('busy_timeout = 0')
    const version=old.prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as {version:number|null}
    if(version?.version!==38)throw Error('Legacy writer freeze requires v38 SQLite')
    try{
      old.exec('BEGIN IMMEDIATE')
      frozen=true
    }catch(error){
      if((error as {code?:string}).code==='SQLITE_BUSY'){
        throw new Error('Legacy writer still holds SQLite write access; stop the old Daemon')
      }
      throw error
    }
    return await operation()
  }finally{
    if(frozen)old.exec('ROLLBACK')
    old.close()
  }
}
