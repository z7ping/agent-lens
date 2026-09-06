import type { SqliteExecutor } from './executor'

export interface FacetScopeProject {
  id: string
  name?: string
  repositoryIdentity?: string
}

export interface FacetScopeSnapshot {
  projects: FacetScopeProject[]
  from?: string
  to?: string
}

export class SqliteFacetScopeReader {
  constructor(private readonly executor: SqliteExecutor) {}

  query(): Promise<FacetScopeSnapshot> {
    return this.executor.run(() => {
      const range = this.executor.db.prepare(`
        SELECT MIN(started_at) AS "from", MAX(ended_at) AS "to"
        FROM session_summary_projection
      `).get() as { from?: string | null; to?: string | null }

      const projects = this.executor.db.prepare(`
        SELECT DISTINCT
          project.id AS id,
          project.name AS name,
          project.repository_identity AS repositoryIdentity
        FROM session_summary_projection AS summary
        JOIN logical_sessions AS logical ON logical.id = summary.logical_session_id
        JOIN projects AS project ON project.id = logical.project_id
        WHERE logical.project_id IS NOT NULL
        ORDER BY COALESCE(project.name, project.id), project.id
      `).all() as Array<{ id: string; name?: string | null; repositoryIdentity?: string | null }>

      return {
        projects: projects.map(project => ({
          id: project.id,
          ...(project.name ? { name: project.name } : {}),
          ...(project.repositoryIdentity ? { repositoryIdentity: project.repositoryIdentity } : {}),
        })),
        ...(range.from ? { from: range.from } : {}),
        ...(range.to ? { to: range.to } : {}),
      }
    })
  }
}
