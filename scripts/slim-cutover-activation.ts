import { basename as invocationBaseName } from 'node:path'
import { randomUUID } from 'node:crypto'
import { link, lstat, open, rename, stat, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect } from 'node:net'
import Database from 'better-sqlite3'
import { assertSlimSchema,auditSlimCutoverFreshness,
  readActiveDatabasePointer,type ActiveDatabasePointer } from '@agent-lens/storage-sqlite'
export {readActiveDatabasePointer} from '@agent-lens/storage-sqlite'
import { auditSlimCutoverGate, type SlimCutoverGateReport } from './slim-cutover-gate'
import { withFrozenLegacyWriter } from './slim-legacy-writer-freeze'

/** M3 requires a separate finalized, certified gate. The existing preparatory
 * gate deliberately cannot return readyToSwitch=true until Hook coverage,
 * legacy writer shutdown and full runtime consumer coverage are attested.
 */
export interface FinalCutoverGate {
  readyToSwitch:boolean
  blockedBy:readonly string[]
  oldDatabaseChanged:boolean
}
export interface SlimActivationPaths {
  legacyPath:string
  backupPath:string
  stagingPath:string
  installedSlimPath:string
  pointerPath:string
}
function paths(input:SlimActivationPaths):SlimActivationPaths {
  const normalized={
    legacyPath:resolve(input.legacyPath),
    backupPath:resolve(input.backupPath),
    stagingPath:resolve(input.stagingPath),
    installedSlimPath:resolve(input.installedSlimPath),
    pointerPath:resolve(input.pointerPath),
  }
  if(new Set(Object.values(normalized)).size!==5) {
    throw new Error('Cutover requires five distinct absolute paths')
  }
  // Activation is a same-directory, same-filesystem link followed by a
  // same-directory pointer rename. No copying a hot SQLite database.
  if(dirname(normalized.stagingPath)!==dirname(normalized.installedSlimPath)) {
    throw new Error('Slim staging and installed DB must share one directory')
  }
  return normalized
}
async function regular(path:string):Promise<void> {
  const info=await lstat(path)
  if(!info.isFile()||info.isSymbolicLink())throw new Error('Expected regular, non-symlink cutover file')
}
async function mustNotExist(path:string):Promise<void> {
  try{await lstat(path)}catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT')return
    throw error
  }
  throw new Error('Cutover destination already exists')
}
function database(path:string,kind:'slim'|'legacy'):void{
  const db=new Database(path,{readonly:true,fileMustExist:true})
  try{
    const integrity=db.pragma('integrity_check') as Array<{integrity_check:string}>
    if(integrity.length!==1||integrity[0]?.integrity_check!=='ok') {
      throw new Error('Cutover '+kind+' SQLite integrity check failed')
    }
    const fk=db.pragma('foreign_key_check') as unknown[]
    if(fk.length)throw new Error('Cutover '+kind+' SQLite foreign keys invalid')
    if(kind==='slim')assertSlimSchema(db)
    else{
      const row=db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
        {version:number|null}
      if(row?.version!==38)throw new Error('Cutover requires a v38 original and backup')
    }
  }finally{db.close()}
}
async function noActiveWal(path:string):Promise<void> {
  for(const suffix of ['-wal','-journal']){
    try{
      if((await stat(path+suffix)).size>0){
        throw new Error('Cutover refuses non-empty SQLite WAL/journal sidecar')
      }
    }catch(error){
      if((error as NodeJS.ErrnoException).code==='ENOENT')continue
      throw error
    }
  }
}
async function writePointer(path:string,state:ActiveDatabasePointer):Promise<void>{
  const temp=path+'.'+randomUUID()+'.tmp'
  const fd=await open(temp,'wx',0o600)
  try{
    await fd.writeFile(JSON.stringify(state)+'\n','utf8')
    await fd.sync()
  }finally{await fd.close()}
  try{
    await rename(temp,path)
  }catch(error){
    await unlink(temp).catch(()=>undefined)
    throw error
  }
}
/** Reversible activation; original and consistent backup remain untouched.
 * Caller MUST independently attest old Daemon stopped and old writer frozen.
 * The normal M3 gate is still fail-closed, so readiness is never inferred
 * from the mere existence of staging files or an operator flag.
 */
