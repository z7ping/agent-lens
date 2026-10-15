import { access, constants as fsConstants, opendir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { httpError } from './http-utils'

export interface BrowsableHostDirectory {
  name: string
  path: string
}

export interface HostDirectoryListing {
  path: string
  parentPath: string | null
  roots: string[]
  directories: BrowsableHostDirectory[]
  breadcrumbs: BrowsableHostDirectory[]
  truncated: boolean
  selectable: boolean
}

const MAX_SCAN = 2_048
const MAX_RESULTS = 300

let cachedWindowsDrives: { at: number; roots: string[] } | undefined
let inFlightDrives: Promise<string[]> | undefined

async function availableWindowsDrives(): Promise<string[]> {
  if (cachedWindowsDrives && Date.now() - cachedWindowsDrives.at < 60_000) return cachedWindowsDrives.roots
  if (inFlightDrives) return inFlightDrives
  inFlightDrives = Promise.all('CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(async letter => {
    const root = `${letter}:\\`
    try { return (await stat(root)).isDirectory() ? root : undefined }
    catch { return undefined }
  })).then(roots => {
    const present = roots.filter((root): root is string => Boolean(root))
    cachedWindowsDrives = { at: Date.now(), roots: present }
    return present
  }).finally(() => { inFlightDrives = undefined })
  return inFlightDrives
}

/** Read directory names only. Never read files, follow child symlinks, or mutate the host. */
export async function browseHostWorkingDirectory(requested?: string): Promise<HostDirectoryListing> {
  const path = requested?.trim() || homedir()
  if (path.length > 4096 || !isAbsolute(path)) throw httpError(400, '请选择运行 AgentLens 的主机上的绝对目录路径。')
  const normalized = resolve(path)
  try {
    const metadata = await stat(normalized)
    if (!metadata.isDirectory()) throw httpError(400, '路径不是目录。')
    await access(normalized, fsConstants.R_OK)
  } catch (error) {
    if (error && typeof error === 'object' && 'statusCode' in error) throw error
    const code = error && typeof error === 'object' ? (error as { code?: string }).code : undefined
    if (code === 'ENOENT' || code === 'ENOTDIR') throw httpError(404, '目录不存在。')
    throw httpError(403, '没有权限访问此目录。')
  }

  const directories: BrowsableHostDirectory[] = []
  let scanned = 0
  let truncated = false
  try {
    const handle = await opendir(normalized)
    for await (const entry of handle) {
      scanned += 1
      if (scanned > MAX_SCAN) { truncated = true; break }
      // Symlinks are deliberately omitted: a navigational listing must not traverse links accidentally.
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      if (directories.length >= MAX_RESULTS) { truncated = true; break }
      directories.push({ name: entry.name, path: join(normalized, entry.name) })
    }
  } catch (error) {
    const code = error && typeof error === 'object' ? (error as { code?: string }).code : undefined
    if (code === 'ENOENT' || code === 'ENOTDIR') throw httpError(404, '目录已不存在，请返回上级。')
    throw httpError(403, '无法列出目录，请检查访问权限。')
  }
  directories.sort((a, b) => a.name.localeCompare(b.name))
  let selectable = true
  try {
    await access(normalized, fsConstants.R_OK | fsConstants.W_OK)
  } catch {
    selectable = false
  }

  const roots = new Set<string>([parse(normalized).root, homedir()])
  if (process.platform === 'win32') {
    for (const root of await availableWindowsDrives()) roots.add(root)
  }
  const rootPath = parse(normalized).root
  let current = rootPath
  const breadcrumbs = [{ name: rootPath, path: rootPath }]
  for (const name of normalized.slice(rootPath.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, name)
    breadcrumbs.push({ name, path: current })
  }
  return {
    path: normalized,
    parentPath: dirname(normalized) === normalized ? null : dirname(normalized),
    roots: [...roots],
    directories,
    breadcrumbs,
    truncated,
    selectable,
  }
}
