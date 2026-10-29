import type {
  AgentInstallation, Host, RuntimeProfile, SourceDefinition,
  HostIdentityHint, InstallationIdentityHint, RuntimeProfileIdentityHint,
  WorkspaceIdentityHint, Workspace,
  CapturePolicyService, SourceService,
  NativeSessionCatalogEntry,
  NativeSessionCatalogStore,
  NativeSessionListQuery,
  NativeSessionListItem,
  NativeSessionMetricOverview,
  NativeSessionMetricOverviewQuery,
  NativeSessionMetricSnapshot, NativeSessionMetricReadResult,
  NativeSessionMetricRebuildCandidate,
  NativeSessionMetricsStore,
  NativeSessionListReader, NativeFacetReader,
  StorageHealth, LaunchableProjectReader, AssetService, AssetInventoryReader,
} from '@agent-lens/core'
import { SqliteSlimStorage } from '@agent-lens/storage-sqlite/slim'
import {
  indexNativeInstallation, NativeOnlyRuntimeCapture, NativeOnlyAssetScanner,
  NativeSessionReader, NativeReaderWorkerClient,
  type NativeCatalogScanReport, type NativeCaptureHandle,
  type NativeSessionReaderStorage,
} from '@agent-lens/core-services'
import { DataRuntimeClient } from './client.js'

type SlimWorkerPort=Pick<DataRuntimeClient,'start'|'request'|'shutdown'>
export interface SlimRuntimeClientOptions {
  /** Must be an EXISTING v1 Slim database. Legacy v38 is never upgraded. */
  dbPath: string
  writer?:SlimWorkerPort
  reader?:SlimWorkerPort
}

/** Incremental native-only Data Runtime composition. Deliberately exposes
 * no arbitrary Legacy RepositorySet, SourceRecord, Event/Evidence or Hub API.
 * The full daemon can adopt this port only after HTTP/Live consumers migrate.
 */
export class SlimDataRuntime {
  private readonly writer:SlimWorkerPort
  private readonly reader:SlimWorkerPort
  private started=false
  private nativeReaderWorker:NativeReaderWorkerClient|null=null
  private readonly readsInFlight=new Map<string,Promise<unknown>>()

  constructor(private readonly options:SlimRuntimeClientOptions){
    if(!options.dbPath || options.dbPath===':memory:') {
      throw new TypeError('Slim Data Runtime requires an existing file-backed database')
    }
    this.writer=options.writer??new DataRuntimeClient({
      dbPath:options.dbPath,schemaKind:'slim',role:'writer',
    })
    this.reader=options.reader??new DataRuntimeClient({
      dbPath:options.dbPath,schemaKind:'slim',role:'reader',
    })
  }

  async start():Promise<void>{
    if(this.started)return
    // Reject v38 and absent DB before allocating worker threads or creating
    // any file. All migration/backup actions are separate explicit operations.
    const verified=SqliteSlimStorage.openExisting(this.options.dbPath,true)
    try{await verified.health()}finally{await verified.close()}
    try{
      await this.writer.start()
      await this.reader.start()
      this.started=true
    }catch(error){
      await Promise.all([
        this.reader.shutdown().catch(()=>undefined),
        this.writer.shutdown().catch(()=>undefined),
      ])
      throw error
    }
  }

  private assertStarted():void {
    if(!this.started)throw new Error('Slim Data Runtime is not started')
  }

  private read<T>(path:string[],args:unknown[]=[]):Promise<T>{
    this.assertStarted()
    // 相同只读查询共用在途 IPC，不保留跨请求缓存，也不扩大 Worker 队列。
    // Task Center / Usage / Agents 的并发请求常会重复读取同一 Facets。
    const key=JSON.stringify([path,args])
    const existing=this.readsInFlight.get(key)
    if(existing)return existing as Promise<T>
    const pending=this.reader.request<T>('storage.call',{path,args})
      .finally(()=>{this.readsInFlight.delete(key)})
    this.readsInFlight.set(key,pending)
    return pending
  }
  private write<T>(path:string[],args:unknown[]=[]):Promise<T>{
    this.assertStarted()
    return this.writer.request<T>('storage.call',{path,args})
  }

  health():Promise<StorageHealth>{
    return this.read(['health'])
  }

  sessions(query:NativeSessionListQuery):Promise<{
    items:NativeSessionListItem[];hasMore:boolean
  }>{
    return this.read(['nativeSessionList','query'],[query])
  }

