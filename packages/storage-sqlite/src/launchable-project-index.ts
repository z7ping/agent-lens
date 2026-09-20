import type Database from 'better-sqlite3'

const EPOCH = '1970-01-01T00:00:00.000Z'

interface SessionIndexRef {
  projectId?: string
  workspaceId?: string
}

function projectKey(projectId: string | undefined, workspaceId: string): string {
  return projectId ?? `workspace:${workspaceId}`
}

function refreshWorkspacePair(
  db: Database.Database,
  projectId: string | undefined,
  workspaceId: string,
): void {
  const key = projectKey(projectId, workspaceId)
  const condition = projectId
    ? 'logical.project_id = ?'
    : 'logical.project_id IS NULL'
  const params = projectId ? [workspaceId, projectId] : [workspaceId]
  const value = db.prepare(`
    SELECT
      workspace.id AS workspace_id,
      workspace.path AS workspace_path,
      MAX(COALESCE(logical.ended_at, logical.started_at, project.last_seen_at, '${EPOCH}')) AS last_seen_at
    FROM logical_sessions AS logical
    JOIN workspaces AS workspace
      ON workspace.id = logical.workspace_id
    LEFT JOIN projects AS project
      ON project.id = logical.project_id
    WHERE logical.workspace_id = ?
      AND ${condition}
      AND TRIM(workspace.path) <> ''
    GROUP BY workspace.id, workspace.path
  `).get(...params) as { workspace_id?: unknown; workspace_path?: unknown; last_seen_at?: unknown } | undefined

  if (!value || typeof value.workspace_id !== 'string' || typeof value.workspace_path !== 'string'
    || typeof value.last_seen_at !== 'string') {
    db.prepare(`
      DELETE FROM launchable_workspace_index
      WHERE project_key = ? AND workspace_id = ?
    `).run(key, workspaceId)
    return
  }

  db.prepare(`
    INSERT INTO launchable_workspace_index(
      project_key,
      workspace_id,
      workspace_path,
      last_seen_at,
      validation_status,
      validated_at,
      validated_path
    ) VALUES (?, ?, ?, ?, 'unknown', NULL, NULL)
    ON CONFLICT(project_key, workspace_id) DO UPDATE SET
      workspace_path = excluded.workspace_path,
      last_seen_at = excluded.last_seen_at,
      validation_status = CASE
        WHEN launchable_workspace_index.workspace_path = excluded.workspace_path
          THEN launchable_workspace_index.validation_status
        ELSE 'unknown'
      END,
      validated_at = CASE
        WHEN launchable_workspace_index.workspace_path = excluded.workspace_path
          THEN launchable_workspace_index.validated_at
        ELSE NULL
      END,
      validated_path = CASE
        WHEN launchable_workspace_index.workspace_path = excluded.workspace_path
          THEN launchable_workspace_index.validated_path
        ELSE NULL
      END
  `).run(key, workspaceId, value.workspace_path, value.last_seen_at)
}

function refreshProjectKey(
  db: Database.Database,
  projectId: string | undefined,
  workspaceId: string,
): void {
  const key = projectKey(projectId, workspaceId)
  const activity = db.prepare(`
    SELECT MAX(last_seen_at) AS last_seen_at
    FROM launchable_workspace_index
    WHERE project_key = ?
  `).get(key) as { last_seen_at?: unknown } | undefined

  if (!activity || typeof activity.last_seen_at !== 'string') {
    db.prepare('DELETE FROM launchable_project_index WHERE project_key = ?').run(key)
    return
  }

  let projectName: string | null = null
  let repositoryIdentity: string | null = null
  if (projectId) {
    const project = db.prepare(`
      SELECT name, repository_identity
      FROM projects
      WHERE id = ?
    `).get(projectId) as { name?: unknown; repository_identity?: unknown } | undefined
    projectName = typeof project?.name === 'string' ? project.name : null
    repositoryIdentity = typeof project?.repository_identity === 'string'
      ? project.repository_identity
      : null
  }

  db.prepare(`
    INSERT INTO launchable_project_index(
      project_key,
      project_id,
      project_name,
      repository_identity,
      last_seen_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_key) DO UPDATE SET
      project_id = excluded.project_id,
      project_name = excluded.project_name,
      repository_identity = excluded.repository_identity,
      last_seen_at = excluded.last_seen_at
  `).run(key, projectId ?? null, projectName, repositoryIdentity, activity.last_seen_at)
}

