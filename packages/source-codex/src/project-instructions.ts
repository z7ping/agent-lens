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
} from '@agent-lens/core'
import { asRecord, isMissingPathError } from '@agent-lens/source-support'
import { parse } from 'smol-toml'

const DEFAULT_PROJECT_ROOT_MARKERS = ['.git'] as const
const DEFAULT_CANDIDATE_FILENAMES = ['AGENTS.override.md', 'AGENTS.md'] as const

export interface CodexProjectInstructionConfig {
  projectRootMarkers: string[]
  fallbackFilenames: string[]
}

async function safeStat(path: string) {
  try {
    return await stat(path)
  } catch (error) {
    if (isMissingPathError(error)) return null
    throw error
  }
}

function stringArray(
  record: Record<string, unknown>,
  key: string,
): string[] | undefined | null {
  const value = record[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) return null
  return value as string[]
}

export async function readCodexProjectInstructionConfig(
  configRoot: string,
): Promise<CodexProjectInstructionConfig | null> {
  const configPath = join(configRoot, 'config.toml')
  const meta = await safeStat(configPath)
  if (!meta?.isFile()) {
    return {
      projectRootMarkers: [...DEFAULT_PROJECT_ROOT_MARKERS],
      fallbackFilenames: [],
    }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = asRecord(parse(await readFile(configPath, 'utf8')))
  } catch (error) {
    if (isMissingPathError(error)) {
      return {
        projectRootMarkers: [...DEFAULT_PROJECT_ROOT_MARKERS],
        fallbackFilenames: [],
      }
    }
    return null
  }

  const configuredMarkers = stringArray(parsed, 'project_root_markers')
  const configuredFallbacks = stringArray(parsed, 'project_doc_fallback_filenames')
  if (configuredMarkers === null || configuredFallbacks === null) return null

  return {
    projectRootMarkers: configuredMarkers ?? [...DEFAULT_PROJECT_ROOT_MARKERS],
    fallbackFilenames: configuredFallbacks ?? [],
  }
}

function candidateFilenames(config: CodexProjectInstructionConfig): string[] {
  const result = [...DEFAULT_CANDIDATE_FILENAMES]
  for (const candidate of config.fallbackFilenames) {
    if (!candidate || result.includes(candidate)) continue
    result.push(candidate)
  }
  return result
}

async function hasAnyProjectMarker(
  directory: string,
  markers: readonly string[],
): Promise<boolean> {
  for (const marker of markers) {
    if (await safeStat(join(directory, marker))) return true
  }
  return false
}

export async function findCodexProjectRoot(
  cwd: string,
  markers: readonly string[],
): Promise<string> {
  const start = resolve(cwd)
  if (!markers.length) return start

  let cursor = start
  while (true) {
    if (await hasAnyProjectMarker(cursor, markers)) return cursor
    const parent = dirname(cursor)
    if (parent === cursor) return start
    cursor = parent
  }
}

function directoriesFromRootToCwd(root: string, cwd: string): string[] {
  const resolvedRoot = resolve(root)
  const resolvedCwd = resolve(cwd)
  const reversed: string[] = []
  let cursor = resolvedCwd

  while (true) {
    reversed.push(cursor)
    if (cursor === resolvedRoot) break
    const parent = dirname(cursor)
    if (parent === cursor) return [resolvedCwd]
    cursor = parent
  }

  return reversed.reverse()
}

export async function findCodexProjectInstructionPaths(
  cwd: string,
  config: CodexProjectInstructionConfig,
): Promise<{ projectRoot: string; paths: string[] }> {
  const projectRoot = await findCodexProjectRoot(cwd, config.projectRootMarkers)
  const candidates = candidateFilenames(config)
  const paths: string[] = []

  for (const directory of directoriesFromRootToCwd(projectRoot, cwd)) {
    let selected: string | undefined
    for (const name of candidates) {
      const candidate = join(directory, name)
      const meta = await safeStat(candidate)
      if (meta?.isFile()) {
        selected = candidate
        break
      }
    }
    if (!selected) continue

    // Codex chooses the first existing candidate in a directory before reading it.
    // An empty override therefore shadows AGENTS.md instead of falling through to it.
    const selectedMeta = await safeStat(selected)
    if (selectedMeta?.isFile() && selectedMeta.size > 0) paths.push(selected)
  }

  return { projectRoot, paths }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
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

export async function discoverCodexProjectInstructionAssets(
  cwds: readonly string[],
  config: CodexProjectInstructionConfig,
  capturedAt: string,
): Promise<DiscoveredAsset[]> {
  const assets = new Map<string, DiscoveredAsset>()

  for (const cwd of cwds) {
    const { projectRoot, paths } = await findCodexProjectInstructionPaths(cwd, config)
    for (const path of paths) {
      const meta = await safeStat(path)
      if (!meta?.isFile() || meta.size === 0) continue
      const fileName = basename(path)
      const key = `${path}\u0000${projectRoot}`
      const observedAt = meta.mtime.toISOString()

      assets.set(key, {
        definition: {
          type: 'rule',
          canonicalName: `codex-project-instructions:${fileName.toLowerCase()}`,
          displayName: fileName,
          upstreamIdentity: `codex-project-instruction:${sha256(fileName.toLowerCase())}`,
        },
        binding: {
          path,
          source: 'codex:project-rule',
          scope: 'project',
          scopeRoot: projectRoot,
        },
        states: [
          {
            state: 'configured',
            value: true,
            observedAt,
            evidenceCandidates: [staticEvidence(path, observedAt, capturedAt)],
          },
          {
            // Static inventory cannot prove project trust, managed config layers or
            // the exact runtime instruction budget used by a particular Codex thread.
            state: 'discoverable',
            value: 'unknown',
            observedAt: capturedAt,
          },
        ],
      })
    }
  }

  return [...assets.values()]
}

export const codexProjectInstructionInternals = {
  candidateFilenames,
  directoriesFromRootToCwd,
}
