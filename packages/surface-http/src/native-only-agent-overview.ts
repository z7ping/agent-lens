import type {
  AgentInstallation, AgentIntegrationRuntimeStatus,
  AssetInventoryReader, CapturePolicyService, NativeFacetReader, SourceService,
} from '@agent-lens/core'
import {
  AGENT_LENS_PROTOCOL_VERSION,
  type AgentOverviewDto, type AgentOverviewResponseDto,
  type AgentDetailResponseDto, type AgentCoverageResponseDto,
} from '@agent-lens/protocol'
import { projectAgentAssetInventory } from '@agent-lens/projection-overview'

export interface NativeAgentOverviewStorage {
  nativeFacets: NativeFacetReader
  installations: {get(id:string): Promise<AgentInstallation|null>}
  assetInventory: Pick<AssetInventoryReader,'listByInstallation'>
}
const meta=()=>({protocolVersion:AGENT_LENS_PROTOCOL_VERSION,generatedAt:new Date().toISOString()})

/** Original Agent page DTO with Slim identities/current asset state; no SQL events or fabricated call counts. */
export async function nativeOnlyAgentOverview(
  storage:NativeAgentOverviewStorage,
  sources:SourceService,
  policy:CapturePolicyService,
  integrationStatus?:(productId:string)=>Promise<AgentIntegrationRuntimeStatus|null>,
):Promise<AgentOverviewResponseDto & {meta:ReturnType<typeof meta> & {native:{usedAssets:'unavailable';capabilities:'unavailable'}}}> {
  const catalog=await storage.nativeFacets.query()
  const installationsByProduct=new Map(catalog.installedProducts.map(item=>[
    item.productId,item.installationIds,
  ] as const))
  const items:AgentOverviewDto[]=await Promise.all(sources.list().map(async source=>{
    const productId=source.manifest.productId
    const enabled=policy.isSourceEnabled(source.manifest.sourceId)
    const ids=installationsByProduct.get(productId)??[]
    const installations=await Promise.all(ids.map(async id=>{
      const installation=await storage.installations.get(id)
      if(!installation||installation.productId!==productId){
        throw new Error('Slim Agent installation identity does not match the Source catalog')
      }
      return installation
    }))
    const runtimeStatus=integrationStatus?await integrationStatus(productId):null
    if(runtimeStatus&&runtimeStatus.productId!==productId){
      throw new Error('Slim Integration status identity mismatch')
    }
    const assetPages=enabled
      ?await Promise.all(installations.map(item=>storage.assetInventory.listByInstallation(item.id)))
      :[]
    return {
      sourceId:source.manifest.sourceId,productId,
      displayName:source.manifest.displayName,
      supported:true,enabled,detected:installations.length>0,
      ...(runtimeStatus?{integration:{
        availability:runtimeStatus.availability,
        capabilities:runtimeStatus.capabilities,
      }}:{}),
      installations:installations.map(item=>({
        id:item.id,
        ...(item.version?{version:item.version}:{}),
        ...(item.executable?{executable:item.executable}:{}),
        ...(item.configRoot?{configRoot:item.configRoot}:{}),
        ...(item.dataRoot?{dataRoot:item.dataRoot}:{}),
        firstSeenAt:item.firstSeenAt,lastSeenAt:item.lastSeenAt,
      })),
      // Missing event-derived enrichment is unknown, not evidence of zero tool use.
      capabilities:[],usedAssets:[],usedAssetsStatus:'unavailable',
      assetInventory:projectAgentAssetInventory(assetPages),
      assetInventoryStatus:enabled?'available':'unavailable',
    } satisfies AgentOverviewDto
  }))
  items.sort((a,b)=>a.displayName.localeCompare(b.displayName)||a.sourceId.localeCompare(b.sourceId))
  return {items,meta:{...meta(),native:{usedAssets:'unavailable',capabilities:'unavailable'}}}
}
export function nativeOnlyAgentDetail(items:readonly AgentOverviewDto[],id:string):AgentDetailResponseDto|null{
  const item=items.find(row=>row.sourceId===id)
  return item?{item,meta:meta()}:null
}
export function nativeOnlyAgentCoverage(items:readonly AgentOverviewDto[]):AgentCoverageResponseDto{
  return {
    items:items.map(({sourceId,productId,displayName,detected,enabled,assetInventory,usedAssets,usedAssetsStatus})=>({
      sourceId,productId,displayName,detected,enabled,assetInventory,usedAssets,
      ...(usedAssetsStatus?{usedAssetsStatus}:{}),
    })),
    meta:meta(),
  }
}