export async function activateSlimCutover(
  input:SlimActivationPaths,gate:FinalCutoverGate|(()=>Promise<FinalCutoverGate>),
):Promise<ActiveDatabasePointer>{
  const value=paths(input)
  // The snapshot/recheck and pointer publication must be within one
  // SQLite writer-freeze window. A standalone preflight has a TOCTOU race.
  return withFrozenLegacyWriter(value.legacyPath,async()=>{
    const checked=typeof gate==='function'?await gate():gate
    if(!checked.readyToSwitch||checked.blockedBy.length||checked.oldDatabaseChanged){
      throw new Error('Cutover blocked: final Source, Hook, writer and freshness gates not certified')
    }
    // A readiness report computed before the write lock is a TOCTOU snapshot.
    // Recompute the entire v38/backup/schema fingerprint while the old writer
    // is physically frozen, rather than trusting any caller's boolean.
    const current=await auditSlimCutoverFreshness({
      legacyPath:value.legacyPath,backupPath:value.backupPath,
      stagingPath:value.stagingPath,
    })
    if(!current.unchangedSinceBackup){
      throw new Error('Legacy database drifted from the M3 backup during cutover; '
        +'restart migration from a fresh consistent backup')
    }
    await Promise.all([value.legacyPath,value.backupPath,value.stagingPath].map(regular))
    await Promise.all([value.legacyPath,value.backupPath,value.stagingPath].map(noActiveWal))
    await mustNotExist(value.installedSlimPath)
    if(await readActiveDatabasePointer(value.pointerPath))throw new Error('Cutover pointer is already active')
    database(value.legacyPath,'legacy')
    database(value.backupPath,'legacy')
    database(value.stagingPath,'slim')
    // link is atomic and EXCLUSIVE (fails EEXIST), and the pointer only becomes
    // visible afterwards. A crash before pointer creation keeps Legacy active.
    await link(value.stagingPath,value.installedSlimPath)
    const pointer:ActiveDatabasePointer={
      schemaVersion:1,mode:'slim',legacyPath:value.legacyPath,
      backupPath:value.backupPath,slimPath:value.installedSlimPath,
      changedAt:new Date().toISOString(),
    }
    try{
      await writePointer(value.pointerPath,pointer)
      return pointer
    }catch(error){
      // The pointer is not published. The exclusive hard link we created must
      // not strand the next safe migration attempt in EEXIST. Only unlink a
      // path that STILL refers to our own staging inode, never an arbitrary
      // file another process may have replaced in the meantime.
      try{
        const [stage,installed]=await Promise.all([
          stat(value.stagingPath),stat(value.installedSlimPath),
        ])
        if(stage.dev===installed.dev&&stage.ino===installed.ino){
          await unlink(value.installedSlimPath)
        }
      }catch(cleanupError){
        throw new AggregateError([error,cleanupError],
          'Slim pointer publication and exclusive hard-link cleanup both failed')
      }
      throw error
    }
  })
}
/** Switches the active pointer back. Never deletes either database or backup.
 * A rollback is a routing operation, not conversion of Slim writes to v38.
 * Caller must stop the Slim daemon before invoking rollback.
 */
export async function rollbackSlimCutover(input:{
  pointerPath:string;legacyPath:string;backupPath:string;installedSlimPath:string
  /** Optional exact daemon port, primarily for owner-aware tests. */
  port?:number
}):Promise<ActiveDatabasePointer>{
  const port=input.port??(process.env.AGENT_LENS_PORT
    ?Number(process.env.AGENT_LENS_PORT):56789)
  if(!Number.isSafeInteger(port)||port<1||port>65535){
    throw new Error('Rollback requires a valid AgentLens daemon port')
  }
  // Reversing the pointer while Slim is still serving requests creates
  // competing historical timelines. Never rely solely on caller comments.
  await assertNoDaemonListening(port)
  const path=resolve(input.pointerPath)
  const current=await readActiveDatabasePointer(path)
  if(!current||current.mode!=='slim')throw new Error('No active Slim cutover to roll back')
  if(current.legacyPath!==resolve(input.legacyPath)
    ||current.backupPath!==resolve(input.backupPath)
    ||current.slimPath!==resolve(input.installedSlimPath)) {
    throw new Error('Rollback identity does not match active cutover')
  }
  await Promise.all([current.legacyPath,current.backupPath,current.slimPath].map(regular))
  await Promise.all([current.legacyPath,current.backupPath,current.slimPath].map(noActiveWal))
  database(current.legacyPath,'legacy')
  database(current.slimPath,'slim')
  const legacy:ActiveDatabasePointer={...current,mode:'legacy',changedAt:new Date().toISOString()}
  await assertNoDaemonListening(port)
  await writePointer(path,legacy)
  return legacy
}
/** A live Daemon on the configured port must be stopped before cutover.
 * Custom-port processes must also be stopped explicitly by the operator. */
