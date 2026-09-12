import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  posix,
  relative,
  resolve,
  sep,
} from 'node:path'
import { isMissingPathError } from './source-fs'

const SENSITIVE_FILE_NAME = /(?:^|[._-])(auth|credentials?|secrets?|tokens?)(?:[._-]|$)|\.(?:pem|key)$|^id_(?:rsa|ed25519)$/i
const HIGH_CONFIDENCE_SECRET = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]{24,}|\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}/i
const CONFIG_SECRET_ASSIGNMENT = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|authorization|private[_-]?key)\s*["']?\s*[:=]\s*["']?(?!\$\{)[^"'\s,}\]]{6,}/i

export const DEFAULT_MANAGED_FILE_PREVIEW_BYTES = 512 * 1024

export type ManagedFileErrorCode =
  | 'invalid-path'
  | 'not-found'
  | 'outside-root'
  | 'symlink'
  | 'not-directory'
  | 'not-file'
  | 'sensitive'
  | 'protected-data'
  | 'too-large'
  | 'binary'
  | 'unreadable'

export class ManagedFileError extends Error {
  constructor(
    readonly code: ManagedFileErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ManagedFileError'
  }
}

export type ManagedFileKind = 'file' | 'directory' | 'symlink' | 'other'

export interface ManagedDirectoryEntry {
  name: string
  relativePath: string
  kind: ManagedFileKind
  size?: number
  modifiedAt?: string
}

export interface ManagedDirectoryListing {
  relativePath: string
  entries: ManagedDirectoryEntry[]
}

export interface ManagedTextPreview {
  name: string
  relativePath: string
  size: number
  modifiedAt: string
  content: string
}

function fsErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : undefined
}

export function isPathInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

export function normalizeManagedRelativePath(value: string | undefined): string {
  const input = value?.trim() ?? ''
  if (!input) return ''
  if (input.includes('\u0000')) throw new ManagedFileError('invalid-path', 'Managed path contains a null byte')

  const portable = input.replaceAll('\\', '/')
  if (/^[A-Za-z]:\//.test(portable) || posix.isAbsolute(portable)) {
    throw new ManagedFileError('invalid-path', 'Managed path must be relative to its declared root')
  }

  const normalized = posix.normalize(portable)
  if (normalized === '.') return ''
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new ManagedFileError('invalid-path', 'Managed path cannot escape its declared root')
  }
  return normalized
}

export function isSensitiveFileName(path: string): boolean {
  return SENSITIVE_FILE_NAME.test(basename(path))
}

export function isEnvironmentSecretFileName(path: string): boolean {
  const name = basename(path).toLowerCase()
  return name === '.env' || name.startsWith('.env.') || name.endsWith('.env')
}

export function isProtectedRuntimeDataFile(path: string): boolean {
  const name = basename(path).toLowerCase()
  return name.endsWith('.jsonl')
    || name.endsWith('.sqlite')
    || name.endsWith('.sqlite3')
    || name.endsWith('.db')
    || name.endsWith('.db-wal')
    || name.endsWith('.db-shm')
}

export function containsHighConfidenceSecret(bytes: Uint8Array): boolean {
  const sample = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, DEFAULT_MANAGED_FILE_PREVIEW_BYTES))
  if (sample.includes(0)) return false
  return HIGH_CONFIDENCE_SECRET.test(sample.toString('utf8'))
}

export function containsConfigSecretAssignment(bytes: Uint8Array): boolean {
  const sample = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, DEFAULT_MANAGED_FILE_PREVIEW_BYTES))
  if (sample.includes(0)) return false
  return CONFIG_SECRET_ASSIGNMENT.test(sample.toString('utf8'))
}