  facets():Promise<{
    installedProducts:Array<{productId:string;installationIds:string[]}>
    projects:Array<{id:string;name?:string;repositoryIdentity?:string;lastActivityAt?:string}>
    projectsTruncated:boolean
  }>{
    return this.read(['nativeFacets','query'])
  }

  catalog(query:{
    sourceId?:string;installationId?:string;projectId?:string;limit?:number
  }={}):Promise<{items:NativeSessionCatalogEntry[];hasMore:boolean}>{
    return this.read(['nativeSessionCatalog','query'],[query])
  }

  metrics(query:NativeSessionMetricOverviewQuery):Promise<NativeSessionMetricOverview>{
    return this.read(['nativeSessionMetrics','overview'],[query])
  }

  upsertCatalog(entry:NativeSessionCatalogEntry):Promise<void>{
    return this.write(['nativeSessionCatalog','upsert'],[entry])
  }

  replaceMetrics(snapshot:NativeSessionMetricSnapshot):Promise<boolean>{
    return this.write(['nativeSessionMetrics','replace'],[snapshot])
  }

  /** Create the same trusted NativeSessionReader used by historical Review,
   * backed only by Slim worker metadata and the isolated source parser worker.
   * Ownership of the worker belongs to this Slim Runtime, not Legacy Cordis.
   */
  nativeReader(sources:SourceService,policy:CapturePolicyService):NativeSessionReader{
    this.assertStarted()
    if(!this.nativeReaderWorker)this.nativeReaderWorker=new NativeReaderWorkerClient()
    return new NativeSessionReader(this.nativePort(),sources,policy,this.nativeReaderWorker)
  }

  /** Slim HTTP and review handlers consume this contract directly.
   * Unlike the Legacy StorageService it offers no Observation/SessionSummary
   * RepositorySet, no write claims and no access to executor/private SQL.
   * Explicit numeric rebuild writes only validated aggregate snapshots.
   */
  nativeHttpPort():{
    nativeSessionCatalog:Pick<NativeSessionCatalogStore,
      'get'|'getByReviewSessionId'|'query'|'isNativeMetricsEligible'>
    nativeSessionList:NativeSessionListReader
    nativeFacets:NativeFacetReader
    /** Narrow read-only identity: never export the old RepositorySet. */
    installations:{get(id:string):Promise<AgentInstallation|null>}
    assetInventory:Pick<AssetInventoryReader,'listByInstallation'>
    launchableProjects:LaunchableProjectReader
    nativeSessionMetrics:NativeSessionMetricsStore
    checkpoints:{get<T>(scope:string,key:string):Promise<T|null>;
      set<T>(scope:string,key:string,value:T):Promise<void>}
    health:()=>Promise<StorageHealth>
  }{
    const self=this
    return {
      identity:{resolveWorkspace(hint){
        return self.write<Workspace|null>(['identity','resolveWorkspace'],[hint])
      }},
      nativeSessionCatalog:{
        get(input){return self.read<NativeSessionCatalogEntry|null>(['nativeSessionCatalog','get'],[input])},
        getByReviewSessionId(id){return self.read<NativeSessionCatalogEntry|null>(['nativeSessionCatalog','getByReviewSessionId'],[id])},
        query(input={}){return self.read<Awaited<ReturnType<NativeSessionCatalogStore['query']>>>(['nativeSessionCatalog','query'],[input])},
        isNativeMetricsEligible(input){
          return self.read<boolean>(['nativeSessionCatalog','isNativeMetricsEligible'],[input])
        },
      },
      nativeSessionList:{query(input){
        return self.read<Awaited<ReturnType<NativeSessionListReader['query']>>>(['nativeSessionList','query'],[input])
      }},
      nativeFacets:{query(input={}){
        return self.read<Awaited<ReturnType<NativeFacetReader['query']>>>(['nativeFacets','query'],[input])
      }},
      installations:{
        get(id){
          return self.read<AgentInstallation|null>(['repositories','installations','get'],[id])
        },
      },
      assetInventory:{
        listByInstallation(id){return self.read<Awaited<ReturnType<AssetInventoryReader['listByInstallation']>>>(
          ['assetInventory','listByInstallation'],[id])},
      },
      launchableProjects:{
        query(input){
          return self.read<Awaited<ReturnType<LaunchableProjectReader['query']>>>(
            ['launchableProjects','query'],[input])
        },
        recordWorkspaceValidation(input){
          return self.write<void>(['launchableProjects','recordWorkspaceValidation'],[input])
        },
      },
      nativeSessionMetrics:{
        get(input){return self.read<NativeSessionMetricReadResult>(['nativeSessionMetrics','get'],[input])},
        overview(input){return self.read<NativeSessionMetricOverview>(['nativeSessionMetrics','overview'],[input])},
        findRebuildCandidates(input,limit,before){
          return self.read<NativeSessionMetricRebuildCandidate[]>(['nativeSessionMetrics','findRebuildCandidates'],[
            input,limit,...(before?[before]:[]),
          ])
        },
        replace(input){return self.write<boolean>(['nativeSessionMetrics','replace'],[input])},
        invalidate(input){return self.write<void>(['nativeSessionMetrics','invalidate'],[input])},
      },
      checkpoints:{
        get<T>(scope:string,key:string){return self.read<T|null>(['checkpoints','get'],[scope,key])},
        set<T>(scope:string,key:string,value:T){return self.write<void>(['checkpoints','set'],[scope,key,value])},
      },
      health(){return self.health()},
    }
  }

