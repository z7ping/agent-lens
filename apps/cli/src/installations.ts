import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export type InstallationKind = 'npm' | 'desktop'

export interface InstallationRecord {
  schemaVersion: 1
  kind: InstallationKind
  version: string
  executable: string
  hookRoot: string
  electronRunAsNode: boolean
  registeredAt: string
  updatedAt: string
}

export interface InstallationStatus {
  kind: InstallationKind
  record: InstallationRecord | null
  valid: boolean
  reason?: string
}

export interface RegisterInstallationInput {
  kind: InstallationKind
  version: string
  executable: string
  hookRoot: string
  electronRunAsNode?: boolean
  homeDir?: string
}

function dataRoot(homeDir = homedir()): string {
  return join(homeDir, '.agent-lens', '1.0')
}

export function installationsDir(homeDir = homedir()): string {
  return join(dataRoot(homeDir), 'installations')
}

export function installationPath(kind: InstallationKind, homeDir = homedir()): string {
  return join(installationsDir(homeDir), `${kind}.json`)
}

function atomicWriteSync(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
}

function isInstallationRecord(value: unknown, kind: InstallationKind): value is InstallationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<InstallationRecord>
  return record.schemaVersion === 1
    && record.kind === kind
    && typeof record.version === 'string'
    && typeof record.executable === 'string'
    && typeof record.hookRoot === 'string'
    && typeof record.electronRunAsNode === 'boolean'
    && typeof record.registeredAt === 'string'
    && typeof record.updatedAt === 'string'
}

function readRecordSync(kind: InstallationKind, homeDir?: string): InstallationRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(installationPath(kind, homeDir), 'utf8')) as unknown
    return isInstallationRecord(parsed, kind) ? parsed : null
  } catch {
    return null
  }
}

function validateRecord(record: InstallationRecord | null): { valid: boolean; reason?: string } {
  if (!record) return { valid: false, reason: '未登记' }
  if (!existsSync(record.executable)) return { valid: false, reason: '执行入口已不存在' }
  if (!existsSync(record.hookRoot)) return { valid: false, reason: 'Hook 目录已不存在' }
  if (!existsSync(join(record.hookRoot, 'agent-lens-hook-codex.mjs'))) return { valid: false, reason: 'Codex Hook 已不存在' }
  if (!existsSync(join(record.hookRoot, 'agent-lens-hook-claude.mjs'))) return { valid: false, reason: 'Claude Hook 已不存在' }
  return { valid: true }
}

export function registerInstallationSync(input: RegisterInstallationInput): InstallationRecord {
  const previous = readRecordSync(input.kind, input.homeDir)
  const now = new Date().toISOString()
  const record: InstallationRecord = {
    schemaVersion: 1,
    kind: input.kind,
    version: input.version,
    executable: input.executable,
    hookRoot: input.hookRoot,
    electronRunAsNode: input.electronRunAsNode === true,
    registeredAt: previous?.registeredAt ?? now,
    updatedAt: now,
  }
  atomicWriteSync(installationPath(input.kind, input.homeDir), `${JSON.stringify(record, null, 2)}\n`)
  return record
}

export function getInstallationStatusSync(kind: InstallationKind, homeDir?: string): InstallationStatus {
  const record = readRecordSync(kind, homeDir)
  const validity = validateRecord(record)
  return { kind, record, ...validity }
}

export function listInstallationStatusSync(homeDir?: string): InstallationStatus[] {
  return [
    getInstallationStatusSync('desktop', homeDir),
    getInstallationStatusSync('npm', homeDir),
  ]
}

export async function registerInstallation(input: RegisterInstallationInput): Promise<InstallationRecord> {
  return registerInstallationSync(input)
}

export async function getInstallationStatus(kind: InstallationKind, homeDir?: string): Promise<InstallationStatus> {
  return getInstallationStatusSync(kind, homeDir)
}

export async function listInstallationStatus(homeDir?: string): Promise<InstallationStatus[]> {
  return listInstallationStatusSync(homeDir)
}

export const installationInternals = {
  dataRoot,
  isInstallationRecord,
  validateRecord,
  readRecordSync,
}
