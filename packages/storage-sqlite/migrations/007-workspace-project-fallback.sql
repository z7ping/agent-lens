-- 为只有 workspacePath、没有仓库元数据的来源建立可筛选的项目身份。
--
-- 1. 先修复升级前已经落库的 projectless workspace/session/observation；
-- 2. 再用触发器守住后续写入，直到来源拿到更强的 repositoryRoot / gitRemote 身份；
-- 3. 如果后续 workspace 被升级为显式项目，项目身份会继续向 session/observation 传播。

INSERT OR IGNORE INTO projects(id, name, repository_identity, created_at, last_seen_at)
SELECT
  CASE
    WHEN id LIKE 'workspace-%' THEN 'project-' || substr(id, 11)
    ELSE 'project-workspace-' || id
  END,
  NULL,
  path,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM workspaces
WHERE project_id IS NULL
  AND trim(path) <> '';

UPDATE workspaces
SET project_id = CASE
  WHEN id LIKE 'workspace-%' THEN 'project-' || substr(id, 11)
  ELSE 'project-workspace-' || id
END
WHERE project_id IS NULL
  AND trim(path) <> '';

UPDATE logical_sessions
SET project_id = (
  SELECT workspaces.project_id
  FROM workspaces
  WHERE workspaces.id = logical_sessions.workspace_id
)
WHERE project_id IS NULL
  AND workspace_id IS NOT NULL;

UPDATE observations
SET project_id = (
  SELECT workspaces.project_id
  FROM workspaces
  WHERE workspaces.id = observations.workspace_id
)
WHERE project_id IS NULL
  AND workspace_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_workspace_project_fallback_insert
AFTER INSERT ON workspaces
WHEN NEW.project_id IS NULL AND trim(NEW.path) <> ''
BEGIN
  INSERT OR IGNORE INTO projects(id, name, repository_identity, created_at, last_seen_at)
  VALUES (
    CASE
      WHEN NEW.id LIKE 'workspace-%' THEN 'project-' || substr(NEW.id, 11)
      ELSE 'project-workspace-' || NEW.id
    END,
    NULL,
    NEW.path,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );

  UPDATE workspaces
  SET project_id = CASE
    WHEN NEW.id LIKE 'workspace-%' THEN 'project-' || substr(NEW.id, 11)
    ELSE 'project-workspace-' || NEW.id
  END
  WHERE id = NEW.id AND project_id IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS trg_workspace_project_fallback_update
AFTER UPDATE OF project_id, path ON workspaces
WHEN NEW.project_id IS NULL AND trim(NEW.path) <> ''
BEGIN
  INSERT OR IGNORE INTO projects(id, name, repository_identity, created_at, last_seen_at)
  VALUES (
    CASE
      WHEN NEW.id LIKE 'workspace-%' THEN 'project-' || substr(NEW.id, 11)
      ELSE 'project-workspace-' || NEW.id
    END,
    NULL,
    NEW.path,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );

  UPDATE workspaces
  SET project_id = CASE
    WHEN NEW.id LIKE 'workspace-%' THEN 'project-' || substr(NEW.id, 11)
    ELSE 'project-workspace-' || NEW.id
  END
  WHERE id = NEW.id AND project_id IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS trg_workspace_project_propagate
AFTER UPDATE OF project_id ON workspaces
WHEN NEW.project_id IS NOT NULL
BEGIN
  UPDATE logical_sessions
  SET project_id = NEW.project_id
  WHERE workspace_id = NEW.id
    AND project_id IS NOT NEW.project_id;

  UPDATE observations
  SET project_id = NEW.project_id
  WHERE workspace_id = NEW.id
    AND project_id IS NOT NEW.project_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_logical_session_project_fallback_insert
AFTER INSERT ON logical_sessions
WHEN NEW.project_id IS NULL AND NEW.workspace_id IS NOT NULL
BEGIN
  UPDATE logical_sessions
  SET project_id = (
    SELECT workspaces.project_id FROM workspaces WHERE workspaces.id = NEW.workspace_id
  )
  WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_logical_session_project_fallback_update
AFTER UPDATE OF project_id, workspace_id ON logical_sessions
WHEN NEW.project_id IS NULL AND NEW.workspace_id IS NOT NULL
BEGIN
  UPDATE logical_sessions
  SET project_id = (
    SELECT workspaces.project_id FROM workspaces WHERE workspaces.id = NEW.workspace_id
  )
  WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_observation_project_fallback_insert
AFTER INSERT ON observations
WHEN NEW.project_id IS NULL AND NEW.workspace_id IS NOT NULL
BEGIN
  UPDATE observations
  SET project_id = (
    SELECT workspaces.project_id FROM workspaces WHERE workspaces.id = NEW.workspace_id
  )
  WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_observation_project_fallback_update
AFTER UPDATE OF project_id, workspace_id ON observations
WHEN NEW.project_id IS NULL AND NEW.workspace_id IS NOT NULL
BEGIN
  UPDATE observations
  SET project_id = (
    SELECT workspaces.project_id FROM workspaces WHERE workspaces.id = NEW.workspace_id
  )
  WHERE id = NEW.id;
END;
