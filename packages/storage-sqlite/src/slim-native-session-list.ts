import type {
  NativeSessionListItem, NativeSessionListQuery, NativeSessionListReader,
} from '@agent-lens/core'
import { NATIVE_SESSION_METRIC_PROJECTION_VERSION } from '@agent-lens/core'
import type { SqliteExecutor } from './executor'

type ListRow = {
  source_id:string; installation_id:string; native_session_id:string
  review_session_id:string; last_activity_at:string; native_title:string|null
  title_override:string|null; title_kind:string|null
  runtime_profile_id:string|null; project_id:string|null
  project_name:string|null; workspace_id:string|null; workspace_path:string|null
  file_identity:string; file_size:number; file_mtime_ms:number
  metric_identity:string|null; metric_size:number|null; metric_mtime:number|null
  parser_version:string|null; projection_version:string|null; coverage:string|null
  interaction_count:number|null; tool_call_count:number|null; tool_result_count:number|null
  tool_error_count:number|null; error_count:number|null
  input_tokens:number|null; output_tokens:number|null
}

function nonempty(value:string|null):string|undefined {
  return value && value.trim()?value:undefined
}

/** An intentionally strict native-only list read model. Stale rollups do NOT
 * masquerade as all-zero Insights, and source-owned file paths never leave SQL.
 * The projection is bounded, ordered and indexed by native Catalog activity.
 */
export class SqliteSlimNativeSessionList implements NativeSessionListReader {
  constructor(private readonly executor:SqliteExecutor) {
    if (!executor.slimSchema) throw new Error('Native-only session list requires slim SQLite')
  }

