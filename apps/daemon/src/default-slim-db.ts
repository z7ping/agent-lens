import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveAgentLensNodeRuntime } from '@agent-lens/runtime-cordis'
import { readActiveDatabasePointer, SqliteSlimStorage } from '@agent-lens/storage-sqlite'

export interface DefaultSlimDbPaths {
  dataRoot:string
  legacyPath?:string
  pointerPath?:string
}
export interface DefaultSlimDbResult {
  dbPath:string
  mode:'fresh'|'existing-slim'|'activated'
}
/** Single default DB resolver used by CLI, Desktop and dev daemon entry.
 * - Empty install: initialize v1 without Legacy migrations.
 * - Activated v38 upgrade: ONLY the attested pointer selects the installed DB.
 * - Unmigrated v38: fail closed with a repair/prepare instruction; never start
 *   the retired Writer or silently convert a running database.
 */
export async function resolveDefaultSlimDb(
  options:DefaultSlimDbPaths,
):Promise<DefaultSlimDbResult>{
  const dataRoot=resolve(options.dataRoot)
  const legacyPath=resolve(options.legacyPath??join(dataRoot,'agent-lens.db'))
  const pointerPath=resolve(options.pointerPath??join(dataRoot,'active-database.json'))
  if(pointerPath===legacyPath)throw new Error('Active pointer and database must have distinct paths')
  const pointer=await readActiveDatabasePointer(pointerPath)
  if(pointer){
    if(pointer.mode!=='slim')throw new Error('Slim cutover has been rolled back; refusing Legacy runtime')
    if(pointer.legacyPath!==legacyPath)throw new Error('Slim pointer legacy database identity mismatch')
    if(pointer.slimPath===legacyPath||pointer.slimPath===pointerPath
      ||pointer.backupPath===legacyPath||pointer.backupPath===pointerPath){
      throw new Error('Slim pointer has unsafe database paths')
    }
    const stage=SqliteSlimStorage.openExisting(pointer.slimPath,true)
    try{await stage.health()}finally{await stage.close()}
    return {dbPath:pointer.slimPath,mode:'activated'}
  }
  if(existsSync(legacyPath)){
    try{
      const stage=SqliteSlimStorage.openExisting(legacyPath,true)
      try{await stage.health()}finally{await stage.close()}
    }catch{
      throw new Error('Existing AgentLens database is not Slim v1. '+
        'The old v38 Writer is retired; run the explicit M3 offline migration '+
        'and activate its database pointer after stopping the old Daemon. '+
        'Original database remains untouched: '+legacyPath)
    }
    return {dbPath:legacyPath,mode:'existing-slim'}
  }
  // Do not create a v38 schema even for new installs. If a concurrent new
  // daemon won the exclusive SQLite creation race, verify its schema first.
  try{
    const fresh=await SqliteSlimStorage.createFresh(legacyPath)
    try{await fresh.health()}finally{await fresh.close()}
    return {dbPath:legacyPath,mode:'fresh'}
  }catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error
    const existing=SqliteSlimStorage.openExisting(legacyPath,true)
    try{await existing.health()}finally{await existing.close()}
    return {dbPath:legacyPath,mode:'existing-slim'}
  }
}
export function defaultSlimDbPaths(env:NodeJS.ProcessEnv=process.env):DefaultSlimDbPaths{
  const {dataRoot}=resolveAgentLensNodeRuntime()
  return {
    dataRoot,
    ...(env.AGENT_LENS_DB_PATH?{legacyPath:env.AGENT_LENS_DB_PATH}:{}),
    ...(env.AGENT_LENS_ACTIVE_DB_POINTER?{pointerPath:env.AGENT_LENS_ACTIVE_DB_POINTER}:{}),
  }
}
