import type {
  AssetBinding,
  AssetBindingHint,
  AssetDefinition,
  AssetDefinitionHint,
  AssetService,
  AssetState,
  AssetStateInput,
  AssetStateObservation,
} from '@agent-lens/core'
import { SourceAssetRunner, type SourceAssetDiscoveryResult } from '@agent-lens/core-services/source-runner'
import type { AgentRescanFailureDto, AgentRescanSummaryDto } from '@agent-lens/protocol'
import type { AgentLensContext } from './context'
import {
  prepareRegisteredSources,
  type RegisteredSourceFailure,
  type RegisteredSourceTarget,
} from './source-sync'

const ASSET_RESCAN_CHECKPOINT_SCOPE = 'agent-rescan-assets-v1'
const PRESENCE_STATES = new Set<AssetState>(['installed', 'configured', 'enabled', 'discoverable', 'exposed'])

interface AssetRescanSnapshot {
  bindings: Record<string, AssetState[]>
  completedAt: string
}

interface ReconciledAssetDiscoveryResult extends SourceAssetDiscoveryResult {
  assetsRemoved: number
  statesCleared: number
}

function failureDto(failure: RegisteredSourceFailure): AgentRescanFailureDto {
  return {
    sourceId: failure.sourceId,
    stage: failure.stage === 'detect' ? 'detect' : 'assets',
    message: failure.error instanceof Error ? failure.error.message : String(failure.error),
  }
}

function assetFailure(sourceId: string, error: unknown): AgentRescanFailureDto {
  return {
    sourceId,
    stage: 'assets',
    message: error instanceof Error ? error.message : String(error),
  }
}

function rescanSnapshotKey(target: RegisteredSourceTarget, installationId: string): string {
  const profile = target.detected.runtimeProfile?.nativeProfileId ?? 'default'
  return `${target.source.manifest.sourceId}:${installationId}:${profile}`
}

class TrackingAssetService implements AssetService {
  private readonly states = new Map<string, Set<AssetState>>()
  private readonly explicitDiscoverable = new Set<string>()

  constructor(private readonly inner: AssetService) {}

  resolveDefinition(input: AssetDefinitionHint): Promise<AssetDefinition> {
    return this.inner.resolveDefinition(input)
  }

  async resolveBinding(input: AssetBindingHint): Promise<AssetBinding> {
    const binding = await this.inner.resolveBinding(input)
    if (!this.states.has(binding.id)) this.states.set(binding.id, new Set())
    return binding
  }

  async recordState(input: AssetStateInput): Promise<AssetStateObservation> {
    let states = this.states.get(input.assetBindingId)
    if (!states) {
      states = new Set()
      this.states.set(input.assetBindingId, states)
    }
    if (input.state === 'discoverable') this.explicitDiscoverable.add(input.assetBindingId)
    if (input.value === true && PRESENCE_STATES.has(input.state)) states.add(input.state)
    return this.inner.recordState(input)
  }

  async finalize(observedAt: string): Promise<number> {
    let recorded = 0
    for (const [bindingId, states] of this.states) {
      if (this.explicitDiscoverable.has(bindingId)) continue
      await this.inner.recordState({
        assetBindingId: bindingId,
        state: 'discoverable',
        value: true,
        observedAt,
        evidenceRefs: [],
      })
      states.add('discoverable')
      recorded += 1
    }
    return recorded
  }

  snapshot(completedAt: string): AssetRescanSnapshot {
    return {
      bindings: Object.fromEntries(
        [...this.states].map(([bindingId, states]) => [bindingId, [...states].sort()]),
      ),
      completedAt,
    }
  }
}

export class SourceRescanService {
  private inFlight: Promise<AgentRescanSummaryDto> | null = null

  constructor(
    private readonly ctx: AgentLensContext,
    private readonly runtimeSignal: AbortSignal,
  ) {}

  rescan(): Promise<AgentRescanSummaryDto> {
    if (this.inFlight) return this.inFlight
    const pending = this.run().finally(() => {
      if (this.inFlight === pending) this.inFlight = null
    })
    this.inFlight = pending
    return pending
  }

