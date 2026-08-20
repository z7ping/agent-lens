import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type {
  DiscoveredAsset,
  EvidenceCandidate,
  SourceExecutionContext,
} from '@agent-lens/core'

async function safeStat(path: string) {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

async function safeEntries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch {
    return []
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
  nativeStableId: string,
): EvidenceCandidate {
  return {
    captureMethod: 'static-scan',
    derivation: 'observed',
    sourceLocator: { kind: 'file', path },
    nativeStableId,
    eventTime: observedAt,
    capturedAt,
    confidenceHint: 'exact',
  }
}

function states(
  path: string,
  observedAt: string,
  capturedAt: string,
  nativeStableId: string,
  values: Array<{ state: 'installed' | 'configured' | 'enabled' | 'discoverable'; value: boolean | 'unknown' }>,
): NonNullable<DiscoveredAsset['states']> {
  const evidence = staticEvidence(path, observedAt, capturedAt, nativeStableId)
  return values.map(value => ({
    ...value,
    observedAt,
    evidenceCandidates: [evidence],
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
      const nativeStableId = `skill:${candidate.source}:${skillFile}`
      yield {
        definition: {
          type: 'skill',
          canonicalName: name,
          displayName: name,
        },
        binding: {
          path: skillDir,
          source: candidate.source,
        },
        states: states(
          skillFile,
          observedAt,
          capturedAt,
          nativeStableId,
          [
            { state: 'installed', value: true },
            { state: 'discoverable', value: true },
          ],
        ),
      }
    }
  }
}

function mcpNamesFromToml(content: string): string[] {
  const names = new Set<string>()
  const regex = /^\s*\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([^\]]+))\]\s*$/gmi
  let match: RegExpExecArray | null
  while ((match = regex.exec(content))) {
    const name = (match[1] ?? match[2] ?? match[3] ?? '').trim()
    if (name) names.add(name)
  }
  return [...names]
}

async function* discoverMcpServers(
  configRoot: string,
  capturedAt: string,
): AsyncIterable<DiscoveredAsset> {
  const configPath = join(configRoot, 'config.toml')
  const meta = await safeStat(configPath)
  if (!meta?.isFile()) return

  let content = ''
  try {
    content = await readFile(configPath, 'utf8')
  } catch {
    return
  }
  const observedAt = meta.mtime.toISOString()

  for (const name of mcpNamesFromToml(content)) {
    const nativeStableId = `mcp:${name}`
    yield {
      definition: {
        type: 'mcp',
        canonicalName: name,
        displayName: name,
      },
      binding: {
        path: configPath,
        source: 'codex:config.toml',
      },
      states: states(
        configPath,
        observedAt,
        capturedAt,
        nativeStableId,
        [
          { state: 'configured', value: true },
          { state: 'discoverable', value: true },
        ],
      ),
    }
  }
}

