import type {
  CapturePolicyService, NativeSessionCatalogStore, NativeSessionMetricsStore,
  NativeSessionMetricRebuildCursor, SourceService,
} from '@agent-lens/core'
import type { NativeSessionWindowReader } from './native-session-http'
import { rebuildNativeSessionMetrics } from './native-session-metrics-http'

const MAX_SESSIONS_PER_TRIGGER=4
const RETRY_COOLDOWN_MS=30_000
const MAX_RECENT=128

/**
 * Lazy, bounded, single-flight repair of lightweight Native-only metrics.
 * Starts only after a user requests Usage/Insights; never scans at startup,
 * reads legacy SQL events, or starts a persistent background polling loop.
 *
 * Until Hook completeness and mutable SQLite recovery are certified, only
 * Pi is eligible. Source authorization and CapturePolicy remain in Reader.
 */
export class NativeMetricsAutoRefresh {
  private readonly abort=new AbortController()
  private readonly recent=new Map<string,number>()
  private active:Promise<void>|null=null
  private before:NativeSessionMetricRebuildCursor|undefined

  constructor(
    private readonly catalog:NativeSessionCatalogStore|undefined,
    private readonly metrics:NativeSessionMetricsStore|undefined,
    private readonly reader:NativeSessionWindowReader|undefined,
    private readonly sources:SourceService|undefined,
    private readonly policy:CapturePolicyService|undefined,
  ) {}

  schedule():void {
    if(this.abort.signal.aborted || this.active || !this.catalog
      || !this.metrics?.findRebuildCandidates || !this.reader
      || !this.sources || !this.policy) return
    this.active=this.run().catch(()=>{
      // An opportunistic refresh must never fail a foreground Usage/Insights
      // response. Missing/stale coverage remains visible until next attempt.
    }).finally(()=>{this.active=null})
  }

  private async run():Promise<void> {
    const source=this.sources!.list().find(item=>item.manifest.sourceId==='pi')
    if(!source?.readNativeSessionPage || source.nativeSessionCoverageComplete!==true
      || !this.policy!.isSourceEnabled('pi'))return
    const candidates=await this.metrics!.findRebuildCandidates!({
      sourceId:'pi',parserVersion:source.manifest.parserVersion,
    },MAX_SESSIONS_PER_TRIGGER,this.before)
    // Advance past the selected metadata page even if some sessions fail or
    // are cooling down. Otherwise the newest four block every older session.
    const last=candidates.at(-1)
    this.before=last && candidates.length===MAX_SESSIONS_PER_TRIGGER
      ? {lastActivityAt:last.lastActivityAt,installationId:last.installationId,
          nativeSessionId:last.nativeSessionId}
      : undefined
    for(const candidate of candidates){
      if(this.abort.signal.aborted)return
      const key=JSON.stringify([
        candidate.sourceId,candidate.installationId,candidate.nativeSessionId,
      ])
      const now=Date.now()
      if((this.recent.get(key)??0)>now)continue
      if(this.recent.size>=MAX_RECENT){
        const oldest=this.recent.keys().next().value
        if(oldest!==undefined)this.recent.delete(oldest)
      }
      this.recent.set(key,now+RETRY_COOLDOWN_MS)
      if(candidate.sourceId!=='pi')continue
      const entry=await this.catalog!.getByReviewSessionId(candidate.reviewSessionId)
      if(!entry || entry.locationKind!=='native'
        || entry.sourceId!==candidate.sourceId
        || entry.installationId!==candidate.installationId
        || entry.nativeSessionId!==candidate.nativeSessionId)continue
      try{
        await rebuildNativeSessionMetrics(
          entry,this.metrics!,this.reader!,source,this.abort.signal,
        )
      }catch{
        if(this.abort.signal.aborted)return
        // Failure stays missing/stale; no unverified totals are published.
      }
    }
  }

  dispose():void {
    this.abort.abort()
    this.recent.clear()
    this.before=undefined
  }
}
