import { createHash } from 'node:crypto'
import { access, readFile, readdir, stat } from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
} from 'node:path'
import type {
  DiscoveredAsset,
  EvidenceCandidate,
  SourceExecutionContext,
} from '@agent-lens/core'
import { isMissingPathError } from '@agent-lens/source-support'
import { HERMES_KNOWN_PROJECT_CWDS_CHECKPOINT_KEY } from './workspace-context.js'

const PROJECT_HERMES_FILES = ['.hermes.md', 'HERMES.md'] as const
const PROJECT_AGENTS_FILES = ['AGENTS.override.md', 'AGENTS.md', 'agents.md'] as const
const PROJECT_CLAUDE_FILES = ['CLAUDE.md', 'claude.md'] as const

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
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

function contextEvidence(
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
  const evidenceCandidates = contextEvidence(path, observedAt, capturedAt)
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
        observedAt: capturedAt,
      },
    ],
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
    // An empty .hermes.md / HERMES.md falls through to the next context type.
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
    const asset = await contextAsset(
      join(cwd, name),
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

export async function* discoverHermesProjectContextAssets(
  ctx: SourceExecutionContext,
  capturedAt: string,
): AsyncIterable<DiscoveredAsset> {
  const remembered = await ctx.checkpoint.get<string[]>(HERMES_KNOWN_PROJECT_CWDS_CHECKPOINT_KEY)
  const projectCwds = remembered?.length ? await existingProjectCwds(remembered) : []
  const seen = new Set<string>()

  for (const cwd of projectCwds) {
    if (ctx.abortSignal.aborted) return
    for (const asset of await projectContextAssets(cwd, capturedAt)) {
      const path = asset.binding?.path
      const key = path ? pathKey(path) : `${asset.definition.canonicalName}:${cwd}`
      if (seen.has(key)) continue
      seen.add(key)
      yield asset
    }
  }
}

export const hermesProjectContextInternals = {
  directoryChain,
  existingProjectCwds,
  findGitRoot,
  nearestHermesContextFile,
  projectContextAssets,
}
