import { createServer, type Server } from 'node:http'
import type {
  CapturePolicyService, NativeFacetReader, NativeSessionCatalogStore,
  NativeSessionListReader, NativeSessionMetricsStore, LaunchableProjectReader,
  SourceService, StorageHealth, BackupService, LiveService, LiveAttachmentService,
  AgentInstallation, AssetInventoryReader, AgentIntegrationRuntimeStatus,
} from '@agent-lens/core'
import { AGENT_LENS_PROTOCOL_VERSION } from '@agent-lens/protocol'
import {
  AGENT_LENS_HTTP_HOST, DEFAULT_AGENT_LENS_HTTP_PORT,
  type RunningHttpSurface,
} from './server'
import { handleNativeSessionCatalogRequest } from './native-session-catalog-http'
import {
  handleNativeSessionWindowRequest, handleNativeSessionAttachmentRequest,
  handleNativeSessionHookRequest, type NativeSessionWindowReader,
} from './native-session-http'
import { handleNativeSessionBodySearchRequest } from './native-session-search-http'
import { handleNativeSessionMetricsRequest } from './native-session-metrics-http'
import { handleNativeSessionMetricsOverviewRequest } from './native-session-metrics-overview-http'
import { NativeMetricsAutoRefresh } from './native-metrics-auto-refresh'
import { nativeOnlyFacetResponse } from './native-only-facets'
import { nativeOnlyAgentOverview, nativeOnlyAgentCoverage, nativeOnlyAgentDetail } from './native-only-agent-overview'
import { HttpEventHub } from './events'
import { readLaunchableProjects } from './launchable-projects'
import { handleBackupRequest } from './backup-http'
import { handleAgentFilesRequest } from './agent-files-http'
import { handleManagedAssetFilesRequest } from './managed-asset-files'
import { handleNativeOnlyTaskFilesRequest } from './native-only-task-files-http'
import { handleCapturePolicyRequest } from './capture-policy-http'
import {
  handleIntegrationDiscoveryRequest,type IntegrationDiscoveryController,
} from './integration-discovery-http'
import {
  handleIntegrationManagementRequest,type IntegrationManagementController,
} from './integration-management-http'
import {
  handleIntegrationAuthorizationRequest,type IntegrationAuthorizationController,
} from './integration-http'
import { discoverLocalePacks } from './locale-packs'
import { handleLiveRequest } from './live-http'
import { handleLiveAttachmentRequest } from './live-attachments-http'
import { nativeMetricContribution } from './native-metrics-contribution'
import { nativeOnlyInsightsResponse, nativeOnlyToolUsageResponse } from './native-only-usage-insights'
import { parseInsightsQuery, parseUsageQuery } from './query-params'
import { badRequest, statusCodeForError, writeJson } from './http-utils'
import { handleStatic, type HttpStaticMount } from './static-files'

/** A Slim-only HTTP composition. No Legacy StorageService, old projection,
 * generic repositories, or Canonical event writer can enter this boundary.
 */
export interface NativeOnlyHttpStorage {
  nativeSessionCatalog: Pick<NativeSessionCatalogStore,
    'get'|'getByReviewSessionId'|'query'|'isNativeMetricsEligible'>
  nativeSessionList: NativeSessionListReader
  nativeFacets: NativeFacetReader
  installations: {get(id:string):Promise<AgentInstallation|null>}
  assetInventory:Pick<AssetInventoryReader,'listByInstallation'>
  launchableProjects: LaunchableProjectReader
  nativeSessionMetrics: NativeSessionMetricsStore
  health(): Promise<StorageHealth>
}

export interface NativeOnlyHttpOptions {
  port?:number
  staticDir?:string
  localePackDirectory?:string
  sources:SourceService
  capturePolicy:CapturePolicyService
  reader:NativeSessionWindowReader
  backgroundProgress?:()=>{
    examinedScopes:number;indexedSessions:number;runningCaptures:number;
    failedScopes:number;deferredScopes:number;finished:boolean
  }
  backup?: BackupService
  lives?: LiveService
  liveAttachments?: LiveAttachmentService
  integrationDiscovery?:IntegrationDiscoveryController
  integrationManagement?:IntegrationManagementController
  integrationAuthorization?:IntegrationAuthorizationController
}

