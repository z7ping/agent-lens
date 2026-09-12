import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  AgentIntegrationRuntimeStatus,
  AgentInstallation,
  StorageService,
} from '@agent-lens/core'
import {
  AGENT_LENS_PROTOCOL_VERSION,
  type ManagedAssetDirectoryResponseDto,
  type ManagedAssetFileEntryDto,
  type ManagedAssetFilePreviewResponseDto,
  type ManagedAssetRoot,
} from '@agent-lens/protocol'
import { httpError, writeJson } from './http-utils'

const MAX_PREVIEW_BYTES = 512 * 1024
const BINARY_EXTENSIONS = new Set([
  '.7z', '.bin', '.bmp', '.db', '.dll', '.dylib', '.exe', '.gif', '.gz', '.ico',
  '.jpeg', '.jpg', '.jsonl', '.pdf', '.png', '.sqlite', '.sqlite3', '.so', '.tar',
  '.webp', '.zip',
])
const SENSITIVE_EXTENSIONS = new Set(['.key', '.p12', '.pem', '.pfx'])
const SENSITIVE_TOKENS = new Set([
  'credential',
  'credentials',
  'secret',
  'secrets',
  'token',
  'tokens',
])

type IntegrationStatusReader = (
  productId: string,
) => AgentIntegrationRuntimeStatus | null | Promise<AgentIntegrationRuntimeStatus | null>

function isPathInside(root: string, candidate: string): boolean {
  const value = relative(root, candidate)
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value))
}

function normalizeRelativePath(value: string | null): string {
  const raw = (value ?? '').trim()
  if (!raw) return ''
  if (raw.includes('\0') || isAbsolute(raw)) throw httpError(400, 'path must be a relative managed-root path')
  const normalized = raw.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (!normalized || normalized === '.') return ''
  if (normalized.split('/').some(part => !part || part === '.' || part === '..')) {
    throw httpError(400, 'path contains unsupported traversal segments')
  }
  return normalized
}

function relativePathForApi(value: string): string {
  return value.replaceAll('\\', '/')
}

function isSensitiveSegment(segment: string): boolean {
  const lower = segment.toLowerCase()
  if (lower === '.env' || lower.startsWith('.env.')) return true
  if (SENSITIVE_EXTENSIONS.has(extname(lower))) return true
  if (lower === 'auth.json' || lower === 'authentication.json' || lower === 'oauth.json') return true
  if (
    lower.includes('private-key')
    || lower.includes('private_key')
    || lower.includes('api-key')
    || lower.includes('api_key')
  ) return true
  return lower.split(/[-_.]/).some(token => SENSITIVE_TOKENS.has(token))
}

function isSensitivePath(relativePath: string): boolean {
  return relativePath
    .replaceAll('\\', '/')
    .split('/')
    .filter(Boolean)
    .some(isSensitiveSegment)
}

function isKnownBinaryPath(relativePath: string): boolean {
  return BINARY_EXTENSIONS.has(extname(relativePath).toLowerCase())
}

function looksBinary(content: Buffer): boolean {
  const sample = content.subarray(0, Math.min(content.length, 8192))
  if (!sample.length) return false
  let controls = 0
  for (const byte of sample) {
    if (byte === 0) return true
    if (byte < 9 || (byte > 13 && byte < 32)) controls += 1
  }
  return controls / sample.length > 0.08
}

function rootPathForInstallation(
  installation: AgentInstallation,
  root: ManagedAssetRoot,
): string | undefined {
  return root === 'config' ? installation.configRoot : installation.dataRoot
}

async function assertAssetsCapability(
  productId: string,
  readStatus?: IntegrationStatusReader,
): Promise<void> {
  if (!readStatus) return
  const status = await readStatus(productId)
  if (!status) throw httpError(404, 'integration not found')
  const assets = status.capabilities.find(item => item.capability === 'assets')
  if (!assets || assets.availability !== 'available') {
    throw httpError(503, 'integration assets capability is unavailable')
  }
}

