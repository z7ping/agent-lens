import type {
  AgentInstallation, Host, RuntimeProfile, AssetService, AssetState,
  CapturePolicyService, CheckpointRepository, SourceCheckpointService,
  SourceDefinition,
} from '@agent-lens/core'

const SCOPE='slim-asset-current-v1'
const LIMIT=2000
const PRESENCE=new Set<AssetState>(['installed','configured','enabled','discoverable','exposed'])
const ABSENCE_FALSE=new Set<AssetState>(['installed','configured'])
interface Snapshot {bindings:Record<string,AssetState[]>;completedAt:string}

const readOnlyCheckpoint:SourceCheckpointService={
  async get(){return null},
  async set(){throw new Error('Slim asset source discovery cannot persist arbitrary checkpoints')},
  async clear(){throw new Error('Slim asset source discovery cannot clear checkpoints')},
}

export interface SlimAssetScanReport {
  sourceId:string
  installationId:string
  assetsDiscovered:number
  statesRecorded:number
  assetsRemoved:number
  statesCleared:number
  /** Zero original Evidence or Canonical event persistence. */
  eventCopiesWritten:0
}

/** Native-only asset discovery: retains only installed/current metadata and a
 * small bounded snapshot of active binding/state IDs, no Event/Evidence rows.
 * Source may provide evidenceCandidates but those are transient and discarded.
 */
export class NativeOnlyAssetScanner {
  constructor(
    private readonly assets:AssetService,
    private readonly checkpoints:Pick<CheckpointRepository,'get'|'set'>,
    private readonly capturePolicy:Pick<CapturePolicyService,
      'isEnabled'|'sanitizeDiscoveredAsset'>,
  ){}

  async scan(input:{
    source:SourceDefinition;host:Host;installation:AgentInstallation
    runtimeProfile?:RuntimeProfile;signal:AbortSignal
  }):Promise<SlimAssetScanReport>{
    const {source,host,installation,runtimeProfile,signal}=input
    if(source.manifest.productId!==installation.productId
      || source.manifest.sourceId.trim()==='' || installation.hostId!==host.id
      || (runtimeProfile&&runtimeProfile.installationId!==installation.id)){
      throw new Error('Slim asset Source installation identity changed')
    }
    const report:SlimAssetScanReport={
      sourceId:source.manifest.sourceId,installationId:installation.id,
      assetsDiscovered:0,statesRecorded:0,assetsRemoved:0,
      statesCleared:0,eventCopiesWritten:0,
    }
    if(!source.discoverAssets||!this.capturePolicy.isEnabled('config'))return report
    const key=JSON.stringify([
      source.manifest.sourceId,installation.id,runtimeProfile?.id??'default'])
    const previous=await this.checkpoints.get<Snapshot>(SCOPE,key)
    const oldBindings=previous?.bindings??{}
    const current=new Map<string,Set<AssetState>>()
    const reported=new Map<string,Set<AssetState>>()
    const activeInstallation=runtimeProfile?{
      ...installation,
      dataRoot:runtimeProfile.dataRoot??installation.dataRoot,
      configRoot:runtimeProfile.configRoot??installation.configRoot,
    }:installation
    for await(const discovered of source.discoverAssets({
      host,installation:activeInstallation,
      ...(runtimeProfile?{runtimeProfile}:{}),
      abortSignal:signal,checkpoint:readOnlyCheckpoint,
    })){
      signal.throwIfAborted()
      if(report.assetsDiscovered>=LIMIT){
        throw new Error('Slim asset scan exceeded safe 2000 binding budget')
      }
      const safe=this.capturePolicy.sanitizeDiscoveredAsset(discovered)
      if(!safe)continue
      const definition=await this.assets.resolveDefinition(safe.definition)
      const binding=await this.assets.resolveBinding({
        assetId:definition.id,installationId:installation.id,
        ...(safe.binding?.runtimeProfileId??runtimeProfile?.id
          ?{runtimeProfileId:safe.binding?.runtimeProfileId??runtimeProfile!.id}:{}),
        ...(safe.binding?.path?{path:safe.binding.path}:{}),
        ...(safe.binding?.source?{source:safe.binding.source}:{}),
        ...(safe.binding?.scope?{scope:safe.binding.scope}:{}),
        ...(safe.binding?.scopeRoot?{scopeRoot:safe.binding.scopeRoot}:{}),
        ...(safe.binding?.version?{version:safe.binding.version}:{}),
      })
      report.assetsDiscovered++
      const present=current.get(binding.id)??new Set<AssetState>()
      const seen=reported.get(binding.id)??new Set<AssetState>()
      current.set(binding.id,present)
      reported.set(binding.id,seen)
      for(const state of safe.states??[]){
        await this.assets.recordState({
          assetBindingId:binding.id,state:state.state,value:state.value,
          observedAt:state.observedAt,evidenceRefs:[],
        })
        seen.add(state.state)
        if(state.value===true&&PRESENCE.has(state.state))present.add(state.state)
        report.statesRecorded++
      }
      if((report.assetsDiscovered&15)===0)await new Promise<void>(resolve=>setImmediate(resolve))
    }
    signal.throwIfAborted()
    const timestamp=new Date().toISOString()
    for(const [bindingId,seen] of reported){
      for(const state of oldBindings[bindingId]??[]){
        if(!PRESENCE.has(state)||seen.has(state))continue
        await this.assets.recordState({
          assetBindingId:bindingId,state,value:'unknown',
          observedAt:timestamp,evidenceRefs:[],
        })
        report.statesCleared++
      }
    }
    for(const [bindingId,states] of Object.entries(oldBindings)){
      if(current.has(bindingId))continue
      report.assetsRemoved++
      for(const state of states){
        if(!PRESENCE.has(state))continue
        await this.assets.recordState({
          assetBindingId:bindingId,state,
          value:ABSENCE_FALSE.has(state)?false:'unknown',
          observedAt:timestamp,evidenceRefs:[],
        })
        report.statesCleared++
      }
    }
    await this.checkpoints.set(SCOPE,key,{
      bindings:Object.fromEntries([...current].map(([id,states])=>[id,[...states].sort()])),
      completedAt:timestamp,
    } satisfies Snapshot)
    return report
  }
}
