import { homedir } from 'node:os'
import {
  officialIntegrationCatalogEntry,
  resolveToolDiscoveryCandidatePath,
  type OfficialIntegrationId,
  type ToolDiscoveryPathCandidateDescriptor,
  type ToolDiscoveryRootRole,
} from './catalog'

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

function roleCandidates(
  integrationId: OfficialIntegrationId,
  role: ToolDiscoveryRootRole,
): readonly ToolDiscoveryPathCandidateDescriptor[] {
  const entry = officialIntegrationCatalogEntry(integrationId)
  return entry?.discovery.roots
    .filter(root => root.role === role)
    .flatMap(root => root.candidates) ?? []
}

function resolveCandidates(
  integrationId: OfficialIntegrationId,
  role: ToolDiscoveryRootRole,
  env: SourceEnvironment,
  homeDir: string,
  platform: NodeJS.Platform,
): string[] {
  const result: string[] = []
  for (const candidate of roleCandidates(integrationId, role)) {
    const path = resolveToolDiscoveryCandidatePath(candidate, {
      env,
      homeDir,
      platform,
      absoluteOnly: false,
    })
    if (path && !result.includes(path)) result.push(path)
  }
  return result
}

function firstResolved(
  integrationId: OfficialIntegrationId,
  role: ToolDiscoveryRootRole,
  env: SourceEnvironment,
  homeDir: string,
  platform = process.platform,
): string {
  const path = resolveCandidates(integrationId, role, env, homeDir, platform)[0]
  if (!path) throw new Error(`Official Integration Catalog has no ${role} root for ${integrationId}`)
  return path
}

export function resolveCodexLocation(
  env: SourceEnvironment = process.env,
  homeDir = homedir(),
): ResolvedSourceLocation {
  return {
    configRoot: firstResolved('codex', 'config', env, homeDir),
    dataRoot: firstResolved('codex', 'data', env, homeDir),
    explicit: Boolean(value(env, 'CODEX_HOME')),
  }
}

export function resolveClaudeLocation(
  env: SourceEnvironment = process.env,
  homeDir = homedir(),
): ResolvedSourceLocation {
  return {
    configRoot: firstResolved('claude-code', 'config', env, homeDir),
    dataRoot: firstResolved('claude-code', 'data', env, homeDir),
    explicit: Boolean(
      value(env, 'CLAUDE_CONFIG_DIR')
      ?? value(env, 'CLAUDE_CODE_HOME')
      ?? value(env, 'CLAUDE_HOME')
    ),
  }
}

export function resolvePiLocation(
  env: SourceEnvironment = process.env,
  homeDir = homedir(),
): ResolvedSourceLocation {
  return {
    configRoot: firstResolved('pi', 'config', env, homeDir),
    dataRoot: firstResolved('pi', 'data', env, homeDir),
    explicit: Boolean(
      value(env, 'PI_CODING_AGENT_DIR')
      || value(env, 'PI_HOME')
      || value(env, 'PI_CODING_AGENT_SESSION_DIR'),
    ),
  }
}

export function resolveHermesRoots(
  env: SourceEnvironment = process.env,
  homeDir = homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const roots = resolveCandidates('hermes', 'data', env, homeDir, platform)
  return value(env, 'HERMES_HOME') ? roots.slice(0, 1) : roots
}

export function resolveHermesConfigRoots(
  env: SourceEnvironment = process.env,
  homeDir = homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const roots = resolveCandidates('hermes', 'config', env, homeDir, platform)
  return value(env, 'HERMES_HOME') ? roots.slice(0, 1) : roots
}

export function resolveOpenCodeRoots(
  env: SourceEnvironment = process.env,
  homeDir = homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  return resolveCandidates('opencode', 'data', env, homeDir, platform)
}

export function resolveOpenCodeConfigRoots(
  env: SourceEnvironment = process.env,
  homeDir = homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  return resolveCandidates('opencode', 'config', env, homeDir, platform)
}

export const sourceLocationInternals = {
  value,
  roleCandidates,
  resolveCandidates,
}
