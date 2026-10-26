import type { Plugin } from '@deepseek-ai/cordis'
import type { AgentLensContext } from '../context'
import { CheckpointPiLiveRecoveryStore } from './recovery-store'
import { PiLiveAdapter } from './adapter'
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
  const adapter = new PiLiveAdapter(service, ctx.liveAttachments, ctx.storage)
  const liveRegistration = ctx.lives.register(adapter)
  const unprovide = ctx.provide('piLive', service)
  void service.preload().catch(error => {
    console.warn('[AgentLens] Pi Live 后台预加载/恢复失败', error)
  })
  return async () => {
    unprovide()
    await liveRegistration.dispose()
    await adapter.dispose()
  }
}

applyPiLiveRuntime.inject = ['storage', 'lives', 'liveAttachments']

/** Internal runtime service. Native Pi history remains owned by @agent-lens/source-pi. */
export const piLiveRuntimePlugin = applyPiLiveRuntime
