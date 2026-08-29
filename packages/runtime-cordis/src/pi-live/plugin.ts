import type { Plugin } from '@deepseek-ai/cordis'
import type { AgentLensContext } from '../context'
import { DefaultPiLiveService } from './service'
import type { PiLiveService } from './types'

declare module '@deepseek-ai/cordis' {
  interface Context {
    piLive: PiLiveService
  }
}

const applyPiLiveRuntime: Plugin.Function<void> = (ctx: AgentLensContext) => {
  const service = new DefaultPiLiveService()
  const unprovide = ctx.provide('piLive', service)
  return async () => {
    unprovide()
    await service.dispose()
  }
}

/** Internal runtime service. Pi observation remains owned by @agent-lens/source-pi. */
export const piLiveRuntimePlugin = applyPiLiveRuntime
