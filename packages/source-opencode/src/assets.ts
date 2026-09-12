import { createHash } from 'node:crypto'
import { opendir, readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'
import { parse, type ParseError } from 'jsonc-parser'
import type {
  AssetScope,
  DiscoveredAsset,
  EvidenceCandidate,
  SourceExecutionContext,
} from '@agent-lens/core'
import { isMissingPathError } from '@agent-lens/source-support'
import {
  directoriesFromProjectRoot,
  discoverOpenCodeInstructionAssets,
  listOpenCodeKnownProjectCwds,
  openCodeProjectContextInternals,
} from './project-context.js'

const CONFIG_NAMES = ['opencode.json', 'opencode.jsonc'] as const
const PLUGIN_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'])

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function pathKey(value: string): string {
  const normalized = resolve(value).replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

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

async function readConfig(path: string): Promise<Record<string, unknown> | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isMissingPathError(error)) return undefined
    throw error
  }

  const errors: ParseError[] = []
  const value = parse(text, errors, { allowTrailingComma: true })
  if (errors.length) return undefined
  return asRecord(value)
}

function evidence(
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

function states(
  path: string,
  observedAt: string,
  capturedAt: string,
  values: Array<{
    state: 'installed' | 'configured' | 'enabled' | 'discoverable'
    value: boolean | 'unknown'
  }>,
): NonNullable<DiscoveredAsset['states']> {
  const evidenceCandidates = evidence(path, observedAt, capturedAt)
  return values.map(item => ({
    ...item,
    observedAt,
    ...(item.value === 'unknown' ? {} : { evidenceCandidates }),
  }))
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

async function* walkSkillCandidates(
  root: string,
  depth = 0,
  maxDepth = 12,
): AsyncIterable<string> {
  if (depth > maxDepth) return
  let dir
  try {
    dir = await opendir(root)
  } catch (error) {
    if (isMissingPathError(error)) return
    throw error
  }

  for await (const entry of dir) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      yield* walkSkillCandidates(path, depth + 1, maxDepth)
      continue
    }
    if (!entry.isFile()) continue
    const lower = entry.name.toLowerCase()
    if ((depth === 0 && lower.endsWith('.md')) || lower === 'skill.md') yield path
  }
}

async function* discoverSkillRoot(
  root: string,
  input: {
    scope: AssetScope
    scopeRoot: string
    source: string
    capturedAt: string
  },
): AsyncIterable<DiscoveredAsset> {
  const seen = new Set<string>()
  for await (const path of walkSkillCandidates(root)) {
    const key = pathKey(path)
    if (seen.has(key)) continue
    seen.add(key)
    const meta = await safeStat(path)
    if (!meta?.isFile()) continue
    const relativeName = relative(root, path).replaceAll('\\', '/')
    const name = basename(path).toLowerCase() === 'skill.md'
      ? basename(resolve(path, '..'))
      : basename(path, extname(path))
    const observedAt = meta.mtime.toISOString()

    yield {
      definition: {
        type: 'skill',
        canonicalName: relativeName,
        displayName: name,
        upstreamIdentity: `opencode-skill:${sha256(key)}`,
      },
      binding: {
        path: basename(path).toLowerCase() === 'skill.md' ? resolve(path, '..') : path,
        source: input.source,
        scope: input.scope,
        scopeRoot: input.scopeRoot,
      },
      states: states(path, observedAt, input.capturedAt, [
        { state: 'installed', value: true },
        { state: 'discoverable', value: 'unknown' },
      ]),
    }
  }
}

async function* discoverMarkdownRoot(
  root: string,
  input: {
    type: 'prompt' | 'builtin'
    scope: AssetScope
    scopeRoot: string
    source: string
    capturedAt: string
    identityPrefix: string
  },
): AsyncIterable<DiscoveredAsset> {
  for await (const path of walkMarkdownFiles(root)) {
    const meta = await safeStat(path)
    if (!meta?.isFile()) continue
    const relativeName = relative(root, path).replaceAll('\\', '/')
    const observedAt = meta.mtime.toISOString()
    yield {
      definition: {
        type: input.type,
        canonicalName: relativeName.replace(/\.md$/i, ''),
        displayName: basename(path, extname(path)),
        upstreamIdentity: `${input.identityPrefix}:${sha256(pathKey(path))}`,
      },
      binding: {
        path,
        source: input.source,
        scope: input.scope,
        scopeRoot: input.scopeRoot,
      },
      states: states(path, observedAt, input.capturedAt, [
        { state: 'configured', value: true },
        { state: 'discoverable', value: 'unknown' },
      ]),
    }
  }
}

