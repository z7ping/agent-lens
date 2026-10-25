import type {
  NativeSessionMetricReadResult,
  NativeSessionMetricSnapshot,
  NativeSessionMetricsStore,
  NativeSessionMetricOverview,
  NativeSessionMetricOverviewQuery,
} from '@agent-lens/core'
import { NATIVE_SESSION_METRIC_PROJECTION_VERSION } from '@agent-lens/core'
import type { SqliteExecutor } from './executor'

type Identity = Pick<NativeSessionMetricSnapshot,'sourceId'|'installationId'|'nativeSessionId'>

function assertSnapshot(snapshot: NativeSessionMetricSnapshot): void {
  for (const key of ['sourceId','installationId','nativeSessionId','fileIdentity','parserVersion','projectionVersion','computedAt'] as const) {
    if (!snapshot[key] || snapshot[key].length > 512) {
      throw new TypeError(`Invalid native metric ${key}`)
    }
  }
  if (!Number.isFinite(Date.parse(snapshot.computedAt))) {
    throw new TypeError('Native metrics require a valid computation time')
  }
  if (!Number.isSafeInteger(snapshot.fileSize) || snapshot.fileSize < 0
    || !Number.isFinite(snapshot.fileMtimeMs)
    || !['complete','partial'].includes(snapshot.coverage)) {
    throw new TypeError('Invalid native metric source revision or coverage')
  }
  for (const key of ['interactionCount','toolCallCount','toolResultCount','toolErrorCount','errorCount'] as const) {
    if (!Number.isSafeInteger(snapshot[key]) || snapshot[key] < 0) {
      throw new TypeError(`Invalid native metric ${key}`)
    }
  }
  for (const key of ['inputTokens','outputTokens'] as const) {
    const value = snapshot[key]
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      throw new TypeError(`Invalid native metric ${key}`)
    }
  }
  if (snapshot.tools.length > 256) throw new RangeError('Too many aggregated native tools')
  const seen = new Set<string>()
  for (const tool of snapshot.tools) {
    if (!tool.nativeToolName.trim() || tool.nativeToolName.length > 128
      || seen.has(tool.nativeToolName)) throw new TypeError('Invalid or duplicate native tool name')
    seen.add(tool.nativeToolName)
    for (const key of ['callCount','resultCount','errorCount','totalDurationMs'] as const) {
      if (!Number.isSafeInteger(tool[key]) || tool[key] < 0) {
        throw new TypeError(`Invalid native tool metric ${key}`)
      }
    }
  }
}

type SnapshotRow = {
  source_id:string; installation_id:string; native_session_id:string
  file_identity:string; file_size:number; file_mtime_ms:number
  parser_version:string; projection_version:string; coverage:'complete'|'partial'
  interaction_count:number; tool_call_count:number; tool_result_count:number
  tool_error_count:number; error_count:number
  input_tokens:number|null; output_tokens:number|null; computed_at:string
}
type ToolRow = {
  native_tool_name:string;call_count:number;result_count:number
  error_count:number;total_duration_ms:number
}

export class SqliteNativeSessionMetrics implements NativeSessionMetricsStore {
  constructor(private readonly executor: SqliteExecutor) {}

  /** An exact Catalog revision is required before overwriting derived totals. */
  async replace(input: NativeSessionMetricSnapshot): Promise<boolean> {
    assertSnapshot(input)
    return this.executor.transaction(async () => {
      const exists = this.executor.db.prepare(`
        SELECT 1 FROM native_session_catalog WHERE
          source_id=? AND installation_id=? AND native_session_id=?
          AND file_identity=? AND file_size=? AND file_mtime_ms=?
        LIMIT 1
      `).get(input.sourceId,input.installationId,input.nativeSessionId,
        input.fileIdentity,input.fileSize,input.fileMtimeMs)
      if (!exists) return false
      this.executor.db.prepare(`
        INSERT INTO native_session_metrics (
          source_id,installation_id,native_session_id,
          file_identity,file_size,file_mtime_ms,parser_version,projection_version,
          coverage,interaction_count,tool_call_count,tool_result_count,
          tool_error_count,error_count,input_tokens,output_tokens,computed_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(source_id,installation_id,native_session_id) DO UPDATE SET
          file_identity=excluded.file_identity,file_size=excluded.file_size,
          file_mtime_ms=excluded.file_mtime_ms,parser_version=excluded.parser_version,
          projection_version=excluded.projection_version,coverage=excluded.coverage,
          interaction_count=excluded.interaction_count,tool_call_count=excluded.tool_call_count,
          tool_result_count=excluded.tool_result_count,tool_error_count=excluded.tool_error_count,
          error_count=excluded.error_count,input_tokens=excluded.input_tokens,
          output_tokens=excluded.output_tokens,computed_at=excluded.computed_at
      `).run(
        input.sourceId,input.installationId,input.nativeSessionId,
        input.fileIdentity,input.fileSize,input.fileMtimeMs,input.parserVersion,
        input.projectionVersion,input.coverage,input.interactionCount,input.toolCallCount,
        input.toolResultCount,input.toolErrorCount,input.errorCount,input.inputTokens,
        input.outputTokens,input.computedAt,
      )
      this.executor.db.prepare(`
        DELETE FROM native_session_tool_metrics
        WHERE source_id=? AND installation_id=? AND native_session_id=?
      `).run(input.sourceId,input.installationId,input.nativeSessionId)
      const insert = this.executor.db.prepare(`
        INSERT INTO native_session_tool_metrics (
          source_id,installation_id,native_session_id,native_tool_name,
          call_count,result_count,error_count,total_duration_ms
        ) VALUES (?,?,?,?,?,?,?,?)
      `)
      for (const tool of input.tools) insert.run(
        input.sourceId,input.installationId,input.nativeSessionId,tool.nativeToolName,
        tool.callCount,tool.resultCount,tool.errorCount,tool.totalDurationMs,
      )
      return true
    })
  }

