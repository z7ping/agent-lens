import { createHash } from 'node:crypto'
import { access, opendir, readFile, readdir, stat } from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'
import { parse as parseYaml } from 'yaml'
import type {
  DiscoveredAsset,
  EvidenceCandidate,
  SourceExecutionContext,
} from '@agent-lens/core'
import { isMissingPathError } from '@agent-lens/source-support'

export const HERMES_KNOWN_PROJECT_CWDS_CHECKPOINT_KEY = 'hermes:known-project-cwds:v1'

const PROJECT_HERMES_FILES = ['.hermes.md', 'HERMES.md'] as const
const PROJECT_AGENTS_FILES = ['AGENTS.override.md', 'AGENTS.md', 'agents.md'] as const
const PROJECT_CLAUDE_FILES = ['CLAUDE.md', 'claude.md'] as const
const MEMORY_FILES = ['MEMORY.md', 'USER.md'] as const

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)
}

export function boolLike(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true
    if (['false', '0', 'no', 'off'].includes(normalized)) return false
  }
  return fallback
}

export function parseHermesConfig(text: string): Record<string, unknown> {
  return asRecord(parseYaml(text))
}

async function safeStat(path: string) {
  try {
    return await stat(path)
  } catch (error) {
    if (isMissingPathError(error)) return null
    throw error
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    if (isMissingPathError(error)) return false
    throw error
  }
}

async function readNonEmpty(path: string): Promise<string | undefined> {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    if (isMissingPathError(error)) return undefined
    throw error
  }
  const trimmed = content.replace(/^\uFEFF/, '').trim()
  return trimmed || undefined
}

function assetEvidence(
  path: string,
  observedAt: string,
  capturedAt: string,
): EvidenceCandidate[] {
  return [{
    captureMethod: 'static-scan',
    derivation: 'observed',
    sourceLocator: { kind: 'file', path },
    eventTime: observedAt,
    capturedAt,
    confidenceHint: 'exact',
  }]
}

function stateList(
  path: string,
  observedAt: string,
  capturedAt: string,
  states: Array<{
    state: 'installed' | 'configured' | 'enabled' | 'discoverable'
    value: boolean | 'unknown'
  }>,
): NonNullable<DiscoveredAsset['states']> {
  const evidenceCandidates = assetEvidence(path, observedAt, capturedAt)
  return states.map(item => ({
    ...item,
    observedAt,
    ...(item.value === 'unknown' ? {} : { evidenceCandidates }),
  }))
}

async function* walkSkillFiles(root: string): AsyncIterable<string> {
  let dir
  try {
    dir = await opendir(root)
  } catch (error) {
    if (isMissingPathError(error)) return
    throw error
  }

  for await (const entry of dir) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) yield* walkSkillFiles(path)
    else if (entry.isFile() && entry.name === 'SKILL.md') yield path
  }
}

async function* discoverSkillAssets(
  profileRoot: string,
  capturedAt: string,
): AsyncIterable<DiscoveredAsset> {
  const skillsRoot = join(profileRoot, 'skills')
  for await (const skillFile of walkSkillFiles(skillsRoot)) {
    const meta = await safeStat(skillFile)
    if (!meta?.isFile()) continue

    const skillDir = dirname(skillFile)
    const relativeName = relative(skillsRoot, skillDir).replaceAll('\\', '/')
    const canonicalName = relativeName.split('/').filter(Boolean).join(':') || basename(skillDir)
    const observedAt = meta.mtime.toISOString()

    yield {
      definition: {
        type: 'skill',
        canonicalName,
        displayName: basename(skillDir),
      },
      binding: {
        path: skillDir,
        source: 'hermes:skills',
        scope: 'user',
        scopeRoot: profileRoot,
      },
      states: stateList(skillFile, observedAt, capturedAt, [
        { state: 'installed', value: true },
        { state: 'discoverable', value: 'unknown' },
      ]),
    }
  }
}

async function* discoverMemoryAssets(
  profileRoot: string,
  capturedAt: string,
): AsyncIterable<DiscoveredAsset> {
  const memoriesRoot = join(profileRoot, 'memories')
  for (const fileName of MEMORY_FILES) {
    const path = join(memoriesRoot, fileName)
    const meta = await safeStat(path)
    if (!meta?.isFile()) continue
    const observedAt = meta.mtime.toISOString()

    yield {
      definition: {
        type: 'memory',
        canonicalName: `hermes:${fileName.toLowerCase()}`,
        displayName: fileName,
      },
      binding: {
        path,
        source: 'hermes:memories',
        scope: 'user',
        scopeRoot: profileRoot,
      },
      states: stateList(path, observedAt, capturedAt, [
        { state: 'installed', value: true },
        { state: 'configured', value: true },
        { state: 'discoverable', value: true },
      ]),
    }
  }
}

