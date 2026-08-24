import { arch, hostname, platform } from 'node:os'
import {
  SourceAssetRunner,
  SourceHistoryRunner,
  SourceRuntimeRunner,
  type SourceAssetDiscoveryResult,
  type SourceHistorySyncResult,
  type SourceRuntimeCaptureHandle,
} from '@agent-lens/core-services/source-runner'
import type { DetectedSource, Host, SourceDefinition } from '@agent-lens/core'
import type { AgentLensContext } from './context'

export type RegisteredSourceStage = 'detect' | 'history' | 'assets' | 'capture'

export interface RegisteredSourceTarget {
  source: SourceDefinition
  host: Host
  detected: DetectedSource
}

export interface RegisteredSourceFailure {
  sourceId: string
  stage: RegisteredSourceStage
  error: unknown
}

export interface RegisteredSourcePreparation {
  targets: RegisteredSourceTarget[]
  failures: RegisteredSourceFailure[]
}

export interface RegisteredSourceStageResult<T> {
  results: T[]
  failures: RegisteredSourceFailure[]
}

async function runtimeHost(ctx: AgentLensContext): Promise<Host> {
  return ctx.identity.resolveHost({
    name: hostname(),
    platform: platform(),
    arch: arch(),
  })
}

function emitDetected(ctx: AgentLensContext, sourceId: string, installationId: string): void {
  ctx.emit('source/detected', { sourceId, installationId })
}

async function registerDetectedSource(
  ctx: AgentLensContext,
  host: Host,
  detected: DetectedSource,
): Promise<void> {
  const installation = await ctx.identity.resolveInstallation({
    hostId: host.id,
    productId: detected.productId,
    ...(detected.executable ? { executable: detected.executable } : {}),
    ...(detected.version ? { version: detected.version } : {}),
    ...(detected.configRoot ? { configRoot: detected.configRoot } : {}),
    ...(detected.dataRoot ? { dataRoot: detected.dataRoot } : {}),
  })
  emitDetected(ctx, detected.sourceId, installation.id)
}

export async function prepareRegisteredSources(
  ctx: AgentLensContext,
  abortSignal: AbortSignal,
): Promise<RegisteredSourcePreparation> {
  const host = await runtimeHost(ctx)
  const batches = await Promise.all(ctx.sources.list().map(async source => {
    if (abortSignal.aborted) {
      return { targets: [], failures: [] } satisfies RegisteredSourcePreparation
    }
    try {
      const detected = await source.detect({ host, env: process.env })
      const targets: RegisteredSourceTarget[] = []
      for (const item of detected) {
        if (item.sourceId !== source.manifest.sourceId) {
          throw new Error(
            `Source mismatch: definition=${source.manifest.sourceId}, detected=${item.sourceId}`,
          )
        }
        await registerDetectedSource(ctx, host, item)
        targets.push({ source, host, detected: item })
      }
      return { targets, failures: [] } satisfies RegisteredSourcePreparation
    } catch (error) {
      return {
        targets: [],
        failures: [{ sourceId: source.manifest.sourceId, stage: 'detect', error }],
      } satisfies RegisteredSourcePreparation
    }
  }))

  return {
    targets: batches.flatMap(batch => batch.targets),
    failures: batches.flatMap(batch => batch.failures),
  }
}

export async function syncRegisteredSourceHistory(
  ctx: AgentLensContext,
  abortSignal: AbortSignal,
  targets: RegisteredSourceTarget[],
): Promise<RegisteredSourceStageResult<SourceHistorySyncResult>> {
  const runner = new SourceHistoryRunner(
    ctx.storage,
    ctx.identity,
    ctx.observations,
    ctx.capabilities,
    ctx.coverage,
    ctx.capturePolicy,
  )
  const results: SourceHistorySyncResult[] = []
  const failures: RegisteredSourceFailure[] = []

  for (const target of targets) {
    if (abortSignal.aborted) break
    try {
      results.push(await runner.sync({ ...target, abortSignal }))
    } catch (error) {
      failures.push({ sourceId: target.source.manifest.sourceId, stage: 'history', error })
    }
  }

  return { results, failures }
}

export async function discoverRegisteredSourceAssets(
  ctx: AgentLensContext,
  abortSignal: AbortSignal,
  targets: RegisteredSourceTarget[],
): Promise<RegisteredSourceStageResult<SourceAssetDiscoveryResult>> {
  const runner = new SourceAssetRunner(
    ctx.storage,
    ctx.identity,
    ctx.capabilities,
    ctx.assets,
    ctx.evidence,
    ctx.capturePolicy,
  )
  const results: SourceAssetDiscoveryResult[] = []
  const failures: RegisteredSourceFailure[] = []

  for (const target of targets) {
    if (abortSignal.aborted) break
    if (!target.source.discoverAssets) continue
    try {
      results.push(await runner.scan({ ...target, abortSignal }))
    } catch (error) {
      failures.push({ sourceId: target.source.manifest.sourceId, stage: 'assets', error })
    }
  }

  return { results, failures }
}

export async function startRegisteredSourceCapture(
  ctx: AgentLensContext,
  abortSignal: AbortSignal,
  targets: RegisteredSourceTarget[],
): Promise<RegisteredSourceStageResult<SourceRuntimeCaptureHandle>> {
  const runner = new SourceRuntimeRunner(
    ctx.storage,
    ctx.identity,
    ctx.observations,
    ctx.capabilities,
    ctx.coverage,
    ctx.capturePolicy,
  )
  const results: SourceRuntimeCaptureHandle[] = []
  const failures: RegisteredSourceFailure[] = []

  for (const target of targets) {
    if (abortSignal.aborted) break
    if (!target.source.startCapture) continue
    try {
      results.push(await runner.start({ ...target, abortSignal }))
    } catch (error) {
      failures.push({ sourceId: target.source.manifest.sourceId, stage: 'capture', error })
    }
  }

  return { results, failures }
}