  async get(identity: Identity): Promise<NativeSessionMetricReadResult> {
    return this.executor.run(() => {
      const row = this.executor.db.prepare(`
        SELECT * FROM native_session_metrics
        WHERE source_id=? AND installation_id=? AND native_session_id=?
      `).get(identity.sourceId,identity.installationId,identity.nativeSessionId) as SnapshotRow | undefined
      if (!row) return { state:'missing' } as const
      const current = this.executor.db.prepare(`
        SELECT 1 FROM native_session_catalog WHERE
          source_id=? AND installation_id=? AND native_session_id=?
          AND file_identity=? AND file_size=? AND file_mtime_ms=?
        LIMIT 1
      `).get(row.source_id,row.installation_id,row.native_session_id,
        row.file_identity,row.file_size,row.file_mtime_ms)
      if (!current) return { state:'stale' } as const
      const tools = this.executor.db.prepare(`
        SELECT * FROM native_session_tool_metrics
        WHERE source_id=? AND installation_id=? AND native_session_id=?
        ORDER BY native_tool_name
      `).all(identity.sourceId,identity.installationId,identity.nativeSessionId) as ToolRow[]
      return {
        state:'available' as const,
        snapshot:{
          sourceId:row.source_id,installationId:row.installation_id,
          nativeSessionId:row.native_session_id,fileIdentity:row.file_identity,
          fileSize:row.file_size,fileMtimeMs:row.file_mtime_ms,
          parserVersion:row.parser_version,projectionVersion:row.projection_version,
          coverage:row.coverage,interactionCount:row.interaction_count,
          toolCallCount:row.tool_call_count,toolResultCount:row.tool_result_count,
          toolErrorCount:row.tool_error_count,errorCount:row.error_count,
          inputTokens:row.input_tokens,outputTokens:row.output_tokens,
          computedAt:row.computed_at,
          tools:tools.map(tool=>({
            nativeToolName:tool.native_tool_name,callCount:tool.call_count,
            resultCount:tool.result_count,errorCount:tool.error_count,
            totalDurationMs:tool.total_duration_ms,
          })),
        },
      }
    })
  }