async function discoverSoulAsset(
  profileRoot: string,
  capturedAt: string,
): Promise<DiscoveredAsset | undefined> {
  const path = join(profileRoot, 'SOUL.md')
  const meta = await safeStat(path)
  if (!meta?.isFile() || !await readNonEmpty(path)) return undefined
  const observedAt = meta.mtime.toISOString()

  return {
    definition: {
      type: 'context',
      canonicalName: 'hermes-soul',
      displayName: 'SOUL.md',
    },
    binding: {
      path,
      source: 'hermes:soul',
      scope: 'user',
      scopeRoot: profileRoot,
    },
    states: stateList(path, observedAt, capturedAt, [
      { state: 'configured', value: true },
      { state: 'discoverable', value: true },
    ]),
  }
}

interface HermesPluginConfig {
  enabled?: Set<string>
  disabled: Set<string>
}

function pluginConfig(config: Record<string, unknown>): HermesPluginConfig {
  const plugins = asRecord(config.plugins)
  const enabledValues = stringList(plugins.enabled)
  return {
    ...(enabledValues === undefined ? {} : { enabled: new Set(enabledValues) }),
    disabled: new Set(stringList(plugins.disabled) ?? []),
  }
}

function pluginEnabledState(
  id: string,
  config: HermesPluginConfig,
): boolean | 'unknown' {
  if (config.disabled.has(id)) return false
  if (config.enabled === undefined) return 'unknown'
  return config.enabled.has(id)
}

async function readPluginManifest(
  pluginRoot: string,
): Promise<{ id: string; displayName: string; version?: string } | undefined> {
  const manifestPath = join(pluginRoot, 'plugin.yaml')
  const entryPath = join(pluginRoot, '__init__.py')
  const [manifestMeta, entryMeta] = await Promise.all([
    safeStat(manifestPath),
    safeStat(entryPath),
  ])
  if (!manifestMeta?.isFile() || !entryMeta?.isFile()) return undefined

  let parsed: Record<string, unknown> = {}
  try {
    parsed = parseHermesConfig(await readFile(manifestPath, 'utf8'))
  } catch {
    return undefined
  }
  const fallback = basename(pluginRoot)
  const name = typeof parsed.name === 'string' && parsed.name.trim()
    ? parsed.name.trim()
    : fallback
  const key = typeof parsed.key === 'string' && parsed.key.trim()
    ? parsed.key.trim()
    : name
  const version = typeof parsed.version === 'string' && parsed.version.trim()
    ? parsed.version.trim()
    : undefined
  return {
    id: key,
    displayName: name,
    ...(version ? { version } : {}),
  }
}

async function* discoverUserPluginAssets(
  profileRoot: string,
  config: HermesPluginConfig,
  capturedAt: string,
): AsyncIterable<DiscoveredAsset> {
  const pluginsRoot = join(profileRoot, 'plugins')
  let entries
  try {
    entries = await readdir(pluginsRoot, { withFileTypes: true })
  } catch (error) {
    if (isMissingPathError(error)) return
    throw error
  }

  const installed = new Set<string>()
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const pluginRoot = join(pluginsRoot, entry.name)
    const manifest = await readPluginManifest(pluginRoot)
    if (!manifest) continue
    installed.add(manifest.id)

    const manifestPath = join(pluginRoot, 'plugin.yaml')
    const meta = await safeStat(manifestPath)
    if (!meta?.isFile()) continue
    const observedAt = meta.mtime.toISOString()
    const enabled = pluginEnabledState(manifest.id, config)
    const configured = config.disabled.has(manifest.id)
      || config.enabled?.has(manifest.id) === true

    yield {
      definition: {
        type: 'plugin',
        canonicalName: manifest.id,
        displayName: manifest.displayName,
        upstreamIdentity: manifest.id,
      },
      binding: {
        path: pluginRoot,
        source: 'hermes:user-plugin',
        scope: 'user',
        scopeRoot: profileRoot,
        ...(manifest.version ? { version: manifest.version } : {}),
      },
      states: stateList(manifestPath, observedAt, capturedAt, [
        { state: 'installed', value: true },
        ...(configured ? [{ state: 'configured' as const, value: true as const }] : []),
        { state: 'enabled', value: enabled },
      ]),
    }
  }

  const configPath = join(profileRoot, 'config.yaml')
  const configMeta = await safeStat(configPath)
  if (!configMeta?.isFile()) return
  const observedAt = configMeta.mtime.toISOString()
  const configuredIds = new Set([
    ...(config.enabled ? [...config.enabled] : []),
    ...config.disabled,
  ])
  for (const id of configuredIds) {
    if (installed.has(id)) continue
    yield {
      definition: {
        type: 'plugin',
        canonicalName: id,
        displayName: id,
        upstreamIdentity: id,
      },
      binding: {
        path: configPath,
        source: 'hermes:config:plugin',
        scope: 'user',
        scopeRoot: profileRoot,
      },
      states: stateList(configPath, observedAt, capturedAt, [
        { state: 'configured', value: true },
        { state: 'installed', value: 'unknown' },
        { state: 'enabled', value: pluginEnabledState(id, config) },
      ]),
    }
  }
}

