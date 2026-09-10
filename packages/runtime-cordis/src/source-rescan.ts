import type { AgentRescanFailureDto, AgentRescanResponseDto } from '@agent-lens/protocol'
import type { AgentLensContext } from './context'
import {
  discoverRegisteredSourceAssets,
  prepareRegisteredSources,
  type RegisteredSourceFailure,
} from './source-sync'

function failureDto(failure: RegisteredSourceFailure): AgentRescanFailureDto {
  return {
    sourceId: failure.sourceId,
    stage: failure.stage === 'detect' ? 'detect' : 'assets',
    message: failure.error instanceof Error ? failure.error.message : String(failure.error),
  }
}

export class SourceRescanService {
  private inFlight: Promise<AgentRescanResponseDto> | null = null

  constructor(
    private readonly ctx: AgentLensContext,
    private readonly runtimeSignal: AbortSignal,
  ) {}

  rescan(): Promise<AgentRescanResponseDto> {
    if (this.inFlight) return this.inFlight
    const pending = this.run().finally(() => {
      if (this.inFlight === pending) this.inFlight = null
    })
    this.inFlight = pending
    return pending
  }

  private async run(): Promise<AgentRescanResponseDto> {
    if (this.runtimeSignal.aborted) throw new Error('AgentLens runtime is shutting down')
    const startedAt = new Date().toISOString()
    const prepared = await prepareRegisteredSources(this.ctx, this.runtimeSignal)
    if (this.runtimeSignal.aborted) throw new Error('AgentLens runtime is shutting down')

    const scanned = await discoverRegisteredSourceAssets(
      this.ctx,
      this.runtimeSignal,
      prepared.targets,
    )
    const failures = [...prepared.failures, ...scanned.failures].map(failureDto)
    const assetsDiscovered = scanned.results.reduce((sum, result) => sum + result.assetsDiscovered, 0)
    const assetsRemoved = scanned.results.reduce((sum, result) => sum + result.assetsRemoved, 0)
    const statesRecorded = scanned.results.reduce((sum, result) => sum + result.statesRecorded, 0)
    const statesCleared = scanned.results.reduce((sum, result) => sum + result.statesCleared, 0)
    const successfulStages = prepared.targets.length + scanned.results.length
    const status = failures.length === 0
      ? 'completed'
      : successfulStages > 0
        ? 'partial'
        : 'failed'

    return {
      status,
      startedAt,
      completedAt: new Date().toISOString(),
      sourcesDetected: prepared.targets.length,
      assetSourcesScanned: scanned.results.length,
      assetsDiscovered,
      assetsRemoved,
      statesRecorded,
      statesCleared,
      failures,
    }
  }
}
