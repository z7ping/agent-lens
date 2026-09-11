import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export type OfficialIntegrationId =
  | 'pi'
  | 'codex'
  | 'claude-code'
  | 'hermes'
  | 'opencode'

export type ToolDiscoveryRootRole = 'config' | 'data'

export interface ToolDiscoveryExecutableDescriptor {
  commands: readonly string[]
  explicitEnvVar?: string | undefined
}

export interface ToolDiscoveryPathCandidateDescriptor {
  envVar?: string | undefined
  path?: string | undefined
  append?: readonly string[] | undefined
  platforms?: readonly NodeJS.Platform[] | undefined
}

export interface ToolDiscoveryRootDescriptor {
  id: string
  role: ToolDiscoveryRootRole
  candidates: readonly ToolDiscoveryPathCandidateDescriptor[]
  marker?: string | undefined
}

export interface ToolDiscoveryDescriptor {
  executable?: ToolDiscoveryExecutableDescriptor | undefined
  roots: readonly ToolDiscoveryRootDescriptor[]
}

export interface OfficialIntegrationCatalogEntry {
  integrationId: OfficialIntegrationId
  productId: OfficialIntegrationId
  displayName: string
  defaultOrder: number
  discovery: ToolDiscoveryDescriptor
}

export interface ResolvedToolDiscoveryRoot {
  descriptorId: string
  role: ToolDiscoveryRootRole
  path: string
  marker?: string | undefined
}

export interface ResolveToolDiscoveryOptions {
  env?: Readonly<Record<string, string | undefined>> | undefined
  platform?: NodeJS.Platform | undefined
  homeDir?: string | undefined
}

function expandHomePath(path: string, homeDir: string): string {
  if (path === '~') return homeDir
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homeDir, path.slice(2))
  return path
}

export interface ResolveToolDiscoveryCandidateOptions {
  env?: Readonly<Record<string, string | undefined>> | undefined
  platform?: NodeJS.Platform | undefined
  homeDir?: string | undefined
  absoluteOnly?: boolean | undefined
}

export function resolveToolDiscoveryCandidatePath(
  candidate: ToolDiscoveryPathCandidateDescriptor,
  options: ResolveToolDiscoveryCandidateOptions = {},
): string | undefined {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const homeDir = options.homeDir ?? homedir()
  if (candidate.platforms && !candidate.platforms.includes(platform)) return undefined
  const raw = candidate.envVar
    ? env[candidate.envVar]?.trim()
    : candidate.path?.trim()
  if (!raw) return undefined
  const expanded = expandHomePath(raw, homeDir)
  const path = candidate.append?.length ? join(expanded, ...candidate.append) : expanded
  return options.absoluteOnly === false || isAbsolute(path) ? path : undefined
}

function roots(
  role: ToolDiscoveryRootRole,
  ...candidates: ToolDiscoveryPathCandidateDescriptor[]
): readonly ToolDiscoveryRootDescriptor[] {
  return [{ id: role, role, candidates }]
}