  /** The ONLY storage dependencies supplied to new Source Reader/Indexer:
   * no legacy RepositorySet, SourceRecords, Evidence, or Event Writer.
   */
  nativePort():NativeSessionReaderStorage & {
    nativeSessionContexts:{get(input:{
      sourceId:string;installationId:string;nativeSessionId:string
    }):Promise<{runtimeProfileId?:string}|null>;upsert(input:{
      sourceId:string;installationId:string;nativeSessionId:string;
      runtimeProfileId?:string;workspaceId?:string;projectId?:string
    }):Promise<void>}
    identity:{resolveWorkspace(hint:WorkspaceIdentityHint):Promise<Workspace|null>}
    nativeSessionMetrics:{invalidate(input:{
      sourceId:string;installationId:string;nativeSessionId:string
    }):Promise<void>}
    checkpoints:{
      get<T>(scope:string,key:string):Promise<T|null>
      set<T>(scope:string,key:string,value:T):Promise<void>
      clear(scope:string,key:string):Promise<void>
    }
  } {
    const self=this
    return {
      nativeSessionCatalog:{
        upsert(entry:NativeSessionCatalogEntry){
          return self.write<void>(['nativeSessionCatalog','upsert'],[entry])
        },
        get(input:Parameters<NativeSessionCatalogStore['get']>[0]){
          return self.read<NativeSessionCatalogEntry|null>(['nativeSessionCatalog','get'],[input])
        },
      },
      repositories:{
        hosts:{
          get(id:string){return self.read<Host|null>(['repositories','hosts','get'],[id])},
        },
        installations:{
          get(id:string){
            return self.read<AgentInstallation|null>(['repositories','installations','get'],[id])
          },
        },
      },
      nativeSessionContexts:{
        get(input){return self.read<{runtimeProfileId?:string}|null>(['nativeSessionContexts','get'],[input])},
        upsert(input){return self.write<void>(['nativeSessionContexts','upsert'],[input])},
      },
      runtimeProfiles:{
        get(id:string){return self.read<RuntimeProfile|null>(['runtimeProfiles','get'],[id])},
      },
      nativeSessionMetrics:{
        invalidate(input){return self.write<void>(['nativeSessionMetrics','invalidate'],[input])},
      },
      checkpoints:{
        get<T>(scope:string,key:string){
          return self.read<T|null>(['checkpoints','get'],[scope,key])
        },
        set<T>(scope:string,key:string,value:T){
          return self.write<void>(['checkpoints','set'],[scope,key,value])
        },
        clear(scope:string,key:string){
          return self.write<void>(['checkpoints','clear'],[scope,key])
        },
      },
    }
  }

  /** Source-owned asset scan writes Slim current-state only; no event copy. */
  async scanInstallationAssets(input:{
    source:SourceDefinition;installationId:string;runtimeProfileId?:string;
    signal:AbortSignal;policy:CapturePolicyService
  }):Promise<import('@agent-lens/core-services').SlimAssetScanReport>{
    this.assertStarted()
    const native=this.nativePort()
    const installation=await native.repositories.installations.get(input.installationId)
    if(!installation)throw new Error('Slim asset installation is unavailable')
    const host=await native.repositories.hosts.get(installation.hostId)
    if(!host)throw new Error('Slim asset Host is unavailable')
    const profile=input.runtimeProfileId
      ?await this.read<RuntimeProfile|null>(['runtimeProfiles','get'],[input.runtimeProfileId])
      :undefined
    if(input.runtimeProfileId&&!profile)throw new Error('Slim asset Profile is unavailable')
    const assets:AssetService={
      resolveDefinition:hint=>this.write<Awaited<ReturnType<AssetService['resolveDefinition']>>>(
        ['assets','resolveDefinition'],[hint]),
      resolveBinding:hint=>this.write<Awaited<ReturnType<AssetService['resolveBinding']>>>(
        ['assets','resolveBinding'],[hint]),
      recordState:state=>this.write<Awaited<ReturnType<AssetService['recordState']>>>(
        ['assets','recordState'],[state]),
    }
    return new NativeOnlyAssetScanner(assets,native.checkpoints,input.policy).scan({
      source:input.source,host,installation,signal:input.signal,
      ...(profile?{runtimeProfile:profile}:{}),
    })
  }

