import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
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
  DiscoveredAsset,
  EvidenceCandidate,
  SourceExecutionContext,
} from '@agent-lens/core'
import { isMissingPathError } from '@agent-lens/source-support'
import { OPENCODE_KNOWN_PROJECT_CWDS_CHECKPOINT_KEY } from './workspace-context.js'

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function pathKey(value: string): string {
  const normalized = resolve(value).replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
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
  const trimmed = content.replace(/^\uFEFF/, '').trim()
  return trimmed || undefined
}

async function findProjectRoot(cwd: string): Promise<string> {
  let current = resolve(cwd)
  while (true) {
    if ((await safeStat(join(current, '.git'))) != null) return current
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

export function directoriesFromProjectRoot(projectRoot: string, cwd: string): string[] {
  const root = resolve(projectRoot)
  let current = resolve(cwd)
  const rel = relative(root, current)
  const inside = rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  if (!inside) return [current]

  const values: string[] = []
  while (true) {
    values.push(current)
    if (pathKey(current) === pathKey(root)) return values.reverse()
    const parent = dirname(current)
    if (parent === current) return [resolve(cwd)]
    current = parent
  }
}

export async function listOpenCodeKnownProjectCwds(
  ctx: SourceExecutionContext,
): Promise<string[]> {
  const remembered = await ctx.checkpoint.get<string[]>(OPENCODE_KNOWN_PROJECT_CWDS_CHECKPOINT_KEY)
  if (!remembered?.length) return []
  const values = new Map<string, string>()
  for (const item of remembered) {
    const raw = item.trim()
    if (!raw || !isAbsolute(raw)) continue
    const cwd = resolve(raw)
    const meta = await safeStat(cwd)
    if (!meta?.isDirectory()) continue
    const key = pathKey(cwd)
    if (!values.has(key)) values.set(key, cwd)
  }
  return [...values.values()]
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

async function instructionAsset(
  path: string,
  input: {
    scope: 'user' | 'project'
    scopeRoot: string
    source: string
    capturedAt: string
  },
): Promise<DiscoveredAsset | undefined> {
  if (!await readNonEmpty(path)) return undefined
  const meta = await safeStat(path)
  if (!meta?.isFile()) return undefined
  const observedAt = meta.mtime.toISOString()
  const evidenceCandidates = evidence(path, observedAt, input.capturedAt)
  return {
    definition: {
      type: 'context',
      canonicalName: basename(path),
      displayName: basename(path),
      upstreamIdentity: `opencode-instruction:${sha256(pathKey(path))}`,
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

export async function* discoverOpenCodeInstructionAssets(
  ctx: SourceExecutionContext,
  capturedAt: string,
): AsyncIterable<DiscoveredAsset> {
  const configRoot = ctx.installation.configRoot
  if (configRoot) {
    const global = await instructionAsset(join(configRoot, 'AGENTS.md'), {
      scope: 'user',
      scopeRoot: configRoot,
      source: 'opencode:global-agents',
      capturedAt,
    })
    if (global) yield global
  }

  const seen = new Set<string>()
  for (const cwd of await listOpenCodeKnownProjectCwds(ctx)) {
    if (ctx.abortSignal.aborted) return
    const projectRoot = await findProjectRoot(cwd)
    for (const directory of directoriesFromProjectRoot(projectRoot, cwd)) {
      const path = join(directory, 'AGENTS.md')
      const key = pathKey(path)
      if (seen.has(key)) continue
      const asset = await instructionAsset(path, {
        scope: 'project',
        scopeRoot: projectRoot,
        source: 'opencode:project-agents',
        capturedAt,
      })
      if (!asset) continue
      seen.add(key)
      yield asset
    }
  }
}

export const openCodeProjectContextInternals = {
  directoriesFromProjectRoot,
  findProjectRoot,
}