/** Reuse the existing native HTTP handlers, but NEVER construct retired
 * Timeline/Review/SessionSummary SQL projections or fake StorageService.
 * Unported API paths are explicitly unsupported until cutover consumers land.
 */
export async function startNativeOnlyHttpSurface(
  storage:NativeOnlyHttpStorage,
  options:NativeOnlyHttpOptions,
):Promise<RunningHttpSurface & {notifyBackgroundActivity:()=>void}> {
  const requestedPort=options.port??DEFAULT_AGENT_LENS_HTTP_PORT
  if(!Number.isInteger(requestedPort)||requestedPort<0||requestedPort>65535){
    throw new RangeError('Invalid native-only HTTP port')
  }
  const eventHub=new HttpEventHub()
  const mounts=new Map<string,HttpStaticMount>()
  if(options.staticDir)mounts.set('native-web',{
    id:'native-web',directory:options.staticDir,spaFallback:true,
  })
  const refresh=new NativeMetricsAutoRefresh(
    storage.nativeSessionCatalog,storage.nativeSessionMetrics,
    options.reader,options.sources,options.capturePolicy,
  )
  const server:Server=createServer(async(request,response)=>{
    try{
      const url=new URL(request.url??'/',`http://${AGENT_LENS_HTTP_HOST}`)
      if(request.method==='GET'&&[
        '/api/v1/usage','/api/v1/insights',
        '/api/v1/native-sessions/metrics/overview',
      ].includes(url.pathname))refresh.schedule()

      // Live is the EXISTING Pi runtime controller, not a SQL projection.
      // Deliberately omit the old history.storage argument: session rows and
      // SourceRecord lookup no longer exist on Slim.
      if(await handleIntegrationAuthorizationRequest(
        request,response,url,options.integrationAuthorization))return
      if(await handleIntegrationDiscoveryRequest(
        request,response,url,options.integrationDiscovery))return
      if(await handleIntegrationManagementRequest(
        request,response,url,options.integrationManagement))return
      if(await handleLiveAttachmentRequest(request,response,url,options.liveAttachments))return
      if(await handleLiveRequest(request,response,url,options.lives,undefined,{
        nativeSessions:storage.nativeSessionList,
        sources:options.sources,
        policy:options.capturePolicy,
      }))return

      if(await handleNativeSessionMetricsOverviewRequest(
        request,response,url,storage.nativeSessionMetrics,
        options.sources,options.capturePolicy,true))return
      if(await handleNativeSessionMetricsRequest(
        request,response,url,storage.nativeSessionCatalog,
        storage.nativeSessionMetrics,options.reader,
        options.sources,options.capturePolicy))return
      if(await handleNativeSessionBodySearchRequest(
        request,response,url,storage.nativeSessionCatalog,
        options.reader,options.capturePolicy))return
      if(await handleNativeSessionCatalogRequest(
        request,response,url,storage.nativeSessionCatalog,
        options.capturePolicy,storage.nativeSessionList,options.sources))return
      if(await handleNativeSessionAttachmentRequest(
        request,response,url,options.reader,storage.nativeSessionCatalog))return
      if(await handleNativeSessionHookRequest(
        request,response,url,options.reader,storage.nativeSessionCatalog))return
      if(await handleNativeSessionWindowRequest(
        request,response,url,options.reader,storage.nativeSessionCatalog))return

      if(await handleNativeOnlyTaskFilesRequest(
        request,response,url,storage.nativeSessionCatalog,
        options.reader,options.capturePolicy))return
      if(await handleAgentFilesRequest(request,response,url,{
        repositories:{installations:storage.installations},
      },options.sources,options.capturePolicy))return

      // Reuse the installed Integration's existing file/asset protections and
      // native Slim current-state inventory. No legacy StorageService.
      if(await handleManagedAssetFilesRequest(request,response,url,{
        repositories:{installations:storage.installations},
        assetInventory:storage.assetInventory,
      },productId=>{
        const definitions=options.sources.list().filter(source=>
          source.manifest.productId===productId)
        if(!definitions.length)return null
        const active=definitions.some(source=>
          options.capturePolicy.isSourceEnabled(source.manifest.sourceId))
        return {
          integrationId:productId,productId,enabled:active,
          availability:active?'available':'unavailable',
          capabilities:[{capability:'assets',availability:active?'available':'unavailable'}],
        } satisfies AgentIntegrationRuntimeStatus
      }))return

      // Existing Vault endpoint and validation; its persistence owner is the
      // original Source/Vault filesystem plus Slim checkpoints, not Events.
      if(await handleBackupRequest(request,response,url,options.backup))return
      // The existing capture-policy handler owns source configuration on both runtimes.
      // No v38 StorageService or legacy write path is involved.
      if(await handleCapturePolicyRequest(request,response,url,options.capturePolicy))return

      if(url.pathname==='/api/v1/events'){
        if(request.method!=='GET'){
          writeJson(response,405,{error:'method_not_allowed'})
          return
        }
        eventHub.connect(response)
        return
      }
      if(url.pathname==='/api/v1/background-activity'){
        if(request.method!=='GET'){
          writeJson(response,405,{error:'method_not_allowed'})
          return
        }
        const progress=options.backgroundProgress?.()
        if(!progress){
          writeJson(response,503,{error:'native_background_progress_unavailable'})
          return
        }
        const at=new Date().toISOString()
        const state=progress.finished
          ?(progress.failedScopes||progress.deferredScopes?'degraded':'completed')
          :'running'
        const item={
          id:'native:startup-index',kind:'source-history' as const,state,
          scope:'local-native',updatedAt:at,
          ...(progress.failedScopes||progress.deferredScopes?{
            errorSummary:`原生索引失败 ${progress.failedScopes}，延迟 ${progress.deferredScopes}`,
          }:{}),
        }
        writeJson(response,200,{generatedAt:at,
          active:progress.finished?[]:[item],
          recent:progress.finished?[item]:[],sources:[item]})
        return
      }
      if(url.pathname==='/api/v1/locales'){
        if(request.method!=='GET'){
          response.setHeader('allow','GET')
          writeJson(response,405,{error:'method_not_allowed'})
          return
        }
        writeJson(response,200,await discoverLocalePacks(options.localePackDirectory))
        return
      }
      if(url.pathname==='/api/v1/ready'){
        writeJson(response,200,{status:'ok',protocolVersion:AGENT_LENS_PROTOCOL_VERSION,
          storageMode:'native-only'})
        return
      }
      if(url.pathname==='/api/v1/health'){
        const health=await storage.health()
        writeJson(response,health.ok?200:503,{
          status:health.ok?'ok':'degraded',
          protocolVersion:AGENT_LENS_PROTOCOL_VERSION,
          storage:{ok:health.ok,schemaVersion:health.schemaVersion,
            details:health.details},
        })
        return
      }
      if(url.pathname==='/api/v1/projects/launchable'){
        if(request.method!=='GET'){
          response.setHeader('allow','GET')
          writeJson(response,405,{error:'method_not_allowed'})
          return
        }
        // Exact existing product route and validation rules, powered by the
        // Slim workspace index rather than old LogicalSession SQL tables.
        writeJson(response,200,await readLaunchableProjects(storage,url.searchParams))
        return
      }
      if(url.pathname==='/api/v1/agents/summary'){
        if(request.method!=='GET'){
          response.setHeader('allow','GET')
          writeJson(response,405,{error:'method_not_allowed'})
          return
        }
        // Same Agent Summary contract as the existing Web navigation. Slim
        // facts are registered Source manifests, CapturePolicy and actual
        // indexed Installation IDs — no fake capabilities or usage totals.
        const native=await nativeOnlyFacetResponse(
          storage.nativeFacets,options.sources,options.capturePolicy)
        writeJson(response,200,{
          items:native.agents.map(agent=>({
            ...agent,installationCount:agent.installationIds.length,
          })),
          meta:{
            protocolVersion:AGENT_LENS_PROTOCOL_VERSION,
            generatedAt:new Date().toISOString(),
          },
        })
        return
      }
      if(url.pathname==='/api/v1/agents'||url.pathname==='/api/v1/agents/coverage'
        ||(/^\/api\/v1\/agents\/[^/]+(?:\/enrichment)?$/.test(url.pathname)
          && url.pathname!='/api/v1/agents/rescan')){
        if(request.method!=='GET'){
          response.setHeader('allow','GET')
          writeJson(response,405,{error:'method_not_allowed'})
          return
        }
        const view=await nativeOnlyAgentOverview(storage,options.sources,options.capturePolicy)
        if(url.pathname==='/api/v1/agents'){
          writeJson(response,200,view)
        }else if(url.pathname==='/api/v1/agents/coverage'){
          writeJson(response,200,nativeOnlyAgentCoverage(view.items))
        }else{
          const enrichment=url.pathname.endsWith('/enrichment')
          const encodedId=url.pathname.slice('/api/v1/agents/'.length,
            enrichment? -'/enrichment'.length:undefined)
          let id:string
          try{id=decodeURIComponent(encodedId)}catch{throw badRequest('Invalid source identifier')}
          const detail=nativeOnlyAgentDetail(view.items,id)
          if(!detail){writeJson(response,404,{error:'not_found'});return}
          writeJson(response,200,enrichment?{
            sourceId:id,capabilities:detail.item.capabilities,
            usedAssets:detail.item.usedAssets,meta:detail.meta,
          }:detail)
        }
        return
      }
      if(url.pathname==='/api/v1/facets'){
        if(request.method!=='GET'){
          writeJson(response,405,{error:'method_not_allowed'})
          return
        }
        writeJson(response,200,await nativeOnlyFacetResponse(
          storage.nativeFacets,options.sources,options.capturePolicy))
        return
      }
      if(url.pathname==='/api/v1/usage'||url.pathname==='/api/v1/insights'){
        if(request.method!=='GET'){
          writeJson(response,405,{error:'method_not_allowed'})
          return
        }
        const usage=url.pathname==='/api/v1/usage'
        const scope=usage?parseUsageQuery(url.searchParams):parseInsightsQuery(url.searchParams)
        const native=await nativeMetricContribution(
          storage.nativeSessionMetrics,options.sources,options.capturePolicy,
          {...scope,projectScopeReady:true,...(usage?{includeTools:true}:{})})
        writeJson(response,200,usage
          ?nativeOnlyToolUsageResponse(native)
          :nativeOnlyInsightsResponse(native,scope))
        return
      }
      if(url.pathname.startsWith('/api/v1/')){
        // Missing ports are NOT empty session lists or zero counts. No
        // fallback to an old Writer or to Legacy SQL projections.
        writeJson(response,501,{
          error:'native_only_route_not_implemented',
          message:'This API requires an unported Native-only consumer',
        })
        return
      }
      if(request.method!=='GET'&&request.method!=='HEAD'){
        throw badRequest('Unsupported method')
      }
      if(await handleStatic(response,url.pathname,mounts.values()))return
      writeJson(response,404,{error:'not_found'})
    }catch(error){
      const status=statusCodeForError(error)
      if(!response.headersSent)writeJson(response,status,{
        error:status>=500?'internal_error':'bad_request',
        message:error instanceof Error?error.message:String(error),
      })
      else response.end()
    }
  })
  try {
    await new Promise<void>((resolve,reject)=>{
      server.once('error',reject)
      server.listen(requestedPort,AGENT_LENS_HTTP_HOST,()=>{
        server.off('error',reject)
        resolve()
      })
    })
  }catch(error){
    refresh.dispose()
    eventHub.close()
    throw error
  }
  const address=server.address()
  return {
    host:AGENT_LENS_HTTP_HOST,
    port:address&&typeof address!=='string'?address.port:requestedPort,
    server,
    notifyBackgroundActivity(){eventHub.notifyBackgroundActivity()},
    mountStatic(mount){
      mounts.set(mount.id,mount)
      return {dispose:()=>{mounts.delete(mount.id)}}
    },
    async dispose(){
      refresh.dispose()
      eventHub.close()
      await new Promise<void>((resolve,reject)=>{
        server.close(error=>error?reject(error):resolve())
      })
    },
  }
}
).test(url.pathname)
          && !url.pathname.endsWith('/summary'))){
        if(request.method!=='GET'){
          response.setHeader('allow','GET')
          writeJson(response,405,{error:'method_not_allowed'})
          return
        }
        const view=await nativeOnlyAgentOverview(storage,options.sources,options.capturePolicy)
        if(url.pathname==='/api/v1/agents'){
          writeJson(response,200,view)
        }else if(url.pathname==='/api/v1/agents/coverage'){
          writeJson(response,200,nativeOnlyAgentCoverage(view.items))
        }else{
          const enrichment=url.pathname.endsWith('/enrichment')
          const encodedId=url.pathname.slice('/api/v1/agents/'.length,
            enrichment? -'/enrichment'.length:undefined)
          let id:string
          try{id=decodeURIComponent(encodedId)}catch{throw badRequest('Invalid source identifier')}
          const detail=nativeOnlyAgentDetail(view.items,id)
          if(!detail){writeJson(response,404,{error:'not_found'});return}
          writeJson(response,200,enrichment?{
            sourceId:id,capabilities:detail.item.capabilities,
            usedAssets:detail.item.usedAssets,meta:detail.meta,
          }:detail)
        }
        return
      }
      if(url.pathname==='/api/v1/facets'){
        if(request.method!=='GET'){
          writeJson(response,405,{error:'method_not_allowed'})
          return
        }
        writeJson(response,200,await nativeOnlyFacetResponse(
          storage.nativeFacets,options.sources,options.capturePolicy))
        return
      }
      if(url.pathname==='/api/v1/usage'||url.pathname==='/api/v1/insights'){
        if(request.method!=='GET'){
          writeJson(response,405,{error:'method_not_allowed'})
          return
        }
        const usage=url.pathname==='/api/v1/usage'
        const scope=usage?parseUsageQuery(url.searchParams):parseInsightsQuery(url.searchParams)
        const native=await nativeMetricContribution(
          storage.nativeSessionMetrics,options.sources,options.capturePolicy,
          {...scope,projectScopeReady:true,...(usage?{includeTools:true}:{})})
        writeJson(response,200,usage
          ?nativeOnlyToolUsageResponse(native)
          :nativeOnlyInsightsResponse(native,scope))
        return
      }
      if(url.pathname.startsWith('/api/v1/')){
        // Missing ports are NOT empty session lists or zero counts. No
        // fallback to an old Writer or to Legacy SQL projections.
        writeJson(response,501,{
          error:'native_only_route_not_implemented',
          message:'This API requires an unported Native-only consumer',
        })
        return
      }
      if(request.method!=='GET'&&request.method!=='HEAD'){
        throw badRequest('Unsupported method')
      }
      if(await handleStatic(response,url.pathname,mounts.values()))return
      writeJson(response,404,{error:'not_found'})
    }catch(error){
      const status=statusCodeForError(error)
      if(!response.headersSent)writeJson(response,status,{
        error:status>=500?'internal_error':'bad_request',
        message:error instanceof Error?error.message:String(error),
      })
      else response.end()
    }
  })
  try {
    await new Promise<void>((resolve,reject)=>{
      server.once('error',reject)
      server.listen(requestedPort,AGENT_LENS_HTTP_HOST,()=>{
        server.off('error',reject)
        resolve()
      })
    })
  }catch(error){
    refresh.dispose()
    throw error
  }
  const address=server.address()
  return {
    host:AGENT_LENS_HTTP_HOST,
    port:address&&typeof address!=='string'?address.port:requestedPort,
    server,
    mountStatic(mount){
      mounts.set(mount.id,mount)
      return {dispose:()=>{mounts.delete(mount.id)}}
    },
    async dispose(){
      refresh.dispose()
      await new Promise<void>((resolve,reject)=>{
        server.close(error=>error?reject(error):resolve())
      })
    },
  }
}
