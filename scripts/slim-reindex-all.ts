import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { indexNativeInstallation } from '@agent-lens/core-services'
import { resolveCapturePolicyPluginState } from '@agent-lens/capture-policy'
import { SqliteSlimStorage } from '@agent-lens/storage-sqlite'
import { NATIVE_REINDEX_SOURCES } from './slim-reindex-native'

export interface ReindexAllArgs {
  stagingPath: string
  limit: number
  sourceId?: string
}

export function parseReindexAllArgs(args: readonly string[]): ReindexAllArgs {
  const opts = new Map<string,string>()
  for (let i=0;i<args.length;i++) {
    const key=args[i]
    if (!key || !['--staging','--limit','--source','--all-installations'].includes(key)
        || opts.has(key)) throw new TypeError('Invalid or repeated reindex-all flag: '+key)
    if(key==='--all-installations') {opts.set(key,'true');continue}
    const value=args[++i]
    if(!value || value.startsWith('--')) throw new TypeError('Missing reindex-all value: '+key)
    opts.set(key,value)
  }
  if(!opts.has('--all-installations')) throw new Error('Explicit --all-installations is required')
  const stagingPath=opts.get('--staging')
  if(!stagingPath) throw new Error('Explicit --staging is required')
  const limit=opts.has('--limit')?Number(opts.get('--limit')):128
  if(!Number.isSafeInteger(limit)||limit<1||limit>5000) {
    throw new RangeError('Reindex-all --limit must be between 1 and 5000')
  }
  const sourceId=opts.get('--source')
  if(sourceId && !NATIVE_REINDEX_SOURCES.has(sourceId)) {
    throw new Error('Unknown native Source: '+sourceId)
  }
  return {stagingPath,limit,...(sourceId?{sourceId}:{})}
}

export interface ReindexAllReport {
  sourceResults: Array<{
    sourceId:string
    scanned:number
    indexed:number
    partial:boolean
    exhausted:boolean
    failed:number
  }>
  skippedProducts: string[]
  /** True only when every selected registered Source was fully enumerated
   * and all first-record checks succeeded; not content-completeness proof. */
  discoveryComplete: boolean
  readyToSwitch:false
}

/** Explicit offline migration orchestrator. Uses only an existing staging DB,
 * enumerates native installations/profiles without requiring manual IDs.
 * Source-owned file authorization still occurs inside the real adapter.
 * No Legacy Writer, source transcript SQL or active DB swapping.
 */
export async function runNativeReindexAll(args:readonly string[]):Promise<ReindexAllReport> {
  const input=parseReindexAllArgs(args)
  const slim=SqliteSlimStorage.openExisting(input.stagingPath)
  try {
    const installations=slim.db.prepare(`
      SELECT id,product_id FROM agent_installations ORDER BY product_id,id
    `).all() as Array<{id:string;product_id:string}>
    const reports:ReindexAllReport['sourceResults']=[]
    const enabled=new Set(resolveCapturePolicyPluginState().settings.enabledSources)
    const skipped=new Set<string>()
    for(const row of installations) {
      const candidates=[...NATIVE_REINDEX_SOURCES.values()]
        .filter(source=>source.manifest.productId===row.product_id
          && (!input.sourceId||source.manifest.sourceId===input.sourceId)
          && enabled.has(source.manifest.sourceId))
      if(!candidates.length) {
        if(!input.sourceId)skipped.add(row.product_id)
        continue
      }
      const profiles=slim.db.prepare(`
        SELECT id FROM runtime_profiles WHERE installation_id=?
        ORDER BY native_profile_id,id
      `).all(row.id) as Array<{id:string}>
      // When profiles exist their roots own session discovery. Do not scan
      // the installation root once per profile or silently merge sessions.
      const scopes=profiles.length?profiles:[{id:''}]
      for(const source of candidates) {
        for(const scope of scopes) {
          const profile=scope.id?await slim.runtimeProfiles.get(scope.id):undefined
          if(scope.id&&!profile)throw new Error('Runtime profile disappeared during reindex')
          const report=await indexNativeInstallation(slim,{
            source,installationId:row.id,signal:new AbortController().signal,
            maxSessions:input.limit,
            fullEnumeration:true,
            ...(profile?{runtimeProfile:profile}:{}),
          })
          reports.push({
            sourceId:report.sourceId,
            scanned:report.scanned,
            indexed:report.indexed,
            partial:report.nativeCoverage==='partial',
            exhausted:report.exhausted,
            failed:Object.values(report.failures).reduce((sum,n)=>sum+(n??0),0),
          })
        }
      }
    }
    return {
      sourceResults:reports,
      skippedProducts:[...skipped].sort(),
      discoveryComplete:reports.length>0 && reports.every(r=>r.exhausted&&!r.failed)
        && skipped.size===0,
      readyToSwitch:false,
    }
  }finally{await slim.close()}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)
  &&/(?:^|[\\/])slim-reindex-all\\.(?:[cm]?js|[cm]?ts)$/.test(process.argv[1])){
  runNativeReindexAll(process.argv.slice(2)).then(report=>{
    process.stdout.write(JSON.stringify(report,null,2)+'\n')
  }).catch(error=>{
    process.stderr.write('Native reindex-all refused: '+
      (error instanceof Error?error.message:String(error))+'\n')
    process.exitCode=1
  })
}