async function* discoverPluginRoot(
  root: string,
  input: {
    scope: AssetScope
    scopeRoot: string
    source: string
    capturedAt: string
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
    if (!entry.isFile() || !PLUGIN_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
    const path = join(root, entry.name)
    const meta = await safeStat(path)
    if (!meta?.isFile()) continue
    const observedAt = meta.mtime.toISOString()
    yield {
      definition: {
        type: 'plugin',
        canonicalName: basename(entry.name, extname(entry.name)),
        displayName: basename(entry.name, extname(entry.name)),
        upstreamIdentity: `opencode-local-plugin:${sha256(pathKey(path))}`,
      },
      binding: {
        path,
        source: input.source,
        scope: input.scope,
        scopeRoot: input.scopeRoot,
      },
      states: states(path, observedAt, input.capturedAt, [
        { state: 'installed', value: true },
        { state: 'configured', value: true },
        { state: 'discoverable', value: 'unknown' },
      ]),
    }
  }
}

function pluginSpecs(config: Record<string, unknown>): string[] {
  const value = Array.isArray(config.plugins)
    ? config.plugins
    : Array.isArray(config.plugin)
      ? config.plugin
      : []
  const result: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) result.push(item.trim())
    else {
      const record = asRecord(item)
      if (typeof record.package === 'string' && record.package.trim()) result.push(record.package.trim())
    }
  }
  return result
}

function namedConfigEntries(
  config: Record<string, unknown>,
  currentKey: string,
  legacyKey: string,
): string[] {
  const current = asRecord(config[currentKey])
  const legacy = asRecord(config[legacyKey])
  return [...new Set([...Object.keys(legacy), ...Object.keys(current)])]
}

async function* discoverConfigAssets(
  path: string,
  input: {
    scope: AssetScope
    scopeRoot: string
    source: string
    capturedAt: string
  },
): AsyncIterable<DiscoveredAsset> {
  const meta = await safeStat(path)
  if (!meta?.isFile()) return
  const config = await readConfig(path)
  if (!config) return
  const observedAt = meta.mtime.toISOString()

  for (const [name, raw] of Object.entries(asRecord(config.mcp))) {
    const server = asRecord(raw)
    const disabled = server.disabled === true
    yield {
      definition: {
        type: 'mcp',
        canonicalName: name,
        displayName: name,
        upstreamIdentity: `opencode-mcp:${sha256(`${pathKey(path)}\0${name}`)}`,
      },
      binding: {
        path,
        source: `${input.source}:mcp`,
        scope: input.scope,
        scopeRoot: input.scopeRoot,
      },
      states: states(path, observedAt, input.capturedAt, [
        { state: 'configured', value: true },
        { state: 'enabled', value: disabled ? false : 'unknown' },
        { state: 'discoverable', value: disabled ? false : 'unknown' },
      ]),
    }
  }

  for (const name of namedConfigEntries(config, 'agents', 'agent')) {
    yield {
      definition: {
        type: 'prompt',
        canonicalName: name,
        displayName: name,
        upstreamIdentity: `opencode-config-agent:${sha256(`${pathKey(path)}\0${name}`)}`,
      },
      binding: {
        path,
        source: `${input.source}:agent`,
        scope: input.scope,
        scopeRoot: input.scopeRoot,
      },
      states: states(path, observedAt, input.capturedAt, [
        { state: 'configured', value: true },
        { state: 'discoverable', value: 'unknown' },
      ]),
    }
  }

  for (const name of namedConfigEntries(config, 'commands', 'command')) {
    yield {
      definition: {
        type: 'builtin',
        canonicalName: `command:${name}`,
        displayName: name,
        upstreamIdentity: `opencode-config-command:${sha256(`${pathKey(path)}\0${name}`)}`,
      },
      binding: {
        path,
        source: `${input.source}:command`,
        scope: input.scope,
        scopeRoot: input.scopeRoot,
      },
      states: states(path, observedAt, input.capturedAt, [
        { state: 'configured', value: true },
        { state: 'discoverable', value: 'unknown' },
      ]),
    }
  }

  for (const spec of pluginSpecs(config)) {
    yield {
      definition: {
        type: 'plugin',
        canonicalName: spec,
        displayName: spec,
        upstreamIdentity: `opencode-package-plugin:${spec}`,
      },
      binding: {
        path,
        source: `${input.source}:plugin`,
        scope: input.scope,
        scopeRoot: input.scopeRoot,
      },
      states: states(path, observedAt, input.capturedAt, [
        { state: 'configured', value: true },
        { state: 'installed', value: 'unknown' },
        { state: 'discoverable', value: 'unknown' },
      ]),
    }
  }
}

