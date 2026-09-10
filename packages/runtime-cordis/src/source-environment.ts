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
  // Claude Code Source 的正式入口优先；CLAUDE_HOME 仅作为 AgentLens 既有 CLI
  // 兼容入口保留。兼容优先级集中在这里，不让各调用方分别解释。
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
