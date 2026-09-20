import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 20_000
const GIT_MAX_BUFFER = 16 * 1024 * 1024

export interface GitWorkspaceSnapshot {
  rootPath: string
  treeSha: string
  capturedAt: string
}

export interface GitWorkspaceDiffEntry {
  path: string
  changeType: 'added' | 'modified' | 'deleted' | 'renamed'
  oldPath?: string
  additions?: number
  deletions?: number
}

export interface GitWorkspaceDiffResult {
  current: GitWorkspaceSnapshot
  changes: GitWorkspaceDiffEntry[]
}

async function git(
  cwd: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
    ...(options.env ? { env: options.env } : {}),
  })
  return stdout
}

async function gitRoot(workspacePath: string): Promise<string | null> {
  try {
    const value = (await git(workspacePath, ['rev-parse', '--show-toplevel'])).trim()
    return value ? resolve(value) : null
  } catch {
    return null
  }
}

async function hasHead(rootPath: string): Promise<boolean> {
  try {
    await git(rootPath, ['rev-parse', '--verify', 'HEAD'])
    return true
  } catch {
    return false
  }
}

/**
 * Materialize the current non-ignored workspace into an anonymous Git tree
 * using a temporary index. Real HEAD/index/worktree are never modified.
 *
 * Existing dirty and untracked files become part of the baseline tree, so a
 * later diff attributes only changes made after this snapshot.
 */
export async function captureGitWorkspaceSnapshot(
  workspacePath: string,
): Promise<GitWorkspaceSnapshot | null> {
  const rootPath = await gitRoot(workspacePath)
  if (!rootPath) return null

  const temporary = await mkdtemp(join(tmpdir(), 'agent-lens-git-tree-'))
  const indexPath = join(temporary, 'index')
  const env = {
    ...process.env,
    GIT_INDEX_FILE: indexPath,
  }

  try {
    if (await hasHead(rootPath)) {
      await git(rootPath, ['read-tree', 'HEAD'], { env })
    } else {
      await git(rootPath, ['read-tree', '--empty'], { env })
    }

    // This snapshots tracked changes plus non-ignored untracked files without
    // changing the user's real index or staging area.
    await git(rootPath, ['add', '-A', '--', '.'], { env })
    const treeSha = (await git(rootPath, ['write-tree'], { env })).trim()
    if (!/^[0-9a-f]{40,64}$/i.test(treeSha)) {
      throw new Error('Git workspace snapshot returned an invalid tree object')
    }
    return {
      rootPath,
      treeSha,
      capturedAt: new Date().toISOString(),
    }
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
  }
}

function parseNameStatus(output: string): Array<{
  status: string
  path: string
  oldPath?: string
}> {
  const tokens = output.split('\0').filter(Boolean)
  const result: Array<{ status: string; path: string; oldPath?: string }> = []

  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++]!
    if (status.startsWith('R')) {
      const oldPath = tokens[index++]
      const path = tokens[index++]
      if (oldPath && path) result.push({ status, path, oldPath })
      continue
    }
    const path = tokens[index++]
    if (path) result.push({ status, path })
  }
  return result
}

function parseNumStat(output: string): Map<string, { additions?: number; deletions?: number }> {
  const tokens = output.split('\0')
  const result = new Map<string, { additions?: number; deletions?: number }>()

  for (let index = 0; index < tokens.length;) {
    const token = tokens[index++]
    if (!token) continue
    const firstTab = token.indexOf('\t')
    const secondTab = firstTab < 0 ? -1 : token.indexOf('\t', firstTab + 1)
    if (firstTab < 0 || secondTab < 0) continue

    const rawAdditions = token.slice(0, firstTab)
    const rawDeletions = token.slice(firstTab + 1, secondTab)
    const embeddedPath = token.slice(secondTab + 1)
    let path = embeddedPath

    // With -z a rename/copy numstat record has an empty embedded path followed
    // by oldPath\0newPath\0. Attribute line counts to the resulting path.
    if (!path) {
      index += 1 // old path
      path = tokens[index++] ?? ''
    }
    if (!path) continue

    const additions = /^\d+$/.test(rawAdditions) ? Number(rawAdditions) : undefined
    const deletions = /^\d+$/.test(rawDeletions) ? Number(rawDeletions) : undefined
    result.set(path, {
      ...(additions === undefined ? {} : { additions }),
      ...(deletions === undefined ? {} : { deletions }),
    })
  }
  return result
}

function changeType(status: string): GitWorkspaceDiffEntry['changeType'] | undefined {
  const code = status[0]
  if (code === 'A') return 'added'
  if (code === 'D') return 'deleted'
  if (code === 'R') return 'renamed'
  if (code === 'M' || code === 'T') return 'modified'
  return undefined
}

/**
 * Compare a baseline against the workspace's current content. Both sides are
 * anonymous trees, so pre-existing dirty/untracked files are not falsely
 * attributed to the task and committed changes remain visible.
 */
export async function compareGitWorkspaceSnapshot(
  baseline: GitWorkspaceSnapshot,
): Promise<GitWorkspaceDiffResult | null> {
  const current = await captureGitWorkspaceSnapshot(baseline.rootPath)
  if (!current || current.rootPath !== baseline.rootPath) return null

  const [nameStatus, numStat] = await Promise.all([
    git(baseline.rootPath, [
      'diff',
      '--name-status',
      '-z',
      '--find-renames',
      baseline.treeSha,
      current.treeSha,
      '--',
    ]),
    git(baseline.rootPath, [
      'diff',
      '--numstat',
      '-z',
      '--find-renames',
      baseline.treeSha,
      current.treeSha,
      '--',
    ]),
  ])

  const lineCounts = parseNumStat(numStat)
  const changes = parseNameStatus(nameStatus).flatMap(item => {
    const type = changeType(item.status)
    if (!type) return []
    const counts = lineCounts.get(item.path)
    return [{
      path: item.path,
      changeType: type,
      ...(item.oldPath ? { oldPath: item.oldPath } : {}),
      ...(counts?.additions === undefined ? {} : { additions: counts.additions }),
      ...(counts?.deletions === undefined ? {} : { deletions: counts.deletions }),
    }]
  })
  return { current, changes }
}

export async function diffGitWorkspaceSnapshot(
  baseline: GitWorkspaceSnapshot,
): Promise<GitWorkspaceDiffEntry[] | null> {
  return (await compareGitWorkspaceSnapshot(baseline))?.changes ?? null
}

export const gitWorkspaceSnapshotInternals = {
  parseNameStatus,
  parseNumStat,
}
