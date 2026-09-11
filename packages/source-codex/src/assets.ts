import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type {
  DiscoveredAsset,
  EvidenceCandidate,
  SourceExecutionContext,
} from '@agent-lens/core'
import { isMissingPathError } from '@agent-lens/source-support'

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

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
  } catch (error) {
    if (isMissingPathError(error)) return
    throw error
  }
  const observedAt = meta.mtime.toISOString()

  for (const name of mcpNamesFromToml(content)) {
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
        [
          { state: 'configured', value: true },
          { state: 'discoverable', value: 'unknown' },
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
      manifest = asRecord(JSON.parse(await readFile(manifestPath, 'utf8')))
    } catch (error) {
      if (!isMissingPathError(error) && !(error instanceof SyntaxError)) throw error
      // Missing/malformed metadata does not erase the independently observed plugin directory.
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
        [
          { state: 'configured', value: true },
          { state: 'discoverable', value: 'unknown' },
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
