import type {
  AgentInstallation, Host, RuntimeProfile, SourceDefinition,
  NativeSessionCatalogEntry,
  NativeSessionCatalogStore,
  NativeSessionListQuery,
  NativeSessionListItem,
  NativeSessionMetricOverview,
  NativeSessionMetricOverviewQuery,
  NativeSessionMetricSnapshot,
  StorageHealth,
} from '@agent-lens/core'
import { SqliteSlimStorage } from '@agent-lens/storage-sqlite'
import {
  indexNativeInstallation, NativeOnlyRuntimeCapture,
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
    return this.reader.request<T>('storage.call',{path,args})
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

  /** The ONLY storage dependencies supplied to new Source Reader/Indexer:
   * no legacy RepositorySet, SourceRecords, Evidence, or Event Writer.
   */
  nativePort():NativeSessionReaderStorage & {
    nativeSessionContexts:{upsert(input:{
      sourceId:string;installationId:string;nativeSessionId:string;
      runtimeProfileId?:string
    }):Promise<void>}
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
        upsert(input){return self.write<void>(['nativeSessionContexts','upsert'],[input])},
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
      nativeSessionMetrics:port.nativeSessionMetrics,
      checkpoints:port.checkpoints,
    }).start({
      source:input.source,installation,host,signal:input.signal,
      ...(profile?{runtimeProfile:profile}:{}),
    })
  }

  async shutdown():Promise<void>{
    this.started=false
    await Promise.all([
      this.reader.shutdown().catch(()=>undefined),
      this.writer.shutdown().catch(()=>undefined),
    ])
  }
}
