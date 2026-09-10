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
    WITH project_activity AS (
      SELECT
        logical.project_id AS project_key,
        logical.project_id AS project_id,
        project.name AS project_name,
        project.repository_identity AS repository_identity,
        MAX(summary.ended_at) AS last_seen_at,
        GROUP_CONCAT(DISTINCT workspace.path) AS workspace_paths
      FROM session_summary_projection AS summary
      JOIN logical_sessions AS logical
        ON logical.id = summary.logical_session_id
      JOIN workspaces AS workspace
        ON workspace.id = logical.workspace_id
      LEFT JOIN projects AS project
        ON project.id = logical.project_id
      WHERE logical.project_id IS NOT NULL
        AND TRIM(workspace.path) <> ''
      GROUP BY logical.project_id, project.name, project.repository_identity

      UNION ALL

      SELECT
        'workspace:' || workspace.id AS project_key,
        NULL AS project_id,
        NULL AS project_name,
        NULL AS repository_identity,
        MAX(summary.ended_at) AS last_seen_at,
        workspace.path AS workspace_paths
      FROM session_summary_projection AS summary
      JOIN logical_sessions AS logical
        ON logical.id = summary.logical_session_id
      JOIN workspaces AS workspace
        ON workspace.id = logical.workspace_id
      WHERE logical.project_id IS NULL
        AND TRIM(workspace.path) <> ''
      GROUP BY workspace.id, workspace.path
    )
    SELECT
      project_key,
      project_id,
      project_name,
      repository_identity,
      last_seen_at
    FROM project_activity
    WHERE 1 = 1
      ${search ? `AND LOWER(
        COALESCE(project_name, '') || char(10) ||
        COALESCE(repository_identity, '') || char(10) ||
        COALESCE(workspace_paths, '')
      ) LIKE ?` : ''}
      ${after ? `AND (
        last_seen_at < ?
        OR (last_seen_at = ? AND project_key > ?)
      )` : ''}
    ORDER BY last_seen_at DESC, project_key ASC
    LIMIT ?
  `
}

function projectWorkspacesSql(projectId: boolean): string {
  return `
    SELECT
      workspace.id AS workspace_id,
      workspace.path AS workspace_path,
      MAX(summary.ended_at) AS last_seen_at
    FROM session_summary_projection AS summary
    JOIN logical_sessions AS logical
      ON logical.id = summary.logical_session_id
    JOIN workspaces AS workspace
      ON workspace.id = logical.workspace_id
    WHERE TRIM(workspace.path) <> ''
      AND ${projectId ? 'logical.project_id = ?' : 'logical.project_id IS NULL AND workspace.id = ?'}
    GROUP BY workspace.id, workspace.path
    ORDER BY last_seen_at DESC, workspace.id ASC
    LIMIT ?
  `
}

function mapWorkspace(value: unknown): LaunchableWorkspaceCandidate {
  const item = row(value)
  return {
    workspaceId: requiredString(item, 'workspace_id'),
    workspacePath: requiredString(item, 'workspace_path'),
    lastSeenAt: requiredString(item, 'last_seen_at'),
  }
}

/**
 * Lightweight read model over the existing Session Summary projection.
 *
 * No second project truth is persisted here: project identity/workspace paths come from Canonical
 * Project/Workspace rows and recency comes from session_summary_projection. The filesystem is not
 * consulted by this reader; the HTTP Runtime decides which candidate path is actually launchable
 * on the current host.
 */
export class SqliteLaunchableProjectReader implements LaunchableProjectReader {
  constructor(private readonly executor: SqliteExecutor) {}

  query(input: LaunchableProjectQuery): Promise<{ items: LaunchableProjectCandidate[]; hasMore: boolean }> {
    const limit = Math.max(1, Math.min(Math.floor(input.limit), MAX_LIMIT))
    const search = input.search?.trim().toLocaleLowerCase()
    return this.executor.run(() => {
      const params: unknown[] = []
      if (search) params.push(`%${search}%`)
      if (input.after) {
        params.push(input.after.lastSeenAt, input.after.lastSeenAt, input.after.key)
      }
      params.push(limit + 1)

      const values = this.executor.db.prepare(
        projectCandidatesSql(Boolean(search), Boolean(input.after)),
      ).all(...params)
      const hasMore = values.length > limit
      const selected = values.slice(0, limit)

      const items = selected.map(value => {
        const item = row(value)
        const key = requiredString(item, 'project_key')
        const projectId = optionalString(item, 'project_id')
        const projectName = optionalString(item, 'project_name')
        const repositoryIdentity = optionalString(item, 'repository_identity')
        const lastSeenAt = requiredString(item, 'last_seen_at')
        const workspaceKey = projectId ?? key.slice('workspace:'.length)
        const workspaces = this.executor.db.prepare(
          projectWorkspacesSql(Boolean(projectId)),
        ).all(workspaceKey, MAX_WORKSPACES_PER_PROJECT).map(mapWorkspace)

        return {
          key,
          ...(projectId ? { projectId } : {}),
          ...(projectName ? { projectName } : {}),
          ...(repositoryIdentity ? { repositoryIdentity } : {}),
          lastSeenAt,
          workspaces,
        }
      })

      return { items, hasMore }
    })
  }
}

export const launchableProjectInternals = {
  MAX_LIMIT,
  MAX_WORKSPACES_PER_PROJECT,
  projectCandidatesSql,
  projectWorkspacesSql,
}
