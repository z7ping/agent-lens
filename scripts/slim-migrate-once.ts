import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join,resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveAgentLensNodeRuntime } from '@agent-lens/runtime-cordis'
import { readActiveDatabasePointer } from '@agent-lens/storage-sqlite'
import { prepareSlimCutover } from './slim-prepare-cutover'
import { finalizeSlimCutover,assertNoDaemonListening } from './slim-cutover-activation'

export interface MigrateOnceOptions {
  legacyPath:string;dataRoot:string;pointerPath:string
  installedSlimPath:string;backupPath:string;stagingPath:string
  maxSessions:number;maxPages:number;port:number
}
export function parseMigrateOnceArgs(args:readonly string[],
  env:NodeJS.ProcessEnv=process.env,
  uuid=()=>randomUUID(),
):MigrateOnceOptions{
  const options=new Map<string,string>()
  for(let i=0;i<args.length;i++){
    const key=args[i]
    if(!key||!['--max-sessions','--max-pages'].includes(key)
      ||options.has(key))throw new Error('Migrate takes only --max-sessions and --max-pages')
    const value=args[++i]
    if(!value||value.startsWith('--'))throw new Error('Missing M3 migration limit')
    options.set(key,value)
  }
  const maxSessions=options.has('--max-sessions')?Number(options.get('--max-sessions')):5000
  const maxPages=options.has('--max-pages')?Number(options.get('--max-pages')):16384
  if(!Number.isSafeInteger(maxSessions)||maxSessions<1||maxSessions>5000){
    throw new RangeError('M3 session limit must be between 1 and 5000')
  }
  if(!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>16384){
    throw new RangeError('M3 page limit must be between 1 and 16384')
  }
  const port=env.AGENT_LENS_PORT?Number(env.AGENT_LENS_PORT):56789
  if(!Number.isSafeInteger(port)||port<1||port>65535){
    throw new RangeError('Invalid AgentLens port for migration stop check')
  }
  const dataRoot=resolve(resolveAgentLensNodeRuntime().dataRoot)
  const legacyPath=resolve(env.AGENT_LENS_DB_PATH??join(dataRoot,'agent-lens.db'))
  const pointerPath=resolve(env.AGENT_LENS_ACTIVE_DB_POINTER??join(dataRoot,'active-database.json'))
  const id=uuid()
  if(!/^[0-9a-f-]{36}$/i.test(id))throw new Error('Invalid migration backup ID')
  const installedSlimPath=join(dataRoot,'agent-lens-slim.db')
  // Exclusive creation, unique evidence snapshots; never overwrite a prior
  // backup or staging run. Stage and installed file share a filesystem.
  const backupPath=join(dataRoot,'agent-lens-v38-'+id+'.backup.sqlite')
  const stagingPath=join(dataRoot,'agent-lens-v1-'+id+'.staging.sqlite')
  if(new Set([legacyPath,pointerPath,installedSlimPath,backupPath,stagingPath]).size!==5){
    throw new Error('M3 migration files must be distinct')
  }
  return {legacyPath,dataRoot,pointerPath,installedSlimPath,backupPath,
    stagingPath,maxSessions,maxPages,port}
}
export async function runSlimMigrateOnce(args:readonly string[]){
  const plan=parseMigrateOnceArgs(args)
  if(!existsSync(plan.legacyPath))throw new Error('No v38 database to migrate')
  if(existsSync(plan.installedSlimPath)){
    throw new Error('Slim destination already exists: refusing to overwrite a previous migration')
  }
  if(await readActiveDatabasePointer(plan.pointerPath)){
    throw new Error('An active or rolled-back database pointer exists; resolve it before migrating')
  }
  await assertNoDaemonListening(plan.port)
  const prepared=await prepareSlimCutover([
    '--legacy',plan.legacyPath,'--backup',plan.backupPath,
    '--staging',plan.stagingPath,'--limit',String(plan.maxSessions),
    '--max-pages',String(plan.maxPages),
  ])
  // Rehearsal is never a green final gate: the finalizer recalculates
  // everything under the actual old SQLite writer freeze.
  const activated=await finalizeSlimCutover({
    legacyPath:plan.legacyPath,backupPath:plan.backupPath,
    stagingPath:plan.stagingPath,installedSlimPath:plan.installedSlimPath,
    pointerPath:plan.pointerPath,
  },plan.port)
  return {
    state:'activated' as const,mode:activated.mode,
    backupPath:plan.backupPath,slimPath:activated.slimPath,
    pointerPath:plan.pointerPath,
    copiedTables:Object.keys(prepared.copiedRows).length,
    scannedSources:prepared.discovery.sourceResults.length,
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)
  &&/(?:^|[\\/])slim-migrate(?:-once)?\\.(?:[cm]?js|[cm]?ts)$/.test(process.argv[1])){
  runSlimMigrateOnce(process.argv.slice(2)).then(x=>{
    process.stdout.write(JSON.stringify(x,null,2)+'\n')
  }).catch(error=>{
    process.stderr.write('AgentLens v38→Slim migration blocked: '+
      (error instanceof Error?error.message:String(error))+'\n')
    process.exitCode=1
  })
}