  private async scanTarget(target: RegisteredSourceTarget): Promise<ReconciledAssetDiscoveryResult> {
    const trackingAssets = new TrackingAssetService(this.ctx.assets)
    const runner = new SourceAssetRunner(
      this.ctx.storage,
      this.ctx.identity,
      this.ctx.capabilities,
      trackingAssets,
      this.ctx.evidence,
      this.ctx.capturePolicy,
    )
    const result = await runner.scan({
      source: target.source,
      host: target.host,
      detected: target.detected,
      abortSignal: this.runtimeSignal,
    })
    if (this.runtimeSignal.aborted) throw new Error('AgentLens runtime is shutting down')

    // No discovery contract means the source did not authoritatively scan its inventory.
    // Likewise, config capture being disabled must never be interpreted as asset removal.
    if (!target.source.discoverAssets || !this.ctx.capturePolicy.isEnabled('config')) {
      return { ...result, assetsRemoved: 0, statesCleared: 0 }
    }

    const completedAt = new Date().toISOString()
    const syntheticStates = await trackingAssets.finalize(completedAt)
    const key = rescanSnapshotKey(target, result.installationId)
    const previous = await this.ctx.storage.checkpoints.get<AssetRescanSnapshot>(
      ASSET_RESCAN_CHECKPOINT_SCOPE,
      key,
    )
    const current = trackingAssets.snapshot(completedAt)
    let assetsRemoved = 0
    let statesCleared = 0

    for (const [bindingId, states] of Object.entries(previous?.bindings ?? {})) {
      if (bindingId in current.bindings) continue
      assetsRemoved += 1
      for (const state of states) {
        if (!PRESENCE_STATES.has(state)) continue
        await this.ctx.assets.recordState({
          assetBindingId: bindingId,
          state,
          value: false,
          observedAt: completedAt,
          evidenceRefs: [],
        })
        statesCleared += 1
      }
    }

    await this.ctx.storage.checkpoints.set(ASSET_RESCAN_CHECKPOINT_SCOPE, key, current)
    return {
      ...result,
      statesRecorded: result.statesRecorded + syntheticStates,
      assetsRemoved,
      statesCleared,
    }
  }

  private async run(): Promise<AgentRescanSummaryDto> {
    if (this.runtimeSignal.aborted) throw new Error('AgentLens runtime is shutting down')
    const startedAt = new Date().toISOString()
    const prepared = await prepareRegisteredSources(this.ctx, this.runtimeSignal)
    if (this.runtimeSignal.aborted) throw new Error('AgentLens runtime is shutting down')

    const results: ReconciledAssetDiscoveryResult[] = []
    const failures: AgentRescanFailureDto[] = prepared.failures.map(failureDto)
    for (const target of prepared.targets) {
      if (this.runtimeSignal.aborted) break
      if (!this.ctx.capturePolicy.isSourceEnabled(target.source.manifest.sourceId)) continue
      try {
        results.push(await this.scanTarget(target))
      } catch (error) {
        failures.push(assetFailure(target.source.manifest.sourceId, error))
      }
    }

    if (this.runtimeSignal.aborted) throw new Error('AgentLens runtime is shutting down')
    const successfulStages = prepared.targets.length + results.length
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
      assetSourcesScanned: results.length,
      assetsDiscovered: results.reduce((sum, result) => sum + result.assetsDiscovered, 0),
      assetsRemoved: results.reduce((sum, result) => sum + result.assetsRemoved, 0),
      statesRecorded: results.reduce((sum, result) => sum + result.statesRecorded, 0),
      statesCleared: results.reduce((sum, result) => sum + result.statesCleared, 0),
      failures,
    }
  }
}

export const sourceRescanInternals = {
  ASSET_RESCAN_CHECKPOINT_SCOPE,
  PRESENCE_STATES,
  TrackingAssetService,
  rescanSnapshotKey,
}
