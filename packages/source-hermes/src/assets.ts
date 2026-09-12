import { opendir, readFile, readdir, stat } from 'node:fs/promises'
import {
  basename,
  dirname,
  join,
  relative,
} from 'node:path'
import { parse as parseYaml } from 'yaml'
import type {
  DiscoveredAsset,
  EvidenceCandidate,
  SourceExecutionContext,
} from '@agent-lens/core'
import { isMissingPathError } from '@agent-lens/source-support'
import {
  discoverHermesProjectContextAssets,
  hermesProjectContextInternals,
} from './project-context.js'

const PROJECT_HERMES_FILES = ['.hermes.md', 'HERMES.md'] as const
const PROJECT_AGENTS_FILES = ['AGENTS.override.md', 'AGENTS.md', 'agents.md'] as const
const PROJECT_CLAUDE_FILES = ['CLAUDE.md', 'claude.md'] as const
const MEMORY_FILES = ['MEMORY.md', 'USER.md'] as const

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
        { state: 'discoverable', value: 'unknown' },
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
      { state: 'discoverable', value: 'unknown' },
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

async function readProfileConfig(profileRoot: string): Promise<Record<string, unknown>> {
  let content: string
  try {
    content = await readFile(join(profileRoot, 'config.yaml'), 'utf8')
  } catch (error) {
    if (isMissingPathError(error)) return {}
    throw error
  }
  try {
    return parseHermesConfig(content)
  } catch {
    // Hermes owns config validation. Independent filesystem assets remain observable
    // even when the current profile config is temporarily malformed.
    return {}
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

  for await (const asset of discoverHermesProjectContextAssets(ctx, capturedAt)) {
    if (ctx.abortSignal.aborted) return
    yield asset
  }
}

export const hermesAssetInternals = {
  boolLike,
  parseHermesConfig,
  pluginEnabledState,
  readPluginManifest,
  ...hermesProjectContextInternals,
}
