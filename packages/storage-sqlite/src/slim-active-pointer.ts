import { lstat,readFile } from 'node:fs/promises'
import { isAbsolute,resolve } from 'node:path'
export interface ActiveDatabasePointer {
  schemaVersion:1
  mode:'slim'|'legacy'
  legacyPath:string
  backupPath:string
  slimPath:string
  changedAt:string
}
/** A missing, invalid or symlinked activation marker is never silently
 * treated as permission to open a different SQLite database. */
export async function readActiveDatabasePointer(path:string):Promise<ActiveDatabasePointer|null>{
  let body:string
  try{
    const file=await lstat(path)
    if(!file.isFile()||file.isSymbolicLink()||file.size>4096){
      throw new Error('Invalid cutover pointer file')
    }
    body=await readFile(path,'utf8')
  }catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT')return null
    throw error
  }
  const value:unknown=JSON.parse(body)
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid cutover pointer')
  const row=value as Record<string,unknown>
  if(row.schemaVersion!==1||(row.mode!=='slim'&&row.mode!=='legacy')
    ||!['legacyPath','backupPath','slimPath','changedAt'].every(key=>
      typeof row[key]==='string'&&(row[key] as string).length>0)){
    throw new Error('Invalid cutover pointer')
  }
  for(const key of ['legacyPath','backupPath','slimPath'] as const){
    if(!isAbsolute(row[key] as string)||resolve(row[key] as string)!==row[key]){
      throw new Error('Cutover pointer path is not absolute')
    }
  }
  return value as ActiveDatabasePointer
}
