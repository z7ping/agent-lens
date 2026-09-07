import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DetectedSource, SourceDetectionContext } from '@agent-lens/core'
import { resolveExecutable } from '@agent-lens/runtime-cordis'

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function resolveHome(env: Readonly<Record<string, string | undefined>>): string {
  const override = env.CODEX_HOME?.trim()
  return override || join(homedir(), '.codex')
}

export async function detectCodex(ctx: SourceDetectionContext): Promise<DetectedSource[]> {
  const env = ctx.env ?? process.env
  const home = resolveHome(env)
  const sessionsDir = join(home, 'sessions')
  const [homeExists, sessionsExist, executable] = await Promise.all([
    exists(home),
    exists(sessionsDir),
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
    configRoot: home,
    dataRoot: sessionsDir,
    confidence: executable && sessionsExist ? 'exact' : 'high',
  }]
}

export function codexHomeFromInstallation(configRoot?: string): string {
  return configRoot?.trim() || join(homedir(), '.codex')
}
