import type {
  CheckpointRepository, CapturePolicyService,
  NativeSessionCatalogStore,
} from '@agent-lens/core'
import type { NativeSessionReader } from '@agent-lens/core-services'
import { DefaultLiveAttachmentService, DefaultLiveService } from '@agent-lens/core-services'
import {
  CheckpointPiLiveRecoveryStore, DefaultPiLiveService, PiLiveAdapter,
} from '@agent-lens/runtime-cordis'
import {
  CheckpointCodexRecoveryStore, CodexLiveAdapter, CodexRpc,
} from '@agent-lens/live-codex'
import {
  DefaultHermesLiveService, HermesApiClient, HermesLiveAdapter,
  resolveHermesApiClientConfig,
} from '@agent-lens/live-hermes'
import { createSlimPiHistoryResolver } from './slim-pi-history.js'
import { createSlimCodexHistoryResolver } from './slim-codex-history.js'

/** Compose the EXISTING Live adapters against original Source sessions.
 * Each privileged integration must have its persisted 'live' grant; merely
 * detecting an installation never starts or authorizes a Live runtime.
 * No Legacy SQL or parallel controller enters this composition.
 */
export async function startSlimLive(
  checkpoints: CheckpointRepository,
  catalog: Pick<NativeSessionCatalogStore,'getByReviewSessionId'>,
  reader: Pick<NativeSessionReader,'read'>,
  policy: Pick<CapturePolicyService,'isSourceEnabled'>,
  authorizedLiveProducts: ReadonlySet<string>,
) {
  const lives=new DefaultLiveService()
  const attachments=new DefaultLiveAttachmentService()
  const cleanup:Array<()=>Promise<void>>=[]
  const enabled=(productId:string)=>authorizedLiveProducts.has(productId)
    && policy.isSourceEnabled(productId)
  let stopped=false
  try {
    if(enabled('pi')){
      const piService=new DefaultPiLiveService(
        undefined,new CheckpointPiLiveRecoveryStore(checkpoints),
      )
      const adapter=new PiLiveAdapter(piService,attachments,undefined,{
        nativeOnly:true,
        nativeHistory:createSlimPiHistoryResolver(catalog,reader,policy),
      })
      const registration=lives.register(adapter)
      cleanup.push(async()=>{await registration.dispose();await adapter.dispose()})
      void piService.preload().catch(error=>{
        if(!stopped)console.warn('[AgentLens] Slim Pi Live preload failed',error)
      })
    }
    if(enabled('codex')){
      const adapter=new CodexLiveAdapter(
        new CodexRpc(),new CheckpointCodexRecoveryStore(checkpoints),
        undefined,{nativeOnly:true,nativeHistory:createSlimCodexHistoryResolver(catalog,reader,policy)},
      )
      const registration=lives.register(adapter)
      cleanup.push(async()=>{await registration.dispose();await adapter.dispose()})
    }
    if(enabled('hermes')){
      const config=await resolveHermesApiClientConfig({})
      const adapter=new HermesLiveAdapter(
        new DefaultHermesLiveService(new HermesApiClient(config)),
      )
      const registration=lives.register(adapter)
      cleanup.push(async()=>{await registration.dispose();await adapter.dispose()})
    }
  }catch(error){
    await Promise.allSettled(cleanup.reverse().map(dispose=>dispose()))
    await attachments.dispose()
    throw error
  }
  return {
    lives,attachments,
    async dispose(){
      if(stopped)return
      stopped=true
      try {
        for(const dispose of cleanup.reverse())await dispose()
      }finally{await attachments.dispose()}
    },
  }
}
