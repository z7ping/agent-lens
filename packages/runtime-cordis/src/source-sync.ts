import { arch, hostname, platform } from 'node:os'
import { SourceHistoryRunner, type SourceHistorySyncResult } from '@agent-lens/core-services/source-runner'
import type { AgentLensContext } from './context'

export async function syncRegisteredSourceHistory(
  ctx: AgentLensContext,
  abortSignal: AbortSignal,
): Promise<SourceHistorySyncResult[]> {
  const host = await ctx.identity.resolveHost({
    name: hostname(),
    platform: platform(),
    arch: arch(),
  })
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
    results.push(await runner.sync({
      source,
      host,
      detected: item,
      abortSignal,
    }))
  }

  return results
}
