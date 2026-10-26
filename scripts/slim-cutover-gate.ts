import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { auditSlimNativeCoverage, auditSlimCutoverFreshness } from '@agent-lens/storage-sqlite'
import { runOriginalsAudit, type OriginalsAuditReport } from './slim-audit-originals'
import { auditLegacyHookOriginals,type LegacyHookAuditReport } from './slim-audit-legacy-hooks'

export interface SlimCutoverGateArgs {
  legacyPath:string
  backupPath:string
  stagingPath:string
  maxSessions:number
  maxPages:number
}

export function parseSlimGateArgs(args:readonly string[]):SlimCutoverGateArgs{
  const params=new Map<string,string>()
  for(let i=0;i<args.length;i++){
    const flag=args[i]
    if(!flag || !['--legacy','--backup','--staging','--max-sessions','--max-pages'].includes(flag)
      || params.has(flag))throw new TypeError('Unsupported or repeated slim gate argument')
    const value=args[++i]
    if(!value||value.startsWith('--'))throw new TypeError('Missing slim gate argument: '+flag)
    params.set(flag,value)
  }
  const legacyPath=params.get('--legacy')
  const backupPath=params.get('--backup')
  const stagingPath=params.get('--staging')
  if(!legacyPath||!backupPath||!stagingPath){
    throw new Error('Slim gate requires explicit --legacy, --backup and --staging')
  }
  const maxSessions=params.has('--max-sessions')?Number(params.get('--max-sessions')):5000
  const maxPages=params.has('--max-pages')?Number(params.get('--max-pages')):256
  if(!Number.isSafeInteger(maxSessions)||maxSessions<1||maxSessions>5000){
    throw new RangeError('Slim gate max sessions must be 1-5000')
  }
  if(!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>16384){
    throw new RangeError('Slim gate max pages must be 1-16384')
  }
  return {legacyPath,backupPath,stagingPath,maxSessions,maxPages}
}

export interface SlimCutoverGateReport {
  originalIdentities:number
  catalogNative:number
  catalogArchivedOnly:number
  originalContentVerified:number
  originalContentUnavailable:number
  originalContentPartial:number
  missingNativeCatalog:number
  missingSessionContexts:number
  oldDatabaseChanged:boolean
  unfinishedNativeMetrics:number
  partialNativeMetrics:number
  legacyHookRecords:number
  legacyHookOriginalsVerified:number
  legacyHookOriginalsIncomplete:boolean
  /** Unmapped legacy SourceRecords cannot be certified by native session catalog. */
  legacyRecordsWithoutSession:number
  blockedBy:readonly string[]
  /** No automatic promotion is possible while the old full Service is active. */
  readyToSwitch:boolean
}

