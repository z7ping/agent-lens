import type { CheckpointRepository } from '@agent-lens/core'
import { DefaultLiveAttachmentService, DefaultLiveService } from '@agent-lens/core-services'
import {
  CheckpointPiLiveRecoveryStore,
  DefaultPiLiveService,
  PiLiveAdapter,
} from '@agent-lens/runtime-cordis'

/** Current Pi Live Worker and native runtime events; no Legacy SQL observations.
 * An old logical Session/SourceRecord history is never fabricated for Resume.
 */
export function startSlimPiLive(checkpoints: CheckpointRepository) {
  const lives=new DefaultLiveService()
  const attachments=new DefaultLiveAttachmentService()
  const piService=new DefaultPiLiveService(
    undefined,new CheckpointPiLiveRecoveryStore(checkpoints),
  )
  const piAdapter=new PiLiveAdapter(piService,attachments,undefined,{nativeOnly:true})
  const registration=lives.register(piAdapter)
  void piService.preload().catch(error=>{
    console.warn('[AgentLens] Slim Pi Live preload failed',error)
  })
  let stopped=false
  return {
    lives,attachments,
    async dispose(){
      if(stopped)return
      stopped=true
      await registration.dispose()
      try{await piAdapter.dispose()}finally{await attachments.dispose()}
    },
  }
}
