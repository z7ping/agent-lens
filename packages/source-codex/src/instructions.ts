import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import {
  basename,
  dirname,
  join,
  resolve,
} from 'node:path'
import type {
  DiscoveredAsset,
  EvidenceCandidate,
  SourceExecutionContext,
} from '@agent-lens/core'
import { isMissingPathError } from '@agent-lens/source-support'
import {
  codexStringArray,
  type CodexTomlConfig,
} from './config'
import { listCodexProjectCwds } from './history'

const DEFAULT_PROJECT_ROOT_MARKERS = ['.git'] as const
const DEFAULT_INSTRUCTION_FILENAMES = ['AGENTS.override.md', 'AGENTS.md'] as const

interface CodexInstructionConfig {
  projectRootMarkers: string[]
  fallbackFilenames: string[]
}

function pathKey(value: string): string {
  const normalized = resolve(value).replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

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

function uniqueNonEmpty(values: readonly string[]): string[] {
  const output: string[] = []
  for (const value of values) {
    if (!value || output.includes(value)) continue
    output.push(value)
  }
  return output
}

function instructionConfigFromToml(
  parsed: CodexTomlConfig | null,
): CodexInstructionConfig | null {
  if (!parsed) return null

  const configuredMarkers = codexStringArray(parsed.project_root_markers)
  const configuredFallbacks = codexStringArray(parsed.project_doc_fallback_filenames)

  return {
    projectRootMarkers: configuredMarkers === undefined
      ? [...DEFAULT_PROJECT_ROOT_MARKERS]
      : configuredMarkers,
    fallbackFilenames: uniqueNonEmpty(configuredFallbacks ?? [])
      .filter(name => !DEFAULT_INSTRUCTION_FILENAMES.includes(name as typeof DEFAULT_INSTRUCTION_FILENAMES[number])),
  }
}
function candidateFilenames(config: CodexInstructionConfig): string[] {
  return uniqueNonEmpty([
    ...DEFAULT_INSTRUCTION_FILENAMES,
    ...config.fallbackFilenames,
  ])
}

async function findProjectRoot(cwd: string, markers: readonly string[]): Promise<string> {
  const normalizedCwd = resolve(cwd)
  if (!markers.length) return normalizedCwd

  let current = normalizedCwd
  while (true) {
    for (const marker of markers) {
      if (!marker) continue
      if (await safeStat(join(current, marker))) return current
    }
    const parent = dirname(current)
    if (parent === current) return normalizedCwd
    current = parent
  }
}

function directoriesFromRootToCwd(projectRoot: string, cwd: string): string[] {
  const root = resolve(projectRoot)
  let current = resolve(cwd)
  const directories: string[] = []

  while (true) {
    directories.push(current)
    if (pathKey(current) === pathKey(root)) break
    const parent = dirname(current)
    if (parent === current) return [resolve(cwd)]
    current = parent
  }

  return directories.reverse()
}

async function firstInstructionFile(
  directory: string,
  filenames: readonly string[],
): Promise<string | undefined> {
  for (const filename of filenames) {
    const path = join(directory, filename)
    const meta = await safeStat(path)
    if (meta?.isFile()) return path
  }
  return undefined
}

function observedEvidence(
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

function instructionStates(
  path: string,
  observedAt: string,
  capturedAt: string,
): NonNullable<DiscoveredAsset['states']> {
  const evidence = observedEvidence(path, observedAt, capturedAt)
  return [
    {
      state: 'configured',
      value: true,
      observedAt,
      evidenceCandidates: [evidence],
    },
    {
      state: 'discoverable',
      value: true,
      observedAt,
      evidenceCandidates: [evidence],
    },
  ]
}

async function globalInstructionAsset(
  configRoot: string,
  capturedAt: string,
): Promise<DiscoveredAsset | undefined> {
  for (const fileName of DEFAULT_INSTRUCTION_FILENAMES) {
    const filePath = join(configRoot, fileName)
    const meta = await safeStat(filePath)
    if (!meta?.isFile()) continue

    let content = ''
    try {
      content = await readFile(filePath, 'utf8')
    } catch (error) {
      if (isMissingPathError(error)) continue
      throw error
    }
    if (!content.trim()) continue

    const observedAt = meta.mtime.toISOString()
    return {
      definition: {
        type: 'rule',
        canonicalName: 'codex-global-instructions',
        displayName: fileName,
      },
      binding: {
        path: filePath,
        source: 'codex:global-rule',
        scope: 'user',
        scopeRoot: configRoot,
      },
      states: instructionStates(filePath, observedAt, capturedAt),
    }
  }
  return undefined
}

async function projectInstructionAssets(
  ctx: SourceExecutionContext,
  config: CodexInstructionConfig,
  capturedAt: string,
): Promise<DiscoveredAsset[]> {
  const filenames = candidateFilenames(config)
  const projectCwds = await listCodexProjectCwds(ctx.installation.dataRoot)
  const assets = new Map<string, DiscoveredAsset>()

  for (const cwd of projectCwds) {
    if (ctx.abortSignal.aborted) break

    const projectRoot = await findProjectRoot(cwd, config.projectRootMarkers)
    for (const directory of directoriesFromRootToCwd(projectRoot, cwd)) {
      const filePath = await firstInstructionFile(directory, filenames)
      if (!filePath) continue

      const key = pathKey(filePath)
      if (assets.has(key)) continue
      const meta = await safeStat(filePath)
      if (!meta?.isFile()) continue
      const observedAt = meta.mtime.toISOString()
      const name = basename(filePath)

      assets.set(key, {
        definition: {
          type: 'rule',
          canonicalName: name,
          displayName: name,
          upstreamIdentity: `codex-project-instruction:${sha256(key)}`,
        },
        binding: {
          path: filePath,
          source: 'codex:project-rule',
          scope: 'project',
          scopeRoot: projectRoot,
        },
        states: instructionStates(filePath, observedAt, capturedAt),
      })
    }
  }

  return [...assets.values()]
}

export async function* discoverCodexInstructions(
  ctx: SourceExecutionContext,
  capturedAt: string,
  parsedConfig: CodexTomlConfig | null,
): AsyncIterable<DiscoveredAsset> {
  const configRoot = ctx.installation.configRoot
  if (!configRoot || ctx.abortSignal.aborted) return

  const global = await globalInstructionAsset(configRoot, capturedAt)
  if (global) yield global

  const config = instructionConfigFromToml(parsedConfig)
  if (!config || ctx.abortSignal.aborted) return

  for (const asset of await projectInstructionAssets(ctx, config, capturedAt)) {
    if (ctx.abortSignal.aborted) return
    yield asset
  }
}

export const codexInstructionInternals = {
  candidateFilenames,
  directoriesFromRootToCwd,
  findProjectRoot,
  instructionConfigFromToml,
}
