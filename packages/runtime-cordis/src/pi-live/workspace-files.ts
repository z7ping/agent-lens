import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { LiveWorkspaceFileReference } from '@agent-lens/core'

const CACHE_TTL_MS = 15_000
const MAX_INDEX_FILES = 5_000
const MAX_RESULTS = 50
const MAX_FALLBACK_DEPTH = 14
const GIT_TIMEOUT_MS = 2_500
const GIT_MAX_BUFFER = 4 * 1024 * 1024
const FALLBACK_IGNORED_DIRECTORIES = new Set([
  '.git',
  '.agent-lens',
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
])

interface CachedWorkspaceFiles {
  expiresAt: number
  files: string[]
}

function normalizeRelativePath(value: string): string | null {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').trim()
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return null
  if (normalized.split('/').some(part => part === '..')) return null
  return normalized
}

export function workspaceFileReferenceValue(path: string): string {
  if (!/[\s"]/.test(path)) return `@${path}`
  return `@"${path.replace(/"/g, '\\"')}"`
}

function gitFiles(cwd: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(
          stdout
            .split('\0')
            .flatMap(value => {
              const normalized = normalizeRelativePath(value)
              return normalized ? [normalized] : []
            })
            .slice(0, MAX_INDEX_FILES),
        )
      },
    )
  })
}

async function fallbackFiles(
  root: string,
  current = '',
  depth = 0,
  result: string[] = [],
): Promise<string[]> {
  if (result.length >= MAX_INDEX_FILES || depth > MAX_FALLBACK_DEPTH) return result
  const absolute = current ? join(root, ...current.split('/')) : root
  let entries
  try {
    entries = await readdir(absolute, { withFileTypes: true })
  } catch {
    return result
  }

  entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    if (result.length >= MAX_INDEX_FILES) break
    if (entry.isSymbolicLink()) continue
    const relative = current ? `${current}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (FALLBACK_IGNORED_DIRECTORIES.has(entry.name)) continue
      await fallbackFiles(root, relative, depth + 1, result)
      continue
    }
    if (!entry.isFile()) continue
    const normalized = normalizeRelativePath(relative)
    if (normalized) result.push(normalized)
  }
  return result
}

function matchScore(path: string, query: string): number {
  if (!query) return 100
  const haystack = path.toLocaleLowerCase()
  const fileName = basename(path).toLocaleLowerCase()
  const needle = query.toLocaleLowerCase()
  if (haystack === needle) return 0
  if (fileName === needle) return 1
  if (fileName.startsWith(needle)) return 2
  if (haystack.startsWith(needle)) return 3
  const segment = haystack.split('/').findIndex(value => value.startsWith(needle))
  if (segment >= 0) return 4 + segment
  const position = haystack.indexOf(needle)
  if (position >= 0) return 20 + position
  return Number.POSITIVE_INFINITY
}

export class PiWorkspaceFileReferenceIndex {
  private readonly cache = new Map<string, CachedWorkspaceFiles>()
  private readonly inFlight = new Map<string, Promise<string[]>>()

  constructor(private readonly now: () => number = Date.now) {}

  async search(
    workspacePath: string,
    query = '',
    limit = 20,
  ): Promise<LiveWorkspaceFileReference[]> {
    const files = await this.files(workspacePath)
    const boundedLimit = Math.max(1, Math.min(MAX_RESULTS, Number.isInteger(limit) ? limit : 20))
    const normalizedQuery = query.trim().replace(/^@/, '').replace(/^"/, '').replace(/"$/, '')
    return files
      .map(path => ({ path, score: matchScore(path, normalizedQuery) }))
      .filter(item => Number.isFinite(item.score))
      .sort((left, right) => left.score - right.score || left.path.localeCompare(right.path))
      .slice(0, boundedLimit)
      .map(({ path }) => ({
        path,
        value: workspaceFileReferenceValue(path),
      }))
  }

  private async files(workspacePath: string): Promise<string[]> {
    const cached = this.cache.get(workspacePath)
    if (cached && cached.expiresAt > this.now()) return cached.files

    const existing = this.inFlight.get(workspacePath)
    if (existing) return existing

    let pending!: Promise<string[]>
    pending = (async () => {
      let files: string[]
      try {
        files = await gitFiles(workspacePath)
      } catch {
        files = await fallbackFiles(workspacePath)
      }
      const unique = [...new Set(files)].slice(0, MAX_INDEX_FILES)
      this.cache.set(workspacePath, {
        expiresAt: this.now() + CACHE_TTL_MS,
        files: unique,
      })
      return unique
    })().finally(() => {
      if (this.inFlight.get(workspacePath) === pending) this.inFlight.delete(workspacePath)
    })
    this.inFlight.set(workspacePath, pending)
    return pending
  }
}

export const piWorkspaceFileReferenceInternals = {
  CACHE_TTL_MS,
  MAX_INDEX_FILES,
  MAX_RESULTS,
  MAX_FALLBACK_DEPTH,
  normalizeRelativePath,
  matchScore,
}