export function summarizeSlimGate(input:{
  identities:{
    oldSessionIdentities:number;nativeIndexed:number;archivedOnly:number
    missingFromNativeCatalog:number;missingContext:number
    invalidOldIdentities:number;legacyRecordsWithoutSession:number
    nativeMetricsMissingOrStale:number
    nativeMetricsPartial?:number
    legacyHookRecords?:number
  }
  originals:Pick<OriginalsAuditReport,
    'verified'|'partial'|'unavailable'|'drifted'|'unsupported'
    |'catalogEnumerationComplete'|'allCurrentOriginalsVerified'>
  oldDatabaseUnchanged:boolean
  /** Only a finalizer holding the real old SQLite writer lock may supply. */
  finalization?:{writerFrozen:true;defaultDaemonSlim:true;oldDaemonStopped:true}
  hooks?:Pick<LegacyHookAuditReport,'found'|'verified'|'scanComplete'|'allLegacyHookOriginalsVerified'>
}):SlimCutoverGateReport{
  const {identities,originals}=input
  const blockedBy:string[]=[]
  if(!input.oldDatabaseUnchanged)blockedBy.push('legacy-database-changed-since-snapshot')
  if(identities.invalidOldIdentities)blockedBy.push('invalid-old-session-identities')
  if(identities.legacyRecordsWithoutSession)blockedBy.push('legacy-source-records-without-native-session')
  if(identities.missingFromNativeCatalog)blockedBy.push('old-sessions-missing-native-catalog')
  if(identities.missingContext)blockedBy.push('old-sessions-missing-slim-context')
  if(!originals.catalogEnumerationComplete)blockedBy.push('native-audit-budget-or-enumeration-incomplete')
  if(!originals.allCurrentOriginalsVerified)blockedBy.push('original-session-content-unverified')
  if(identities.nativeMetricsMissingOrStale)blockedBy.push('native-metrics-missing-or-stale')
  if(identities.nativeMetricsPartial)blockedBy.push('native-metrics-partial-not-certified')
  const hooksComplete=Boolean(input.hooks?.scanComplete
    &&input.hooks.allLegacyHookOriginalsVerified
    &&input.hooks.found===(identities.legacyHookRecords??0)
    &&input.hooks.verified===(identities.legacyHookRecords??0))
  if(identities.legacyHookRecords&&!hooksComplete){
    blockedBy.push('legacy-hook-records-require-archive-verification')
  }
  if(identities.archivedOnly)blockedBy.push('archived-only-sessions-not-deep-audited')
  // Hook-only history, application configuration, daemon writer ownership,
  // cleanup/rollback and migration ownership have separate mandatory gates.
  if(!hooksComplete||identities.archivedOnly)blockedBy.push('hook-and-archival-coverage-not-certified')
  if(!input.finalization?.defaultDaemonSlim||!input.finalization.oldDaemonStopped){
    blockedBy.push('full-consumer-and-legacy-writer-retirement-pending')
  }
  if(!input.finalization?.writerFrozen){
    blockedBy.push('old-writer-freeze-and-atomic-swap-not-certified')
  }
  return {
    originalIdentities:identities.oldSessionIdentities,
    catalogNative:identities.nativeIndexed,
    catalogArchivedOnly:identities.archivedOnly,
    originalContentVerified:originals.verified,
    originalContentUnavailable:originals.unavailable+originals.drifted+originals.unsupported,
    originalContentPartial:originals.partial,
    missingNativeCatalog:identities.missingFromNativeCatalog,
    missingSessionContexts:identities.missingContext,
    oldDatabaseChanged:!input.oldDatabaseUnchanged,
    unfinishedNativeMetrics:identities.nativeMetricsMissingOrStale,
    partialNativeMetrics:identities.nativeMetricsPartial??0,
    legacyHookRecords:identities.legacyHookRecords??0,
    legacyHookOriginalsVerified:input.hooks?.verified??0,
    legacyHookOriginalsIncomplete:!hooksComplete,
    legacyRecordsWithoutSession:identities.legacyRecordsWithoutSession,
    blockedBy,
    readyToSwitch:blockedBy.length===0&&Boolean(input.finalization),
  }
}

/** One explicit, read-only rehearsal command. Each report is read-only;
 * re-check old DB after slow original-file verification to detect drift during
 * the audit. Never promotes a DB, stops an Agent, or deletes old data.
 */
export async function auditSlimCutoverGate(args:readonly string[],
  finalization?:{writerFrozen:true;defaultDaemonSlim:true;oldDaemonStopped:true},
):Promise<SlimCutoverGateReport>{
  const input=parseSlimGateArgs(args)
  const paths={
    legacyPath:input.legacyPath,
    backupPath:input.backupPath,
    stagingPath:input.stagingPath,
  }
  const freshness=await auditSlimCutoverFreshness(paths)
  const old=new Database(input.legacyPath,{readonly:true,fileMustExist:true})
  let identities:ReturnType<typeof auditSlimNativeCoverage>
  try{
    const slim=new Database(input.stagingPath,{readonly:true,fileMustExist:true})
    try{identities=auditSlimNativeCoverage(old,slim)}
    finally{slim.close()}
  }finally{old.close()}
  const originals=await runOriginalsAudit([
    '--staging',input.stagingPath,
    '--max-sessions',String(input.maxSessions),
    '--max-pages',String(input.maxPages),
  ])
  const hooks=await auditLegacyHookOriginals([
    '--legacy',input.legacyPath,'--staging',input.stagingPath,
    '--max-records',String(input.maxSessions),
  ])
  const finalFreshness=await auditSlimCutoverFreshness(paths)
  return summarizeSlimGate({
    identities,originals,hooks,
    ...(finalization?{finalization}:{}),
    oldDatabaseUnchanged:freshness.unchangedSinceBackup&&finalFreshness.unchangedSinceBackup,
  })
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)
  &&/(?:^|[\\/])slim-cutover-gate\\.(?:[cm]?js|[cm]?ts)$/.test(process.argv[1])){
  auditSlimCutoverGate(process.argv.slice(2)).then(report=>{
    process.stdout.write(JSON.stringify(report,null,2)+'\n')
  }).catch(error=>{
    process.stderr.write('Slim cutover gate refused: '+
      (error instanceof Error?error.message:String(error))+'\n')
    process.exitCode=1
  })
}
