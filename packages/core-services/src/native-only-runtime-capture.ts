import type {
  AgentInstallation, CheckpointRepository, Host, NativeSessionCatalogStore,
  NativeSessionMetricsStore, RuntimeProfile, SourceCheckpointService,
  SourceDefinition, SourceRecord,
} from '@agent-lens/core'
import { NativeSessionCatalogTracker } from './native-session-catalog-tracker'

export interface NativeCaptureCounters {
  received:number
  sourceVerified:number
  catalogUpdated:number
  metricsInvalidated:number
  coverageGaps:number
  /** Deliberately always zero; raw Source events never enter SQLite. */
  eventCopiesWritten:0
}
export interface NativeCaptureHandle {
  readonly sourceId:string
  readonly installationId:string
  snapshot():Readonly<NativeCaptureCounters>
  dispose():Promise<void>
}

interface NativeCapturePort {
  nativeSessionCatalog:NativeSessionCatalogStore
  nativeSessionMetrics?:Pick<NativeSessionMetricsStore,'invalidate'>
  checkpoints:Pick<CheckpointRepository,'get'|'set'|'clear'>
}

const CURSOR_MAX_BYTES=4096
const forbidden=/^(payload|body|prompt|message|messages|text|output|input|arguments|args|secret|token|password|content|error|stack)$/i

function checkCursor(value:unknown,depth=0):boolean {
  if(depth>3)return false
  if(value===null || typeof value==='boolean'
    || (typeof value==='number' && Number.isSafeInteger(value)))return true
  if(typeof value==='string')return value.length<=512
  if(Array.isArray(value))return value.length<=32&&value.every(item=>checkCursor(item,depth+1))
  if(!value||typeof value!=='object')return false
  const props=Object.entries(value)
  return props.length<=32 && props.every(([key,item])=>
    key.length<=128 && !forbidden.test(key) && checkCursor(item,depth+1))
}

function captureCheckpoint(
  store:NativeCapturePort['checkpoints'],scope:string,
):SourceCheckpointService {
  return {
    async get<T>(key:string):Promise<T|null> {
      if(!key||key.length>128)throw new TypeError('Invalid native capture checkpoint key')
      return store.get<T>(scope,key)
    },
    async set<T>(key:string,value:T):Promise<void> {
      if(!key||key.length>128 || !checkCursor(value)
        || Buffer.byteLength(JSON.stringify(value),'utf8')>CURSOR_MAX_BYTES){
        throw new TypeError('Native capture checkpoint must be bounded cursor metadata')
      }
      await store.set(scope,key,value)
    },
    async clear(key:string):Promise<void> {
      if(!key||key.length>128)throw new TypeError('Invalid native capture checkpoint key')
      await store.clear(scope,key)
    },
  }
}

/**
 * Replaces the persistent-event branch of SourceRuntimeRunner in a Slim
 * runtime. Source callbacks are strictly serialized to preserve ordering.
 * Raw records remain in memory only until recovery/catalog verification.
 *
 * Hook-only facts not certified by original recovery count as gaps instead
 * of silently recreating legacy Observation/Evidence tables.
 */
export class NativeOnlyRuntimeCapture {
  constructor(private readonly port:NativeCapturePort){}

  async start(input:{
    source:SourceDefinition
    host:Host
    installation:AgentInstallation
    runtimeProfile?:RuntimeProfile
    signal:AbortSignal
  }):Promise<NativeCaptureHandle> {
    const {source,host,installation,runtimeProfile,signal}=input
    if(source.manifest.productId!==installation.productId
      || !source.manifest.sourceId || host.id!==installation.hostId
      || (runtimeProfile && runtimeProfile.installationId!==installation.id)){
      throw new Error('Native capture Source installation identity mismatch')
    }
    const counts:NativeCaptureCounters={
      received:0,sourceVerified:0,catalogUpdated:0,
      metricsInvalidated:0,coverageGaps:0,eventCopiesWritten:0,
    }
    if(!source.startCapture){
      return {
        sourceId:source.manifest.sourceId,installationId:installation.id,
        snapshot:()=>({...counts}),
        async dispose(){},
      }
    }
    if(!source.rawRecovery?.verify || !source.readNativeSessionPage){
      throw new Error('Native runtime capture requires verifiable Source history')
    }
    const effectiveInstallation=runtimeProfile?{
      ...installation,
      dataRoot:runtimeProfile.dataRoot??installation.dataRoot,
      configRoot:runtimeProfile.configRoot??installation.configRoot,
    }:installation
    const scope=JSON.stringify([
      'slim-native-capture-v1',source.manifest.sourceId,installation.id,
      runtimeProfile?.id??'default',
    ])
    const checkpoint=captureCheckpoint(this.port.checkpoints,scope)
    const context={
      host,installation:effectiveInstallation,
      ...(runtimeProfile?{runtimeProfile}:{}),
      abortSignal:signal,checkpoint,
    }
    const tracker=new NativeSessionCatalogTracker(this.port.nativeSessionCatalog)
    let closed=false
    let tail:Promise<void>=Promise.resolve()
    const handleRecord=async(record:SourceRecord):Promise<void>=>{
      signal.throwIfAborted()
      counts.received++
      if(record.sourceId!==source.manifest.sourceId
        || record.installationId!==installation.id
        || !record.sourceSessionNativeId || !record.fingerprint
        || !record.locator.path
        || record.locator.kind==='runtime-hook'){
        counts.coverageGaps++
        return
      }
      let verification:Awaited<ReturnType<NonNullable<NonNullable<SourceDefinition['rawRecovery']>['verify']>>>
      try{
        verification=await source.rawRecovery!.verify(record,context)
      }catch(error){
        if(signal.aborted)throw error
        counts.coverageGaps++
        return
      }
      if(verification.state!=='verified'){
        counts.coverageGaps++
        return
      }
      counts.sourceVerified++
      // Tracker never consults the v38 write-claim table on this path.
      const changed=await tracker.observe(source,record)
      if(changed) {
        counts.catalogUpdated++
        if(this.port.nativeSessionMetrics){
          await this.port.nativeSessionMetrics.invalidate({
            sourceId:record.sourceId,installationId:record.installationId,
            nativeSessionId:record.sourceSessionNativeId,
          })
          counts.metricsInvalidated++
        }
      }
    }

    const capture=await source.startCapture(context,{
      emit:(record)=>{
        if(closed)throw new Error('Native capture has been disposed')
        const next=tail.then(()=>handleRecord(record))
        tail=next.then(()=>undefined,()=>undefined)
        return next
      },
    })
    return {
      sourceId:source.manifest.sourceId,installationId:installation.id,
      snapshot:()=>({...counts}),
      async dispose(){
        if(closed)return
        closed=true
        try{await capture.dispose()}finally{await tail}
      },
    }
  }
}
