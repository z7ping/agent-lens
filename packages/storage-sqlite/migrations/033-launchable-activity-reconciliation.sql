-- Reconcile the launchable catalog with the same observed activity used by Review.
-- Keep cached filesystem validation when a workspace path has not changed.
DELETE FROM launchable_workspace_index
WHERE NOT EXISTS (
  SELECT 1
  FROM logical_sessions AS logical
  JOIN workspaces AS workspace ON workspace.id = logical.workspace_id
  WHERE workspace.id = launchable_workspace_index.workspace_id
    AND COALESCE(logical.project_id, 'workspace:' || workspace.id) = launchable_workspace_index.project_key
    AND TRIM(workspace.path) <> ''
);

INSERT INTO launchable_workspace_index(
  project_key, workspace_id, workspace_path, last_seen_at,
  validation_status, validated_at, validated_path
)
SELECT
  COALESCE(logical.project_id, 'workspace:' || workspace.id),
  workspace.id,
  workspace.path,
  MAX(MAX(
    COALESCE(summary.ended_at, '1970-01-01T00:00:00.000Z'),
    COALESCE(logical.ended_at, logical.started_at, project.last_seen_at, '1970-01-01T00:00:00.000Z')
  )),
  'unknown',
  NULL,
  NULL
FROM logical_sessions AS logical
JOIN workspaces AS workspace ON workspace.id = logical.workspace_id
LEFT JOIN projects AS project ON project.id = logical.project_id
LEFT JOIN session_summary_projection AS summary ON summary.logical_session_id = logical.id
WHERE TRIM(workspace.path) <> ''
GROUP BY COALESCE(logical.project_id, 'workspace:' || workspace.id), workspace.id, workspace.path
ON CONFLICT(project_key, workspace_id) DO UPDATE SET
  workspace_path = excluded.workspace_path,
  last_seen_at = excluded.last_seen_at,
  validation_status = CASE
    WHEN workspace_path = excluded.workspace_path THEN validation_status
    ELSE 'unknown'
  END,
  validated_at = CASE
    WHEN workspace_path = excluded.workspace_path THEN validated_at
    ELSE NULL
  END,
  validated_path = CASE
    WHEN workspace_path = excluded.workspace_path THEN validated_path
    ELSE NULL
  END;

DELETE FROM launchable_project_index
WHERE NOT EXISTS (
  SELECT 1 FROM launchable_workspace_index AS workspace
  WHERE workspace.project_key = launchable_project_index.project_key
);

INSERT INTO launchable_project_index(
  project_key, project_id, project_name, repository_identity, last_seen_at
)
SELECT
  workspace.project_key,
  CASE WHEN workspace.project_key LIKE 'workspace:%' THEN NULL ELSE workspace.project_key END,
  project.name,
  project.repository_identity,
  MAX(workspace.last_seen_at)
FROM launchable_workspace_index AS workspace
LEFT JOIN projects AS project ON project.id = CASE
  WHEN workspace.project_key LIKE 'workspace:%' THEN NULL
  ELSE workspace.project_key
END
GROUP BY workspace.project_key, project.name, project.repository_identity
ON CONFLICT(project_key) DO UPDATE SET
  project_id = excluded.project_id,
  project_name = excluded.project_name,
  repository_identity = excluded.repository_identity,
  last_seen_at = excluded.last_seen_at;

-- Summary projection is refreshed as new observations arrive, while the logical
-- session's ended_at often remains at its original session boundary.
CREATE TRIGGER IF NOT EXISTS trg_launchable_summary_insert
AFTER INSERT ON session_summary_projection
BEGIN
  UPDATE launchable_workspace_index
  SET last_seen_at = MAX(last_seen_at, NEW.ended_at)
  WHERE (project_key, workspace_id) IN (
    SELECT COALESCE(project_id, 'workspace:' || workspace_id), workspace_id
    FROM logical_sessions WHERE id = NEW.logical_session_id
  );
  UPDATE launchable_project_index
  SET last_seen_at = MAX(last_seen_at, NEW.ended_at)
  WHERE project_key IN (
    SELECT COALESCE(project_id, 'workspace:' || workspace_id)
    FROM logical_sessions WHERE id = NEW.logical_session_id AND workspace_id IS NOT NULL
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_launchable_summary_update
AFTER UPDATE OF ended_at ON session_summary_projection
BEGIN
  UPDATE launchable_workspace_index
  SET last_seen_at = MAX(last_seen_at, NEW.ended_at)
  WHERE (project_key, workspace_id) IN (
    SELECT COALESCE(project_id, 'workspace:' || workspace_id), workspace_id
    FROM logical_sessions WHERE id = NEW.logical_session_id
  );
  UPDATE launchable_project_index
  SET last_seen_at = MAX(last_seen_at, NEW.ended_at)
  WHERE project_key IN (
    SELECT COALESCE(project_id, 'workspace:' || workspace_id)
    FROM logical_sessions WHERE id = NEW.logical_session_id AND workspace_id IS NOT NULL
  );
END;
