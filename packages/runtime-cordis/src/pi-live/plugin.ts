import type { Plugin } from '@deepseek-ai/cordis'
import type { AgentLensContext } from '../context'
import { CheckpointPiLiveRecoveryStore } from './recovery-store'
import { DefaultPiLiveService } from './service'
import type { PiLiveStartInput, PiLiveService } from './types'
import { WorkerPiRuntimeHost, type PiRuntimeHandle, type PiRuntimeHost } from './worker-host'
import { validatePiLiveWorkspace } from './workspace-validation'

declare module '@deepseek-ai/cordis' {
  interface Context {
    piLive: PiLiveService
  }
}

class WorkspaceValidatingPiRuntimeHost implements PiRuntimeHost {
  private readonly delegate = new WorkerPiRuntimeHost()

  async start(
    runtimeSessionId: string,
    input: PiLiveStartInput,
    signal: AbortSignal,
    onEvent: (event: Record<string, unknown>) => void,
    onExit: (error: Error) => void,
  ): Promise<PiRuntimeHandle> {
    const cwd = await validatePiLiveWorkspace(input.cwd)
    return this.delegate.start(runtimeSessionId, { ...input, cwd }, signal, onEvent, onExit)
  }
}

class WorkspaceValidatingPiLiveService extends DefaultPiLiveService {
  override async start(input: PiLiveStartInput) {
    const cwd = await validatePiLiveWorkspace(input.cwd)
    return super.start({ ...input, cwd })
  }
}

const applyPiLiveRuntime: Plugin.Function<void> = (ctx: AgentLensContext) => {
  const recoveryStore = new CheckpointPiLiveRecoveryStore(ctx.storage.checkpoints)
  const service = new WorkspaceValidatingPiLiveService(new WorkspaceValidatingPiRuntimeHost(), recoveryStore)
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