  /**
   * Global numerical projection: ONLY durable Native-only writer claims,
   * no legacy SourceRecord/Observation joins that could double-count facts.
   * Never load event bodies and never scan native files during aggregation.
   */
  overview(input:NativeSessionMetricOverviewQuery):Promise<NativeSessionMetricOverview>{
    if(!input.sourceId || input.sourceId.length>128 || !input.parserVersion
      || input.parserVersion.length>512
      || (input.installationId!==undefined && (!input.installationId || input.installationId.length>512))
      || (input.from!==undefined && !Number.isFinite(Date.parse(input.from)))
      || (input.to!==undefined && !Number.isFinite(Date.parse(input.to)))
      || (input.from && input.to && Date.parse(input.from)>Date.parse(input.to))){
      throw new TypeError('Invalid Native-only metrics aggregate query')
    }
    return this.executor.run(()=>{
      const cte=`
        WITH selected AS (
          SELECT catalog.source_id,catalog.installation_id,catalog.native_session_id,
                 metrics.interaction_count,metrics.tool_call_count,metrics.tool_result_count,
                 metrics.tool_error_count,metrics.error_count,metrics.input_tokens,metrics.output_tokens,
                 CASE
                   WHEN metrics.source_id IS NULL THEN 'missing'
                   WHEN metrics.file_identity<>catalog.file_identity
                     OR metrics.file_size<>catalog.file_size
                     OR metrics.file_mtime_ms<>catalog.file_mtime_ms
                     OR metrics.parser_version<>?
                     OR metrics.projection_version<>?
                   THEN 'stale'
                   ELSE metrics.coverage
                 END AS metric_status
          FROM native_session_write_claims AS claim
          JOIN native_session_catalog AS catalog
            ON catalog.source_id=claim.source_id
           AND catalog.installation_id=claim.installation_id
           AND catalog.native_session_id=claim.native_session_id
           AND catalog.location_kind='native'
          LEFT JOIN native_session_metrics AS metrics
            ON metrics.source_id=catalog.source_id
           AND metrics.installation_id=catalog.installation_id
           AND metrics.native_session_id=catalog.native_session_id
          WHERE claim.mode='native-only' AND claim.source_id=?
            ${input.installationId?"AND claim.installation_id=?":""}
            ${input.from?"AND catalog.last_activity_at>=?":""}
            ${input.to?"AND catalog.last_activity_at<=?":""}
        )
      `
      const params=[
        input.parserVersion,NATIVE_SESSION_METRIC_PROJECTION_VERSION,input.sourceId,
        ...(input.installationId?[input.installationId]:[]),
        ...(input.from?[input.from]:[]),
        ...(input.to?[input.to]:[]),
      ]
      const row=this.executor.db.prepare(`${cte}
        SELECT COUNT(*) AS eligibleSessions,
          COALESCE(SUM(CASE WHEN metric_status='complete' THEN 1 ELSE 0 END),0) AS readySessions,
          COALESCE(SUM(CASE WHEN metric_status='missing' THEN 1 ELSE 0 END),0) AS missingSessions,
          COALESCE(SUM(CASE WHEN metric_status='stale' THEN 1 ELSE 0 END),0) AS staleSessions,
          COALESCE(SUM(CASE WHEN metric_status='partial' THEN 1 ELSE 0 END),0) AS partialSessions,
          COALESCE(SUM(CASE WHEN metric_status='complete' THEN interaction_count ELSE 0 END),0) AS interactionCount,
          COALESCE(SUM(CASE WHEN metric_status='complete' THEN tool_call_count ELSE 0 END),0) AS toolCallCount,
          COALESCE(SUM(CASE WHEN metric_status='complete' THEN tool_result_count ELSE 0 END),0) AS toolResultCount,
          COALESCE(SUM(CASE WHEN metric_status='complete' THEN tool_error_count ELSE 0 END),0) AS toolErrorCount,
          COALESCE(SUM(CASE WHEN metric_status='complete' THEN error_count ELSE 0 END),0) AS errorCount,
          CASE WHEN SUM(CASE WHEN metric_status='complete' THEN 1 ELSE 0 END)=0
             OR SUM(CASE WHEN metric_status='complete' AND input_tokens IS NULL THEN 1 ELSE 0 END)>0
               THEN NULL
               ELSE SUM(CASE WHEN metric_status='complete' THEN input_tokens ELSE 0 END)
          END AS inputTokens,
          CASE WHEN SUM(CASE WHEN metric_status='complete' THEN 1 ELSE 0 END)=0
             OR SUM(CASE WHEN metric_status='complete' AND output_tokens IS NULL THEN 1 ELSE 0 END)>0
               THEN NULL
               ELSE SUM(CASE WHEN metric_status='complete' THEN output_tokens ELSE 0 END)
          END AS outputTokens
        FROM selected
      `).get(...params) as Omit<NativeSessionMetricOverview,'sourceId'|'totals'|'tools'|'toolsTruncated'> & {
        interactionCount:number;toolCallCount:number;toolResultCount:number;
        toolErrorCount:number;errorCount:number;inputTokens:number|null;outputTokens:number|null
      }
      const rows=this.executor.db.prepare(`${cte}
        SELECT tool.native_tool_name AS nativeToolName,
          SUM(tool.call_count) AS callCount,
          SUM(tool.result_count) AS resultCount,
          SUM(tool.error_count) AS errorCount,
          SUM(tool.total_duration_ms) AS totalDurationMs,
          COUNT(*) AS sessionCount
        FROM selected
        JOIN native_session_tool_metrics AS tool
          ON tool.source_id=selected.source_id
         AND tool.installation_id=selected.installation_id
         AND tool.native_session_id=selected.native_session_id
        WHERE selected.metric_status='complete'
        GROUP BY tool.native_tool_name
        ORDER BY callCount DESC,tool.native_tool_name ASC LIMIT 257
      `).all(...params) as NativeSessionMetricOverview['tools']
      return {
        sourceId:input.sourceId,
        eligibleSessions:row.eligibleSessions,readySessions:row.readySessions,
        missingSessions:row.missingSessions,staleSessions:row.staleSessions,
        partialSessions:row.partialSessions,
        totals:{
          interactionCount:row.interactionCount,toolCallCount:row.toolCallCount,
          toolResultCount:row.toolResultCount,toolErrorCount:row.toolErrorCount,
          errorCount:row.errorCount,inputTokens:row.inputTokens,outputTokens:row.outputTokens,
        },
        tools:rows.slice(0,256),
        toolsTruncated:rows.length>256,
      }
    })
  }

  invalidate(identity: Identity): Promise<void> {
    return this.executor.run(() => {
      this.executor.db.prepare(`
        DELETE FROM native_session_metrics
        WHERE source_id=? AND installation_id=? AND native_session_id=?
      `).run(identity.sourceId,identity.installationId,identity.nativeSessionId)
    })
  }
}
