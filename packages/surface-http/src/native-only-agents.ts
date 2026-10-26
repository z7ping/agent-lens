import type {
  AgentInstallation, AssetInventoryReader, CapturePolicyService,
  NativeFacetReader, SourceService,
} from '@agent-lens/core'
import type {
  AgentOverviewDto, AgentDetailResponseDto, AgentOverviewResponseDto,
  AgentCoverageResponseDto, AgentEnrichmentResponseDto,
} from '@agent-lens/protocol'
import { AGENT_LENS_PROTOCOL_VERSION } from '@agent-lens/protocol'
import { projectAgentAssetInventory } from '@agent-lens/projection-overview'

interface NativeAgentStorage {
  nativeFacets:NativeFacetReader
  installations:{get(id:string):Promise<AgentInstallation|null>}
  assetInventory:Pick<AssetInventoryReader,'listByInstallation'>
}
const metadata=()=>({
  protocolVersion:AGENT_LENS_PROTOCOL_VERSION,
  generatedAt:new Date().toISOString(),
})
/** Both surfaces use the original Source definitions and the same asset
 * projection, backed by Slim's existing state-only inventory. Missing usage
 * and runtime capabilities are deliberately not synthesized from old events.
 */
export async function nativeOnlyAgentOverview(
  storage:NativeAgentStorage,sources:SourceService,
  policy:Pick<CapturePolicyService,'isSourceEnabled'>,
):Promise<AgentOverviewResponseDto & {meta:ReturnType<typeof metadata> & {
  native:{usageState:'unavailable';capabilitiesState:'unavailable'}
}}> {
  const facets=await storage.nativeFacets.query()
  const installed=new Map(facets.installedProducts.map(item=>[
    item.productId,item.installationIds,
  ] as const))
  const items=await Promise.all(sources.list().map(async source=>{
    const manifest=source.manifest
    const enabled=policy.isSourceEnabled(manifest.sourceId)
    const ids=[...new Set(installed.get(manifest.productId)??[])]
    // Never return another product's installation even if an index is stale.
    const installations=(await Promise.all(ids.map(id=>storage.installations.get(id))))
      .filter((item):item is AgentInstallation=>Boolean(item&&item.productId===manifest.productId))
    const pages=enabled
      ? await Promise.all(installations.map(item=>storage.assetInventory.listByInstallation(item.id)))
      : []
    return {
      sourceId:manifest.sourceId,productId:manifest.productId,
      displayName:manifest.displayName,supported:true,enabled,
      detected:installations.length>0,
      installations:installations.map(item=>({
        id:item.id,
        ...(item.version?{version:item.version}:{}),
        ...(item.executable?{executable:item.executable}:{}),
        ...(item.configRoot?{configRoot:item.configRoot}:{}),
        ...(item.dataRoot?{dataRoot:item.dataRoot}:{}),
        firstSeenAt:item.firstSeenAt,lastSeenAt:item.lastSeenAt,
      })),
      // Real Source/current-asset facts; no fabricated usage counters.
      capabilities:[],assetInventory:projectAgentAssetInventory(pages),
      usedAssets:[],assetInventoryStatus:enabled?'available':'unavailable',
    } satisfies AgentOverviewDto
  }))
  items.sort((a,b)=>a.displayName.localeCompare(b.displayName)
    ||a.sourceId.localeCompare(b.sourceId))
  return {items,meta:{...metadata(),native:{
    usageState:'unavailable',capabilitiesState:'unavailable',
  }}}
}

export function nativeAgentDetail(
  result:AgentOverviewResponseDto,sourceId:string,
):AgentDetailResponseDto|null{
  const item=result.items.find(item=>item.sourceId===sourceId)
  return item?{item,meta:metadata()}:null
}
export function nativeAgentCoverage(
  result:AgentOverviewResponseDto,
):AgentCoverageResponseDto{
  return {
    items:result.items.map(item=>({
      sourceId:item.sourceId,productId:item.productId,
      displayName:item.displayName,detected:item.detected,enabled:item.enabled,
      assetInventory:item.assetInventory,usedAssets:item.usedAssets,
    })),
    meta:metadata(),
  }
}
export function nativeAgentEnrichment(
  result:AgentOverviewResponseDto,sourceId:string,
):AgentEnrichmentResponseDto|null{
  const item=result.items.find(item=>item.sourceId===sourceId)
  return item?{
    sourceId:item.sourceId,capabilities:[],usedAssets:[],meta:metadata(),
  }:null
}
