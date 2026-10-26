import type { AgentInstallation, Host, Project, RuntimeProfile, Workspace } from '@agent-lens/core'

type SqliteRow = Record<string, unknown>

function rowRecord(value: unknown): SqliteRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('SQLite persistence returned a non-object row')
  }
  return value as SqliteRow
}
function requiredString(row: SqliteRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new TypeError(`SQLite row field ${key} must be a string`)
  return value
}

function optionalString(row: SqliteRow, key: string): string | undefined {
  const value = row[key]
  if (value == null) return undefined
  if (typeof value !== 'string') throw new TypeError(`SQLite row field ${key} must be a string or null`)
  return value
}

export function mapHost(value: unknown): Host {
  const row = rowRecord(value)
  return {
    id: requiredString(row, 'id'),
    name: requiredString(row, 'name'),
    platform: requiredString(row, 'platform'),
    arch: requiredString(row, 'arch'),
    createdAt: requiredString(row, 'created_at'),
    lastSeenAt: requiredString(row, 'last_seen_at'),
  }
}

export function mapInstallation(value: unknown): AgentInstallation {
  const row = rowRecord(value)
  const version = optionalString(row, 'version')
  const executable = optionalString(row, 'executable')
  const configRoot = optionalString(row, 'config_root')
  const dataRoot = optionalString(row, 'data_root')
  return {
    id: requiredString(row, 'id'),
    hostId: requiredString(row, 'host_id'),
    productId: requiredString(row, 'product_id'),
    ...(version === undefined ? {} : { version }),
    ...(executable === undefined ? {} : { executable }),
    ...(configRoot === undefined ? {} : { configRoot }),
    ...(dataRoot === undefined ? {} : { dataRoot }),
    firstSeenAt: requiredString(row, 'first_seen_at'),
    lastSeenAt: requiredString(row, 'last_seen_at'),
  }
}

export function mapRuntimeProfile(value: unknown): RuntimeProfile {
  const row = rowRecord(value)
  const name = optionalString(row, 'name')
  const configRoot = optionalString(row, 'config_root')
  const dataRoot = optionalString(row, 'data_root')
  return {
    id: requiredString(row, 'id'),
    installationId: requiredString(row, 'installation_id'),
    nativeProfileId: requiredString(row, 'native_profile_id'),
    ...(name === undefined ? {} : { name }),
    ...(configRoot === undefined ? {} : { configRoot }),
    ...(dataRoot === undefined ? {} : { dataRoot }),
    firstSeenAt: requiredString(row, 'first_seen_at'),
    lastSeenAt: requiredString(row, 'last_seen_at'),
  }
}

export function mapProject(value: unknown): Project {
  const row = rowRecord(value)
  const name = optionalString(row, 'name')
  const repositoryIdentity = optionalString(row, 'repository_identity')
  return {
    id: requiredString(row, 'id'),
    ...(name === undefined ? {} : { name }),
    ...(repositoryIdentity === undefined ? {} : { repositoryIdentity }),
    createdAt: requiredString(row, 'created_at'),
    lastSeenAt: requiredString(row, 'last_seen_at'),
  }
}

export function mapWorkspace(value: unknown): Workspace {
  const row = rowRecord(value)
  const projectId = optionalString(row, 'project_id')
  const repositoryId = optionalString(row, 'repository_id')
  const worktreeId = optionalString(row, 'worktree_id')
  return {
    id: requiredString(row, 'id'),
    hostId: requiredString(row, 'host_id'),
    ...(projectId === undefined ? {} : { projectId }),
    path: requiredString(row, 'path'),
    ...(repositoryId === undefined ? {} : { repositoryId }),
    ...(worktreeId === undefined ? {} : { worktreeId }),
  }
}
