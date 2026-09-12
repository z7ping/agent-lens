import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import type {
  DiscoveredAsset,
  EvidenceCandidate,
  SourceExecutionContext,
} from '@agent-lens/core'
import { asRecord, isMissingPathError } from '@agent-lens/source-support'
import {
  codexTable,
  readCodexConfig,
  type CodexTomlConfig,
} from './config'
import { discoverCodexInstructions } from './instructions'

async function safeStat(path: string) {
  try {
    return await stat(path)
  } catch (error) {
    if (isMissingPathError(error)) return null
    throw error
  }
}

async function safeEntries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (isMissingPathError(error)) return []
    throw error
  }
}

async function* walkNamedFile(
  root: string,
  fileName: string,
  depth = 0,
  maxDepth = 8,
): AsyncIterable<string> {
  if (depth > maxDepth) return
  for (const entry of await safeEntries(root)) {
    const fullPath = join(root, entry.name)
    if (entry.isDirectory()) {
      yield* walkNamedFile(fullPath, fileName, depth + 1, maxDepth)
    } else if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
      yield fullPath
    }
  }
}

function staticEvidence(
  path: string,
  observedAt: string,
  capturedAt: string,
): EvidenceCandidate {
  return {
    captureMethod: 'static-scan',
    derivation: 'observed',
    sourceLocator: { kind: 'file', path },
    eventTime: observedAt,
    capturedAt,
    confidenceHint: 'exact',
  }
}

function states(
  path: string,
  observedAt: string,
  capturedAt: string,
  values: Array<{ state: 'installed' | 'configured' | 'enabled' | 'discoverable'; value: boolean | 'unknown' }>,
): NonNullable<DiscoveredAsset['states']> {
  const evidence = staticEvidence(path, observedAt, capturedAt)
  return values.map(value => ({
    ...value,
    observedAt,
    ...(value.value === 'unknown' ? {} : { evidenceCandidates: [evidence] }),
  }))
}

async function* discoverSkills(
  configRoot: string,
  capturedAt: string,
): AsyncIterable<DiscoveredAsset> {
  const roots = [
    { root: join(configRoot, 'skills'), source: 'codex:skills' },
    { root: join(configRoot, 'plugins', 'cache'), source: 'codex:plugin-cache' },
  ]

  for (const candidate of roots) {
    for await (const skillFile of walkNamedFile(candidate.root, 'SKILL.md')) {
      const meta = await safeStat(skillFile)
      if (!meta?.isFile()) continue
      const skillDir = dirname(skillFile)
      const name = basename(skillDir)
      const observedAt = meta.mtime.toISOString()
      yield {
        definition: {
          type: 'skill',
          canonicalName: name,
          displayName: name,
        },
        binding: {
          path: skillDir,
          source: candidate.source,
          scope: 'user',
          scopeRoot: configRoot,
        },
        states: states(
          skillFile,
          observedAt,
          capturedAt,
          [
            { state: 'installed', value: true },
            { state: 'discoverable', value: 'unknown' },
          ],
        ),
      }
    }
  }
}

function mcpNamesFromConfig(config: CodexTomlConfig | null): string[] {
  const servers = codexTable(config?.mcp_servers)
  return servers ? Object.keys(servers) : []
}
async function* discoverMcpServers(
  configRoot: string,
  capturedAt: string,
  config: CodexTomlConfig | null,
): AsyncIterable<DiscoveredAsset> {
  const configPath = join(configRoot, 'config.toml')
  const meta = await safeStat(configPath)
  if (!meta?.isFile()) return

  const observedAt = meta.mtime.toISOString()

  for (const name of mcpNamesFromConfig(config)) {
    yield {
      definition: {
        type: 'mcp',
        canonicalName: name,
        displayName: name,
      },
      binding: {
        path: configPath,
        source: 'codex:config.toml',
        scope: 'user',
        scopeRoot: configRoot,
      },
      states: states(
        configPath,
        observedAt,
        capturedAt,
        [
          { state: 'configured', value: true },
          { state: 'discoverable', value: 'unknown' },
        ],
      ),
    }
  }
}

function pluginConfigEntries(config: CodexTomlConfig | null): Map<string, Record<string, unknown>> {
  const table = codexTable(config?.plugins)
  const entries = new Map<string, Record<string, unknown>>()
  if (!table) return entries
  for (const [id, value] of Object.entries(table)) {
    const plugin = codexTable(value)
    if (plugin) entries.set(id, plugin)
  }
  return entries
}

function pluginIdentityFromCachePath(cacheRoot: string, manifestPath: string): {
  configId?: string
  pluginName?: string
  version?: string
  pluginRoot?: string
} {
  const relativeManifest = relative(cacheRoot, manifestPath).replaceAll('\\', '/')
  const parts = relativeManifest.split('/').filter(Boolean)
  const manifestTail = parts.slice(3)
  const validManifest = manifestTail.length === 1 && manifestTail[0] === 'plugin.json'
    || manifestTail.length === 2
      && manifestTail[0] === '.codex-plugin'
      && manifestTail[1] === 'plugin.json'
  if (parts.length < 4 || !validManifest) return {}
  const [marketplace, pluginName, version] = parts
  if (!marketplace || !pluginName || !version) return {}
  return {
    configId: `${pluginName}@${marketplace}`,
    pluginName,
    version,
    pluginRoot: join(cacheRoot, marketplace, pluginName, version),
  }
}

