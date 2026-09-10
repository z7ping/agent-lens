import type { AgentLensContext } from './context'
import {
  discoverRegisteredSourceAssets,
  prepareRegisteredSources,
  type RegisteredSourceFailure,
} from './source-sync'

export interface SourceRescanFailure {
  sourceId: string
  stage: 'detect' | 'assets'
  message: string
}

export interface SourceRescanSummary {
  status: 'completed' | 'partial' | 'failed'
  startedAt: string
  completedAt: string
  sourcesDetected: number
  assetSourcesScanned: number
  assetsDiscovered: number
  assetsRemoved: number
  statesRecorded: number
  statesCleared: number
  failures: SourceRescanFailure[]
}

function failureDto(failure: RegisteredSourceFailure): SourceRescanFailure {
  return {
    sourceId: failure.sourceId,
    stage: failure.stage === 'detect' ? 'detect' : 'assets',
    message: failure.error instanceof Error ? failure.error.message : String(failure.error),
  }
}

export class SourceRescanService {
  private inFlight: Promise<SourceRescanSummary> | null = null
  private readonly detectedSources = new Map<string, boolean>()

  constructor(
    private readonly ctx: AgentLensContext,
    private readonly runtimeSignal: AbortSignal,
  ) {}

  isSourceDetected(sourceId: string): boolean | undefined {
    return this.detectedSources.get(sourceId)
  }

  rescan(): Promise<SourceRescanSummary> {
    if (this.inFlight) return this.inFlight
    const pending = this.run().finally(() => {
      if (this.inFlight === pending) this.inFlight = null
    })
    this.inFlight = pending
    return pending
  }

  private async run(): Promise<SourceRescanSummary> {
    if (this.runtimeSignal.aborted) throw new Error('AgentLens runtime is shutting down')
    const startedAt = new Date().toISOString()
    const enabledSourceIds = this.ctx.sources.list()
      .filter(source => this.ctx.capturePolicy.isSourceEnabled(source.manifest.sourceId))
      .map(source => source.manifest.sourceId)
    const prepared = await prepareRegisteredSources(this.ctx, this.runtimeSignal)
    if (this.runtimeSignal.aborted) throw new Error('AgentLens runtime is shutting down')

    const failedDetections = new Set(
      prepared.failures
        .filter(failure => failure.stage === 'detect')
        .map(failure => failure.sourceId),
    )
    const detectedNow = new Set(prepared.targets.map(target => target.source.manifest.sourceId))
    for (const sourceId of enabledSourceIds) {
      // A failed detector is unknown, not "uninstalled". Preserve the previous
      // current-state answer when available instead of overwriting it with false.
      if (failedDetections.has(sourceId)) continue
      this.detectedSources.set(sourceId, detectedNow.has(sourceId))
    }

    const scanned = await discoverRegisteredSourceAssets(
      this.ctx,
      this.runtimeSignal,
      prepared.targets,
    )
    if (this.runtimeSignal.aborted) throw new Error('AgentLens runtime is shutting down')

    const failures = [...prepared.failures, ...scanned.failures].map(failureDto)
    const successfulStages = prepared.targets.length + scanned.results.length
    return {
      status: failures.length === 0
        ? 'completed'
        : successfulStages > 0
          ? 'partial'
          : 'failed',
      startedAt,
      completedAt: new Date().toISOString(),
      sourcesDetected: prepared.targets.length,
      assetSourcesScanned: scanned.results.length,
      assetsDiscovered: scanned.results.reduce((sum, result) => sum + result.assetsDiscovered, 0),
      assetsRemoved: scanned.results.reduce((sum, result) => sum + result.assetsRemoved, 0),
      statesRecorded: scanned.results.reduce((sum, result) => sum + result.statesRecorded, 0),
      statesCleared: scanned.results.reduce((sum, result) => sum + result.statesCleared, 0),
      failures,
    }
  }
}