export async function assertNoDaemonListening(port:number):Promise<void>{
  await new Promise<void>((done,fail)=>{
    const socket=connect({host:'127.0.0.1',port})
    let settled=false
    const finish=(error?:Error)=>{
      if(settled)return
      settled=true
      socket.destroy()
      error?fail(error):done()
    }
    socket.setTimeout(500)
    socket.once('connect',()=>finish(new Error('Daemon port occupied; stop the old AgentLens first')))
    socket.once('error',error=>{
      if((error as NodeJS.ErrnoException).code==='ECONNREFUSED')finish()
      else finish(new Error('Cannot certify Daemon shutdown: '+error.message))
    })
    socket.once('timeout',()=>finish(new Error('Daemon port probe timed out')))
  })
}

export interface CutoverAuditLimits {maxSessions:number;maxPages:number}

export function finalGateArgs(input:SlimActivationPaths,limits:CutoverAuditLimits):string[]{
  if(!Number.isSafeInteger(limits.maxSessions)||limits.maxSessions<1||limits.maxSessions>5000){
    throw new RangeError('Cutover final session limit must be 1-5000')
  }
  if(!Number.isSafeInteger(limits.maxPages)||limits.maxPages<1||limits.maxPages>16384){
    throw new RangeError('Cutover final page limit must be 1-16384')
  }
  return ['--legacy',input.legacyPath,'--backup',input.backupPath,
    '--staging',input.stagingPath,'--max-sessions',String(limits.maxSessions),
    '--max-pages',String(limits.maxPages)]
}

export async function finalizeSlimCutover(input:SlimActivationPaths,port:number,
  limits:CutoverAuditLimits={maxSessions:5000,maxPages:256}):
  Promise<ActiveDatabasePointer>{
  if(!Number.isSafeInteger(port)||port<1||port>65535){
    throw new Error('Valid AgentLens port required for M3 cutover')
  }
  const args=finalGateArgs(input,limits)
  await assertNoDaemonListening(port)
  return activateSlimCutover(input,async()=>{
    await assertNoDaemonListening(port)
    const result=await auditSlimCutoverGate(args,
      {writerFrozen:true,defaultDaemonSlim:true,oldDaemonStopped:true})
    await assertNoDaemonListening(port)
    if(!result.readyToSwitch){
      throw new Error('M3 final cutover blocked: '+result.blockedBy.join(', '))
    }
    return result
  })
}

function parse(args:readonly string[]){
  const action=args[0]
  if(action!=='activate'&&action!=='rollback'){
    throw new Error('Explicit activate or rollback action required')
  }
  const values=new Map<string,string>()
  const flags=['--legacy','--backup','--staging','--installed','--pointer']
  for(let i=1;i<args.length;i++){
    const flag=args[i]
    if(!flag||!flags.includes(flag)||values.has(flag))throw new Error('Invalid cutover option')
    const value=args[++i]
    if(!value||value.startsWith('--'))throw new Error('Missing cutover option value')
    values.set(flag,value)
  }
  for(const flag of action==='activate'?flags:flags.filter(x=>x!=='--staging')){
    if(!values.get(flag))throw new Error('Cutover requires '+flag)
  }
  if(action==='rollback'&&values.has('--staging'))throw new Error('Rollback must not move staging')
  return {action,values}
}
async function main(args:readonly string[]){
  const {action,values}=parse(args)
  const legacyPath=values.get('--legacy')!,backupPath=values.get('--backup')!
  const pointerPath=values.get('--pointer')!,installedSlimPath=values.get('--installed')!
  if(action==='rollback'){
    return rollbackSlimCutover({legacyPath,backupPath,pointerPath,installedSlimPath})
  }
  const stagingPath=values.get('--staging')!
  const observedPort=process.env.AGENT_LENS_PORT
    ?Number(process.env.AGENT_LENS_PORT):56789
  if(!Number.isSafeInteger(observedPort)||observedPort<1||observedPort>65535){
    throw new Error('Valid AGENT_LENS_PORT required for cutover')
  }
  return finalizeSlimCutover({legacyPath,backupPath,stagingPath,
    installedSlimPath,pointerPath},observedPort)
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)
  &&["slim-cutover-activation.ts","slim-cutover-activation.js","slim-cutover-activation.mjs"].includes(invocationBaseName(process.argv[1]))){
  main(process.argv.slice(2)).then(result=>{
    process.stdout.write(JSON.stringify({mode:result.mode,activated:result.mode==='slim'})+'\n')
  }).catch(error=>{
    process.stderr.write('Slim activation refused: '+(error instanceof Error?error.message:String(error))+'\n')
    process.exitCode=1
  })
}