async function resolveManagedTarget(
  rootPath: string,
  relativePath: string,
): Promise<{ rootRealPath: string; targetPath: string; targetRealPath: string }> {
  let rootRealPath: string
  try {
    rootRealPath = await realpath(rootPath)
  } catch {
    throw httpError(404, 'managed root is unavailable')
  }

  const targetPath = relativePath
    ? resolve(rootRealPath, ...relativePath.split('/'))
    : rootRealPath
  if (!isPathInside(rootRealPath, targetPath)) {
    throw httpError(403, 'managed path escapes root')
  }

  let targetRealPath: string
  try {
    targetRealPath = await realpath(targetPath)
  } catch {
    throw httpError(404, 'managed path does not exist')
  }
  if (!isPathInside(rootRealPath, targetRealPath)) {
    throw httpError(403, 'managed path resolves outside root')
  }

  return { rootRealPath, targetPath, targetRealPath }
}

async function entryForPath(
  rootRealPath: string,
  parentRelativePath: string,
  parentRealPath: string,
  name: string,
): Promise<ManagedAssetFileEntryDto> {
  const logicalPath = parentRelativePath ? `${parentRelativePath}/${name}` : name
  const path = join(parentRealPath, name)
  const linkMeta = await lstat(path)
  const symlink = linkMeta.isSymbolicLink()

  let targetPath = path
  let targetMeta = linkMeta
  let accessible = true
  if (symlink) {
    try {
      targetPath = await realpath(path)
      accessible = isPathInside(rootRealPath, targetPath)
      if (accessible) targetMeta = await stat(targetPath)
    } catch {
      accessible = false
    }
  }

  const kind: ManagedAssetFileEntryDto['kind'] = !accessible && symlink
    ? 'symlink'
    : targetMeta.isDirectory()
      ? 'directory'
      : targetMeta.isFile()
        ? 'file'
        : symlink
          ? 'symlink'
          : 'other'
  const sensitive = isSensitivePath(logicalPath)
  const previewable = kind === 'file'
    && accessible
    && !sensitive
    && !isKnownBinaryPath(logicalPath)
    && targetMeta.size <= MAX_PREVIEW_BYTES

  return {
    name,
    relativePath: relativePathForApi(logicalPath),
    kind,
    accessible,
    ...(symlink ? { symlink: true } : {}),
    ...(kind === 'file' ? { size: targetMeta.size } : {}),
    modifiedAt: targetMeta.mtime.toISOString(),
    ...(sensitive ? { sensitive: true } : {}),
    ...(kind === 'file' ? { previewable } : {}),
  }
}

export async function readManagedAssetDirectory(
  storage: StorageService,
  input: {
    productId: string
    installationId: string
    root: ManagedAssetRoot
    relativePath?: string
  },
): Promise<ManagedAssetDirectoryResponseDto> {
  const installation = await storage.repositories.installations.get(input.installationId)
  if (!installation || installation.productId !== input.productId) {
    throw httpError(404, 'installation not found for integration')
  }

  const rootPath = rootPathForInstallation(installation, input.root)
  if (!rootPath) throw httpError(404, `${input.root} root is unavailable`)
  if (!isAbsolute(rootPath)) throw httpError(400, 'managed root must be absolute')
  const relativePath = normalizeRelativePath(input.relativePath ?? '')
  const { rootRealPath, targetRealPath } = await resolveManagedTarget(rootPath, relativePath)
  const targetMeta = await stat(targetRealPath)
  if (!targetMeta.isDirectory()) throw httpError(400, 'managed path is not a directory')

  const dirEntries = await readdir(targetRealPath, { withFileTypes: true })
  const entries = await Promise.all(dirEntries.map(entry =>
    entryForPath(rootRealPath, relativePath, targetRealPath, entry.name)
  ))
  entries.sort((left, right) => {
    const leftDir = left.kind === 'directory' ? 0 : 1
    const rightDir = right.kind === 'directory' ? 0 : 1
    return leftDir - rightDir || left.name.localeCompare(right.name)
  })

  return {
    productId: input.productId,
    installationId: input.installationId,
    root: input.root,
    rootPath,
    relativePath,
    entries,
    meta: { protocolVersion: AGENT_LENS_PROTOCOL_VERSION },
  }
}

