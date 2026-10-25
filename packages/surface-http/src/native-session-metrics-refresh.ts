import type {
  CapturePolicyService, NativeSessionCatalogStore, NativeSessionMetricsStore,
  SourceService,
} from '@agent-lens/core'
import type { NativeSessionWindowReader } from './native-session-http'
import { rebuildNativeSessionMetrics } from './native-session-metrics-http'

const PROBE_COOLDOWN_MS=5_000
const ATTEMPT_COOLDOWN_MS=5*60_000
const MAX_ATTEMPT_KEYS=256

export interface NativeMetricRefreshScope {
  sourceIds?:readonly string[]
  projectId?:string
  logicalSessionId?:string
  toolName?:string
}

/** Lazy maintenance, never startup recovery:
 * - triggered only after an actual unscoped Usage/Insights read
 * - one Source session per trigger, one worker read at a time
 * - only durable Native-only claims can be candidates
 * - bounded candidate probes + cooldown avoid retry storms
 */
export class NativeMetricsDemandRefresh {
  private active=false
  private stopped=false
  private controller:AbortController|null=null
  private readonly probedAt=new Map<string,number>()
  private readonly attemptedAt=new Map<string,number>()

  constructor(
    private readonly catalog:NativeSessionCatalogStore|undefined,
    private readonly metrics:NativeSessionMetricsStore|undefined,
    private readonly reader:NativeSessionWindowReader|undefined,
    private readonly sources:SourceService|undefined,
    private readonly policy:CapturePolicyService|undefined,
  ){}

  request(scope:NativeMetricRefreshScope={}):void{
    if(this.stopped||this.active||!this.catalog||!this.metrics?.listPending
      ||!this.reader||!this.sources||!this.policy
      ||scope.projectId||scope.logicalSessionId||scope.toolName
      ||scope.sourceIds?.length===0)return

    const allowed=this.sources.list().filter(source=>
      source.readNativeSessionPage
      && this.policy!.isSourceEnabled(source.manifest.sourceId)
      && (!scope.sourceIds||scope.sourceIds.includes(source.manifest.sourceId)))
    if(!allowed.length)return
    this.active=true
    // Runs after the requesting HTTP response has been sent. No file scans
    // are performed synchronously in the Usage/Insights request.
    setImmediate(()=>{
      void this.run(allowed).catch(error=>{
        if(!this.stopped)console.warn('[AgentLens] Native metrics lazy refresh failed',{
          errorType:error instanceof Error?error.name:'unknown',
          // No Source file paths, payloads or user prompts in diagnostics.
        })
      }).finally(()=>{this.active=false})
    })
  }

  private async run(allowed:ReturnType<SourceService['list']>):Promise<void>{
    if(!this.metrics?.listPending||!this.catalog||!this.reader)return
    const now=Date.now()
    for(const source of allowed){
      if(this.stopped)return
      const sourceId=source.manifest.sourceId
      const lastProbe=this.probedAt.get(sourceId)??0
      if(now-lastProbe<PROBE_COOLDOWN_MS)continue
      this.probedAt.set(sourceId,now)
      const pending=await this.metrics.listPending({
        sourceId,parserVersion:source.manifest.parserVersion,
      })
      for(const candidate of pending){
        if(this.stopped)return
        const key=JSON.stringify([
          candidate.sourceId,candidate.installationId,candidate.nativeSessionId,
          candidate.fileIdentity,candidate.fileSize,candidate.fileMtimeMs,
          source.manifest.parserVersion,
        ])
        const lastAttempt=this.attemptedAt.get(key)??0
        if(now-lastAttempt<ATTEMPT_COOLDOWN_MS)continue
        // Schedule only for the exact native revision selected by SQL. The
        // writer will repeat the revision check before committing the rollup.
        const entry=await this.catalog.get({
          sourceId:candidate.sourceId,
          installationId:candidate.installationId,
          nativeSessionId:candidate.nativeSessionId,
          locationKind:'native',
        })
        if(!entry||entry.fileIdentity!==candidate.fileIdentity
          ||entry.fileSize!==candidate.fileSize
          ||entry.fileMtimeMs!==candidate.fileMtimeMs)continue
        this.attemptedAt.set(key,now)
        while(this.attemptedAt.size>MAX_ATTEMPT_KEYS){
          const oldest=this.attemptedAt.keys().next().value
          if(oldest===undefined)break
          this.attemptedAt.delete(oldest)
        }
        const controller=new AbortController()
        this.controller=controller
        try{
          await rebuildNativeSessionMetrics(entry,this.metrics,this.reader,source,controller.signal)
        }finally{
          this.controller=null
        }
        // A request authorizes at most one bounded Source scan; do not drain
        // an installation's catalog in one automatic maintenance task.
        return
      }
    }
  }

  dispose():void{
    this.stopped=true
    this.controller?.abort()
  }
}
