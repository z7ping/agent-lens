import { arch, hostname, platform } from 'node:os'
import {
  SourceAssetRunner,
  SourceHistoryRunner,
  SourceRuntimeRunner,
  type SourceAssetDiscoveryResult,
  type SourceHistorySyncResult,
  type SourceRuntimeCaptureHandle,
} from '@agent-lens/core-services/source-runner'
import type { AgentLensContext } from './context'

async function runtimeHost(ctx: AgentLensContext) {
  return ctx.identity.resolveHost({
    name: hostname(),
    platform: platform(),
    arch: arch(),
  })
}

function emitDetected(ctx: AgentLensContext, sourceId: string, installationId: string): void {
  ctx.emit('source/detected', { sourceId, installationId })
}

export async function syncRegisteredSourceHistory(
  ctx: AgentLensContext,
  abortSignal: AbortSignal,
): Promise<SourceHistorySyncResult[]> {
  const host = await runtimeHost(ctx)
  const detected = await ctx.sources.detect({
    host,
    env: process.env,
  })
  const definitions = new Map(
    ctx.sources.list().map(source => [source.manifest.sourceId, source]),
  )
  const runner = new SourceHistoryRunner(
    ctx.storage,
    ctx.identity,
    ctx.observations,
    ctx.capabilities,
    ctx.coverage,
  )
  const results: SourceHistorySyncResult[] = []

  for (const item of detected) {
    if (abortSignal.aborted) break
    const source = definitions.get(item.sourceId)
    if (!source) {
      throw new Error(`Detected source has no registered definition: ${item.sourceId}`)
    }
    const result = await runner.sync({
      source,
      host,
      detected: item,
      abortSignal,
    })
    results.push(result)
    emitDetected(ctx, result.sourceId, result.installationId)
  }

  return results
}

export async function discoverRegisteredSourceAssets(
  ctx: AgentLensContext,
  abortSignal: AbortSignal,
): Promise<SourceAssetDiscoveryResult[]> {
  const host = await runtimeHost(ctx)
  const detected = await ctx.sources.detect({
    host,
    env: process.env,
  })
  const definitions = new Map(
    ctx.sources.list().map(source => [source.manifest.sourceId, source]),
  )
  const runner = new SourceAssetRunner(
    ctx.storage,
    ctx.identity,
    ctx.capabilities,
    ctx.assets,
    ctx.evidence,
  )
  const results: SourceAssetDiscoveryResult[] = []

  for (const item of detected) {
    if (abortSignal.aborted) break
    const source = definitions.get(item.sourceId)
    if (!source) {
      throw new Error(`Detected source has no registered definition: ${item.sourceId}`)
    }
    if (!source.discoverAssets) continue
    const result = await runner.scan({
      source,
      host,
      detected: item,
      abortSignal,
    })
    results.push(result)
    emitDetected(ctx, result.sourceId, result.installationId)
  }

  return results
}

export async function startRegisteredSourceCapture(
  ctx: AgentLensContext,
  abortSignal: AbortSignal,
): Promise<SourceRuntimeCaptureHandle[]> {
  const host = await runtimeHost(ctx)
  const detected = await ctx.sources.detect({
    host,
    env: process.env,
  })
  const definitions = new Map(
    ctx.sources.list().map(source => [source.manifest.sourceId, source]),
  )
  const runner = new SourceRuntimeRunner(
    ctx.storage,
    ctx.identity,
    ctx.observations,
    ctx.capabilities,
    ctx.coverage,
  )
  const handles: SourceRuntimeCaptureHandle[] = []

  try {
    for (const item of detected) {
      if (abortSignal.aborted) break
      const source = definitions.get(item.sourceId)
      if (!source) {
        throw new Error(`Detected source has no registered definition: ${item.sourceId}`)
      }
      if (!source.startCapture) continue
      const handle = await runner.start({
        source,
        host,
        detected: item,
        abortSignal,
      })
      handles.push(handle)
      emitDetected(ctx, handle.sourceId, handle.installationId)
    }
    return handles
  } catch (error) {
    for (const handle of handles.reverse()) {
      await handle.dispose().catch(() => undefined)
    }
    throw error
  }
}
