import { createServer, type Server } from 'node:http'
import type {
  CapturePolicyService, NativeFacetReader, NativeSessionCatalogStore,
  NativeSessionListReader, NativeSessionMetricsStore, LaunchableProjectReader,
  SourceService, StorageHealth,
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
import { readLaunchableProjects } from './launchable-projects'
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
  launchableProjects: LaunchableProjectReader
  nativeSessionMetrics: NativeSessionMetricsStore
  health(): Promise<StorageHealth>
}

export interface NativeOnlyHttpOptions {
  port?:number
  staticDir?:string
  sources:SourceService
  capturePolicy:CapturePolicyService
  reader:NativeSessionWindowReader
}

/** Reuse the existing native HTTP handlers, but NEVER construct retired
 * Timeline/Review/SessionSummary SQL projections or fake StorageService.
 * Unported API paths are explicitly unsupported until cutover consumers land.
 */
export async function startNativeOnlyHttpSurface(
  storage:NativeOnlyHttpStorage,
  options:NativeOnlyHttpOptions,
):Promise<RunningHttpSurface> {
  const requestedPort=options.port??DEFAULT_AGENT_LENS_HTTP_PORT
  if(!Number.isInteger(requestedPort)||requestedPort<0||requestedPort>65535){
    throw new RangeError('Invalid native-only HTTP port')
  }
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
