import type {
  CapturePolicyService, NativeSessionCatalogStore, NativeSessionMetricsStore,
  NativeSessionMetricRebuildCursor, SourceService,
} from '@agent-lens/core'
import type { NativeSessionWindowReader } from './native-session-http'
import { rebuildNativeSessionMetrics, type NativeMetricRebuildProgress } from './native-session-metrics-http'

const MAX_SESSIONS_PER_TRIGGER=4
const RETRY_COOLDOWN_MS=30_000
const MAX_RECENT=128
const MAX_RESUMABLE=8

/**
 * Lazy, bounded, single-flight repair of lightweight Native-only metrics.
 * Starts only after a user requests Usage/Insights; never scans at startup,
 * reads legacy SQL events, or starts a persistent background polling loop.
 *
 * Sources with incomplete Hook coverage may produce partial numerical snapshots;
 * only fully certified native coverage can produce complete totals. A missing
 * or disabled native Reader never scans, and CapturePolicy remains in the Reader.
 */
export class NativeMetricsAutoRefresh {
  private readonly abort=new AbortController()
  private readonly recent=new Map<string,number>()
  // A restart safely replays from the original Source; no event/ID checkpoint
  // is persisted. Bound open sessions to avoid retaining large call maps.
  private readonly ongoing=new Map<string,NativeMetricRebuildProgress>()
  private active:Promise<void>|null=null
  // Independent per-Source keyset cursors; one certified Source per trigger
  // avoids multiplying the bounded reader budget as adapters are enabled.
  private readonly beforeBySource=new Map<string,NativeSessionMetricRebuildCursor>()
  private nextSourceId:string|undefined

  constructor(
    private readonly catalog:Pick<NativeSessionCatalogStore,'getByReviewSessionId'>|undefined,
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
    const eligible=this.sources!.list().filter(source=>
      // Coverage certification controls snapshot completeness, not whether
      // authorized native Source data can be counted as explicitly partial.
      Boolean(source.readNativeSessionPage)
      && this.policy!.isSourceEnabled(source.manifest.sourceId))
      .sort((a,b)=>a.manifest.sourceId.localeCompare(b.manifest.sourceId))
    if(!eligible.length)return
    const nextIndex=eligible.findIndex(item=>item.manifest.sourceId===this.nextSourceId)
    const source=eligible[nextIndex<0?0:nextIndex]!
    const sourceId=source.manifest.sourceId
    this.nextSourceId=eligible[(nextIndex<0?0:nextIndex)+1]?.manifest.sourceId
      ?? eligible[0]!.manifest.sourceId
    // Continue unfinished long sessions before advancing the metadata keyset.
    // Otherwise an in-progress session disappears from the next candidate page
    // and may never reach EOF when the catalog contains many newer sessions.
    const pending=[...this.ongoing.entries()].find(([,progress])=>
      progress.sourceId===sourceId)
    if(pending){
      const [key,progress]=pending
      const entry=await this.catalog!.getByReviewSessionId(
        // The stable native review ID is resolved from the Catalog rather
        // than synthesized from the Source session ID.
        progress.reviewSessionId,
      )
      if(entry && entry.locationKind==='native'
        && entry.sourceId===progress.sourceId
        && entry.installationId===progress.installationId
        && entry.nativeSessionId===progress.nativeSessionId){
        try{
          const result=await rebuildNativeSessionMetrics(
            entry,this.metrics!,this.reader!,source,this.abort.signal,
            {enabled:true,progress},
          )
          this.ongoing.delete(key)
          if(result.state==='in_progress')this.ongoing.set(key,result.progress)
        }catch{
          if(this.abort.signal.aborted)return
          // A permanently failing Reader must not monopolize a Source's
          // future candidate pages. Discard only its ephemeral partial state;
          // retry from the original Source after the ordinary cooldown.
          this.ongoing.delete(key)
          this.recent.set(key,Date.now()+RETRY_COOLDOWN_MS)
        }
      }else this.ongoing.delete(key)
      return
    }
    const candidates=await this.metrics!.findRebuildCandidates!({
      sourceId,parserVersion:source.manifest.parserVersion,
      coverageCertified:source.nativeSessionCoverageComplete===true,
    },MAX_SESSIONS_PER_TRIGGER,this.beforeBySource.get(sourceId))
    // Advance past the selected metadata page even if some sessions fail or
    // are cooling down. Otherwise the newest four block every older session.
    const last=candidates.at(-1)
    if(last && candidates.length===MAX_SESSIONS_PER_TRIGGER){
      this.beforeBySource.set(sourceId,{
        lastActivityAt:last.lastActivityAt,installationId:last.installationId,
        nativeSessionId:last.nativeSessionId,
      })
    }else this.beforeBySource.delete(sourceId)
    for(const candidate of candidates){
      if(this.abort.signal.aborted)return
      const key=JSON.stringify([
        candidate.sourceId,candidate.installationId,candidate.nativeSessionId,
      ])
      const now=Date.now()
      const resume=this.ongoing.get(key)
      if(!resume && (this.recent.get(key)??0)>now)continue
      if(this.recent.size>=MAX_RECENT){
        const oldest=this.recent.keys().next().value
        if(oldest!==undefined)this.recent.delete(oldest)
      }
      this.recent.set(key,now+RETRY_COOLDOWN_MS)
      if(candidate.sourceId!==sourceId)continue
      const entry=await this.catalog!.getByReviewSessionId(candidate.reviewSessionId)
      if(!entry || entry.locationKind!=='native'
        || entry.sourceId!==candidate.sourceId
        || entry.installationId!==candidate.installationId
        || entry.nativeSessionId!==candidate.nativeSessionId)continue
      try{
        const result=await rebuildNativeSessionMetrics(
          entry,this.metrics!,this.reader!,source,this.abort.signal,
          {enabled:true,reviewSessionId:candidate.reviewSessionId,
            ...(resume?{progress:resume}:{})},
        )
        if(result.state==='in_progress'){
          if(!this.ongoing.has(key) && this.ongoing.size>=MAX_RESUMABLE){
            const oldest=this.ongoing.keys().next().value
            if(oldest!==undefined)this.ongoing.delete(oldest)
          }
          this.ongoing.delete(key)
          this.ongoing.set(key,result.progress)
        }else this.ongoing.delete(key)
      }catch{
        if(this.abort.signal.aborted)return
        // Failure stays missing/stale; no unverified totals are published.
      }
    }
  }

  dispose():void {
    this.abort.abort()
    this.recent.clear()
    this.ongoing.clear()
    this.beforeBySource.clear()
    this.nextSourceId=undefined
  }
}