async function* discoverConfigAssets(
  profileRoot: string,
  config: Record<string, unknown>,
  capturedAt: string,
): AsyncIterable<DiscoveredAsset> {
  const configPath = join(profileRoot, 'config.yaml')
  const meta = await safeStat(configPath)
  if (!meta?.isFile()) return

  const observedAt = meta.mtime.toISOString()
  const mcpServers = asRecord(config.mcp_servers)
  for (const [name, rawConfig] of Object.entries(mcpServers)) {
    const server = asRecord(rawConfig)
    const enabled = boolLike(server.enabled, true)
    yield {
      definition: { type: 'mcp', canonicalName: name, displayName: name },
      binding: {
        path: configPath,
        source: 'hermes:config:mcp',
        scope: 'user',
        scopeRoot: profileRoot,
      },
      states: stateList(configPath, observedAt, capturedAt, [
        { state: 'configured', value: true },
        { state: 'enabled', value: enabled },
        { state: 'discoverable', value: enabled ? 'unknown' : false },
      ]),
    }
  }

  for (const section of ['toolsets', 'platform_toolsets']) {
    const values = config[section]
    const names = Array.isArray(values)
      ? values
        .filter((item): item is string => typeof item === 'string')
        .map(item => item.trim())
        .filter(Boolean)
      : Object.keys(asRecord(values))
    for (const name of names) {
      yield {
        definition: { type: 'builtin', canonicalName: name, displayName: name },
        binding: {
          path: configPath,
          source: `hermes:config:${section}`,
          scope: 'user',
          scopeRoot: profileRoot,
        },
        states: stateList(configPath, observedAt, capturedAt, [
          { state: 'configured', value: true },
        ]),
      }
    }
  }
}

