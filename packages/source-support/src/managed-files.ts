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
const CONFIG_SECRET_ASSIGNMENT = /(?:api[_-]?(?:key|token)|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer[_-]?token|client[_-]?secret|secret[_-]?key|secret|token|password|passwd|authorization|private[_-]?key|credentials?)\s*["']?\s*[:=]\s*["']?(?!\$\{)[^"'\s,}\]]{6,}/i
const SECRET_CONFIG_KEY = /^(?:api[_-]?(?:key|token)|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer[_-]?token|client[_-]?secret|secret[_-]?key|secret|token|password|passwd|authorization|private[_-]?key|credentials?)$/i
const CONFIG_SECRET_LINE = /^(\s*["']?(?:api[_-]?(?:key|token)|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer[_-]?token|client[_-]?secret|secret[_-]?key|secret|token|password|passwd|authorization|private[_-]?key|credentials?)["']?\s*[:=]\s*)(.+?)(\s*(?:,|#.*)?\s*)$/gim
const REDACTED_SECRET = '[REDACTED]'

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

export interface ManagedFileMetadata {
  name: string
  relativePath: string
  size: number
  modifiedAt: string
}

export interface ManagedTextPreview extends ManagedFileMetadata {
  content: string
  redacted?: boolean
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
