import type {
  NativeFacetReader, SourceService, CapturePolicyService,
} from '@agent-lens/core'
import type { FacetResponseDto } from '@agent-lens/protocol'
import { AGENT_LENS_PROTOCOL_VERSION } from '@agent-lens/protocol'

/** Slim Facet DTO adapter: no Canonical Observation scan, no invented
 * session start date. Product registration and policy remain authoritative.
 */
export async function nativeOnlyFacetResponse(
  native:NativeFacetReader,sources:SourceService,policy:CapturePolicyService,
):Promise<FacetResponseDto & {meta:{
  protocolVersion:typeof AGENT_LENS_PROTOCOL_VERSION
  generatedAt:string
  native:{projectsTruncated:boolean;dateRangeState:'unavailable'}
}}> {
  const facets=await native.query()
  const installed=new Map(facets.installedProducts.map(
    product=>[product.productId,product.installationIds] as const))
  const agents=sources.list().map(source=>{
    const productId=source.manifest.productId
    const installations=installed.get(productId)??[]
    return {
      sourceId:source.manifest.sourceId,
      productId,
      displayName:source.manifest.displayName,
      supported:true,
      enabled:policy.isSourceEnabled(source.manifest.sourceId),
      detected:installations.length>0,
      installationIds:installations,
    }
  }).sort((a,b)=>a.displayName.localeCompare(b.displayName)||a.sourceId.localeCompare(b.sourceId))
  return {
    agents,
    projects:facets.projects,
    // A native session's last activity cannot prove the first event date.
    dateRange:{},
    meta:{
      protocolVersion:AGENT_LENS_PROTOCOL_VERSION,
      generatedAt:new Date().toISOString(),
      native:{
        projectsTruncated:facets.projectsTruncated,
        dateRangeState:'unavailable',
      },
    },
  }
}
