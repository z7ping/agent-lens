import type { Plugin } from '@deepseek-ai/cordis'
import type { AgentLensContext } from '../context'
import { CheckpointPiLiveRecoveryStore } from './recovery-store'
import { PiLiveAdapter } from './adapter'
import { DefaultPiLiveService } from './service'
import { createPiLiveStartupAuditSink } from './startup-audit'
import type { PiLiveService } from './types'

declare module '@deepseek-ai/cordis' {
  interface Context {
    piLive: PiLiveService
  }
}

const applyPiLiveRuntime: Plugin.Function<void> = (ctx: AgentLensContext) => {
  const recoveryStore = new CheckpointPiLiveRecoveryStore(ctx.storage.checkpoints)
  const startupAudit = createPiLiveStartupAuditSink(ctx)
  const service = new DefaultPiLiveService(undefined, recoveryStore, startupAudit)
  const adapter = new PiLiveAdapter(service)
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

applyPiLiveRuntime.inject = ['storage', 'lives', 'sources', 'identity', 'observations', 'capturePolicy']

/** Internal runtime service. Pi observation remains owned by @agent-lens/source-pi; Live is registered through ctx.lives. */
export const piLiveRuntimePlugin = applyPiLiveRuntime
