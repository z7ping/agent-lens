import type { Plugin } from '@deepseek-ai/cordis'
import type { AgentLensContext } from '../context'
import { CheckpointPiLiveRecoveryStore } from './recovery-store'
import { DefaultPiLiveService } from './service'
import type { PiLiveService } from './types'

declare module '@deepseek-ai/cordis' {
  interface Context {
    piLive: PiLiveService
  }
}

const applyPiLiveRuntime: Plugin.Function<void> = (ctx: AgentLensContext) => {
  const recoveryStore = new CheckpointPiLiveRecoveryStore(ctx.storage.checkpoints)
  const service = new DefaultPiLiveService(undefined, recoveryStore)
  const unprovide = ctx.provide('piLive', service)
  void service.preload().catch(error => {
    console.warn('[AgentLens] Pi Live 后台预加载/恢复失败', error)
  })
  return async () => {
    unprovide()
    await service.dispose()
  }
}

applyPiLiveRuntime.inject = ['storage']

/** Internal runtime service. Pi observation remains owned by @agent-lens/source-pi. */
export const piLiveRuntimePlugin = applyPiLiveRuntime