export const OFFICIAL_INTEGRATION_CATALOG: readonly OfficialIntegrationCatalogEntry[] = [
  {
    integrationId: 'pi',
    productId: 'pi',
    displayName: 'Pi',
    defaultOrder: 10,
    discovery: {
      executable: { commands: ['pi'], explicitEnvVar: 'PI_BIN' },
      roots: [
        ...roots('config',
          { envVar: 'PI_CODING_AGENT_DIR' },
          { envVar: 'PI_HOME', append: ['agent'] },
          { path: '~/.pi/agent' },
        ),
        ...roots('data',
          { envVar: 'PI_CODING_AGENT_SESSION_DIR' },
          { envVar: 'PI_CODING_AGENT_DIR', append: ['sessions'] },
          { envVar: 'PI_HOME', append: ['agent', 'sessions'] },
          { path: '~/.pi/agent/sessions' },
        ),
      ],
    },
  },
  {
    integrationId: 'codex',
    productId: 'codex',
    displayName: 'Codex',
    defaultOrder: 20,
    discovery: {
      executable: { commands: ['codex'], explicitEnvVar: 'CODEX_BIN' },
      roots: [
        ...roots('config',
          { envVar: 'CODEX_HOME' },
          { path: '~/.codex' },
        ),
        ...roots('data',
          { envVar: 'CODEX_HOME', append: ['sessions'] },
          { path: '~/.codex/sessions' },
        ),
      ],
    },
  },
  {
    integrationId: 'claude-code',
    productId: 'claude-code',
    displayName: 'Claude Code',
    defaultOrder: 30,
    discovery: {
      executable: { commands: ['claude'], explicitEnvVar: 'CLAUDE_BIN' },
      roots: [
        ...roots('config',
          { envVar: 'CLAUDE_CODE_HOME' },
          { envVar: 'CLAUDE_HOME' },
          { path: '~/.claude' },
        ),
        ...roots('data',
          { envVar: 'CLAUDE_CODE_HOME', append: ['projects'] },
          { envVar: 'CLAUDE_HOME', append: ['projects'] },
          { path: '~/.claude/projects' },
        ),
      ],
    },
  },
  {
    integrationId: 'hermes',
    productId: 'hermes',
    displayName: 'Hermes',
    defaultOrder: 40,
    discovery: {
      executable: { commands: ['hermes'] },
      roots: [
        {
          id: 'config',
          role: 'config',
          candidates: [
            { path: '~/.hermes' },
          ],
        },
        {
          id: 'data',
          role: 'data',
          marker: 'state.db',
          candidates: [
            { envVar: 'HERMES_HOME' },
            { envVar: 'LOCALAPPDATA', append: ['hermes'], platforms: ['win32'] },
            { path: '~/AppData/Local/hermes', platforms: ['win32'] },
            { path: '~/.hermes' },
          ],
        },
      ],
    },
  },
  {
    integrationId: 'opencode',
    productId: 'opencode',
    displayName: 'OpenCode',
    defaultOrder: 50,
    discovery: {
      executable: { commands: ['opencode', 'opencode2'] },
      roots: [
        {
          id: 'data',
          role: 'data',
          marker: 'opencode.db',
          candidates: [
            { envVar: 'OPENCODE_HOME' },
            { envVar: 'APPDATA', append: ['opencode'], platforms: ['win32'] },
            { path: '~/AppData/Roaming/opencode', platforms: ['win32'] },
            { envVar: 'XDG_DATA_HOME', append: ['opencode'], platforms: ['linux', 'darwin', 'freebsd', 'openbsd', 'aix', 'sunos'] },
            { path: '~/.local/share/opencode' },
          ],
        },
      ],
    },
  },
] as const

const catalogById = new Map(
  OFFICIAL_INTEGRATION_CATALOG.map(entry => [entry.integrationId, entry]),
)

export function officialIntegrationCatalogEntry(
  integrationId: string,
): OfficialIntegrationCatalogEntry | undefined {
  return catalogById.get(integrationId as OfficialIntegrationId)
}

export function resolveToolDiscoveryRoots(
  integration: OfficialIntegrationCatalogEntry | OfficialIntegrationId,
  options: ResolveToolDiscoveryOptions = {},
): ResolvedToolDiscoveryRoot[] {
  const entry = typeof integration === 'string'
    ? officialIntegrationCatalogEntry(integration)
    : integration
  if (!entry) return []

  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const homeDir = options.homeDir ?? homedir()
  const result: ResolvedToolDiscoveryRoot[] = []
  const seen = new Set<string>()

  for (const root of entry.discovery.roots) {
    for (const candidate of root.candidates) {
      const path = resolveToolDiscoveryCandidatePath(candidate, {
        env,
        platform,
        homeDir,
        absoluteOnly: true,
      })
      if (!path) continue
      const key = `${root.role}\u0000${path}`
      if (seen.has(key)) continue
      seen.add(key)
      result.push({
        descriptorId: root.id,
        role: root.role,
        path,
        ...(root.marker ? { marker: root.marker } : {}),
      })
    }
  }
  return result
}
