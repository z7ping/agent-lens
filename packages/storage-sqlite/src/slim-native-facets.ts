import type { NativeFacetReader } from '@agent-lens/core'
import type { SqliteExecutor } from './executor'

/** Single slim-only, indexed project/Agent selector. Native session activity
 * is only metadata, not a SessionSummary full-event aggregation.
 */
export class SqliteSlimNativeFacetReader implements NativeFacetReader {
  constructor(private readonly executor:SqliteExecutor){
    if(!executor.slimSchema)throw new Error('Native facets require slim SQLite')
  }

  query(input:{projectLimit?:number}={}):ReturnType<NativeFacetReader['query']>{
    const limit=input.projectLimit??500
    if(!Number.isSafeInteger(limit)||limit<1||limit>5000){
      throw new RangeError('Slim project facet limit must be 1-5000')
    }
    return this.executor.run(()=>{
      const installations=this.executor.db.prepare(`
        SELECT product_id AS productId,id
        FROM agent_installations ORDER BY product_id,id
        LIMIT 10001
      `).all() as Array<{productId:string;id:string}>
      // Never claim complete discovery if the installation list was capped.
      if(installations.length>10000){
        throw new Error('Slim installation facet exceeds supported size')
      }
      const grouped=new Map<string,string[]>()
      for(const item of installations){
        const values=grouped.get(item.productId)??[]
        values.push(item.id)
        grouped.set(item.productId,values)
      }
      const projects=this.executor.db.prepare(`
        WITH native_activity AS (
          SELECT COALESCE(ctx.project_id,workspace.project_id) AS project_id,
            MAX(catalog.last_activity_at) AS last_activity_at
          FROM native_session_context AS ctx
          LEFT JOIN workspaces AS workspace ON workspace.id=ctx.workspace_id
          INNER JOIN native_session_catalog AS catalog
            ON catalog.source_id=ctx.source_id
            AND catalog.installation_id=ctx.installation_id
            AND catalog.native_session_id=ctx.native_session_id
            AND catalog.location_kind='native'
          GROUP BY COALESCE(ctx.project_id,workspace.project_id)
        )
        SELECT project.id,project.name,
          project.repository_identity AS repositoryIdentity,
          activity.last_activity_at AS lastActivityAt
        FROM projects AS project
        LEFT JOIN native_activity AS activity ON activity.project_id=project.id
        -- Local cwd-derived identities are valid only while still referenced.
        -- A later verified Git association may supersede their local identity.
        -- Keep unrelated legacy projects (which may not have a workspace).
        WHERE project.repository_identity IS NULL
          OR project.repository_identity NOT LIKE 'local-workspace:%'
          OR EXISTS(SELECT 1 FROM workspaces AS ws WHERE ws.project_id=project.id)
          OR EXISTS(SELECT 1 FROM native_session_context AS ctx WHERE ctx.project_id=project.id)
        ORDER BY COALESCE(activity.last_activity_at,project.last_seen_at) DESC,project.id
        LIMIT ?
      `).all(limit+1) as Array<{
        id:string;name:string|null;repositoryIdentity:string|null;lastActivityAt:string|null
      }>
      return {
        installedProducts:[...grouped].map(([productId,installationIds])=>({
          productId,installationIds,
        })),
        projects:projects.slice(0,limit).map(item=>({
          id:item.id,
          ...(item.name?{name:item.name}:{}),
          ...(item.repositoryIdentity?{repositoryIdentity:item.repositoryIdentity}:{}),
          ...(item.lastActivityAt?{lastActivityAt:item.lastActivityAt}:{}),
        })),
        projectsTruncated:projects.length>limit,
      }
    })
  }
}
