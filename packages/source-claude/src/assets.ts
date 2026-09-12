import { opendir, readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import {
  basename,
  dirname,
  extname,
  join,
  relative,
} from 'node:path'
import type {
  AssetScope,
  DiscoveredAsset,
  EvidenceCandidate,
  SourceExecutionContext,
} from '@agent-lens/core'
import { isMissingPathError } from '@agent-lens/source-support'
import {
  claudeProjectContextInternals,
  discoverClaudeProjectInstructionAssets,
  listClaudeKnownProjectCwds,
} from './project-context.js'

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

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return asRecord(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if (isMissingPathError(error) || error instanceof SyntaxError) return undefined
    throw error
  }
}

async function* walkNamedFile(
  root: string,
  fileName: string,
): AsyncIterable<string> {
  let dir
  try {
    dir = await opendir(root)
  } catch (error) {
    if (isMissingPathError(error)) return
    throw error
  }

  for await (const entry of dir) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) yield* walkNamedFile(path, fileName)
    else if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) yield path
  }
}

async function* walkMarkdownFiles(root: string): AsyncIterable<string> {
  let dir
  try {
    dir = await opendir(root)
  } catch (error) {
    if (isMissingPathError(error)) return
    throw error
  }

  for await (const entry of dir) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) yield* walkMarkdownFiles(path)
    else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') yield path
  }
}

function staticEvidence(
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

function assetStates(
  path: string,
  observedAt: string,
  capturedAt: string,
  values: Array<{
    state: 'installed' | 'configured' | 'enabled' | 'discoverable'
    value: boolean | 'unknown'
  }>,
): NonNullable<DiscoveredAsset['states']> {
  const evidenceCandidates = staticEvidence(path, observedAt, capturedAt)
  return values.map(value => ({
    ...value,
    observedAt,
    ...(value.value === 'unknown' ? {} : { evidenceCandidates }),
  }))
}

async function* discoverSkillRoot(
  root: string,
  input: {
    scope: AssetScope
    scopeRoot: string
    source: string
    capturedAt: string
    prefix?: string
  },
): AsyncIterable<DiscoveredAsset> {
  for await (const skillFile of walkNamedFile(root, 'SKILL.md')) {
    const skillDir = dirname(skillFile)
    if (basename(skillDir).toLowerCase() === 'synced') continue
    const meta = await safeStat(skillFile)
    if (!meta?.isFile()) continue
    const relativeName = relative(root, skillDir).replaceAll('\\', '/')
    const displayName = basename(skillDir)
    const canonicalName = input.prefix
      ? `${input.prefix}:${relativeName || displayName}`
      : relativeName || displayName
    const observedAt = meta.mtime.toISOString()

    yield {
      definition: {
        type: 'skill',
        canonicalName,
        displayName,
      },
      binding: {
        path: skillDir,
        source: input.source,
        scope: input.scope,
        scopeRoot: input.scopeRoot,
      },
      states: assetStates(skillFile, observedAt, input.capturedAt, [
        { state: 'installed', value: true },
        { state: 'discoverable', value: 'unknown' },
      ]),
    }
  }
}

async function* discoverCommandRoot(
  root: string,
  input: {
    scope: AssetScope
    scopeRoot: string
    source: string
    capturedAt: string
    prefix?: string
  },
): AsyncIterable<DiscoveredAsset> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (isMissingPathError(error)) return
    throw error
  }

  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.md') continue
    const path = join(root, entry.name)
    const meta = await safeStat(path)
    if (!meta?.isFile()) continue
    const name = basename(entry.name, extname(entry.name))
    const observedAt = meta.mtime.toISOString()

    yield {
      definition: {
        type: 'builtin',
        canonicalName: input.prefix ? `${input.prefix}:command:${name}` : `command:${name}`,
        displayName: name,
      },
      binding: {
        path,
        source: input.source,
        scope: input.scope,
        scopeRoot: input.scopeRoot,
      },
      states: assetStates(path, observedAt, input.capturedAt, [
        { state: 'installed', value: true },
        { state: 'discoverable', value: 'unknown' },
      ]),
    }
  }
}

async function* discoverRuleRoot(
  root: string,
  input: {
    scope: AssetScope
    scopeRoot: string
    source: string
    capturedAt: string
  },
): AsyncIterable<DiscoveredAsset> {
  for await (const path of walkMarkdownFiles(root)) {
    const meta = await safeStat(path)
    if (!meta?.isFile()) continue
    const observedAt = meta.mtime.toISOString()
    yield {
      definition: {
        type: 'rule',
        canonicalName: basename(path),
        displayName: basename(path),
        upstreamIdentity: `claude-rule:${path}`,
      },
      binding: {
        path,
        source: input.source,
        scope: input.scope,
        scopeRoot: input.scopeRoot,
      },
      states: assetStates(path, observedAt, input.capturedAt, [
        { state: 'configured', value: true },
        { state: 'discoverable', value: 'unknown' },
      ]),
    }
  }
}