async function* discoverDirectoryAssets(
  root: string,
  input: {
    scope: AssetScope
    scopeRoot: string
    sourcePrefix: string
    capturedAt: string
  },
): AsyncIterable<DiscoveredAsset> {
  for (const skillDir of ['skills']) {
    for await (const asset of discoverSkillRoot(join(root, skillDir), {
      scope: input.scope,
      scopeRoot: input.scopeRoot,
      source: `${input.sourcePrefix}:skills`,
      capturedAt: input.capturedAt,
    })) yield asset
  }

  for (const dir of ['agents', 'agent']) {
    for await (const asset of discoverMarkdownRoot(join(root, dir), {
      type: 'prompt',
      scope: input.scope,
      scopeRoot: input.scopeRoot,
      source: `${input.sourcePrefix}:${dir}`,
      capturedAt: input.capturedAt,
      identityPrefix: 'opencode-agent',
    })) yield asset
  }

  for (const dir of ['commands', 'command']) {
    for await (const asset of discoverMarkdownRoot(join(root, dir), {
      type: 'builtin',
      scope: input.scope,
      scopeRoot: input.scopeRoot,
      source: `${input.sourcePrefix}:${dir}`,
      capturedAt: input.capturedAt,
      identityPrefix: 'opencode-command',
    })) yield asset
  }

  for (const dir of ['plugins', 'plugin']) {
    for await (const asset of discoverPluginRoot(join(root, dir), {
      scope: input.scope,
      scopeRoot: input.scopeRoot,
      source: `${input.sourcePrefix}:${dir}`,
      capturedAt: input.capturedAt,
    })) yield asset
  }
}

async function* discoverUserAssets(
  configRoot: string,
  capturedAt: string,
): AsyncIterable<DiscoveredAsset> {
  for await (const asset of discoverDirectoryAssets(configRoot, {
    scope: 'user',
    scopeRoot: configRoot,
    sourcePrefix: 'opencode:user',
    capturedAt,
  })) yield asset

  for (const name of CONFIG_NAMES) {
    for await (const asset of discoverConfigAssets(join(configRoot, name), {
      scope: 'user',
      scopeRoot: configRoot,
      source: 'opencode:user-config',
      capturedAt,
    })) yield asset
  }

  const home = homedir()
  for (const [root, source] of [
    [join(home, '.claude', 'skills'), 'opencode:compat:claude-skills'],
    [join(home, '.agents', 'skills'), 'opencode:compat:agents-skills'],
  ] as const) {
    for await (const asset of discoverSkillRoot(root, {
      scope: 'user',
      scopeRoot: home,
      source,
      capturedAt,
    })) yield asset
  }
}

async function* discoverProjectAssets(
  ctx: SourceExecutionContext,
  capturedAt: string,
): AsyncIterable<DiscoveredAsset> {
  const seenPaths = new Set<string>()

  for (const cwd of await listOpenCodeKnownProjectCwds(ctx)) {
    if (ctx.abortSignal.aborted) return
    const projectRoot = await openCodeProjectContextInternals.findProjectRoot(cwd)
    for (const directory of directoriesFromProjectRoot(projectRoot, cwd)) {
      const relativeDirectory = relative(projectRoot, directory).replaceAll('\\', '/') || '.'
      const scopeRoot = projectRoot

      for (const configPath of [
        ...CONFIG_NAMES.map(name => join(directory, name)),
        ...CONFIG_NAMES.map(name => join(directory, '.opencode', name)),
      ]) {
        const key = pathKey(configPath)
        if (seenPaths.has(key)) continue
        seenPaths.add(key)
        for await (const asset of discoverConfigAssets(configPath, {
          scope: 'project',
          scopeRoot,
          source: `opencode:project-config:${relativeDirectory}`,
          capturedAt,
        })) yield asset
      }

      for await (const asset of discoverDirectoryAssets(join(directory, '.opencode'), {
        scope: 'project',
        scopeRoot,
        sourcePrefix: `opencode:project:${relativeDirectory}`,
        capturedAt,
      })) {
        const path = asset.binding?.path
        const key = path ? pathKey(path) : asset.definition.upstreamIdentity ?? asset.definition.canonicalName
        if (seenPaths.has(key)) continue
        seenPaths.add(key)
        yield asset
      }

      for (const [compatRoot, source] of [
        [join(directory, '.claude', 'skills'), `opencode:compat:project-claude-skills:${relativeDirectory}`],
        [join(directory, '.agents', 'skills'), `opencode:compat:project-agents-skills:${relativeDirectory}`],
      ] as const) {
        for await (const asset of discoverSkillRoot(compatRoot, {
          scope: 'project',
          scopeRoot,
          source,
          capturedAt,
        })) {
          const path = asset.binding?.path
          const key = path ? pathKey(path) : asset.definition.upstreamIdentity ?? asset.definition.canonicalName
          if (seenPaths.has(key)) continue
          seenPaths.add(key)
          yield asset
        }
      }
    }
  }
}

export async function* discoverOpenCodeAssets(
  ctx: SourceExecutionContext,
): AsyncIterable<DiscoveredAsset> {
  const configRoot = ctx.installation.configRoot
  if (!configRoot || ctx.abortSignal.aborted) return
  const capturedAt = new Date().toISOString()

  for await (const asset of discoverOpenCodeInstructionAssets(ctx, capturedAt)) {
    if (ctx.abortSignal.aborted) return
    yield asset
  }

  for await (const asset of discoverUserAssets(configRoot, capturedAt)) {
    if (ctx.abortSignal.aborted) return
    yield asset
  }

  for await (const asset of discoverProjectAssets(ctx, capturedAt)) {
    if (ctx.abortSignal.aborted) return
    yield asset
  }
}

export const openCodeAssetInternals = {
  namedConfigEntries,
  pluginSpecs,
  readConfig,
}
