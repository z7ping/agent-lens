import { createHash } from 'node:crypto'
import { opendir, readFile, stat } from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import type {
  AssetScope,
  DiscoveredAsset,
  EvidenceCandidate,
  SourceExecutionContext,
} from '@agent-lens/core'
import { isMissingPathError } from '@agent-lens/source-support'
import { CLAUDE_KNOWN_PROJECT_CWDS_CHECKPOINT_KEY } from './workspace-context.js'

const MEMORY_FILE_NAMES = ['CLAUDE.md', 'CLAUDE.local.md'] as const

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function pathKey(value: string): string {
  const normalized = resolve(value).replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function safeStat(path: string) {
  try {
    return await stat(path)
  } catch (error) {
    if (isMissingPathError(error)) return null
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
  const normalized = content.replace(/^\uFEFF/, '').trim()
  return normalized || undefined
}

async function findGitRoot(cwd: string): Promise<string | undefined> {
  let current = resolve(cwd)
  while (true) {
    if ((await safeStat(join(current, '.git'))) != null) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

function ancestorsFromFilesystemRoot(cwd: string): string[] {
  let current = resolve(cwd)
  const values: string[] = []
  while (true) {
    values.push(current)
    const parent = dirname(current)
    if (parent === current) return values.reverse()
    current = parent
  }
}

function directoriesFromProjectRoot(projectRoot: string, cwd: string): string[] {
  const root = resolve(projectRoot)
  let current = resolve(cwd)
  const values: string[] = []
  while (true) {
    values.push(current)
    if (pathKey(current) === pathKey(root)) return values.reverse()
    const parent = dirname(current)
    if (parent === current) return [resolve(cwd)]
    current = parent
  }
}

async function existingKnownCwds(values: readonly string[]): Promise<string[]> {
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

export async function listClaudeKnownProjectCwds(
  ctx: SourceExecutionContext,
): Promise<string[]> {
  const remembered = await ctx.checkpoint.get<string[]>(CLAUDE_KNOWN_PROJECT_CWDS_CHECKPOINT_KEY)
  return remembered?.length ? existingKnownCwds(remembered) : []
}

function evidenceFor(
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

async function instructionAsset(
  path: string,
  input: {
    scope: AssetScope
    scopeRoot: string
    source: string
    capturedAt: string
    type?: 'context' | 'rule'
  },
): Promise<DiscoveredAsset | undefined> {
  if (!await readNonEmpty(path)) return undefined
  const meta = await safeStat(path)
  if (!meta?.isFile()) return undefined
  const observedAt = meta.mtime.toISOString()
  const evidenceCandidates = evidenceFor(path, observedAt, input.capturedAt)
  return {
    definition: {
      type: input.type ?? 'context',
      canonicalName: basename(path),
      displayName: basename(path),
      upstreamIdentity: `claude-instruction:${sha256(pathKey(path))}`,
    },
    binding: {
      path,
      source: input.source,
      scope: input.scope,
      scopeRoot: input.scopeRoot,
    },
    states: [
      {
        state: 'configured',
        value: true,
        observedAt,
        evidenceCandidates,
      },
      {
        state: 'discoverable',
        value: 'unknown',
        observedAt: input.capturedAt,
      },
    ],
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
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) yield path
  }
}

function scopeForAncestor(
  directory: string,
  projectRoot: string | undefined,
): { scope: AssetScope; scopeRoot: string } {
  if (projectRoot && isPathInside(projectRoot, directory)) {
    return { scope: 'project', scopeRoot: projectRoot }
  }
  // Claude Code intentionally loads CLAUDE.md files from ancestors above the repository.
  // Treat those as workspace-scoped context rooted at the ancestor that owns the file.
  return { scope: 'workspace', scopeRoot: directory }
}

async function startupInstructionAssets(
  cwd: string,
  capturedAt: string,
): Promise<DiscoveredAsset[]> {
  const projectRoot = await findGitRoot(cwd)
  const assets: DiscoveredAsset[] = []
  const seen = new Set<string>()

  for (const directory of ancestorsFromFilesystemRoot(cwd)) {
    const scope = scopeForAncestor(directory, projectRoot)
    for (const fileName of MEMORY_FILE_NAMES) {
      const path = join(directory, fileName)
      const asset = await instructionAsset(path, {
        ...scope,
        source: fileName === 'CLAUDE.local.md'
          ? 'claude:project-memory:local'
          : 'claude:project-memory',
        capturedAt,
      })
      if (!asset) continue
      const key = pathKey(path)
      if (!seen.has(key)) {
        seen.add(key)
        assets.push(asset)
      }
    }
  }

  if (projectRoot) {
    const projectClaude = await instructionAsset(
      join(projectRoot, '.claude', 'CLAUDE.md'),
      {
        scope: 'project',
        scopeRoot: projectRoot,
        source: 'claude:project-memory:.claude',
        capturedAt,
      },
    )
    if (projectClaude) {
      const key = pathKey(projectClaude.binding?.path ?? '')
      if (!seen.has(key)) {
        seen.add(key)
        assets.push(projectClaude)
      }
    }
  }

  return assets
}

async function projectRuleAssets(
  cwd: string,
  capturedAt: string,
): Promise<DiscoveredAsset[]> {
  const projectRoot = await findGitRoot(cwd)
  if (!projectRoot) return []
  const assets: DiscoveredAsset[] = []
  const rulesRoot = join(projectRoot, '.claude', 'rules')

  // Claude Code recursively discovers files *inside* the project's single
  // .claude/rules root. It does not treat every ancestor directory as a new rules root.
  for await (const path of walkMarkdownFiles(rulesRoot)) {
    const asset = await instructionAsset(path, {
      scope: 'project',
      scopeRoot: projectRoot,
      source: 'claude:project-rule',
      capturedAt,
      type: 'rule',
    })
    if (asset) assets.push(asset)
  }
  return assets
}

export async function* discoverClaudeProjectInstructionAssets(
  ctx: SourceExecutionContext,
  capturedAt: string,
): AsyncIterable<DiscoveredAsset> {
  const cwds = await listClaudeKnownProjectCwds(ctx)
  const seen = new Set<string>()

  for (const cwd of cwds) {
    if (ctx.abortSignal.aborted) return
    for (const asset of [
      ...await startupInstructionAssets(cwd, capturedAt),
      ...await projectRuleAssets(cwd, capturedAt),
    ]) {
      const path = asset.binding?.path
      const key = path ? pathKey(path) : `${asset.definition.canonicalName}:${cwd}`
      if (seen.has(key)) continue
      seen.add(key)
      yield asset
    }
  }
}

export const claudeProjectContextInternals = {
  ancestorsFromFilesystemRoot,
  directoriesFromProjectRoot,
  existingKnownCwds,
  findGitRoot,
  projectRuleAssets,
  startupInstructionAssets,
}
