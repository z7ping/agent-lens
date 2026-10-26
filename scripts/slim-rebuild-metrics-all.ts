import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DefaultSourceService } from '@agent-lens/core-services'
import { DefaultCapturePolicyService, capturePolicySettingsFromEnv } from '@agent-lens/capture-policy'
import { rebuildNativeSessionMetrics } from '../packages/surface-http/src/native-session-metrics-http'
import type { NativeMetricRebuildProgress } from '../packages/surface-http/src/native-session-metrics-http'
import { SlimDataRuntime } from '../apps/daemon/src/data-runtime/slim-runtime'
import { NATIVE_REINDEX_SOURCES } from './slim-reindex-native'

export interface OfflineMetricsOptions {
  stagingPath:string
  maxSessions:number
  maxPages:number
}
export function parseOfflineMetricArgs(args:readonly string[]):OfflineMetricsOptions {
  const options=new Map<string,string>()
  for(let i=0;i<args.length;i++){
    const flag=args[i]
    if(!flag||!['--staging','--max-sessions','--max-pages'].includes(flag)
      || options.has(flag))throw new Error('Invalid offline metrics argument')
    const value=args[++i]
    if(!value||value.startsWith('--'))throw new Error('Missing offline metrics argument')
    options.set(flag,value)
  }
  const stagingPath=options.get('--staging')
  if(!stagingPath)throw new Error('Offline metrics require explicit --staging')
  const maxSessions=options.has('--max-sessions')?Number(options.get('--max-sessions')):5000
  const maxPages=options.has('--max-pages')?Number(options.get('--max-pages')):16384
  if(!Number.isSafeInteger(maxSessions)||maxSessions<1||maxSessions>5000){
    throw new RangeError('Offline metric session budget must be 1-5000')
  }
  if(!Number.isSafeInteger(maxPages)||maxPages<64||maxPages>16384){
    throw new RangeError('Offline metric page budget must be 64-16384')
  }
  return {stagingPath:resolve(stagingPath),maxSessions,maxPages}
}
export interface OfflineMetricsReport {
  scanned:number
  complete:number
  partial:number
  failed:number
  unfinished:number
  sourceResults:Array<{sourceId:string;scanned:number;complete:number;partial:number;failed:number}>
  /** Missing, stalled, uncertified Sources prevent M3 activation. */
  readyToSwitch:false
}
/** Offline only: reuses exactly the already shipped per-session numerical
 * projector, authorized isolated NativeReader and Slim worker storage.
 * Never requests or stores original prompts, payloads, Evidence or events.
 * The per-call accumulator/cursor is ephemeral, with bounded total pages.
 */
export async function rebuildAllSlimMetrics(args:readonly string[]):Promise<OfflineMetricsReport>{
  const options=parseOfflineMetricArgs(args)
  const runtime=new SlimDataRuntime({dbPath:options.stagingPath})
  await runtime.start()
  try{
    const sources=new DefaultSourceService()
    for(const source of NATIVE_REINDEX_SOURCES.values())sources.register(source)
    const policy=new DefaultCapturePolicyService({
      ...capturePolicySettingsFromEnv({}),
      enabledSources:sources.list().map(source=>source.manifest.sourceId),
    })
    const reader=runtime.nativeReader(sources,policy)
    const {nativeSessionCatalog:catalog,nativeSessionMetrics:metrics}=runtime.nativeHttpPort()
    if(!metrics.findRebuildCandidates)throw Error('Slim numerical rebuild candidate port missing')
    const report:OfflineMetricsReport={
      scanned:0,complete:0,partial:0,failed:0,unfinished:0,
      sourceResults:[],readyToSwitch:false,
    }
    const signal=new AbortController().signal
    for(const source of sources.list()){
      const per={sourceId:source.manifest.sourceId,scanned:0,complete:0,partial:0,failed:0}
      report.sourceResults.push(per)
      let before:NonNullable<Parameters<NonNullable<typeof metrics.findRebuildCandidates>>[2]>
        |undefined
      while(report.scanned<options.maxSessions){
        const page=await metrics.findRebuildCandidates({
          sourceId:source.manifest.sourceId,
          parserVersion:source.manifest.parserVersion,
          coverageCertified:source.nativeSessionCoverageComplete===true,
        },Math.min(4,options.maxSessions-report.scanned),before)
        if(!page.length)break
        for(const candidate of page){
          report.scanned++;per.scanned++
          const entry=await catalog.getByReviewSessionId(candidate.reviewSessionId)
          if(!entry||entry.locationKind!=='native'
            ||entry.sourceId!==candidate.sourceId
            ||entry.installationId!==candidate.installationId
            ||entry.nativeSessionId!==candidate.nativeSessionId){
            report.failed++;per.failed++
            continue
          }
          let progress:NativeMetricRebuildProgress|undefined
          let resultState:'complete'|'partial'|'failed'='failed'
          // Each resumed call reads <=64 original pages; all state is in
          // memory until the verified EOF makes a numerical snapshot safe.
          for(let call=0;call<Math.ceil(options.maxPages/64);call++){
            const result=await rebuildNativeSessionMetrics(entry,metrics,reader,source,signal,{
              enabled:true,reviewSessionId:candidate.reviewSessionId,
              ...(progress?{progress}:{}),
            })
            if(result.state==='in_progress'){
              progress=result.progress
              continue
            }
            if(result.state==='available'){
              resultState=result.coverage==='complete'?'complete':'partial'
            }
            break
          }
          if(resultState==='complete'){report.complete++;per.complete++}
          else if(resultState==='partial'){report.partial++;per.partial++}
          else{report.failed++;per.failed++}
          if((report.scanned&7)===0)await new Promise<void>(done=>setImmediate(done))
        }
        const last=page.at(-1)!
        before={lastActivityAt:last.lastActivityAt,
          installationId:last.installationId,nativeSessionId:last.nativeSessionId}
        if(page.length<4)break
      }
      // A complete Source with a rebuilt ready numerical projection has no
      // remaining candidates. The final cross-Source gate performs the
      // authoritative current/partial/stale/missing SQL reconciliation.
      if(report.scanned>=options.maxSessions)break
    }
    report.unfinished=report.failed+report.partial
    return report
  }finally{await runtime.shutdown()}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  rebuildAllSlimMetrics(process.argv.slice(2)).then(report=>{
    process.stdout.write(JSON.stringify(report,null,2)+'\n')
  }).catch(error=>{
    process.stderr.write('Offline Slim metrics refused: '+
      (error instanceof Error?error.message:String(error))+'\n')
    process.exitCode=1
  })
}