async function* discoverPluginManifests(
  configRoot: string,
  capturedAt: string,
): AsyncIterable<DiscoveredAsset> {
  const pluginsRoot = join(configRoot, 'plugins')
  const seen = new Set<string>()

  for await (const manifestPath of walkNamedFile(join(pluginsRoot, 'cache'), 'plugin.json')) {
    const meta = await safeStat(manifestPath)
    if (!meta?.isFile()) continue
    let manifest: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(await readFile(manifestPath, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) manifest = parsed
    } catch {
      // A malformed manifest still proves that a plugin binding exists at this path.
    }

    const name = typeof manifest.name === 'string' && manifest.name
      ? manifest.name
      : typeof manifest.id === 'string' && manifest.id
        ? manifest.id
        : basename(dirname(manifestPath))
    const version = typeof manifest.version === 'string' && manifest.version
      ? manifest.version
      : undefined
    const upstreamIdentity = typeof manifest.id === 'string' && manifest.id
      ? manifest.id
      : undefined
    const bindingPath = dirname(manifestPath)
    const key = `${name}:${bindingPath}`
    if (seen.has(key)) continue
    seen.add(key)
    const observedAt = meta.mtime.toISOString()
    const nativeStableId = `plugin:${bindingPath}`

    yield {
      definition: {
        type: 'plugin',
        canonicalName: name,
        displayName: name,
        ...(upstreamIdentity ? { upstreamIdentity } : {}),
      },
      binding: {
        path: bindingPath,
        source: 'codex:plugin-manifest',
        ...(version ? { version } : {}),
      },
      states: states(
        manifestPath,
        observedAt,
        capturedAt,
        nativeStableId,
        [{ state: 'installed', value: true }],
      ),
    }
  }

  for (const entry of await safeEntries(pluginsRoot)) {
    if (!entry.isDirectory() || entry.name === 'cache') continue
    const bindingPath = join(pluginsRoot, entry.name)
    const key = `${entry.name}:${bindingPath}`
    if (seen.has(key)) continue
    seen.add(key)
    const meta = await safeStat(bindingPath)
    if (!meta) continue
    const observedAt = meta.mtime.toISOString()
    yield {
      definition: {
        type: 'plugin',
        canonicalName: entry.name,
        displayName: entry.name,
      },
      binding: {
        path: bindingPath,
        source: 'codex:plugins',
      },
      states: states(
        bindingPath,
        observedAt,
        capturedAt,
        `plugin:${bindingPath}`,
        [{ state: 'installed', value: true }],
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
    const parsed = JSON.parse(await readFile(hooksPath, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) hooks = parsed
  } catch {
    return
  }

  const root = hooks.hooks && typeof hooks.hooks === 'object' && !Array.isArray(hooks.hooks)
    ? hooks.hooks as Record<string, unknown>
    : {}
  const observedAt = meta.mtime.toISOString()
  for (const [eventName, groups] of Object.entries(root)) {
    if (!Array.isArray(groups) || groups.length === 0) continue
    const nativeStableId = `hook:${eventName}`
    yield {
      definition: {
        type: 'hook',
        canonicalName: `codex-hook:${eventName}`,
        displayName: `${eventName} Hook`,
      },
      binding: {
        path: hooksPath,
        source: 'codex:hooks.json',
      },
      states: states(
        hooksPath,
        observedAt,
        capturedAt,
        nativeStableId,
        [
          { state: 'configured', value: true },
          { state: 'enabled', value: true },
        ],
      ),
    }
  }
}

async function* discoverGlobalRule(
  configRoot: string,
  capturedAt: string,
): AsyncIterable<DiscoveredAsset> {
  for (const fileName of ['AGENTS.override.md', 'AGENTS.md']) {
    const filePath = join(configRoot, fileName)
    const meta = await safeStat(filePath)
    if (!meta?.isFile() || meta.size === 0) continue
    const observedAt = meta.mtime.toISOString()
    yield {
      definition: {
        type: 'rule',
        canonicalName: 'codex-global-instructions',
        displayName: fileName,
      },
      binding: {
        path: filePath,
        source: 'codex:global-rule',
      },
      states: states(
        filePath,
        observedAt,
        capturedAt,
        `rule:${filePath}`,
        [
          { state: 'configured', value: true },
          { state: 'discoverable', value: true },
        ],
      ),
    }
    return
  }
}

export async function* discoverCodexAssets(
  ctx: SourceExecutionContext,
): AsyncIterable<DiscoveredAsset> {
  const configRoot = ctx.installation.configRoot
  if (!configRoot || ctx.abortSignal.aborted) return
  const capturedAt = new Date().toISOString()

  const groups = [
    discoverSkills(configRoot, capturedAt),
    discoverMcpServers(configRoot, capturedAt),
    discoverPluginManifests(configRoot, capturedAt),
    discoverHooks(configRoot, capturedAt),
    discoverGlobalRule(configRoot, capturedAt),
  ]

  for (const group of groups) {
    for await (const asset of group) {
      if (ctx.abortSignal.aborted) return
      yield asset
    }
  }
}

export const codexAssetInternals = {
  mcpNamesFromToml,
}