export async function readManagedAssetFile(
  storage: StorageService,
  input: {
    productId: string
    installationId: string
    root: ManagedAssetRoot
    relativePath: string
  },
): Promise<ManagedAssetFilePreviewResponseDto> {
  const installation = await storage.repositories.installations.get(input.installationId)
  if (!installation || installation.productId !== input.productId) {
    throw httpError(404, 'installation not found for integration')
  }

  const rootPath = rootPathForInstallation(installation, input.root)
  if (!rootPath) throw httpError(404, `${input.root} root is unavailable`)
  if (!isAbsolute(rootPath)) throw httpError(400, 'managed root must be absolute')
  const relativePath = normalizeRelativePath(input.relativePath)
  if (!relativePath) throw httpError(400, 'file path is required')
  if (isSensitivePath(relativePath)) throw httpError(403, 'sensitive files are not previewable')
  if (isKnownBinaryPath(relativePath)) throw httpError(415, 'binary or session files are not previewable')

  const { targetRealPath } = await resolveManagedTarget(rootPath, relativePath)
  const meta = await stat(targetRealPath)
  if (!meta.isFile()) throw httpError(400, 'managed path is not a file')
  if (meta.size > MAX_PREVIEW_BYTES) throw httpError(413, 'file is too large to preview')

  const content = await readFile(targetRealPath)
  if (looksBinary(content)) throw httpError(415, 'binary files are not previewable')

  return {
    productId: input.productId,
    installationId: input.installationId,
    root: input.root,
    rootPath,
    relativePath,
    name: basename(relativePath),
    size: meta.size,
    modifiedAt: meta.mtime.toISOString(),
    content: content.toString('utf8'),
    meta: { protocolVersion: AGENT_LENS_PROTOCOL_VERSION },
  }
}

function routeMatch(pathname: string): { productId: string; kind: 'files' | 'file' } | null {
  const match = pathname.match(/^\/api\/v1\/integrations\/([^/]+)\/assets\/(files|file)$/)
  if (!match) return null
  let productId: string
  try {
    productId = decodeURIComponent(match[1]!)
  } catch {
    throw httpError(400, 'integration id is malformed')
  }
  return {
    productId,
    kind: match[2] as 'files' | 'file',
  }
}

function queryRoot(url: URL): ManagedAssetRoot {
  const root = url.searchParams.get('root')
  if (root !== 'config' && root !== 'data') throw httpError(400, 'root must be config or data')
  return root
}

export async function handleManagedAssetFilesRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storage: StorageService,
  readIntegrationStatus?: IntegrationStatusReader,
): Promise<boolean> {
  const route = routeMatch(url.pathname)
  if (!route) return false

  if (request.method !== 'GET') {
    writeJson(response, 405, { error: 'method_not_allowed' })
    return true
  }

  await assertAssetsCapability(route.productId, readIntegrationStatus)

  const installationId = url.searchParams.get('installationId')?.trim()
  if (!installationId) throw httpError(400, 'installationId is required')
  const root = queryRoot(url)
  const relativePath = url.searchParams.get('path') ?? ''

  const body = route.kind === 'files'
    ? await readManagedAssetDirectory(storage, {
      productId: route.productId,
      installationId,
      root,
      relativePath,
    })
    : await readManagedAssetFile(storage, {
      productId: route.productId,
      installationId,
      root,
      relativePath,
    })

  writeJson(response, 200, body)
  return true
}

export const managedAssetFileInternals = {
  MAX_PREVIEW_BYTES,
  isKnownBinaryPath,
  isPathInside,
  isSensitivePath,
  looksBinary,
  normalizeRelativePath,
}