  /** Local native discovery writes ONLY host/installation/Profile metadata.
   * The RPC allowlist cannot reach Session/Observation/Legacy Writer methods.
   */
  resolveHost(hint:HostIdentityHint):Promise<Host>{
    return this.write(['identity','resolveHost'],[hint])
  }

  resolveInstallation(hint:InstallationIdentityHint):Promise<AgentInstallation>{
    return this.write(['identity','resolveInstallation'],[hint])
  }

  resolveProfile(hint:RuntimeProfileIdentityHint):Promise<RuntimeProfile>{
    return this.write(['runtimeProfiles','resolve'],[hint])
  }

  /** Rebuild from existing Slim Project/Workspace/Native Context metadata.
   * No Legacy SQL and no native transcript replay.
   */
  rebuildLaunchableProjects():Promise<void>{
    return this.write<void>(['launchableProjects','rebuild'])
  }

  /** Read-only profile enumeration for bounded Native-only startup. */
  profiles(installationId:string):Promise<RuntimeProfile[]>{
    return this.read(['runtimeProfiles','listByInstallation'],[installationId])
  }

  /** Native Source history indexing now uses the real isolated Worker port. */
  async reindexInstallation(input:{
    source:SourceDefinition;installationId:string
    runtimeProfileId?:string;signal:AbortSignal;maxSessions?:number
  }):Promise<NativeCatalogScanReport>{
    this.assertStarted()
    const profile=input.runtimeProfileId
      ? await this.read<RuntimeProfile|null>(['runtimeProfiles','get'],[input.runtimeProfileId])
      : undefined
    if(input.runtimeProfileId&&!profile){
      throw new Error('Requested native runtime profile is not indexed')
    }
    return indexNativeInstallation(this.nativePort(),{
      source:input.source,installationId:input.installationId,
      signal:input.signal,
      ...(profile?{runtimeProfile:profile}:{}),
      ...(input.maxSessions?{maxSessions:input.maxSessions}:{}),
    })
  }

  /** Captures into Source-owned original files plus slim metadata only.
   * Incomplete Hook-only facts are counted as gaps, never mirrored to Events.
   */
  async captureInstallation(input:{
    source:SourceDefinition;installationId:string
    runtimeProfileId?:string;signal:AbortSignal
  }):Promise<NativeCaptureHandle>{
    this.assertStarted()
    const port=this.nativePort()
    const installation=await port.repositories.installations.get(input.installationId)
    if(!installation)throw new Error('Native capture installation is not indexed')
    const host=await port.repositories.hosts.get(installation.hostId)
    if(!host)throw new Error('Native capture host is not indexed')
    const profile=input.runtimeProfileId
      ? await this.read<RuntimeProfile|null>(['runtimeProfiles','get'],[input.runtimeProfileId])
      : undefined
    if(input.runtimeProfileId&&!profile){
      throw new Error('Requested native capture runtime profile is not indexed')
    }
    if(!port.nativeSessionCatalog)throw new Error('Native Catalog is unavailable')
    return new NativeOnlyRuntimeCapture({
      nativeSessionCatalog:port.nativeSessionCatalog,
      nativeSessionContexts:port.nativeSessionContexts,
      identity:port.identity,
      nativeSessionMetrics:port.nativeSessionMetrics,
      checkpoints:port.checkpoints,
    }).start({
      source:input.source,installation,host,signal:input.signal,
      ...(profile?{runtimeProfile:profile}:{}),
    })
  }

  async shutdown():Promise<void>{
    this.started=false
    const worker=this.nativeReaderWorker
    this.nativeReaderWorker=null
    await Promise.all([
      worker?.dispose().catch(()=>undefined),
      this.reader.shutdown().catch(()=>undefined),
      this.writer.shutdown().catch(()=>undefined),
    ])
  }
}