function refKey(ref: SessionIndexRef): string | undefined {
  if (!ref.workspaceId) return undefined
  return `${ref.projectId ?? '<none>'}\u0000${ref.workspaceId}`
}

export function refreshLaunchableSessionIndex(
  db: Database.Database,
  previous: SessionIndexRef | undefined,
  next: SessionIndexRef,
): void {
  const refs = new Map<string, SessionIndexRef>()
  for (const ref of [previous, next]) {
    if (!ref?.workspaceId) continue
    const key = refKey(ref)
    if (key) refs.set(key, ref)
  }

  for (const ref of refs.values()) {
    refreshWorkspacePair(db, ref.projectId, ref.workspaceId!)
  }
  for (const ref of refs.values()) {
    refreshProjectKey(db, ref.projectId, ref.workspaceId!)
  }
}

export function refreshLaunchableWorkspaceDefinition(
  db: Database.Database,
  workspaceId: string,
): void {
  const affected = db.prepare(`
    SELECT DISTINCT project_key
    FROM launchable_workspace_index
    WHERE workspace_id = ?
  `).all(workspaceId) as Array<{ project_key?: unknown }>

  const workspace = db.prepare(`
    SELECT path
    FROM workspaces
    WHERE id = ?
  `).get(workspaceId) as { path?: unknown } | undefined
  const path = typeof workspace?.path === 'string' ? workspace.path : ''

  if (!path.trim()) {
    db.prepare('DELETE FROM launchable_workspace_index WHERE workspace_id = ?').run(workspaceId)
  } else {
    db.prepare(`
      UPDATE launchable_workspace_index
      SET workspace_path = ?,
          validation_status = CASE WHEN workspace_path = ? THEN validation_status ELSE 'unknown' END,
          validated_at = CASE WHEN workspace_path = ? THEN validated_at ELSE NULL END,
          validated_path = CASE WHEN workspace_path = ? THEN validated_path ELSE NULL END
      WHERE workspace_id = ?
    `).run(path, path, path, path, workspaceId)
  }

  for (const item of affected) {
    if (typeof item.project_key !== 'string') continue
    const row = db.prepare(`
      SELECT project_id, workspace_id
      FROM launchable_workspace_index
      WHERE project_key = ?
      ORDER BY last_seen_at DESC, workspace_id ASC
      LIMIT 1
    `).get(item.project_key) as { project_id?: unknown; workspace_id?: unknown } | undefined
    const projectId = item.project_key.startsWith('workspace:')
      ? undefined
      : item.project_key
    const fallbackWorkspaceId = item.project_key.startsWith('workspace:')
      ? item.project_key.slice('workspace:'.length)
      : typeof row?.workspace_id === 'string'
        ? row.workspace_id
        : workspaceId
    refreshProjectKey(db, projectId, fallbackWorkspaceId)
  }
}

export function refreshLaunchableProjectMetadata(
  db: Database.Database,
  projectId: string,
): void {
  const project = db.prepare(`
    SELECT name, repository_identity
    FROM projects
    WHERE id = ?
  `).get(projectId) as { name?: unknown; repository_identity?: unknown } | undefined

  db.prepare(`
    UPDATE launchable_project_index
    SET project_name = ?,
        repository_identity = ?
    WHERE project_key = ?
  `).run(
    typeof project?.name === 'string' ? project.name : null,
    typeof project?.repository_identity === 'string' ? project.repository_identity : null,
    projectId,
  )
}
