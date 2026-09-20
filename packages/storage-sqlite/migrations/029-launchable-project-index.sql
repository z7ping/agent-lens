CREATE TABLE IF NOT EXISTS launchable_project_index (
  project_key TEXT PRIMARY KEY,
  project_id TEXT,
  project_name TEXT,
  repository_identity TEXT,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_launchable_project_index_recent
ON launchable_project_index(last_seen_at DESC, project_key ASC);

CREATE INDEX IF NOT EXISTS idx_launchable_project_index_project
ON launchable_project_index(project_id);

CREATE TABLE IF NOT EXISTS launchable_workspace_index (
  project_key TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  validation_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK(validation_status IN ('unknown', 'valid', 'invalid')),
  validated_at TEXT,
  validated_path TEXT,
  PRIMARY KEY(project_key, workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_launchable_workspace_index_project_recent
ON launchable_workspace_index(project_key, last_seen_at DESC, workspace_id ASC);

CREATE INDEX IF NOT EXISTS idx_launchable_workspace_index_workspace
ON launchable_workspace_index(workspace_id);

INSERT INTO launchable_project_index(
  project_key,
  project_id,
  project_name,
  repository_identity,
  last_seen_at
)
WITH project_activity AS (
  SELECT
    logical.project_id AS project_key,
    logical.project_id AS project_id,
    project.name AS project_name,
    project.repository_identity AS repository_identity,
    MAX(COALESCE(logical.ended_at, logical.started_at, project.last_seen_at, '1970-01-01T00:00:00.000Z')) AS last_seen_at
  FROM logical_sessions AS logical
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
    MAX(COALESCE(logical.ended_at, logical.started_at, '1970-01-01T00:00:00.000Z')) AS last_seen_at
  FROM logical_sessions AS logical
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
FROM project_activity;

INSERT INTO launchable_workspace_index(
  project_key,
  workspace_id,
  workspace_path,
  last_seen_at,
  validation_status,
  validated_at,
  validated_path
)
SELECT
  COALESCE(logical.project_id, 'workspace:' || workspace.id) AS project_key,
  workspace.id AS workspace_id,
  workspace.path AS workspace_path,
  MAX(COALESCE(logical.ended_at, logical.started_at, project.last_seen_at, '1970-01-01T00:00:00.000Z')) AS last_seen_at,
  'unknown' AS validation_status,
  NULL AS validated_at,
  NULL AS validated_path
FROM logical_sessions AS logical
JOIN workspaces AS workspace
  ON workspace.id = logical.workspace_id
LEFT JOIN projects AS project
  ON project.id = logical.project_id
WHERE TRIM(workspace.path) <> ''
GROUP BY
  COALESCE(logical.project_id, 'workspace:' || workspace.id),
  workspace.id,
  workspace.path;