function pathKey(value: string): string {
  const normalized = resolve(value).replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

async function existingProjectCwds(values: readonly string[]): Promise<string[]> {
  const result = new Map<string, string>()
  for (const value of values) {
    const raw = value.trim()
    if (!raw || !isAbsolute(raw)) continue
    const cwd = resolve(raw)
    const meta = await safeStat(cwd)
    if (!meta?.isDirectory()) continue
    const key = pathKey(cwd)
    if (!result.has(key)) result.set(key, cwd)
  }
  return [...result.values()]
}

async function findGitRoot(cwd: string): Promise<string | undefined> {
  let current = resolve(cwd)
  while (true) {
    if (await pathExists(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

function directoryChain(projectRoot: string, cwd: string): string[] {
  const root = resolve(projectRoot)
  let current = resolve(cwd)
  const result: string[] = []
  while (true) {
    result.push(current)
    if (pathKey(current) === pathKey(root)) return result.reverse()
    const parent = dirname(current)
    if (parent === current) return [resolve(cwd)]
    current = parent
  }
}

async function nearestHermesContextFile(
  cwd: string,
  projectRoot: string,
): Promise<string | undefined> {
  let current = resolve(cwd)
  while (true) {
    for (const name of PROJECT_HERMES_FILES) {
      const candidate = join(current, name)
      if ((await safeStat(candidate))?.isFile()) return candidate
    }
    if (pathKey(current) === pathKey(projectRoot)) return undefined
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

async function contextAsset(
  path: string,
  projectRoot: string,
  source: string,
  capturedAt: string,
): Promise<DiscoveredAsset | undefined> {
  const content = await readNonEmpty(path)
  if (!content) return undefined
  const meta = await safeStat(path)
  if (!meta?.isFile()) return undefined
  const observedAt = meta.mtime.toISOString()
  return {
    definition: {
      type: 'context',
      canonicalName: basename(path),
      displayName: basename(path),
      upstreamIdentity: `hermes-project-context:${sha256(pathKey(path))}`,
    },
    binding: {
      path,
      source,
      scope: 'project',
      scopeRoot: projectRoot,
    },
    states: stateList(path, observedAt, capturedAt, [
      { state: 'configured', value: true },
      { state: 'discoverable', value: true },
    ]),
  }
}

async function projectContextAssets(
  cwd: string,
  capturedAt: string,
): Promise<DiscoveredAsset[]> {
  const gitRoot = await findGitRoot(cwd)
  const projectRoot = gitRoot ?? resolve(cwd)

  const hermesPath = await nearestHermesContextFile(cwd, projectRoot)
  if (hermesPath) {
    const asset = await contextAsset(
      hermesPath,
      projectRoot,
      'hermes:project-context:hermes',
      capturedAt,
    )
    if (asset) return [asset]
    // Hermes treats an empty .hermes.md / HERMES.md as absent and falls through.
  }

  const agents: DiscoveredAsset[] = []
  const seenContents = new Set<string>()
  for (const directory of directoryChain(projectRoot, cwd)) {
    for (const name of PROJECT_AGENTS_FILES) {
      const path = join(directory, name)
      const content = await readNonEmpty(path)
      if (!content) continue
      if (!seenContents.has(content)) {
        seenContents.add(content)
        const asset = await contextAsset(
          path,
          projectRoot,
          'hermes:project-context:agents',
          capturedAt,
        )
        if (asset) agents.push(asset)
      }
      break
    }
  }
  if (agents.length) return agents

  for (const name of PROJECT_CLAUDE_FILES) {
    const path = join(cwd, name)
    const asset = await contextAsset(
      path,
      projectRoot,
      'hermes:project-context:claude',
      capturedAt,
    )
    if (asset) return [asset]
  }

  const cursorAssets: DiscoveredAsset[] = []
  const cursorRule = await contextAsset(
    join(cwd, '.cursorrules'),
    projectRoot,
    'hermes:project-context:cursor',
    capturedAt,
  )
  if (cursorRule) cursorAssets.push(cursorRule)

  const cursorDir = join(cwd, '.cursor', 'rules')
  let cursorEntries
  try {
    cursorEntries = await readdir(cursorDir, { withFileTypes: true })
  } catch (error) {
    if (!isMissingPathError(error)) throw error
    cursorEntries = []
  }
  for (const entry of cursorEntries
    .filter(entry => entry.isFile() && entry.name.endsWith('.mdc'))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const asset = await contextAsset(
      join(cursorDir, entry.name),
      projectRoot,
      'hermes:project-context:cursor',
      capturedAt,
    )
    if (asset) cursorAssets.push(asset)
  }
  return cursorAssets
}

async function readProfileConfig(profileRoot: string): Promise<Record<string, unknown>> {
  try {
    return parseHermesConfig(await readFile(join(profileRoot, 'config.yaml'), 'utf8'))
  } catch (error) {
    if (isMissingPathError(error)) return {}
    throw error
  }
}

export async function* discoverHermesAssets(
  ctx: SourceExecutionContext,
): AsyncIterable<DiscoveredAsset> {
  const profileRoot = ctx.installation.configRoot
  if (!profileRoot || ctx.abortSignal.aborted) return
  const capturedAt = new Date().toISOString()
  const config = await readProfileConfig(profileRoot)
  const plugins = pluginConfig(config)

  for (const group of [
    discoverSkillAssets(profileRoot, capturedAt),
    discoverMemoryAssets(profileRoot, capturedAt),
    discoverUserPluginAssets(profileRoot, plugins, capturedAt),
    discoverConfigAssets(profileRoot, config, capturedAt),
  ]) {
    for await (const asset of group) {
      if (ctx.abortSignal.aborted) return
      yield asset
    }
  }

  const soul = await discoverSoulAsset(profileRoot, capturedAt)
  if (soul) yield soul

  const remembered = await ctx.checkpoint.get<string[]>(HERMES_KNOWN_PROJECT_CWDS_CHECKPOINT_KEY)
  const projectCwds = remembered?.length ? await existingProjectCwds(remembered) : []
  const seenProjectAssets = new Set<string>()
  for (const cwd of projectCwds) {
    if (ctx.abortSignal.aborted) return
    for (const asset of await projectContextAssets(cwd, capturedAt)) {
      const path = asset.binding?.path
      const key = path ? pathKey(path) : `${asset.definition.canonicalName}:${cwd}`
      if (seenProjectAssets.has(key)) continue
      seenProjectAssets.add(key)
      yield asset
    }
  }
}

export const hermesAssetInternals = {
  boolLike,
  directoryChain,
  existingProjectCwds,
  findGitRoot,
  nearestHermesContextFile,
  parseHermesConfig,
  pluginEnabledState,
  projectContextAssets,
  readPluginManifest,
}
