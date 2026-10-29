import { createHash } from 'node:crypto'
import type {
  Host, HostIdentityHint, AgentInstallation, InstallationIdentityHint,
  Project, ProjectIdentityHint, Workspace, WorkspaceIdentityHint, IdentityService,
} from '@agent-lens/core'
import type { SqliteExecutor } from './executor'
import { isSlimDatabase } from './slim-schema'
import { mapHost, mapInstallation, mapProject, mapWorkspace } from './repository-row-mappers'

function stableId(prefix:string,parts:unknown[]):string {
  return prefix+'-'+createHash('sha256')
    .update(JSON.stringify(parts)).digest('hex').slice(0,32)
}
function normalizedPath(value:string):string {
  const normal=value.replace(/\\/g,'/').replace(/\/+$/,'')
  return /^[A-Za-z]:\//.test(normal)?normal.toLowerCase():normal
}
const now=()=>new Date().toISOString()

/** Metadata-only identity writer. Uses EXACT historic stable ID rules for
 * Host/Installation/Project/Workspace to preserve attribution across a
 * one-time migration; never creates LogicalSession/SourceSession/Observation.
 */
export class SqliteSlimIdentityService implements Pick<IdentityService,
  'resolveHost'|'resolveInstallation'|'resolveProject'|'resolveWorkspace'> {
  constructor(private readonly executor:SqliteExecutor){
    if(!isSlimDatabase(executor.db))throw new Error('Slim identities require slim SQLite')
  }

  resolveHost(hint:HostIdentityHint):Promise<Host> {
    const name=hint.name??'local'
    const platform=hint.platform??'unknown'
    const arch=hint.arch??'unknown'
    const id=stableId('host',[name,platform,arch])
    return this.executor.run(()=>{
      const db=this.executor.db
      const existing=db.prepare('SELECT * FROM hosts WHERE id=?').get(id) as
        Record<string,unknown>|undefined
      const host:Host={
        id,name,platform,arch,
        createdAt:existing?mapHost(existing).createdAt:now(),lastSeenAt:now(),
      }
      db.prepare(`INSERT INTO hosts(
        id,name,platform,arch,created_at,last_seen_at
      ) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,platform=excluded.platform,arch=excluded.arch,
        last_seen_at=excluded.last_seen_at`).run(
        host.id,host.name,host.platform,host.arch,host.createdAt,host.lastSeenAt)
      return host
    })
  }

  resolveInstallation(hint:InstallationIdentityHint):Promise<AgentInstallation> {
    return this.executor.run(()=>{
      const db=this.executor.db
      db.prepare(`INSERT OR IGNORE INTO agent_products(id,name) VALUES (?,?)`)
        .run(hint.productId,hint.productId)
      const existingRows=hint.dataRoot ? db.prepare(`
        SELECT * FROM agent_installations
        WHERE host_id=? AND product_id=? ORDER BY first_seen_at,id
      `).all(hint.hostId,hint.productId) as Record<string,unknown>[] : []
      const shared=existingRows.map(mapInstallation).find(row=>
        row.dataRoot!==undefined
        &&normalizedPath(row.dataRoot)===normalizedPath(hint.dataRoot!)
        &&normalizedPath(row.configRoot??'')===normalizedPath(hint.configRoot??''))
      const id=shared?.id??stableId('installation',[
        hint.hostId,hint.productId,hint.executable??'',
        hint.configRoot??'',hint.dataRoot??'',
      ])
      const existing=db.prepare('SELECT * FROM agent_installations WHERE id=?')
        .get(id) as Record<string,unknown>|undefined
      const previous=existing?mapInstallation(existing):undefined
      const item:AgentInstallation={
        id,hostId:hint.hostId,productId:hint.productId,
        ...(hint.version??previous?.version?{version:hint.version??previous!.version}:{}),
        ...(hint.executable??previous?.executable?{executable:hint.executable??previous!.executable}:{}),
        ...(hint.configRoot??previous?.configRoot?{configRoot:hint.configRoot??previous!.configRoot}:{}),
        ...(hint.dataRoot??previous?.dataRoot?{dataRoot:hint.dataRoot??previous!.dataRoot}:{}),
        firstSeenAt:previous?.firstSeenAt??now(),lastSeenAt:now(),
      }
      db.prepare(`INSERT INTO agent_installations(
        id,host_id,product_id,version,executable,config_root,data_root,
        first_seen_at,last_seen_at
      ) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        host_id=excluded.host_id,product_id=excluded.product_id,
        version=excluded.version,executable=excluded.executable,
        config_root=excluded.config_root,data_root=excluded.data_root,
        last_seen_at=excluded.last_seen_at`).run(
        item.id,item.hostId,item.productId,item.version??null,item.executable??null,
        item.configRoot??null,item.dataRoot??null,item.firstSeenAt,item.lastSeenAt)
      return item
    })
  }

  resolveProject(hint:ProjectIdentityHint):Promise<Project|null> {
    const identity=hint.repositoryIdentity??hint.name
    if(!identity)return Promise.resolve(null)
    const id=stableId('project',[identity])
    return this.executor.run(()=>{
      const db=this.executor.db
      const value=db.prepare('SELECT * FROM projects WHERE id=?')
        .get(id) as Record<string,unknown>|undefined
      const old=value?mapProject(value):undefined
      const name=hint.name??old?.name
      const repositoryIdentity=hint.repositoryIdentity??old?.repositoryIdentity
      const item:Project={
        id,
        ...(name?{name}:{}),
        ...(repositoryIdentity?{repositoryIdentity}:{}),
        createdAt:old?.createdAt??now(),lastSeenAt:now(),
      }
      db.prepare(`INSERT INTO projects(
        id,name,repository_identity,created_at,last_seen_at
      ) VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,repository_identity=excluded.repository_identity,
        last_seen_at=excluded.last_seen_at`).run(
        item.id,item.name??null,item.repositoryIdentity??null,
        item.createdAt,item.lastSeenAt)
      db.prepare(`UPDATE launchable_project_index
        SET project_name=?,repository_identity=?
        WHERE project_id=?`).run(item.name??null,item.repositoryIdentity??null,item.id)
      return item
    })
  }

  async resolveWorkspace(hint:WorkspaceIdentityHint):Promise<Workspace|null> {
    const path=hint.path??hint.repositoryRoot
    if(!path)return null
    const id=stableId('workspace',[hint.hostId,normalizedPath(path)])
    const explicitRepository=Boolean(hint.repositoryRoot||hint.gitRemote)
    // A verified native cwd is a real local workspace even without Git.
    // Preserve any existing repository-backed project ID, otherwise create a
    // path-scoped LOCAL project (never pretend a Git remote was discovered).
    const known=await this.executor.run(()=>this.executor.db.prepare(
      'SELECT project_id FROM workspaces WHERE id=?',
    ).get(id) as {project_id:string|null}|undefined)
    const project=explicitRepository
      ?await this.resolveProject({
        ...(hint.repositoryRoot?{name:hint.repositoryRoot.split(/[\\/]/).filter(Boolean).at(-1)}:{}),
        repositoryIdentity:hint.gitRemote??hint.repositoryRoot!,
      })
      :!known?.project_id && (path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path)
        || path.startsWith('\\\\'))
        ?await this.resolveProject({
          name:path.split(/[\\/]/).filter(Boolean).at(-1)??path,
          repositoryIdentity:'local-workspace:'+hint.hostId+':'+normalizedPath(path),
        })
        :null
    return this.executor.run(()=>{
      const db=this.executor.db
      const value=db.prepare('SELECT * FROM workspaces WHERE id=?')
        .get(id) as Record<string,unknown>|undefined
      const old=value?mapWorkspace(value):undefined
      const repositoryId=hint.gitRemote??old?.repositoryId
      const workspace:Workspace={
        id,hostId:hint.hostId,
        ...(project?.id??old?.projectId?{projectId:project?.id??old!.projectId}:{}),
        path,
        ...(repositoryId?{repositoryId}:{}),
        ...(old?.worktreeId?{worktreeId:old.worktreeId}:{}),
      }
      db.prepare(`INSERT INTO workspaces(
        id,host_id,project_id,path,repository_id,worktree_id
      ) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        host_id=excluded.host_id,project_id=excluded.project_id,
        path=excluded.path,repository_id=excluded.repository_id,
        worktree_id=excluded.worktree_id`).run(
        workspace.id,workspace.hostId,workspace.projectId??null,
        workspace.path,workspace.repositoryId??null,workspace.worktreeId??null)
      const key=workspace.projectId??'workspace:'+id
      const at=now()
      const p=workspace.projectId
        ?db.prepare('SELECT name,repository_identity FROM projects WHERE id=?')
          .get(workspace.projectId) as {name:string|null;repository_identity:string|null}|undefined
        :undefined
      db.prepare(`INSERT INTO launchable_project_index(
        project_key,project_id,project_name,repository_identity,last_seen_at
      ) VALUES (?,?,?,?,?)
      ON CONFLICT(project_key) DO UPDATE SET
        project_name=excluded.project_name,
        repository_identity=excluded.repository_identity,
        last_seen_at=MAX(launchable_project_index.last_seen_at,excluded.last_seen_at)
      `).run(key,workspace.projectId??null,p?.name??null,p?.repository_identity??null,at)
      db.prepare(`INSERT INTO launchable_workspace_index(
        project_key,workspace_id,workspace_path,last_seen_at
      ) VALUES (?,?,?,?)
      ON CONFLICT(project_key,workspace_id) DO UPDATE SET
        workspace_path=excluded.workspace_path,
        last_seen_at=excluded.last_seen_at,
        validation_status=CASE WHEN launchable_workspace_index.workspace_path=excluded.workspace_path
          THEN launchable_workspace_index.validation_status ELSE 'unknown' END,
        validated_at=CASE WHEN launchable_workspace_index.workspace_path=excluded.workspace_path
          THEN launchable_workspace_index.validated_at ELSE NULL END,
        validated_path=CASE WHEN launchable_workspace_index.workspace_path=excluded.workspace_path
          THEN launchable_workspace_index.validated_path ELSE NULL END`
      ).run(key,id,path,at)
      return workspace
    })
  }
}