function enabledPluginEntries(settings: Record<string, unknown>): Map<string, boolean> {
  const value = settings.enabledPlugins
  const result = new Map<string, boolean>()
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string' && item.trim()) result.set(item.trim(), true)
    }
    return result
  }
  const entries = asRecord(value)
  for (const [id, enabled] of Object.entries(entries)) {
    if (typeof enabled === 'boolean') result.set(id, enabled)
  }
  return result
}

async function* settingsAssets(
  path: string,
  input: {
    scope: AssetScope
    scopeRoot: string
    source: string
    capturedAt: string
    includeMcp?: boolean
  },
): AsyncIterable<DiscoveredAsset> {
  const meta = await safeStat(path)
  if (!meta?.isFile()) return
  const settings = await readJson(path)
  if (!settings) return
  const observedAt = meta.mtime.toISOString()

  if (input.includeMcp !== false) {
    const mcp = asRecord(settings.mcpServers ?? settings.mcp_servers)
    for (const name of Object.keys(mcp)) {
      yield {
        definition: { type: 'mcp', canonicalName: name, displayName: name },
        binding: {
          path,
          source: `${input.source}:mcp`,
          scope: input.scope,
          scopeRoot: input.scopeRoot,
        },
        states: assetStates(path, observedAt, input.capturedAt, [
          { state: 'configured', value: true },
          { state: 'discoverable', value: 'unknown' },
        ]),
      }
    }
  }

  const hooks = asRecord(settings.hooks)
  for (const [eventName, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups) || groups.length === 0) continue
    yield {
      definition: {
        type: 'hook',
        canonicalName: `claude-hook:${eventName}`,
        displayName: `${eventName} Hook`,
      },
      binding: {
        path,
        source: `${input.source}:hook`,
        scope: input.scope,
        scopeRoot: input.scopeRoot,
      },
      states: assetStates(path, observedAt, input.capturedAt, [
        { state: 'configured', value: true },
        { state: 'enabled', value: 'unknown' },
      ]),
    }
  }

  for (const [id, enabled] of enabledPluginEntries(settings)) {
    yield {
      definition: {
        type: 'plugin',
        canonicalName: id,
        displayName: id,
        upstreamIdentity: id,
      },
      binding: {
        path,
        source: `${input.source}:plugin`,
        scope: input.scope,
        scopeRoot: input.scopeRoot,
      },
      states: assetStates(path, observedAt, input.capturedAt, [
        { state: 'configured', value: true },
        { state: 'installed', value: 'unknown' },
        { state: 'enabled', value: enabled ? 'unknown' : false },
      ]),
    }
  }
}

async function* projectMcpAssets(
  projectRoot: string,
  capturedAt: string,
): AsyncIterable<DiscoveredAsset> {
  const path = join(projectRoot, '.mcp.json')
  const meta = await safeStat(path)
  if (!meta?.isFile()) return
  const config = await readJson(path)
  if (!config) return
  const observedAt = meta.mtime.toISOString()
  const servers = asRecord(config.mcpServers ?? config.mcp_servers)

  for (const name of Object.keys(servers)) {
    yield {
      definition: { type: 'mcp', canonicalName: name, displayName: name },
      binding: {
        path,
        source: 'claude:project-mcp',
        scope: 'project',
        scopeRoot: projectRoot,
      },
      states: assetStates(path, observedAt, capturedAt, [
        { state: 'configured', value: true },
        // Project MCP requires workspace approval in interactive sessions.
        { state: 'discoverable', value: 'unknown' },
      ]),
    }
  }
}

