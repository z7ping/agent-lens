import type {
  LaunchableProjectCandidate,
  LaunchableProjectQuery,
  LaunchableProjectReader,
  LaunchableWorkspaceCandidate,
} from '@agent-lens/core'
import type { SqliteExecutor } from './executor'

const MAX_LIMIT = 100
const MAX_WORKSPACES_PER_PROJECT = 64

type SqliteRow = Record<string, unknown>

function row(value: unknown): SqliteRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('SQLite launchable project query returned a non-object row')
  }
  return value as SqliteRow
}

function requiredString(value: SqliteRow, key: string): string {
  const item = value[key]
  if (typeof item !== 'string') throw new TypeError(`SQLite launchable project field ${key} must be a string`)
  return item
}

function optionalString(value: SqliteRow, key: string): string | undefined {
  const item = value[key]
  if (item == null) return undefined
  if (typeof item !== 'string') throw new TypeError(`SQLite launchable project field ${key} must be a string or null`)
  return item
}

function projectCandidatesSql(search: boolean, after: boolean): string {
  return `
    SELECT
      candidate.project_key,
      candidate.project_id,
      candidate.project_name,
      candidate.repository_identity,
      candidate.last_seen_at
    FROM launchable_project_index AS candidate
    WHERE 1 = 1
      ${search ? `AND (
        LOWER(COALESCE(candidate.project_name, '')) LIKE ?
        OR LOWER(COALESCE(candidate.repository_identity, '')) LIKE ?
        OR EXISTS (
          SELECT 1
          FROM launchable_workspace_index AS search_workspace
          WHERE search_workspace.project_key = candidate.project_key
            AND LOWER(search_workspace.workspace_path) LIKE ?
        )
      )` : ''}
      ${after ? `AND (
        candidate.last_seen_at < ?
        OR (candidate.last_seen_at = ? AND candidate.project_key > ?)
      )` : ''}
    ORDER BY candidate.last_seen_at DESC, candidate.project_key ASC
    LIMIT ?
  `
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

function projectWorkspacesBatchSql(projectCount: number): string {
  if (projectCount < 1) throw new Error('launchable workspace batch query requires at least one project')
  return `
    WITH ranked AS (
      SELECT
        project_key,
        workspace_id,
        workspace_path,
        last_seen_at,
        validation_status,
        validated_at,
        ROW_NUMBER() OVER (
          PARTITION BY project_key
          ORDER BY last_seen_at DESC, workspace_id ASC
        ) AS workspace_rank
      FROM launchable_workspace_index
      WHERE project_key IN (${placeholders(projectCount)})
    )
    SELECT
      project_key,
      workspace_id,
      workspace_path,
      last_seen_at,
      validation_status,
      validated_at
    FROM ranked
    WHERE workspace_rank <= ?
    ORDER BY project_key ASC, last_seen_at DESC, workspace_id ASC
  `
}

function mapWorkspace(value: unknown): LaunchableWorkspaceCandidate {
  const item = row(value)
  const validationStatus = optionalString(item, 'validation_status')
  const validatedAt = optionalString(item, 'validated_at')
  return {
    workspaceId: requiredString(item, 'workspace_id'),
    workspacePath: requiredString(item, 'workspace_path'),
    lastSeenAt: requiredString(item, 'last_seen_at'),
    ...(validationStatus === 'unknown' || validationStatus === 'valid' || validationStatus === 'invalid'
      ? { validationStatus }
      : {}),
    ...(validatedAt ? { validatedAt } : {}),
  }
}

interface SelectedProject {
  key: string
  projectId?: string
  projectName?: string
  repositoryIdentity?: string
  lastSeenAt: string
}

function mapSelectedProject(value: unknown): SelectedProject {
  const item = row(value)
  const projectId = optionalString(item, 'project_id')
  const projectName = optionalString(item, 'project_name')
  const repositoryIdentity = optionalString(item, 'repository_identity')
  return {
    key: requiredString(item, 'project_key'),
    ...(projectId ? { projectId } : {}),
    ...(projectName ? { projectName } : {}),
    ...(repositoryIdentity ? { repositoryIdentity } : {}),
    lastSeenAt: requiredString(item, 'last_seen_at'),
  }
}

/**
 * Incremental read model over Canonical Project / Workspace / Logical Session rows.
 *
 * Canonical writes maintain launchable_*_index in the same SQLite database. Reads therefore
 * avoid re-aggregating the whole logical_sessions history when Task Center opens.
 */
export class SqliteLaunchableProjectReader implements LaunchableProjectReader {
  constructor(private readonly executor: SqliteExecutor) {}

  query(input: LaunchableProjectQuery): Promise<{ items: LaunchableProjectCandidate[]; hasMore: boolean }> {
    const limit = Math.max(1, Math.min(Math.floor(input.limit), MAX_LIMIT))
    const search = input.search?.trim().toLocaleLowerCase()
    return this.executor.run(() => {
      const params: unknown[] = []
      if (search) {
        const pattern = `%${search}%`
        params.push(pattern, pattern, pattern)
      }
      if (input.after) {
        params.push(input.after.lastSeenAt, input.after.lastSeenAt, input.after.key)
      }
      params.push(limit + 1)

      const values = this.executor.db.prepare(
        projectCandidatesSql(Boolean(search), Boolean(input.after)),
      ).all(...params)
      const hasMore = values.length > limit
      const selected = values.slice(0, limit).map(mapSelectedProject)
      if (!selected.length) return { items: [], hasMore }

      const keys = selected.map(item => item.key)
      const workspaceRows = this.executor.db.prepare(
        projectWorkspacesBatchSql(keys.length),
      ).all(...keys, MAX_WORKSPACES_PER_PROJECT)

      const workspacesByProject = new Map<string, LaunchableWorkspaceCandidate[]>()
      for (const value of workspaceRows) {
        const item = row(value)
        const projectKey = requiredString(item, 'project_key')
        const workspaces = workspacesByProject.get(projectKey) ?? []
        workspaces.push(mapWorkspace(item))
        workspacesByProject.set(projectKey, workspaces)
      }

      return {
        items: selected.map(item => ({
          ...item,
          workspaces: workspacesByProject.get(item.key) ?? [],
        })),
        hasMore,
      }
    })
  }

  recordWorkspaceValidation(input: {
    workspaceId: string
    workspacePath: string
    status: 'valid' | 'invalid'
    validatedAt: string
  }): Promise<void> {
    return this.executor.run(() => {
      this.executor.db.prepare(`
        UPDATE launchable_workspace_index
        SET validation_status = ?,
            validated_at = ?,
            validated_path = ?
        WHERE workspace_id = ?
          AND workspace_path = ?
      `).run(
        input.status,
        input.validatedAt,
        input.workspacePath,
        input.workspaceId,
        input.workspacePath,
      )
    })
  }
}

export const launchableProjectInternals = {
  MAX_LIMIT,
  MAX_WORKSPACES_PER_PROJECT,
  projectCandidatesSql,
  projectWorkspacesBatchSql,
}
