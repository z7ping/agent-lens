import type {
  NativeSessionMetricReadResult,
  NativeSessionMetricSnapshot,
  NativeSessionMetricsStore,
  NativeSessionMetricOverview,
  NativeSessionMetricOverviewQuery,
  NativeSessionMetricRebuildCandidate,
  NativeSessionMetricRebuildCursor,
  NativeErrorIndexEntry, NativeErrorIndexQuery, NativeErrorIndexResult,
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
    const samples=tool.durationSampleCount??0
    const longest=tool.maxDurationMs??null
    if(!Number.isSafeInteger(samples)||samples<0||samples>tool.resultCount
      ||(longest!==null&&(!Number.isSafeInteger(longest)||longest<0))
      ||(samples===0&&longest!==null)||(samples>0&&longest===null)){
      throw new TypeError('Invalid native tool duration samples')
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
  duration_sample_count:number;max_duration_ms:number|null
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
          call_count,result_count,error_count,total_duration_ms,
          duration_sample_count,max_duration_ms
        ) VALUES (?,?,?,?,?,?,?,?,?,?)
      `)
      for (const tool of input.tools) insert.run(
        input.sourceId,input.installationId,input.nativeSessionId,tool.nativeToolName,
        tool.callCount,tool.resultCount,tool.errorCount,tool.totalDurationMs,
        tool.durationSampleCount??0,tool.maxDurationMs??null,
      )
      return true
    })
  }



  /** Small IPC-safe batches; only the published generation becomes queryable. */
  async stageErrors(identity:Identity,generation:string,errors:readonly NativeErrorIndexEntry[]):Promise<void>{
    if(!/^[0-9a-f-]{36}$/.test(generation)||errors.length>50)throw new RangeError('Invalid error batch')
    for(const entry of errors){
      if(!/^[0-9a-f]{64}$/.test(entry.eventKey)||!/^[0-9a-f]{64}$/.test(entry.fingerprint)
        ||!Number.isFinite(Date.parse(entry.occurredAt))
        ||entry.summary.length>240||entry.toolName!==null&&entry.toolName.length>128
        ||entry.errorCode!==null&&entry.errorCode.length>80){
        throw new TypeError('Invalid native error index entry')
      }
    }
    await this.executor.transaction(async()=>{
      const db=this.executor.db
      // Clean interrupted staging generations but preserve the published one.
      db.prepare(`DELETE FROM native_error_index WHERE source_id=? AND installation_id=?
        AND native_session_id=? AND scan_generation<>?
        AND scan_generation<>COALESCE((SELECT scan_generation FROM native_error_index_state
          WHERE source_id=? AND installation_id=? AND native_session_id=?),'')`)
        .run(identity.sourceId,identity.installationId,identity.nativeSessionId,generation,
          identity.sourceId,identity.installationId,identity.nativeSessionId)
      const insert=db.prepare(`INSERT OR IGNORE INTO native_error_index (
        source_id,installation_id,native_session_id,scan_generation,event_key,
        occurred_at,turn_ordinal,native_event_id,tool_name,error_kind,
        error_code,summary,fingerprint
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      for(const entry of errors)insert.run(identity.sourceId,identity.installationId,
        identity.nativeSessionId,generation,entry.eventKey,entry.occurredAt,
        entry.turnOrdinal,entry.nativeEventId,entry.toolName,entry.kind,
        entry.errorCode,entry.summary,entry.fingerprint)
    })
  }

  /** Atomic publish: both the metric and Catalog revisions must still match. */
  async publishErrors(input:NativeSessionMetricSnapshot,generation:string):Promise<boolean>{
    if(!/^[0-9a-f-]{36}$/.test(generation))throw new RangeError('Invalid error generation')
    return this.executor.transaction(async()=>{
      const identity=[input.sourceId,input.installationId,input.nativeSessionId]
      const match=this.executor.db.prepare(`SELECT 1 FROM native_session_metrics m
        JOIN native_session_catalog c ON c.source_id=m.source_id
          AND c.installation_id=m.installation_id AND c.native_session_id=m.native_session_id
        WHERE m.source_id=? AND m.installation_id=? AND m.native_session_id=?
          AND c.location_kind='native'
          AND c.file_identity=? AND c.file_size=? AND c.file_mtime_ms=?
          AND m.file_identity=? AND m.file_size=? AND m.file_mtime_ms=?
          AND m.parser_version=? AND m.projection_version=? LIMIT 1`)
        .get(...identity,input.fileIdentity,input.fileSize,input.fileMtimeMs,
          input.fileIdentity,input.fileSize,input.fileMtimeMs,input.parserVersion,input.projectionVersion)
      if(!match)return false
      this.executor.db.prepare(`INSERT INTO native_error_index_state(
        source_id,installation_id,native_session_id,scan_generation,
        file_identity,file_size,file_mtime_ms,parser_version,projection_version,indexed_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source_id,installation_id,native_session_id) DO UPDATE SET
        scan_generation=excluded.scan_generation,file_identity=excluded.file_identity,
        file_size=excluded.file_size,file_mtime_ms=excluded.file_mtime_ms,
        parser_version=excluded.parser_version,projection_version=excluded.projection_version,
        indexed_at=excluded.indexed_at`)
        .run(...identity,generation,input.fileIdentity,input.fileSize,input.fileMtimeMs,
          input.parserVersion,input.projectionVersion,new Date().toISOString())
      this.executor.db.prepare(`DELETE FROM native_error_index WHERE
        source_id=? AND installation_id=? AND native_session_id=? AND scan_generation<>?`)
        .run(...identity,generation)
      return true
    })
  }

  /** Search only current, parser-matching Source facts. Never serve stale rows. */
  queryErrors(query:NativeErrorIndexQuery):Promise<NativeErrorIndexResult> {
    if(!query.sourceId || !query.parserVersion || query.limit<1 || query.limit>100
      || query.offset<0 || !Number.isSafeInteger(query.offset))throw new RangeError('Invalid error index query')
    return this.executor.run(()=>{
      const where=[
        'e.source_id=?', 'm.parser_version=?', 'm.projection_version=?',
      ]
      const params:(string|number)[]=[
        query.sourceId,query.parserVersion,NATIVE_SESSION_METRIC_PROJECTION_VERSION,
      ]
      if(query.projectId){where.push('ctx.project_id=?');params.push(query.projectId)}
      if(query.toolName){where.push('e.tool_name=?');params.push(query.toolName)}
      if(query.from){where.push('e.occurred_at>=?');params.push(query.from)}
      if(query.to){where.push('e.occurred_at<=?');params.push(query.to)}
      if(query.search){
        where.push('(instr(lower(e.summary),lower(?))>0 OR instr(lower(e.error_code),lower(?))>0 OR instr(lower(e.tool_name),lower(?))>0)')
        params.push(query.search,query.search,query.search)
      }
      const base=`FROM native_error_index e
        JOIN native_session_metrics m ON m.source_id=e.source_id
          AND m.installation_id=e.installation_id AND m.native_session_id=e.native_session_id
        JOIN native_session_catalog c ON c.source_id=e.source_id
          AND c.installation_id=e.installation_id AND c.native_session_id=e.native_session_id
          AND c.location_kind='native'
          AND c.file_identity=m.file_identity AND c.file_size=m.file_size
          AND c.file_mtime_ms=m.file_mtime_ms
        LEFT JOIN native_session_context ctx ON ctx.source_id=e.source_id
          AND ctx.installation_id=e.installation_id AND ctx.native_session_id=e.native_session_id
        WHERE ${where.join(' AND ')}`
      const total=(this.executor.db.prepare(`SELECT COUNT(*) AS value ${base}`)
        .get(...params) as {value:number}).value
      const rows=this.executor.db.prepare(`SELECT
          e.event_key,e.occurred_at,e.turn_ordinal,e.native_event_id,e.tool_name,
          e.error_kind,e.error_code,e.summary,e.fingerprint,
          c.review_session_id,m.coverage
        ${base}
        ORDER BY e.occurred_at DESC,e.event_key DESC
        LIMIT ? OFFSET ?`).all(...params,query.limit,query.offset) as Array<{
          event_key:string;occurred_at:string;turn_ordinal:number|null
          native_event_id:string|null;tool_name:string|null;error_kind:'tool'|'runtime'
          error_code:string|null;summary:string;fingerprint:string
          review_session_id:string|null;coverage:'complete'|'partial'
        }>
      return {
        total,hasMore:query.offset+rows.length<total,
        items:rows.map(row=>({
          eventKey:row.event_key,occurredAt:row.occurred_at,
          turnOrdinal:row.turn_ordinal,nativeEventId:row.native_event_id,
          toolName:row.tool_name,kind:row.error_kind,errorCode:row.error_code,
          summary:row.summary,fingerprint:row.fingerprint,
          sessionId:row.review_session_id??'',
          sourceId:query.sourceId,coverage:row.coverage,
        })),
      }
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
            durationSampleCount:tool.duration_sample_count,
            maxDurationMs:tool.max_duration_ms,
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
      || (input.projectId!==undefined && (!input.projectId.trim() || input.projectId.length>512))
      || (input.nativeToolName!==undefined && (!input.nativeToolName.trim() || input.nativeToolName.length>128))
      || (input.from!==undefined && !Number.isFinite(Date.parse(input.from)))
      || (input.to!==undefined && !Number.isFinite(Date.parse(input.to)))
      || (input.from && input.to && Date.parse(input.from)>Date.parse(input.to))
      || (input.coverageCertified!==undefined && typeof input.coverageCertified!=='boolean')
      || (input.includeTrend!==undefined && typeof input.includeTrend!=='boolean')){
      throw new TypeError('Invalid Native-only metrics aggregate query')
    }
    return this.executor.run(()=>{
      const cte=`
        WITH selected AS (
          SELECT catalog.source_id,catalog.installation_id,catalog.native_session_id,
                 catalog.last_activity_at,
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
                   WHEN metrics.coverage='complete' AND ?<>1 THEN 'partial'
                   ELSE metrics.coverage
                 END AS metric_status
          FROM native_session_catalog AS catalog
          LEFT JOIN native_session_metrics AS metrics
            ON metrics.source_id=catalog.source_id
           AND metrics.installation_id=catalog.installation_id
           AND metrics.native_session_id=catalog.native_session_id
          WHERE catalog.location_kind='native'
             AND catalog.source_id=?
            ${input.installationId?"AND catalog.installation_id=?":""}
            ${input.projectId?`AND EXISTS (
              SELECT 1 FROM native_session_context AS ctx
              LEFT JOIN workspaces AS ws ON ws.id=ctx.workspace_id
              WHERE ctx.source_id=catalog.source_id
                AND ctx.installation_id=catalog.installation_id
                AND ctx.native_session_id=catalog.native_session_id
                AND COALESCE(ctx.project_id,ws.project_id)=?
            )`:""}
            ${input.from?"AND catalog.last_activity_at>=?":""}
            ${input.to?"AND catalog.last_activity_at<=?":""}
        )
      `
      const params=[
        input.parserVersion,NATIVE_SESSION_METRIC_PROJECTION_VERSION,
        input.coverageCertified===true?1:0,input.sourceId,
        ...(input.installationId?[input.installationId]:[]),
        ...(input.projectId?[input.projectId]:[]),
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
          COALESCE(SUM(CASE WHEN metric_status='partial' THEN interaction_count ELSE 0 END),0) AS partialInteractionCount,
          COALESCE(SUM(CASE WHEN metric_status='partial' THEN tool_call_count ELSE 0 END),0) AS partialToolCallCount,
          COALESCE(SUM(CASE WHEN metric_status='partial' THEN error_count ELSE 0 END),0) AS partialErrorCount,
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
        partialInteractionCount:number;partialToolCallCount:number;partialErrorCount:number
      }
      const rows=this.executor.db.prepare(`${cte}
        SELECT tool.native_tool_name AS nativeToolName,
          SUM(tool.call_count) AS callCount,
          SUM(tool.result_count) AS resultCount,
          SUM(tool.error_count) AS errorCount,
          SUM(tool.total_duration_ms) AS totalDurationMs,
          SUM(tool.duration_sample_count) AS durationSampleCount,
          MAX(tool.max_duration_ms) AS maxDurationMs,
          COUNT(*) AS sessionCount
        FROM selected
        JOIN native_session_tool_metrics AS tool
          ON tool.source_id=selected.source_id
         AND tool.installation_id=selected.installation_id
         AND tool.native_session_id=selected.native_session_id
        WHERE selected.metric_status='complete'
          ${input.nativeToolName?"AND tool.native_tool_name=?":""}
        GROUP BY tool.native_tool_name
        ORDER BY callCount DESC,tool.native_tool_name ASC LIMIT 257
      `).all(...params,...(input.nativeToolName?[input.nativeToolName]:[])) as NativeSessionMetricOverview['tools']
      // Partial is a separate lower-bound projection. Do not add it to certified
      // totals or label it a complete session, even after the reader reaches EOF.
      const partialRows=row.partialSessions>0?this.executor.db.prepare(`${cte}
        SELECT tool.native_tool_name AS nativeToolName,
          SUM(tool.call_count) AS callCount,
          SUM(tool.result_count) AS resultCount,
          SUM(tool.error_count) AS errorCount,
          SUM(tool.total_duration_ms) AS totalDurationMs,
          SUM(tool.duration_sample_count) AS durationSampleCount,
          MAX(tool.max_duration_ms) AS maxDurationMs,
          COUNT(*) AS sessionCount
        FROM selected
        JOIN native_session_tool_metrics AS tool
          ON tool.source_id=selected.source_id
         AND tool.installation_id=selected.installation_id
         AND tool.native_session_id=selected.native_session_id
        WHERE selected.metric_status='partial'
          ${input.nativeToolName?"AND tool.native_tool_name=?":""}
        GROUP BY tool.native_tool_name
        ORDER BY callCount DESC,tool.native_tool_name ASC LIMIT 257
      `).all(...params,...(input.nativeToolName?[input.nativeToolName]:[])) as NativeSessionMetricOverview['tools']:[]
      // Derived from the already indexed session summary. Assign a complete
      // session's totals to its last activity day; never claim these are event-day
      // counts or include partial/stale/missing metrics.
      const trend=input.includeTrend?this.executor.db.prepare(`${cte}
        SELECT substr(last_activity_at,1,10) AS date,
          COUNT(*) AS sessionCount,
          SUM(interaction_count) AS interactionCount,
          SUM(tool_call_count) AS toolCallCount,
          SUM(error_count) AS errorCount
        FROM selected
        WHERE metric_status='complete' AND last_activity_at IS NOT NULL
        GROUP BY substr(last_activity_at,1,10)
        ORDER BY date DESC LIMIT 32
      `).all(...params).reverse() as NonNullable<NativeSessionMetricOverview['trend']>:undefined
      return {
        sourceId:input.sourceId,
        ...(trend?{trend}:{}),
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
        ...(row.partialSessions>0?{observed:{
          interactionCount:row.partialInteractionCount,
          toolCallCount:row.partialToolCallCount,
          errorCount:row.partialErrorCount,
          tools:partialRows.slice(0,256),toolsTruncated:partialRows.length>256,
        }}:{}),
      }
    })
  }

  /** Only NEW Native-only sessions needing (re)projection. No event reads. */
  async findRebuildCandidates(
    input:NativeSessionMetricOverviewQuery,limit:number,
    before?:NativeSessionMetricRebuildCursor,
  ):Promise<NativeSessionMetricRebuildCandidate[]>{
    if(!input.sourceId || !input.parserVersion
      || input.sourceId.length>128 || input.parserVersion.length>512
      || (input.coverageCertified!==undefined && typeof input.coverageCertified!=='boolean')
      || (input.projectId!==undefined && (!input.projectId.trim() || input.projectId.length>512))
      || !Number.isSafeInteger(limit) || limit<1 || limit>4
      || (before && (!before.lastActivityAt || before.lastActivityAt.length>128
        || !Number.isFinite(Date.parse(before.lastActivityAt))
        || !before.installationId || before.installationId.length>512
        || !before.nativeSessionId || before.nativeSessionId.length>512))){
      throw new TypeError('Invalid native metric refresh scope')
    }
    return this.executor.run(()=>{
      const rows=this.executor.db.prepare(`
        SELECT catalog.review_session_id AS reviewSessionId,
          catalog.source_id AS sourceId,
          catalog.installation_id AS installationId,
          catalog.native_session_id AS nativeSessionId,
          catalog.last_activity_at AS lastActivityAt
        FROM native_session_catalog AS catalog
        LEFT JOIN native_session_metrics AS metrics
          ON metrics.source_id=catalog.source_id
          AND metrics.installation_id=catalog.installation_id
          AND metrics.native_session_id=catalog.native_session_id
        WHERE catalog.location_kind='native'
          
          AND catalog.source_id=?
          AND catalog.review_session_id IS NOT NULL
          ${input.projectId?`AND EXISTS (
              SELECT 1 FROM native_session_context AS ctx
              LEFT JOIN workspaces AS ws ON ws.id=ctx.workspace_id
              WHERE ctx.source_id=catalog.source_id
                AND ctx.installation_id=catalog.installation_id
                AND ctx.native_session_id=catalog.native_session_id
                AND COALESCE(ctx.project_id,ws.project_id)=?
            )`:""}
          AND (metrics.source_id IS NULL
            OR metrics.file_identity<>catalog.file_identity
            OR metrics.file_size<>catalog.file_size
            OR metrics.file_mtime_ms<>catalog.file_mtime_ms
            OR metrics.parser_version<>?
            OR metrics.projection_version<>?
            OR (metrics.coverage='partial' AND ?=1))
          ${before ? `AND (
            catalog.last_activity_at < ?
            OR (catalog.last_activity_at = ? AND catalog.installation_id > ?)
            OR (catalog.last_activity_at = ? AND catalog.installation_id = ?
                AND catalog.native_session_id > ?)
          )` : ''}
        ORDER BY catalog.last_activity_at DESC,
          catalog.installation_id ASC,catalog.native_session_id ASC
        LIMIT ?
      `).all(input.sourceId,
        // Match SQL placeholder order: source -> optional project -> version checks.
        ...(input.projectId?[input.projectId]:[]),
        input.parserVersion,NATIVE_SESSION_METRIC_PROJECTION_VERSION,
        input.coverageCertified===true?1:0,
        ...(before ? [before.lastActivityAt,before.lastActivityAt,before.installationId,
          before.lastActivityAt,before.installationId,before.nativeSessionId] : []),
        limit) as NativeSessionMetricRebuildCandidate[]
      return rows
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
