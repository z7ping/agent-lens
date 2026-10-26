import type {
  AgentIntegrationRuntimeStatus, CapturePolicyService,
  LiveService, SourceService,
} from '@agent-lens/core'
import {
  IntegrationManagementService, IntegrationPreferenceService,
  OfficialToolDiscoveryService, integrationPreferencesPath,
  integrationAuthorizationPath, readIntegrationAuthorizationSync,
  authorizedIntegrationCapabilities, grantIntegrationCapabilities,
} from '@agent-lens/runtime-cordis'

/** Pure composition of the SAME installed Integration management services.
 * Source registration and explicit grants remain the authority; no v38 SQL.
 * Discovery runs independently of HTTP readiness and never starts an Agent.
 */
export function startSlimIntegrations(options:{
  sources:SourceService
  policy:CapturePolicyService
  lives:LiveService
  preferencesPath?:string
  authorizationPath?:string
  discovery?:OfficialToolDiscoveryService
  scanOnStart?:boolean
}) {
  const discovery=options.discovery??new OfficialToolDiscoveryService()
  const preference=new IntegrationPreferenceService(
    options.preferencesPath??integrationPreferencesPath(),
  )
  const authorizationPath=options.authorizationPath??integrationAuthorizationPath()
  let grants=readIntegrationAuthorizationSync(authorizationPath)
  const integrationStatus=async(productId:string):Promise<AgentIntegrationRuntimeStatus|null>=>{
    const matched=options.sources.list().filter(source=>source.manifest.productId===productId)
    if(!matched.length)return null
    const enabled=matched.some(source=>options.policy.isSourceEnabled(source.manifest.sourceId))
    const registered=options.lives.list().some(adapter=>adapter.manifest.productId===productId)
    const supportedLive=['pi','codex','hermes'].includes(productId)
    const allowed=authorizedIntegrationCapabilities(grants,productId).includes('live')
    const capabilities:AgentIntegrationRuntimeStatus['capabilities']=[
      {capability:'source',availability:enabled?'available':'unavailable'},
      {capability:'assets',availability:enabled?'available':'unavailable'},
      ...(supportedLive?[{
        capability:'live' as const,
        availability:registered?'available' as const:'unavailable' as const,
        authorization:allowed?'granted' as const:'required' as const,
        ...(!allowed?{reasonCode:'authorization-required' as const}:{}),
      }]:[]),
    ]
    return {
      integrationId:productId,productId,enabled,
      availability:enabled?'available':'unavailable',capabilities,
    }
  }
  const management=new IntegrationManagementService({
    discovery,preferences:preference,capturePolicy:options.policy,
    integrationStatus,
  })
  if(options.scanOnStart!==false){
    void discovery.rescan().catch(error=>{
      console.warn('[AgentLens] Slim Integration discovery failed',error)
    })
  }
  return {
    integrationStatus,
    discovery:{
      snapshot:()=>discovery.snapshot(),
      rescan:(id?:string)=>discovery.rescan(id),
    },
    management:{
      query:()=>management.query(),
      preferences:()=>management.preferences(),
      updatePreferences:(input:Parameters<IntegrationManagementService['updatePreferences']>[0])=>
        management.updatePreferences(input),
      enabled:(id:string)=>management.enabled(id),
      setEnabled:(id:string,enabled:boolean)=>management.setEnabled(id,enabled),
    },
    authorization:{
      available:(productId:string):readonly ('live'|'hook'|'runtime')[]=>{
        const recognized=options.sources.list().some(source=>source.manifest.productId===productId)
        return recognized&&['pi','codex','hermes'].includes(productId)?['live']:[]
      },
      async grant(productId:string,capabilities:readonly ('live'|'hook'|'runtime')[]){
        grants=await grantIntegrationCapabilities(authorizationPath,productId,capabilities)
        return authorizedIntegrationCapabilities(grants,productId)
      },
    },
  }
}