function decodeUtf8(bytes: Uint8Array): string | null {
  if (Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

async function realPath(path: string, label: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if (isMissingPathError(error)) throw new ManagedFileError('not-found', `${label} does not exist`, { cause: error })
    throw new ManagedFileError('unreadable', `${label} cannot be resolved`, { cause: error })
  }
}

async function secureExistingPath(root: string, relativePath: string): Promise<{
  rootPath: string
  rootRealPath: string
  relativePath: string
  logicalPath: string
  realPath: string
  kind: Exclude<ManagedFileKind, 'symlink'>
  size: number
  modifiedAt: string
}> {
  const normalized = normalizeManagedRelativePath(relativePath)
  const rootPath = resolve(root)
  const rootRealPath = await realPath(rootPath, 'Managed root')
  const logicalPath = normalized ? resolve(rootPath, ...normalized.split('/')) : rootPath

  if (!isPathInside(rootPath, logicalPath)) {
    throw new ManagedFileError('outside-root', 'Managed path escapes its declared root')
  }

  let meta
  try {
    meta = await lstat(normalized ? logicalPath : rootRealPath)
  } catch (error) {
    if (isMissingPathError(error)) throw new ManagedFileError('not-found', 'Managed path does not exist', { cause: error })
    throw new ManagedFileError('unreadable', 'Managed path cannot be inspected', { cause: error })
  }

  if (normalized && meta.isSymbolicLink()) {
    const parentRealPath = await realPath(dirname(logicalPath), 'Managed path parent')
    if (!isPathInside(rootRealPath, parentRealPath)) {
      throw new ManagedFileError('outside-root', 'Managed path parent resolves outside its declared root')
    }
    throw new ManagedFileError('symlink', 'Symbolic links are not traversable in managed file browsing')
  }

  const resolvedPath = normalized ? await realPath(logicalPath, 'Managed path') : rootRealPath
  if (!isPathInside(rootRealPath, resolvedPath)) {
    throw new ManagedFileError('outside-root', 'Managed path resolves outside its declared root')
  }

  const kind: Exclude<ManagedFileKind, 'symlink'> = meta.isFile()
    ? 'file'
    : meta.isDirectory()
      ? 'directory'
      : 'other'

  return {
    rootPath,
    rootRealPath,
    relativePath: normalized,
    logicalPath,
    realPath: resolvedPath,
    kind,
    size: meta.size,
    modifiedAt: meta.mtime.toISOString(),
  }
}

export async function listManagedDirectory(
  root: string,
  relativePath = '',
): Promise<ManagedDirectoryListing> {
  const target = await secureExistingPath(root, relativePath)
  if (target.kind !== 'directory') {
    throw new ManagedFileError('not-directory', 'Managed path is not a directory')
  }

  let entries
  try {
    entries = await readdir(target.realPath, { withFileTypes: true })
  } catch (error) {
    throw new ManagedFileError('unreadable', 'Managed directory cannot be read', { cause: error })
  }

  const values: ManagedDirectoryEntry[] = []
  for (const entry of entries) {
    const childPath = resolve(target.realPath, entry.name)
    let meta
    try {
      meta = await lstat(childPath)
    } catch (error) {
      if (isMissingPathError(error)) continue
      throw new ManagedFileError('unreadable', `Managed entry cannot be inspected: ${entry.name}`, { cause: error })
    }

    const kind: ManagedFileKind = meta.isSymbolicLink()
      ? 'symlink'
      : meta.isDirectory()
        ? 'directory'
        : meta.isFile()
          ? 'file'
          : 'other'
    const childRelativePath = target.relativePath
      ? posix.join(target.relativePath, entry.name)
      : entry.name

    values.push({
      name: entry.name,
      relativePath: childRelativePath,
      kind,
      ...(kind === 'file' ? { size: meta.size } : {}),
      modifiedAt: meta.mtime.toISOString(),
    })
  }

  values.sort((a, b) => {
    const rank = (value: ManagedFileKind) => value === 'directory' ? 0 : value === 'file' ? 1 : value === 'symlink' ? 2 : 3
    return rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name)
  })

  return { relativePath: target.relativePath, entries: values }
}

export async function previewManagedTextFile(
  root: string,
  relativePath: string,
  maxBytes = DEFAULT_MANAGED_FILE_PREVIEW_BYTES,
): Promise<ManagedTextPreview> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('maxBytes must be a positive safe integer')
  }

  const target = await secureExistingPath(root, relativePath)
  if (target.kind !== 'file') throw new ManagedFileError('not-file', 'Managed path is not a file')
  if (isSensitiveFileName(target.logicalPath) || isEnvironmentSecretFileName(target.logicalPath)) {
    throw new ManagedFileError('sensitive', 'Managed file is protected by its file name')
  }
  if (isProtectedRuntimeDataFile(target.logicalPath)) {
    throw new ManagedFileError('protected-data', 'Runtime and session data files are not previewable')
  }
  if (target.size > maxBytes) {
    throw new ManagedFileError('too-large', `Managed file exceeds preview limit of ${maxBytes} bytes`)
  }

  let bytes
  try {
    bytes = await readFile(target.realPath)
  } catch (error) {
    const code = fsErrorCode(error)
    if (code === 'EACCES' || code === 'EPERM') {
      throw new ManagedFileError('unreadable', 'Managed file cannot be read', { cause: error })
    }
    if (isMissingPathError(error)) throw new ManagedFileError('not-found', 'Managed file no longer exists', { cause: error })
    throw error
  }
  if (bytes.byteLength > maxBytes) {
    throw new ManagedFileError('too-large', `Managed file exceeds preview limit of ${maxBytes} bytes`)
  }

  const afterReadPath = await realPath(target.logicalPath, 'Managed file')
  if (afterReadPath !== target.realPath || !isPathInside(target.rootRealPath, afterReadPath)) {
    throw new ManagedFileError('outside-root', 'Managed file changed location during preview')
  }

  const content = decodeUtf8(bytes)
  if (content === null) throw new ManagedFileError('binary', 'Managed file is not valid UTF-8 text')
  if (containsHighConfidenceSecret(bytes) || containsConfigSecretAssignment(bytes)) {
    throw new ManagedFileError('sensitive', 'Managed file contains protected credential material')
  }

  return {
    name: basename(target.logicalPath),
    relativePath: target.relativePath,
    size: bytes.byteLength,
    modifiedAt: target.modifiedAt,
    content,
  }
}
