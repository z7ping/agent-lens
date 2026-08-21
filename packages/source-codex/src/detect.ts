import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { DetectedSource, SourceDetectionContext } from '@agent-lens/core'

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

async function findExecutable(env: Readonly<Record<string, string | undefined>>): Promise<string | undefined> {
  const explicit = env.CODEX_BIN?.trim()
  if (explicit && await exists(explicit)) return explicit

  const pathValue = env.PATH ?? process.env.PATH ?? ''
  const names = process.platform === 'win32'
    ? ['codex.exe', 'codex.cmd', 'codex.bat']
    : ['codex']
  for (const root of pathValue.split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(root, name)
      if (await exists(candidate)) return candidate
    }
  }
  return undefined
}

export async function detectCodex(ctx: SourceDetectionContext): Promise<DetectedSource[]> {
  const env = ctx.env ?? process.env
  const home = resolveHome(env)
  const sessionsDir = join(home, 'sessions')
  const [homeExists, sessionsExist, executable] = await Promise.all([
    exists(home),
    exists(sessionsDir),
    findExecutable(env),
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
