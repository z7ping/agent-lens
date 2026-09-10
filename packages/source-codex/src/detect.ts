import { access } from 'node:fs/promises'
import type { DetectedSource, SourceDetectionContext } from '@agent-lens/core'
import {
  resolveCodexLocation,
  resolveExecutable,
} from '@agent-lens/runtime-cordis'

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function detectCodex(ctx: SourceDetectionContext): Promise<DetectedSource[]> {
  const env = ctx.env ?? process.env
  const location = resolveCodexLocation(env)
  const [homeExists, sessionsExist, executable] = await Promise.all([
    exists(location.configRoot),
    exists(location.dataRoot),
    resolveExecutable('codex', {
      explicit: env.CODEX_BIN,
      pathValue: env.PATH ?? process.env.PATH,
    }),
  ])

  if (!homeExists && !sessionsExist && !executable) return []

  return [{
    sourceId: 'codex',
    productId: 'codex',
    ...(executable ? { executable } : {}),
    configRoot: location.configRoot,
    dataRoot: location.dataRoot,
    confidence: executable && sessionsExist ? 'exact' : 'high',
  }]
}

export function codexHomeFromInstallation(configRoot?: string): string {
  return configRoot?.trim() || resolveCodexLocation().configRoot
}
