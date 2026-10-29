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
const MAX_BATCHES_PER_REQUEST=256
const BATCH_PAUSE_MS=150

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
  private queueTimer:ReturnType<typeof setTimeout>|null=null
  private batchesRemaining=0
  private idleBatches=0
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
    private readonly onUpdated?:(reviewSessionId:string)=>void,
  ) {}

  schedule():void {
    if(this.abort.signal.aborted || this.active || this.queueTimer || !this.catalog
      || !this.metrics?.findRebuildCandidates || !this.reader
      || !this.sources || !this.policy) return
    if(!this.batchesRemaining) {
      this.batchesRemaining=MAX_BATCHES_PER_REQUEST
      this.idleBatches=0
    }
    this.active=this.run().then(progressed=>{
      if(this.abort.signal.aborted)return
      this.batchesRemaining--
      this.idleBatches=progressed?0:this.idleBatches+1
      // Work is lazy, but once requested it drains bounded batches without
      // needing the user to repeatedly press Refresh. A full idle source
      // sweep (or the safety budget) ends the run.
      const sourceCount=this.sources!.list().filter(source=>
        Boolean(source.readNativeSessionPage)
        && this.policy!.isSourceEnabled(source.manifest.sourceId)).length
      if(this.batchesRemaining>0 && sourceCount>0 && this.idleBatches<sourceCount) {
        this.queueTimer=setTimeout(()=>{
          this.queueTimer=null
          this.schedule()
        },BATCH_PAUSE_MS)
      } else this.batchesRemaining=0
    }).catch(()=>{
      this.batchesRemaining=0
      // Failed opportunistic work leaves incomplete coverage visible.
    }).finally(()=>{this.active=null})
  }

  private async run():Promise<boolean> {
    const eligible=this.sources!.list().filter(source=>
      // Coverage certification controls snapshot completeness, not whether
      // authorized native Source data can be counted as explicitly partial.
      Boolean(source.readNativeSessionPage)
      && this.policy!.isSourceEnabled(source.manifest.sourceId))
      .sort((a,b)=>a.manifest.sourceId.localeCompare(b.manifest.sourceId))
    if(!eligible.length)return false
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
          if(result.state==='available')this.onUpdated?.(progress.reviewSessionId)
          return result.state==='available'||result.state==='in_progress'
        }catch{
          if(this.abort.signal.aborted)return false
          // A permanently failing Reader must not monopolize a Source's
          // future candidate pages. Discard only its ephemeral partial state;
          // retry from the original Source after the ordinary cooldown.
          this.ongoing.delete(key)
          this.recent.set(key,Date.now()+RETRY_COOLDOWN_MS)
        }
      }else this.ongoing.delete(key)
      return false
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
    let progressed=false
    for(const candidate of candidates){
      if(this.abort.signal.aborted)return false
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
        if(result.state==='available'){
          progressed=true
          this.onUpdated?.(candidate.reviewSessionId)
        }
        if(result.state==='in_progress'){
          progressed=true
          if(!this.ongoing.has(key) && this.ongoing.size>=MAX_RESUMABLE){
            const oldest=this.ongoing.keys().next().value
            if(oldest!==undefined)this.ongoing.delete(oldest)
          }
          this.ongoing.delete(key)
          this.ongoing.set(key,result.progress)
        }else this.ongoing.delete(key)
      }catch{
        if(this.abort.signal.aborted)return false
        // Failure stays missing/stale; no unverified totals are published.
      }
    }
    return progressed
  }

  dispose():void {
    this.abort.abort()
    if(this.queueTimer)clearTimeout(this.queueTimer)
    this.queueTimer=null
    this.recent.clear()
    this.ongoing.clear()
    this.beforeBySource.clear()
    this.nextSourceId=undefined
  }
}
