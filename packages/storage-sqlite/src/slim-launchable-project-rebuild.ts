import type Database from 'better-sqlite3'

/** Rebuild Task Center launchable metadata from slim-only Project/Workspace
 * plus Native Catalog activity. No logical_sessions, stored Observations or
 * event summary projections are ever read.
 */
export function rebuildSlimLaunchableProjectIndex(db:Database.Database):void {
  const rebuild=db.transaction(()=>{
    // Keep explicit validation for unchanged workspace paths.
    const previous=db.prepare(`
      SELECT project_key,workspace_id,workspace_path,validation_status,
        validated_at,validated_path
      FROM launchable_workspace_index
      WHERE validation_status IN ('valid','invalid')
    `).all() as Array<{
      project_key:string;workspace_id:string;workspace_path:string
      validation_status:'valid'|'invalid';validated_at:string|null;validated_path:string|null
    }>
    db.exec('DELETE FROM launchable_workspace_index; DELETE FROM launchable_project_index;')
    db.exec(`
      INSERT INTO launchable_workspace_index (
        project_key,workspace_id,workspace_path,last_seen_at
      )
      SELECT COALESCE(link.project_id,'workspace:'||link.workspace_id),
        link.workspace_id,link.workspace_path,MAX(link.last_seen_at)
      FROM (
        SELECT workspace.id AS workspace_id, workspace.path AS workspace_path,
          COALESCE(context.project_id,workspace.project_id) AS project_id,
          COALESCE(MAX(catalog.last_activity_at),MAX(context.updated_at),
            MAX(project.last_seen_at),'1970-01-01T00:00:00.000Z') AS last_seen_at
        FROM workspaces AS workspace
        LEFT JOIN native_session_context AS context
          ON context.workspace_id=workspace.id
        LEFT JOIN native_session_catalog AS catalog
          ON catalog.source_id=context.source_id
          AND catalog.installation_id=context.installation_id
          AND catalog.native_session_id=context.native_session_id
          AND catalog.location_kind='native'
        LEFT JOIN projects AS project
          ON project.id=COALESCE(context.project_id,workspace.project_id)
        WHERE TRIM(workspace.path)<>''
        GROUP BY workspace.id,workspace.path,
          COALESCE(context.project_id,workspace.project_id)
      ) AS link
      GROUP BY COALESCE(link.project_id,'workspace:'||link.workspace_id),
        link.workspace_id,link.workspace_path;
      INSERT INTO launchable_project_index(
        project_key,project_id,project_name,repository_identity,last_seen_at
      )
      SELECT index_row.project_key,
        project.id,project.name,project.repository_identity,
        MAX(index_row.last_seen_at)
      FROM launchable_workspace_index AS index_row
      LEFT JOIN projects AS project ON project.id=index_row.project_key
      GROUP BY index_row.project_key;
    `)
    const keep=db.prepare(`
      UPDATE launchable_workspace_index
      SET validation_status=?,validated_at=?,validated_path=?
      WHERE project_key=? AND workspace_id=? AND workspace_path=?
    `)
    for(const item of previous) {
      keep.run(item.validation_status,item.validated_at,item.validated_path,
        item.project_key,item.workspace_id,item.workspace_path)
    }
  })
  rebuild()
}
