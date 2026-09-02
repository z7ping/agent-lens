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
  void service.preload().catch(error => {
    if (process.env.AGENT_LENS_DEV_API_PORT) {
      console.warn('[AgentLens][dev] Pi SDK 后台预加载失败', error)
    }
  })
  return async () => {
    unprovide()
    await service.dispose()
  }
}

/** Internal runtime service. Pi observation remains owned by @agent-lens/source-pi. */
export const piLiveRuntimePlugin = applyPiLiveRuntime
