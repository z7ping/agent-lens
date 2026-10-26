import type { CheckpointRepository, CapturePolicyService, NativeSessionCatalogStore } from '@agent-lens/core'
import type { NativeSessionReader } from '@agent-lens/core-services'
import { createSlimPiHistoryResolver } from './slim-pi-history.js'
import { CodexLiveAdapter, CheckpointCodexRecoveryStore } from '@agent-lens/live-codex'
import { DefaultLiveAttachmentService, DefaultLiveService } from '@agent-lens/core-services'
import {
  CheckpointPiLiveRecoveryStore,
  DefaultPiLiveService,
  PiLiveAdapter,
} from '@agent-lens/runtime-cordis'

/** Current Pi Live Worker and native runtime events; no Legacy SQL observations.
 * An old logical Session/SourceRecord history is never fabricated for Resume.
 */
export function startSlimAgentLives(
  checkpoints: CheckpointRepository,
  catalog: Pick<NativeSessionCatalogStore,'getByReviewSessionId'>,
  reader: Pick<NativeSessionReader,'read'>,
  policy: Pick<CapturePolicyService,'isSourceEnabled'>,
) {
  const lives=new DefaultLiveService()
  const attachments=new DefaultLiveAttachmentService()
  const piService=new DefaultPiLiveService(
    undefined,new CheckpointPiLiveRecoveryStore(checkpoints),
  )
  const piAdapter=new PiLiveAdapter(piService,attachments,undefined,{
    nativeOnly:true,
    nativeHistory:createSlimPiHistoryResolver(catalog,reader,policy),
  })
  const piRegistration=lives.register(piAdapter)
  const codexAdapter=new CodexLiveAdapter(
    undefined,new CheckpointCodexRecoveryStore(checkpoints),undefined,{nativeOnly:true})
  const codexRegistration=lives.register(codexAdapter)
  void piService.preload().catch(error=>{
    console.warn('[AgentLens] Slim Pi Live preload failed',error)
  })
  let stopped=false
  return {
    lives,attachments,
    async dispose(){
      if(stopped)return
      stopped=true
      await codexRegistration.dispose()
      await piRegistration.dispose()
      try{await codexAdapter.dispose()}finally{
        try{await piAdapter.dispose()}finally{await attachments.dispose()}
      }
    },
  }
}