async function* discoverUserAssets(
  configRoot: string,
  capturedAt: string,
): AsyncIterable<DiscoveredAsset> {
  const userInstruction = join(configRoot, 'CLAUDE.md')
  const instructionMeta = await safeStat(userInstruction)
  if (instructionMeta?.isFile()) {
    const content = (await readFile(userInstruction, 'utf8')).trim()
    if (content) {
      const observedAt = instructionMeta.mtime.toISOString()
      yield {
        definition: {
          type: 'context',
          canonicalName: 'claude-user-instructions',
          displayName: 'CLAUDE.md',
        },
        binding: {
          path: userInstruction,
          source: 'claude:user-memory',
          scope: 'user',
          scopeRoot: configRoot,
        },
        states: assetStates(userInstruction, observedAt, capturedAt, [
          { state: 'configured', value: true },
          { state: 'discoverable', value: 'unknown' },
        ]),
      }
    }
  }

  for await (const asset of discoverRuleRoot(join(configRoot, 'rules'), {
    scope: 'user',
    scopeRoot: configRoot,
    source: 'claude:user-rule',
    capturedAt,
  })) yield asset

  for await (const asset of discoverSkillRoot(join(configRoot, 'skills'), {
    scope: 'user',
    scopeRoot: configRoot,
    source: 'claude:user-skill',
    capturedAt,
  })) yield asset

  for await (const asset of discoverCommandRoot(join(configRoot, 'commands'), {
    scope: 'user',
    scopeRoot: configRoot,
    source: 'claude:user-command',
    capturedAt,
  })) yield asset

  for await (const asset of settingsAssets(join(configRoot, 'settings.json'), {
    scope: 'user',
    scopeRoot: configRoot,
    source: 'claude:user-settings',
    capturedAt,
  })) yield asset

  // Claude Code keeps global config/MCP state in ~/.claude.json even though the rest
  // of the profile can move under CLAUDE_CONFIG_DIR.
  for await (const asset of settingsAssets(join(homedir(), '.claude.json'), {
    scope: 'user',
    scopeRoot: homedir(),
    source: 'claude:global-config',
    capturedAt,
  })) yield asset
}

async function* discoverProjectAssets(
  ctx: SourceExecutionContext,
  capturedAt: string,
): AsyncIterable<DiscoveredAsset> {
  const cwds = await listClaudeKnownProjectCwds(ctx)
  const seenRoots = new Set<string>()
  const seenAssetPaths = new Set<string>()

  for (const cwd of cwds) {
    if (ctx.abortSignal.aborted) return
    const projectRoot = await claudeProjectContextInternals.findGitRoot(cwd) ?? cwd
    const rootKey = process.platform === 'win32'
      ? projectRoot.replaceAll('\\', '/').toLowerCase()
      : projectRoot.replaceAll('\\', '/')
    if (!seenRoots.has(rootKey)) {
      seenRoots.add(rootKey)

      for await (const asset of settingsAssets(join(projectRoot, '.claude', 'settings.json'), {
        scope: 'project',
        scopeRoot: projectRoot,
        source: 'claude:project-settings',
        capturedAt,
      })) yield asset

      for await (const asset of settingsAssets(join(projectRoot, '.claude', 'settings.local.json'), {
        scope: 'project',
        scopeRoot: projectRoot,
        source: 'claude:project-local-settings',
        capturedAt,
      })) yield asset

      for await (const asset of projectMcpAssets(projectRoot, capturedAt)) yield asset
    }

    for (const directory of claudeProjectContextInternals.directoriesFromProjectRoot(projectRoot, cwd)) {
      const relativeDirectory = relative(projectRoot, directory).replaceAll('\\', '/') || '.'
      const assetPrefix = `project:${relativeDirectory}`

      for await (const asset of discoverSkillRoot(join(directory, '.claude', 'skills'), {
        scope: 'project',
        scopeRoot: projectRoot,
        source: 'claude:project-skill',
        capturedAt,
        prefix: assetPrefix,
      })) {
        const path = asset.binding?.path ?? ''
        if (seenAssetPaths.has(path)) continue
        seenAssetPaths.add(path)
        yield asset
      }

      for await (const asset of discoverCommandRoot(join(directory, '.claude', 'commands'), {
        scope: 'project',
        scopeRoot: projectRoot,
        source: 'claude:project-command',
        capturedAt,
        prefix: assetPrefix,
      })) {
        const path = asset.binding?.path ?? ''
        if (seenAssetPaths.has(path)) continue
        seenAssetPaths.add(path)
        yield asset
      }
    }
  }
}

export async function* discoverClaudeAssets(
  ctx: SourceExecutionContext,
): AsyncIterable<DiscoveredAsset> {
  const configRoot = ctx.installation.configRoot
  if (!configRoot || ctx.abortSignal.aborted) return
  const capturedAt = new Date().toISOString()

  for await (const asset of discoverUserAssets(configRoot, capturedAt)) {
    if (ctx.abortSignal.aborted) return
    yield asset
  }

  for await (const asset of discoverClaudeProjectInstructionAssets(ctx, capturedAt)) {
    if (ctx.abortSignal.aborted) return
    yield asset
  }

  for await (const asset of discoverProjectAssets(ctx, capturedAt)) {
    if (ctx.abortSignal.aborted) return
    yield asset
  }
}

export const claudeAssetInternals = {
  enabledPluginEntries,
  readJson,
  settingsAssets,
}