  query(input:NativeSessionListQuery):Promise<{items:NativeSessionListItem[];hasMore:boolean}> {
    if(!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>200){
      throw new RangeError('Native session list limit must be 1-200')
    }
    for(const key of ['sourceId','installationId','projectId'] as const){
      if(input[key]!==undefined && (!input[key]!.trim() || input[key]!.length>512)){
        throw new TypeError('Invalid native session list '+key)
      }
    }
    if(input.search!==undefined && input.search.length>256){
      throw new RangeError('Native session list search exceeds 256 characters')
    }
    if(input.before && (!Number.isFinite(Date.parse(input.before.lastActivityAt))
      || !input.before.sourceId || !input.before.installationId
      || !input.before.nativeSessionId)){
      throw new TypeError('Invalid native session list cursor')
    }
    if(input.parserVersion!==undefined && (!input.parserVersion.trim() || input.parserVersion.length>512)) {
      throw new TypeError('Invalid native parser version')
    }
    if(input.coverageCertified!==undefined&&typeof input.coverageCertified!=='boolean'){
      throw new TypeError('Invalid native coverage certification')
    }
    if(input.sourceCertifications!==undefined && (
      !Array.isArray(input.sourceCertifications)
      || input.sourceCertifications.length>64
      || input.sourceCertifications.some(source=>
        !source.sourceId || source.sourceId.length>128
        || !source.parserVersion || source.parserVersion.length>512
        || typeof source.coverageCertified!=='boolean')
      || new Set(input.sourceCertifications.map(source=>source.sourceId)).size
        !==input.sourceCertifications.length)){
      throw new TypeError('Invalid per-source native metric certifications')
    }
    const certifications=input.sourceCertifications===undefined?undefined
      :new Map(input.sourceCertifications.map(source=>[source.sourceId,source] as const))
    const clauses=["c.location_kind='native'","c.review_session_id IS NOT NULL"]
    const values:Array<string|number>=[]
    if(input.sourceId){clauses.push('c.source_id=?');values.push(input.sourceId)}
    if(input.installationId){clauses.push('c.installation_id=?');values.push(input.installationId)}
    if(input.projectId){
      clauses.push('COALESCE(ctx.project_id,ws.project_id)=?')
      values.push(input.projectId)
    }
    const search=input.search?.trim()
    if(search){
      clauses.push(`(
        instr(lower(COALESCE(ctx.title_override,c.title,'')),lower(?))>0
        OR instr(lower(c.native_session_id),lower(?))>0
        OR instr(lower(COALESCE(project.name,'')),lower(?))>0
      )`)
      values.push(search,search,search)
    }
    if(input.before){
      clauses.push(`(c.last_activity_at,c.source_id,c.installation_id,c.native_session_id)
         < (?,?,?,?)`)
      values.push(input.before.lastActivityAt,input.before.sourceId,
        input.before.installationId,input.before.nativeSessionId)
    }
    return this.executor.run(()=>{
      const rows=this.executor.db.prepare(`
        SELECT c.source_id,c.installation_id,c.native_session_id,
          c.review_session_id,c.last_activity_at,c.title AS native_title,
          c.file_identity,c.file_size,c.file_mtime_ms,
          ctx.title_override,ctx.title_kind,ctx.runtime_profile_id,
          COALESCE(ctx.project_id,ws.project_id) AS project_id,
          project.name AS project_name,
          ctx.workspace_id,ws.path AS workspace_path,
          m.file_identity AS metric_identity,m.file_size AS metric_size,
          m.file_mtime_ms AS metric_mtime,m.parser_version,
          m.projection_version,m.coverage,
          m.interaction_count,m.tool_call_count,m.tool_result_count,
          m.tool_error_count,m.error_count,m.input_tokens,m.output_tokens
        FROM native_session_catalog AS c
        LEFT JOIN native_session_context AS ctx
          ON ctx.source_id=c.source_id AND ctx.installation_id=c.installation_id
          AND ctx.native_session_id=c.native_session_id
        LEFT JOIN workspaces AS ws ON ws.id=ctx.workspace_id
        LEFT JOIN projects AS project
          ON project.id=COALESCE(ctx.project_id,ws.project_id)
        LEFT JOIN native_session_metrics AS m
          ON m.source_id=c.source_id AND m.installation_id=c.installation_id
          AND m.native_session_id=c.native_session_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY c.last_activity_at DESC,c.source_id DESC,
          c.installation_id DESC,c.native_session_id DESC
        LIMIT ?
      `).all(...values,input.limit+1) as ListRow[]
      const items:NativeSessionListItem[]=rows.slice(0,input.limit).map(item=>{
        const certified=certifications?.get(item.source_id)
        const expectedVersion=certifications===undefined
          ?input.parserVersion:certified?.parserVersion
        const complete=certifications===undefined
          ?input.coverageCertified===true&&Boolean(expectedVersion)
          :certified?.coverageCertified===true
        const stale=item.metric_identity!==null && (
          (certifications!==undefined && !certified)
          item.metric_identity!==item.file_identity
          || item.metric_size!==item.file_size || item.metric_mtime!==item.file_mtime_ms
          || item.projection_version!==NATIVE_SESSION_METRIC_PROJECTION_VERSION
          || (expectedVersion!==undefined && item.parser_version!==expectedVersion)
        )
        const status:NativeSessionListItem['metricsState']=item.metric_identity===null
          ?'missing':stale?'stale'
          :item.coverage==='complete'&&complete?'complete':'partial'
        const title=nonempty(item.title_kind==='explicit'||item.title_kind==='generated'
          ?item.title_override:item.native_title)
        const titleProvenance:NativeSessionListItem['titleProvenance']=
          title && (item.title_kind==='explicit'||item.title_kind==='generated')
            ? item.title_kind : title?'native':'unknown'
        return {
          sourceId:item.source_id,installationId:item.installation_id,
          nativeSessionId:item.native_session_id,reviewSessionId:item.review_session_id,
          lastActivityAt:item.last_activity_at,titleProvenance,
          ...(title?{title}:{}),
          ...(nonempty(item.project_id)?{projectId:item.project_id!}:{}),
          ...(nonempty(item.project_name)?{projectName:item.project_name!}:{}),
          ...(nonempty(item.workspace_id)?{workspaceId:item.workspace_id!}:{}),
          ...(nonempty(item.workspace_path)?{workspacePath:item.workspace_path!}:{}),
          ...(nonempty(item.runtime_profile_id)?{runtimeProfileId:item.runtime_profile_id!}:{}),
          metricsState:status,
          ...((status==='partial'||status==='complete') ? {
            metrics:{
              interactionCount:item.interaction_count!,
              toolCallCount:item.tool_call_count!,
              toolResultCount:item.tool_result_count!,
              toolErrorCount:item.tool_error_count!,
              errorCount:item.error_count!,
              inputTokens:item.input_tokens,outputTokens:item.output_tokens,
            },
          } : {}),
        }
      })
      return {items,hasMore:rows.length>input.limit}
    })
  }
}
