import { basename as invocationBaseName } from 'node:path'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stageSlimCutover } from '@agent-lens/storage-sqlite'
import { runNativeReindexAll } from './slim-reindex-all'
import { rebuildAllSlimMetrics } from './slim-rebuild-metrics-all'
import { auditSlimCutoverGate } from './slim-cutover-gate'

export interface SlimPrepareOptions {
  legacyPath: string
  backupPath: string
  stagingPath: string
  maxSessions: number
  maxPages: number
}

/** A one-shot OFFLINE PREPARATION, never a live DB promotion. */
export function parseSlimPrepareArgs(args:readonly string[]):SlimPrepareOptions {
  const names=new Map<string,string>()
  for(let i=0;i<args.length;i++){
    const flag=args[i]
    if(!flag || !['--legacy','--backup','--staging','--limit','--max-pages'].includes(flag)
      || names.has(flag)) throw new TypeError('Unsupported or duplicate Slim prepare option')
    const value=args[++i]
    if(!value || value.startsWith('--'))throw new TypeError('Missing Slim prepare value: '+flag)
    names.set(flag,value)
  }
  const legacyPath=names.get('--legacy')
  const backupPath=names.get('--backup')
  const stagingPath=names.get('--staging')
  if(!legacyPath||!backupPath||!stagingPath){
    throw new Error('Slim prepare requires explicit --legacy, --backup and --staging')
  }
  const paths=[legacyPath,backupPath,stagingPath].map(path=>resolve(path))
  if(new Set(paths).size!==3){
    throw new Error('Slim prepare requires three distinct paths')
  }
  const maxSessions=names.has('--limit')?Number(names.get('--limit')):5000
  const maxPages=names.has('--max-pages')?Number(names.get('--max-pages')):256
  if(!Number.isSafeInteger(maxSessions)||maxSessions<1||maxSessions>5000){
    throw new RangeError('Slim prepare limit must be 1-5000')
  }
  if(!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>16384){
    throw new RangeError('Slim prepare max pages must be 1-16384')
  }
  return {
    legacyPath:paths[0]!,backupPath:paths[1]!,stagingPath:paths[2]!,
    maxSessions,maxPages,
  }
}

export interface SlimPrepareReport {
  copiedRows:Readonly<Record<string,number>>
  discovery:Awaited<ReturnType<typeof runNativeReindexAll>>
  metrics:Awaited<ReturnType<typeof rebuildAllSlimMetrics>>
  gate:Awaited<ReturnType<typeof auditSlimCutoverGate>>
  blockedBy:readonly string[]
  readyToSwitch:false
}

/** Reuse the existing staging, verified Source discovery and read-only gate
 * in ONE explicitly authorized command. All original and backup paths remain
 * untouched; only NEW backup/staging files may be created.
 *
 * A failed scan leaves both new files in place for investigation. Do not
 * delete them or claim an atomic switch was performed.
 */
export async function prepareSlimCutover(args:readonly string[]):Promise<SlimPrepareReport>{
  const input=parseSlimPrepareArgs(args)
  const stage=await stageSlimCutover(input)
  const discovery=await runNativeReindexAll([
    '--staging',input.stagingPath,'--all-installations',
    '--limit',String(input.maxSessions),
  ])
  const metrics=await rebuildAllSlimMetrics([
    '--staging',input.stagingPath,
    '--max-sessions',String(input.maxSessions),
    '--max-pages',String(input.maxPages),
  ])
  const gate=await auditSlimCutoverGate([
    '--legacy',input.legacyPath,'--backup',input.backupPath,
    '--staging',input.stagingPath,'--max-sessions',String(input.maxSessions),
    '--max-pages',String(input.maxPages),
  ])
  const blockedBy=[...new Set([
    ...gate.blockedBy,
    ...(discovery.discoveryComplete?[]:['native-source-enumeration-incomplete']),
    ...(metrics.failed||metrics.partial?['native-numerical-metrics-not-fully-certified']:[]),
    ...(metrics.disabledSources.length?['native-source-disabled-by-capture-policy']:[]),
    ...(metrics.budgetReached?['native-numerical-metrics-budget-exhausted']:[]),
  ])]
  return {
    copiedRows:stage.copiedRows,
    discovery,metrics,gate,blockedBy,
    readyToSwitch:false,
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)
  &&["slim-prepare-cutover.ts","slim-prepare-cutover.js","slim-prepare-cutover.mjs"].includes(invocationBaseName(process.argv[1]))){
  prepareSlimCutover(process.argv.slice(2)).then(report=>{
    process.stdout.write(JSON.stringify(report,null,2)+'\n')
  }).catch(error=>{
    process.stderr.write('Slim prepare refused: '+
      (error instanceof Error?error.message:String(error))+'\n')
    process.exitCode=1
  })
}
