import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ResolvedSourceLocation {
  configRoot: string
  dataRoot: string
  explicit: boolean
}

type SourceEnvironment = Readonly<Record<string, string | undefined>>

function value(env: SourceEnvironment, name: string): string | undefined {
  const resolved = env[name]?.trim()
  return resolved || undefined
}

function expandHomePath(path: string, homeDir: string): string {
  if (path === '~') return homeDir
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homeDir, path.slice(2))
  return path
}

export function resolveCodexLocation(
  env: SourceEnvironment = process.env,
  homeDir = homedir(),
): ResolvedSourceLocation {
  const configured = value(env, 'CODEX_HOME')
  const configRoot = configured ? expandHomePath(configured, homeDir) : join(homeDir, '.codex')
  return {
    configRoot,
    dataRoot: join(configRoot, 'sessions'),
    explicit: Boolean(configured),
  }
}

export function resolveClaudeLocation(
  env: SourceEnvironment = process.env,
  homeDir = homedir(),
): ResolvedSourceLocation {
  const configured = value(env, 'CLAUDE_CODE_HOME') ?? value(env, 'CLAUDE_HOME')
  const configRoot = configured ? expandHomePath(configured, homeDir) : join(homeDir, '.claude')
  return {
    configRoot,
    dataRoot: join(configRoot, 'projects'),
    explicit: Boolean(configured),
  }
}

export function resolvePiLocation(
  env: SourceEnvironment = process.env,
  homeDir = homedir(),
): ResolvedSourceLocation {
  const configuredAgentDir = value(env, 'PI_CODING_AGENT_DIR')
  const configuredPiHome = value(env, 'PI_HOME')
  const configRoot = configuredAgentDir
    ? expandHomePath(configuredAgentDir, homeDir)
    : join(configuredPiHome ? expandHomePath(configuredPiHome, homeDir) : join(homeDir, '.pi'), 'agent')
  const configuredSessionDir = value(env, 'PI_CODING_AGENT_SESSION_DIR')
  return {
    configRoot,
    dataRoot: configuredSessionDir
      ? expandHomePath(configuredSessionDir, homeDir)
      : join(configRoot, 'sessions'),
    explicit: Boolean(configuredAgentDir || configuredPiHome || configuredSessionDir),
  }
}

export function resolveHermesRoots(
  env: SourceEnvironment = process.env,
  homeDir = homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const explicit = value(env, 'HERMES_HOME')
  if (explicit) return [expandHomePath(explicit, homeDir)]
  const result: string[] = []
  if (platform === 'win32') {
    result.push(join(value(env, 'LOCALAPPDATA') ?? join(homeDir, 'AppData', 'Local'), 'hermes'))
  }
  result.push(join(homeDir, '.hermes'))
  return [...new Set(result)]
}

export function resolveHermesConfigRoots(
  env: SourceEnvironment = process.env,
  homeDir = homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  return [...new Set([
    join(homeDir, '.hermes'),
    ...resolveHermesRoots(env, homeDir, platform),
  ])]
}

export function resolveOpenCodeRoots(
  env: SourceEnvironment = process.env,
  homeDir = homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const result: string[] = []
  const add = (path: string | undefined) => {
    const normalized = path?.trim()
    if (normalized && !result.includes(normalized)) result.push(normalized)
  }

  add(value(env, 'OPENCODE_HOME'))
  if (platform === 'win32') {
    add(join(value(env, 'APPDATA') ?? join(homeDir, 'AppData', 'Roaming'), 'opencode'))
  } else {
    add(join(value(env, 'XDG_DATA_HOME') ?? join(homeDir, '.local', 'share'), 'opencode'))
  }
  add(join(homeDir, '.local', 'share', 'opencode'))
  return result
}

export const sourceLocationInternals = {
  value,
  expandHomePath,
}
