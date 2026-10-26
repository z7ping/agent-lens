import type {
  CapturePolicyService, RuntimeProfile, SourceService,
} from '@agent-lens/core'
import type { NativeCaptureHandle } from '@agent-lens/core-services'
import type { SlimDataRuntime } from './data-runtime/slim-runtime.js'

const MAX_STARTUP_SCOPES=256
const MAX_STARTUP_SESSIONS_PER_SCOPE=128

export interface SlimSourceProgress {
  examinedScopes:number
  indexedSessions:number
  runningCaptures:number
  failedScopes:number
  deferredScopes:number
  finished:boolean
}

/** Native-only startup reconciliation. Existing Slim installations are read
 * via bounded metadata, not by importing old HistorySync/Legacy Writer.
 * It runs AFTER HTTP listen and never blocks the initial response.
 */
export class SlimSourceCoordinator {
  private readonly abort=new AbortController()
  private task:Promise<void>|null=null
  private readonly captures:NativeCaptureHandle[]=[]
  private progress:Omit<SlimSourceProgress,'runningCaptures'>={
    examinedScopes:0,indexedSessions:0,failedScopes:0,deferredScopes:0,finished:false,
  }

  constructor(
    private readonly runtime:Pick<SlimDataRuntime,
      'facets'|'profiles'|'reindexInstallation'|'captureInstallation'>,
    private readonly sources:SourceService,
    private readonly policy:Pick<CapturePolicyService,'isSourceEnabled'>,
  ) {}

  snapshot():SlimSourceProgress{
    return {...this.progress,runningCaptures:this.captures.length}
  }

  start():void{
    if(this.task)return
    this.task=Promise.resolve().then(()=>this.run()).catch(error=>{
      if(!this.abort.signal.aborted){
        this.progress.failedScopes++
        console.warn('[AgentLens] native-only source startup failed',error)
      }
    }).finally(()=>{this.progress.finished=true})
  }

  private async run():Promise<void>{
    const facets=await this.runtime.facets()
    const registered=this.sources.list()
    let scoped=0
    for(const product of facets.installedProducts){
      if(this.abort.signal.aborted)break
      const available=registered.filter(source=>
        source.manifest.productId===product.productId
        && this.policy.isSourceEnabled(source.manifest.sourceId))
      if(!available.length)continue
      for(const installationId of product.installationIds){
        if(this.abort.signal.aborted)break
        let profiles:RuntimeProfile[]
        try{profiles=await this.runtime.profiles(installationId)}catch(error){
          if(this.abort.signal.aborted)break
          this.progress.failedScopes++
          console.warn('[AgentLens] Slim native Profile enumeration failed',{
            installationId,error,
          })
          continue
        }
        // Profiles own their own native roots. Never scan the installation
        // root as a second identity when Profiles were explicitly indexed.
        const scopes:(RuntimeProfile|undefined)[]=profiles.length?profiles:[undefined]
        for(const source of available){
          for(const profile of scopes){
            if(this.abort.signal.aborted)break
            if(scoped++>=MAX_STARTUP_SCOPES){
              this.progress.deferredScopes++
              continue
            }
            this.progress.examinedScopes++
            const scope={
              source,installationId,signal:this.abort.signal,
              ...(profile?{runtimeProfileId:profile.id}:{}),
            }
            try{
              const report=await this.runtime.reindexInstallation({
                ...scope,maxSessions:MAX_STARTUP_SESSIONS_PER_SCOPE,
              })
              this.progress.indexedSessions+=report.indexed
              // A partial Catalog scan is NOT a complete history claim.
              // Capture verifies every subsequent original record separately.
              if(this.abort.signal.aborted||!source.startCapture)continue
              const handle=await this.runtime.captureInstallation(scope)
              if(this.abort.signal.aborted){
                await handle.dispose()
              }else{
                this.captures.push(handle)
              }
            }catch(error){
              if(this.abort.signal.aborted)break
              this.progress.failedScopes++
              console.warn('[AgentLens] native-only Source scope failed',{
                sourceId:source.manifest.sourceId,installationId,
                profileId:profile?.id,error,
              })
            }
          }
        }
      }
    }
    if(this.progress.deferredScopes){
      console.warn('[AgentLens] native-only scopes deferred by bounded startup budget',{
        deferred:this.progress.deferredScopes,maxScopes:MAX_STARTUP_SCOPES,
      })
    }
  }

  async dispose():Promise<void>{
    this.abort.abort()
    await this.task?.catch(()=>undefined)
    const captures=this.captures.splice(0).reverse()
    await Promise.all(captures.map(handle=>handle.dispose().catch(error=>{
      console.warn('[AgentLens] native-only capture dispose failed',error)
    })))
  }
}
