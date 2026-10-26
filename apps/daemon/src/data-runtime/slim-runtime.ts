import type {
  NativeSessionCatalogEntry,
  NativeSessionListQuery,
  NativeSessionListItem,
  NativeSessionMetricOverview,
  NativeSessionMetricOverviewQuery,
  NativeSessionMetricSnapshot,
  StorageHealth,
} from '@agent-lens/core'
import { SqliteSlimStorage } from '@agent-lens/storage-sqlite'
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

  async shutdown():Promise<void>{
    this.started=false
    await Promise.all([
      this.reader.shutdown().catch(()=>undefined),
      this.writer.shutdown().catch(()=>undefined),
    ])
  }
}