async function* discoverPluginManifests(
  configRoot: string,
  capturedAt: string,
  config: CodexTomlConfig | null,
): AsyncIterable<DiscoveredAsset> {
  const cacheRoot = join(configRoot, 'plugins', 'cache')
  const configured = pluginConfigEntries(config)
  const seenConfigIds = new Set<string>()

  for await (const manifestPath of walkNamedFile(cacheRoot, 'plugin.json')) {
    const meta = await safeStat(manifestPath)
    if (!meta?.isFile()) continue
    let manifest: Record<string, unknown> = {}
    try {
      manifest = asRecord(JSON.parse(await readFile(manifestPath, 'utf8')))
    } catch (error) {
      if (!isMissingPathError(error) && !(error instanceof SyntaxError)) throw error
      // Cache layout still proves an installed plugin even when optional manifest metadata is unreadable.
    }

    const cacheIdentity = pluginIdentityFromCachePath(cacheRoot, manifestPath)
    const configId = cacheIdentity.configId
    if (!configId || !cacheIdentity.pluginRoot) continue
    const configuredPlugin = configured.get(configId)
    if (configId) seenConfigIds.add(configId)

    const name = typeof manifest.name === 'string' && manifest.name
      ? manifest.name
      : typeof manifest.id === 'string' && manifest.id
        ? manifest.id
        : cacheIdentity.pluginName ?? basename(dirname(manifestPath))
    const manifestVersion = typeof manifest.version === 'string' && manifest.version
      ? manifest.version
      : undefined
    const version = manifestVersion ?? cacheIdentity.version
    const bindingPath = cacheIdentity.pluginRoot
    const observedAt = meta.mtime.toISOString()
    const configuredEnabled = configuredPlugin?.enabled

    yield {
      definition: {
        type: 'plugin',
        canonicalName: configId ?? name,
        displayName: name,
        ...(configId ? { upstreamIdentity: configId } : {}),
      },
      binding: {
        path: bindingPath,
        source: 'codex:plugin-cache',
        scope: 'user',
        scopeRoot: configRoot,
        ...(version ? { version } : {}),
      },
      states: states(
        manifestPath,
        observedAt,
        capturedAt,
        [
          { state: 'installed', value: true },
          ...(configuredPlugin ? [{ state: 'configured' as const, value: true as const }] : []),
          ...(configuredPlugin && configuredEnabled === false
            ? [{ state: 'enabled' as const, value: false as const }]
            : configuredPlugin
              ? [{ state: 'enabled' as const, value: 'unknown' as const }]
              : []),
        ],
      ),
    }
  }

  const configPath = join(configRoot, 'config.toml')
  const configMeta = await safeStat(configPath)
  if (!configMeta?.isFile()) return
  const observedAt = configMeta.mtime.toISOString()
  for (const [configId, plugin] of configured) {
    if (seenConfigIds.has(configId)) continue
    const enabled = plugin.enabled
    yield {
      definition: {
        type: 'plugin',
        canonicalName: configId,
        displayName: configId,
        upstreamIdentity: configId,
      },
      binding: {
        path: configPath,
        source: 'codex:config.toml:plugin',
        scope: 'user',
        scopeRoot: configRoot,
      },
      states: states(
        configPath,
        observedAt,
        capturedAt,
        [
          { state: 'configured', value: true },
          { state: 'installed', value: 'unknown' },
          { state: 'enabled', value: enabled === false ? false : 'unknown' },
        ],
      ),
    }
  }
}
async function* discoverHooks(
  configRoot: string,
  capturedAt: string,
): AsyncIterable<DiscoveredAsset> {
  const hooksPath = join(configRoot, 'hooks.json')
  const meta = await safeStat(hooksPath)
  if (!meta?.isFile()) return

  let hooks: Record<string, unknown> = {}
  try {
    hooks = asRecord(JSON.parse(await readFile(hooksPath, 'utf8')))
  } catch (error) {
    if (isMissingPathError(error) || error instanceof SyntaxError) return
    throw error
  }

  const root = asRecord(hooks.hooks)
  const observedAt = meta.mtime.toISOString()
  for (const [eventName, groups] of Object.entries(root)) {
    if (!Array.isArray(groups) || groups.length === 0) continue
    yield {
      definition: {
        type: 'hook',
        canonicalName: `codex-hook:${eventName}`,
        displayName: `${eventName} Hook`,
      },
      binding: {
        path: hooksPath,
        source: 'codex:hooks.json',
        scope: 'user',
        scopeRoot: configRoot,
      },
      states: states(
        hooksPath,
        observedAt,
        capturedAt,
        [
          { state: 'configured', value: true },
          { state: 'enabled', value: 'unknown' },
        ],
      ),
    }
  }
}

export async function* discoverCodexAssets(
  ctx: SourceExecutionContext,
): AsyncIterable<DiscoveredAsset> {
  const configRoot = ctx.installation.configRoot
  if (!configRoot || ctx.abortSignal.aborted) return
  const capturedAt = new Date().toISOString()
  const config = await readCodexConfig(configRoot)

  const groups = [
    discoverSkills(configRoot, capturedAt),
    discoverMcpServers(configRoot, capturedAt, config),
    discoverPluginManifests(configRoot, capturedAt, config),
    discoverHooks(configRoot, capturedAt),
    discoverCodexInstructions(ctx, capturedAt, config),
  ]

  for (const group of groups) {
    for await (const asset of group) {
      if (ctx.abortSignal.aborted) return
      yield asset
    }
  }
}

export const codexAssetInternals = {
  mcpNamesFromConfig,
  pluginIdentityFromCachePath,
}
