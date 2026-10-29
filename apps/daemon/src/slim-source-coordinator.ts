import { arch, hostname, platform } from 'node:os'
import type {
  CapturePolicyService, RuntimeProfile, SourceService,
} from '@agent-lens/core'
import type { NativeCaptureHandle } from '@agent-lens/core-services'
import type { SlimDataRuntime } from './data-runtime/slim-runtime.js'
import type { AgentRescanSummaryDto } from '@agent-lens/protocol'

const MAX_STARTUP_SCOPES=256
const MAX_STARTUP_SESSIONS_PER_SCOPE=128
const MAX_DETECTIONS_PER_SOURCE=64

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
  private rescanQueue:Promise<void>=Promise.resolve()
  private readonly captureKeys=new Set<string>()
  private readonly captures:NativeCaptureHandle[]=[]
  private progress:Omit<SlimSourceProgress,'runningCaptures'>={
    examinedScopes:0,indexedSessions:0,failedScopes:0,deferredScopes:0,finished:false,
  }

  constructor(
    private readonly runtime:Pick<SlimDataRuntime,
      'facets'|'profiles'|'reindexInstallation'|'captureInstallation'
      |'resolveHost'|'resolveInstallation'|'resolveProfile'|'scanInstallationAssets'
      |'rebuildLaunchableProjects'>,
    private readonly sources:SourceService,
    private readonly policy:Pick<CapturePolicyService,'isSourceEnabled'>,
    private readonly assetPolicy?:CapturePolicyService,
    private readonly onProgress?:()=>void,
  ) {}

  snapshot():SlimSourceProgress{
    return {...this.progress,runningCaptures:this.captures.length}
  }

  start():void{
    if(this.task)return
    this.onProgress?.()
    this.task=Promise.resolve().then(()=>this.run()).catch(error=>{
      if(!this.abort.signal.aborted){
        this.progress.failedScopes++
        console.warn('[AgentLens] native-only source startup failed',error)
      }
    }).finally(()=>{
      this.progress.finished=true
      this.onProgress?.()
    })
  }

  /** User-triggered rescan reuses the SAME discover/index/asset/capture path.
   * Serialized after startup, without spawning duplicate original captures.
   */
  async rescan(sourceId?:string):Promise<AgentRescanSummaryDto>{
    if(this.abort.signal.aborted)throw new Error('Native Source coordinator is stopped')
    if(sourceId&&!this.sources.list().some(source=>source.manifest.sourceId===sourceId)){
      throw new Error('Unknown native Source: '+sourceId)
    }
    const startedAt=new Date().toISOString()
    const report:AgentRescanSummaryDto={
      status:'completed',startedAt,completedAt:startedAt,
      sourcesDetected:0,assetSourcesScanned:0,assetsDiscovered:0,
      assetsRemoved:0,statesRecorded:0,statesCleared:0,failures:[],
    }
    const work=this.rescanQueue.then(async()=>{
      await this.task?.catch(()=>undefined)
      if(this.abort.signal.aborted)throw new Error('Native Source coordinator is stopped')
      this.progress.finished=false
      this.onProgress?.()
      try{
        await this.run(sourceId,report)
      }finally{
        this.progress.finished=true
        this.onProgress?.()
      }
      report.status=report.failures.length
        ?(report.sourcesDetected||report.assetSourcesScanned?'partial':'failed')
        :'completed'
      report.completedAt=new Date().toISOString()
    })
    this.rescanQueue=work.then(()=>undefined,()=>undefined)
    await work
    return report
  }

  /** Same official Source detect() contract as the old application, but only
   * metadata identities are persisted. Per-source failures do not hide
   * existing indexed installations or start a Legacy import.
   */
  private async discoverInstallations(sourceId?:string,report?:AgentRescanSummaryDto):Promise<void>{
    const registered=this.sources.list().filter(source=>
      !sourceId||source.manifest.sourceId===sourceId)
    if(!registered.length)return
    const host=await this.runtime.resolveHost({
      name:hostname(),platform:platform(),arch:arch(),
    })
    for(const source of registered){
      if(this.abort.signal.aborted)break
      try{
        const detected=await source.detect({host,env:process.env})
        if(detected.length>MAX_DETECTIONS_PER_SOURCE){
          throw new Error('Source returned too many native installations')
        }
        if(detected.length)report&&(report.sourcesDetected++)
        for(const item of detected){
          if(this.abort.signal.aborted)break
          if(item.sourceId!==source.manifest.sourceId
            || item.productId!==source.manifest.productId){
            throw new Error('Native Source discovery identity mismatch')
          }
          const installation=await this.runtime.resolveInstallation({
            hostId:host.id,productId:item.productId,
            ...(item.version?{version:item.version}:{}),
            ...(item.executable?{executable:item.executable}:{}),
            ...(item.configRoot?{configRoot:item.configRoot}:{}),
            ...(item.dataRoot?{dataRoot:item.dataRoot}:{}),
          })
          if(item.runtimeProfile){
            await this.runtime.resolveProfile({
              installationId:installation.id,
              nativeProfileId:item.runtimeProfile.nativeProfileId,
              ...(item.runtimeProfile.name?{name:item.runtimeProfile.name}:{}),
              ...(item.runtimeProfile.configRoot
                ?{configRoot:item.runtimeProfile.configRoot}:{}),
              ...(item.runtimeProfile.dataRoot
                ?{dataRoot:item.runtimeProfile.dataRoot}:{}),
            })
          }
        }
      }catch(error){
        if(this.abort.signal.aborted)break
        this.progress.failedScopes++
        report?.failures.push({sourceId:source.manifest.sourceId,stage:'detect',
          message:error instanceof Error?error.message:String(error)})
        console.warn('[AgentLens] Slim native Source discovery failed',{
          sourceId:source.manifest.sourceId,error,
        })
      }
    }
  }

  private async run(sourceId?:string,report?:AgentRescanSummaryDto):Promise<void>{
    await this.discoverInstallations(sourceId,report)
    if(this.abort.signal.aborted)return
    const facets=await this.runtime.facets()
    const registered=this.sources.list().filter(source=>
      !sourceId||source.manifest.sourceId===sourceId)
    const scannedAssets=new Set<string>()
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
          report?.failures.push({sourceId:sourceId??product.productId,stage:'detect',
            message:error instanceof Error?error.message:String(error)})
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
            this.onProgress?.()
            const scope={
              source,installationId,signal:this.abort.signal,
              ...(profile?{runtimeProfileId:profile.id}:{}),
            }
            try{
              const indexReport=await this.runtime.reindexInstallation({
                ...scope,maxSessions:MAX_STARTUP_SESSIONS_PER_SCOPE,
              })
              this.progress.indexedSessions+=indexReport.indexed
              this.onProgress?.()
              if(source.discoverAssets && this.assetPolicy && !this.abort.signal.aborted){
                try{
                  const scan=await this.runtime.scanInstallationAssets({
                    ...scope,policy:this.assetPolicy,
                  })
                  if(report){
                    scannedAssets.add(source.manifest.sourceId)
                    report.assetSourcesScanned=scannedAssets.size
                    report.assetsDiscovered+=scan.assetsDiscovered
                    report.assetsRemoved+=scan.assetsRemoved
                    report.statesRecorded+=scan.statesRecorded
                    report.statesCleared+=scan.statesCleared
                  }
                }catch(error){
                  if(!this.abort.signal.aborted){
                    this.progress.failedScopes++
                    report?.failures.push({sourceId:source.manifest.sourceId,stage:'assets',
                      message:error instanceof Error?error.message:String(error)})
                    console.warn('[AgentLens] Slim native asset discovery failed',{
                      sourceId:source.manifest.sourceId,installationId,
                      profileId:profile?.id,error,
                    })
                  }
                }
              }
              // A partial Catalog scan is NOT a complete history claim.
              // Capture verifies every subsequent original record separately.
              if(this.abort.signal.aborted||!source.startCapture)continue
              const captureKey=JSON.stringify([source.manifest.sourceId,installationId,
                profile?.id??'default'])
              if(this.captureKeys.has(captureKey))continue
              const handle=await this.runtime.captureInstallation(scope)
              if(this.abort.signal.aborted){
                await handle.dispose()
              }else{
                this.captures.push(handle)
                this.captureKeys.add(captureKey)
              }
            }catch(error){
              if(this.abort.signal.aborted)break
              this.progress.failedScopes++
              report?.failures.push({sourceId:source.manifest.sourceId,stage:'detect',
                message:error instanceof Error?error.message:String(error)})
              console.warn('[AgentLens] native-only Source scope failed',{
                sourceId:source.manifest.sourceId,installationId,
                profileId:profile?.id,error,
              })
            }
          }
        }
      }
    }
    // The old migration can contain valid workspaces without a populated
    // launchable index. Refresh once after Source-native attribution, including
    // an explicit rescan, without touching original Agent files or old tables.
    try{
      if(!this.abort.signal.aborted)await this.runtime.rebuildLaunchableProjects()
    }catch(error){
      this.progress.failedScopes++
      report?.failures.push({sourceId:sourceId??'native',stage:'detect',
        message:error instanceof Error?error.message:String(error)})
      console.warn('[AgentLens] Slim launchable project index refresh failed',error)
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
    await this.rescanQueue
    const captures=this.captures.splice(0).reverse()
    this.captureKeys.clear()
    await Promise.all(captures.map(handle=>handle.dispose().catch(error=>{
      console.warn('[AgentLens] native-only capture dispose failed',error)
    })))
  }
}
