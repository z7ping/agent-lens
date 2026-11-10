import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { resolveHermesConfigRoots } from '@agent-lens/runtime-cordis'
import { AGENT_LENS_PROTOCOL_VERSION, type AgentWorkspaceResponseDto, type AgentWorkBoardDto, type AgentWorkTaskDto, type AgentWorkRunDto, type AgentWorkScheduleDto, type AgentWorkExecutionDto, type AgentWorkFeatureDto, type AgentWorkProjectDto, type AgentWorkLinkDto, type AgentWorkCommentDto, type AgentWorkEventDto } from '@agent-lens/protocol'

const PROJECT_PAGE_SIZE = 100
const MAX_SCHEDULES = 200
const MAX_EXECUTIONS = 200
const MAX_JOB_BYTES = 2 * 1024 * 1024
const SLUG = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/

type Workspace = Omit<AgentWorkspaceResponseDto, 'sourceId' | 'meta'>
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length ? value : undefined
const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
const obj = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const epoch = (value: unknown): string | undefined => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{10,13}$/.test(value) ? Number(value) : NaN
  if (!Number.isFinite(n)) return text(value)
  return new Date(n < 1e11 ? n * 1000 : n).toISOString()
}
async function fileExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile() } catch (e) {
    if (['ENOENT','ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) return false
    throw e
  }
}
async function dirs(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && SLUG.test(entry.name))
      .map(entry => entry.name)
      .sort()
  } catch (e) {
    if (['ENOENT','ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) return []
    throw e
  }
}
async function jsonFile(path: string, maxBytes: number): Promise<unknown> {
  const info = await stat(path)
  if (!info.isFile() || info.size > maxBytes) throw new Error('Hermes original file exceeds read budget')
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}
function openReadOnly(path: string): DatabaseSync {
  // No writes, no schema migrations, no fallback to opening a new database.
  return new DatabaseSync(path, { readOnly: true, timeout: 1000 })
}
function columns(db: DatabaseSync, table: string): Set<string> {
  return new Set(db.prepare('PRAGMA table_info(' + table + ')').all()
    .map(row => text((row as {name?: unknown}).name)).filter((n): n is string => !!n))
}
function select(columns: Set<string>, names: readonly string[]): string {
  return names.map(name => columns.has(name) ? '"' + name + '"' : 'NULL AS "' + name + '"').join(', ')
}
async function boardList(root: string): Promise<Array<{id:string; path:string; metadata:string}>> {
  const boards = [{ id: 'default', path: join(root, 'kanban.db'), metadata: join(root, 'kanban', 'boards', 'default', 'board.json') }]
  for (const slug of (await dirs(join(root, 'kanban', 'boards'))).filter(slug => slug !== 'default')) {
    const metadata = join(root, 'kanban', 'boards', slug, 'board.json')
    // Hermes treats board.json, not a leftover kanban.db, as the board identity marker.
    if (!await fileExists(metadata)) continue
    boards.push({ id: slug, path: join(root, 'kanban', 'boards', slug, 'kanban.db'), metadata })
  }
  return boards
}
async function readBoards(root: string, requestedBoard: string | undefined, offset: number, limit: number, taskId?: string, taskEventOffset=0,runOffset=0,commentOffset=0,boardOffset=0) {
  const boards: AgentWorkBoardDto[] = []
  let tasks: AgentWorkTaskDto[] = []
  let runs: AgentWorkRunDto[] = []
  let tasksHasMore = false
  let boardsTotal = 0
  let boardsHasMore = false
  let runsHasMore = false
  let taskCommentsHasMore = false
  let selectedBoard: string | undefined
  let detailTaskId: string | undefined
  let taskLinks: AgentWorkLinkDto[] = []
  let taskComments: AgentWorkCommentDto[] = []
  let taskEvents: AgentWorkEventDto[] = []
  let taskEventsHasMore = false
  let failedBoards = 0
  const discoveredBoards = await boardList(root)
  const availableBoards = []
  for (const board of discoveredBoards) if (await fileExists(board.path)) availableBoards.push(board)
  boardsTotal = availableBoards.length
  const boardPage = availableBoards.slice(boardOffset,boardOffset+24)
  boardsHasMore = boardOffset+boardPage.length<boardsTotal
  for (const board of boardPage) {
    let db: DatabaseSync | undefined
    try {
      db = openReadOnly(board.path)
      const tc = columns(db, 'tasks')
      if (!tc.has('id') || !tc.has('title') || !tc.has('status')) throw new Error('Unsupported Hermes kanban schema')
      let info: Record<string, unknown> = {}
      if (await fileExists(board.metadata)) {
        try { info = obj(await jsonFile(board.metadata, 256 * 1024)) }
        catch { /* Metadata is optional; task rows remain authoritative. */ }
      }
      const count = Number((db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as {n:number}).n)
      boards.push({ id: board.id, name: text(info.name) ?? board.id, archived: info.archived === true, taskCount: count,
        ...(text(info.project_id) ? {projectId: text(info.project_id)} : {}) })
      const active = requestedBoard ? board.id === requestedBoard : selectedBoard === undefined
      if (!active) continue
      selectedBoard = board.id
      const records = db.prepare('SELECT ' + select(tc, ['id','title','status','assignee','project_id','priority','created_at','last_failure_error','current_run_id','session_id']) +
        ' FROM tasks ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?').all(limit + 1, offset) as Record<string,unknown>[]
      tasksHasMore = records.length > limit
      tasks = records.slice(0, limit).map(row => ({
        id: String(row.id), boardId: board.id, title: String(row.title), status: String(row.status),
        priority: number(row.priority) ?? 0,
        ...(text(row.assignee) ? {assignee: text(row.assignee)} : {}),
        ...(text(row.project_id) ? {projectId: text(row.project_id)} : {}),
        ...(epoch(row.created_at) ? {createdAt: epoch(row.created_at)} : {}),
        ...(text(row.last_failure_error) ? {lastError: text(row.last_failure_error)} : {}),
        ...(number(row.current_run_id) ? {currentRunId: number(row.current_run_id)} : {}),
        ...(text(row.session_id) ? {sourceSessionNativeId: text(row.session_id)} : {}),
      }))
      // Fetch attempts only for the explicitly opened task; never truncate across a whole task page.
      if (taskId) {
        const rc = columns(db, 'task_runs')
        if (rc.has('task_id') && rc.has('id')) {
          const records = db.prepare('SELECT ' + select(rc, ['id','task_id','profile','status','outcome','started_at','ended_at','summary','error']) +
            ' FROM task_runs WHERE task_id = ? ORDER BY started_at DESC, id DESC LIMIT 101 OFFSET ?')
            .all(taskId,runOffset) as Record<string,unknown>[]
          runsHasMore = records.length > 100
          // Hermes' gateway persists the run->session binding in owner_admitted events.
          // Unlike tasks.session_id (originating conversation), this ID identifies the
          // actual worker session admitted for this specific execution attempt.
          const admitted = new Map<number,string>()
          const ambiguous = new Set<number>()
          const eventColumns = columns(db,'task_events')
          if (eventColumns.has('task_id') && eventColumns.has('run_id')
              && eventColumns.has('kind') && eventColumns.has('payload')) {
            const runIds = records.slice(0,100).map(row=>Number(row.id)).filter(Number.isSafeInteger)
            if (runIds.length) {
              const admissionRows = db.prepare(
                'SELECT run_id,payload FROM task_events WHERE task_id = ? AND kind = ?'
                + ' AND run_id IN (' + runIds.map(()=>'?').join(',') + ')'
                + ' ORDER BY id DESC LIMIT 500',
              ).all(taskId,'owner_admitted',...runIds) as Array<{run_id:unknown;payload:unknown}>
              for (const event of admissionRows) {
                const runId = Number(event.run_id)
                if (!Number.isSafeInteger(runId) || typeof event.payload !== 'string'
                  || event.payload.length > 8192 || ambiguous.has(runId)) continue
                let payload: Record<string,unknown>
                try { payload = obj(JSON.parse(event.payload) as unknown) }
                catch { continue }
                const id = text(payload.session_id)
                if (!id || id.length > 256) continue
                const previous = admitted.get(runId)
                if (previous && previous !== id) {
                  ambiguous.add(runId)
                  admitted.delete(runId)
                } else admitted.set(runId,id)
              }
            }
          }
          runs = records.slice(0,100).map(row => ({
            id: Number(row.id), boardId: board.id, taskId: String(row.task_id), status: String(row.status ?? 'unknown'),
            ...(admitted.has(Number(row.id)) ? {workerSessionNativeId:admitted.get(Number(row.id))} : {}),
            ...(text(row.profile) ? {profile:text(row.profile)} : {}),
            ...(text(row.outcome) ? {outcome:text(row.outcome)} : {}),
            ...(epoch(row.started_at) ? {startedAt:epoch(row.started_at)} : {}),
            ...(epoch(row.ended_at) ? {endedAt:epoch(row.ended_at)} : {}),
            ...(text(row.summary) ? {summary:text(row.summary)?.slice(0,1000)} : {}),
            ...(text(row.error) ? {error:text(row.error)?.slice(0,1000)} : {}),
          }))
        }
      }
      if (taskId && db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(taskId)) {
        detailTaskId = taskId
        const lc = columns(db,'task_links')
        if (lc.has('parent_id') && lc.has('child_id')) {
          taskLinks = (db.prepare('SELECT parent_id,child_id FROM task_links WHERE parent_id = ? OR child_id = ? LIMIT 200').all(taskId,taskId) as {parent_id:string;child_id:string}[])
            .map(item=>({parentId:item.parent_id,childId:item.child_id}))
        }
        const cc = columns(db,'task_comments')
        if (cc.has('task_id') && cc.has('id')) {
          const commentRecords = (db.prepare('SELECT '+select(cc,['id','author','body','created_at'])+
            ' FROM task_comments WHERE task_id = ? ORDER BY id DESC LIMIT 51 OFFSET ?').all(taskId,commentOffset) as Record<string,unknown>[])
          taskCommentsHasMore = commentRecords.length > 50
          taskComments = commentRecords.slice(0,50).map(item=>({id:Number(item.id),author:String(item.author??''),body:String(item.body??'').slice(0,1200),
              ...(epoch(item.created_at)?{createdAt:epoch(item.created_at)}:{})}))
        }
        const ec=columns(db,'task_events')
        if (ec.has('task_id') && ec.has('id')) {
          const records=db.prepare('SELECT '+select(ec,['id','kind','run_id','created_at'])+
            ' FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 101 OFFSET ?')
            .all(taskId,taskEventOffset) as Record<string,unknown>[]
          taskEventsHasMore=records.length>100
          taskEvents=records.slice(0,100).map(item=>({id:Number(item.id),kind:String(item.kind??'unknown'),
            ...(number(item.run_id)?{runId:number(item.run_id)}:{}),
            ...(epoch(item.created_at)?{createdAt:epoch(item.created_at)}:{})}))
        }
      }
    } catch {
      // A single corrupt/locked Board must not hide the healthy Boards.
      failedBoards += 1
      const index = boards.findIndex(item => item.id === board.id)
      if (index >= 0) boards.splice(index, 1)
      if (selectedBoard === board.id) {
        selectedBoard = undefined
        tasks = []
        runs = []
        taskLinks = []
        taskComments = []
        taskEvents = []
        detailTaskId = undefined
        tasksHasMore = false
        runsHasMore = false
        taskEventsHasMore = false
        taskCommentsHasMore = false
      }
    } finally { db?.close() }
  }
  return { boards, boardsTotal, boardsHasMore, selectedBoard, tasks, runs, tasksHasMore,
    ...(detailTaskId?{detailTaskId}:{}),taskLinks,taskComments,taskEvents,taskEventsHasMore,runsHasMore,taskCommentsHasMore,failedBoards }
}
async function readProjects(root: string, offset=0): Promise<{
  discovered:boolean
  projects:AgentWorkProjectDto[]
  projectsHasMore:boolean
  projectsTotal:number
  failedProjects:number
}> {
  const profiles = [{name:'default',home:root}, ...(await dirs(join(root,'profiles'))).map(name=>({name,home:join(root,'profiles',name)}))]
  const projects:AgentWorkProjectDto[]=[]
  let discovered=false
  let projectsTotal=0
  let failedProjects=0
  for (const profile of profiles) {
    const path=join(profile.home,'projects.db')
    if (!await fileExists(path)) continue
    discovered=true
    let db: DatabaseSync | undefined
    try {
      db = openReadOnly(path)
      const pc=columns(db,'projects')
      if (!pc.has('id') || !pc.has('slug') || !pc.has('name')) throw new Error('Unsupported Hermes projects schema')
      const count=Number((db.prepare('SELECT COUNT(*) AS n FROM projects').get() as {n:number}).n)
      const localOffset=Math.max(0,offset-projectsTotal)
      projectsTotal+=count
      const remaining=PROJECT_PAGE_SIZE-projects.length
      if (remaining<=0 || localOffset>=count) continue
      const rows=db.prepare('SELECT '+select(pc,['id','slug','name','archived','board_slug','primary_path'])+
        ' FROM projects ORDER BY name ASC, id ASC LIMIT ? OFFSET ?').all(remaining,localOffset) as Record<string,unknown>[]
      for (const row of rows) projects.push({
        id:String(row.id),profile:profile.name,slug:String(row.slug),name:String(row.name),
        archived:Number(row.archived??0)!==0,
        ...(text(row.board_slug)?{boardId:text(row.board_slug)}:{}),
        ...(text(row.primary_path)?{primaryPath:text(row.primary_path)}:{}),
      })
    } catch {
      failedProjects += 1
    } finally {db?.close()}
  }
  return {discovered,projects,failedProjects,projectsTotal,projectsHasMore:projectsTotal>offset+projects.length}
}
async function readSchedules(root: string, jobId?:string, profileName?:string, executionOffset=0, scheduleOffset=0) {
  const profiles = [{name:'default',home:root}, ...(await dirs(join(root,'profiles'))).map(name => ({name, home:join(root,'profiles',name)}))]
  const schedules: AgentWorkScheduleDto[] = []
  const executions: AgentWorkExecutionDto[] = []
  let executionsHasMore = false
  let schedulesTotal = 0
  let failedCronSources = 0
  let discovered = false
  for (const profile of profiles) {
    const jobsPath = join(profile.home, 'cron', 'jobs.json')
    const executionPath = join(profile.home, 'cron', 'executions.db')
    if (await fileExists(jobsPath)) {
      discovered = true
      try {
      const parsed = await jsonFile(jobsPath, MAX_JOB_BYTES)
      const value = Array.isArray(parsed) ? parsed : obj(parsed).jobs
      const records = Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(obj(value)) : []
      for (const raw of records) {
        const job = obj(raw)
        const id = text(job.id)
        if (!id) continue
        const ordinal=schedulesTotal++
        if (ordinal < scheduleOffset || schedules.length >= MAX_SCHEDULES) continue
        const schedule = obj(job.schedule)
        schedules.push({
          id, profile:profile.name, name:text(job.name) ?? text(job.prompt)?.slice(0,50) ?? id,
          state: ['completed','error'].includes(text(job.state) ?? '') ? String(job.state) : job.enabled === false ? 'paused' : text(job.state) === 'paused' ? 'scheduled' : text(job.state) ?? 'scheduled',
          enabled: job.enabled !== false,
          schedule: text(job.schedule_display) ?? text(schedule.display) ?? text(schedule.expr) ?? text(schedule.kind) ?? '',
          noAgent:job.no_agent === true,
          ...(text(job.next_run_at)? {nextRunAt:text(job.next_run_at)} : {}),
          ...(text(job.last_run_at)? {lastRunAt:text(job.last_run_at)} : {}),
          ...(text(job.last_status)? {lastStatus:text(job.last_status)} : {}),
          ...(text(job.last_error)? {lastError:text(job.last_error)?.slice(0,1000)} : {}),
          ...(text(job.workdir)? {workdir:text(job.workdir)} : {}),
        })
      }
      } catch {
        failedCronSources += 1
      }
    }
    if (await fileExists(executionPath)) {
      discovered = true
      if (!jobId || profileName !== profile.name) continue
      let db: DatabaseSync | undefined
      try {
        db = openReadOnly(executionPath)
        const ec = columns(db, 'executions')
        if (!ec.has('job_id') || !ec.has('id') || !ec.has('status')) throw new Error('Unsupported Hermes cron executions schema')
        const records = db.prepare('SELECT ' + select(ec, ['id','job_id','status','claimed_at','started_at','finished_at','error','delivery_outcome']) +
          ' FROM executions WHERE job_id = ? ORDER BY claimed_at DESC, id DESC LIMIT ? OFFSET ?')
          .all(jobId, MAX_EXECUTIONS + 1, executionOffset) as Record<string,unknown>[]
        executionsHasMore = records.length > MAX_EXECUTIONS
        for (const row of records.slice(0,MAX_EXECUTIONS)) {
          executions.push({
            id:String(row.id),jobId:String(row.job_id),profile:profile.name,status:String(row.status),
            claimedAt:String(row.claimed_at ?? ''),
            ...(text(row.started_at)?{startedAt:text(row.started_at)}:{}),
            ...(text(row.finished_at)?{finishedAt:text(row.finished_at)}:{}),
            ...(text(row.error)?{error:text(row.error)?.slice(0,1000)}:{}),
            ...(text(row.delivery_outcome)?{deliveryOutcome:text(row.delivery_outcome)}:{}),
          })
        }
      } catch {
        failedCronSources += 1
      } finally { db?.close() }
    }
  }
  return { discovered, failedCronSources, schedules, schedulesHasMore: schedulesTotal > scheduleOffset+schedules.length, schedulesTotal, executions, executionsHasMore }
}
/** Bounded, read-only Hermes work view. Features are independent so one broken source does not hide the other. */
export async function readHermesWorkspace(options: {
  board?: string
  offset?: number
  limit?: number
  roots?: string[]
  jobId?: string
  profile?: string
  executionOffset?: number
  scheduleOffset?: number
  taskId?: string
  taskEventOffset?: number
  runOffset?: number
  commentOffset?: number
  projectOffset?: number
  boardOffset?: number
} = {}): Promise<AgentWorkspaceResponseDto> {
  const roots = options.roots ?? resolveHermesConfigRoots()
  const features: AgentWorkFeatureDto[] = [
    {id:'boards',availability:'unknown'},
    {id:'schedules',availability:'unknown'},
    {id:'projects',availability:'unknown'},
  ]
  const result: Workspace = {features,projects:[],projectsTotal:0,projectsHasMore:false,boards:[],boardsTotal:0,boardsHasMore:false,tasks:[],runs:[],runsHasMore:false,taskCommentsHasMore:false,taskLinks:[],taskComments:[],taskEvents:[],taskEventsHasMore:false,tasksHasMore:false,schedules:[],schedulesHasMore:false,schedulesTotal:0,executions:[],executionsHasMore:false}
  const limit = Math.min(100,Math.max(1,Math.floor(options.limit ?? 40)))
  const offset = Math.max(0,Math.min(100000,Math.floor(options.offset ?? 0)))
  const candidates = [...new Set(roots.map(root => basename(dirname(root)) === 'profiles' ? dirname(dirname(root)) : root))]
  for (const root of candidates) {
    try {
      const info = await readBoards(root,options.board,offset,limit,options.taskId,
        Math.min(100000,Math.max(0,options.taskEventOffset??0)),
        Math.min(100000,Math.max(0,options.runOffset??0)),
        Math.min(100000,Math.max(0,options.commentOffset??0)),
        Math.min(100000,Math.max(0,options.boardOffset??0)))
      if (info.boardsTotal) {
        Object.assign(result,info)
        features[0] = info.failedBoards
          ? {id:'boards',availability:info.boards.length?'partial':'error',
            reason:info.failedBoards+' Hermes board(s) could not be read'}
          : {id:'boards',availability:'available'}
        break
      }
    } catch (error) {
      features[0] = {id:'boards',availability:'error',reason:error instanceof Error ? error.message : 'read failed'}
      break
    }
  }
  for (const root of candidates) {
    try {
      const info = await readSchedules(root, options.jobId, options.profile, Math.min(100000,Math.max(0,options.executionOffset ?? 0)), Math.min(100000,Math.max(0,options.scheduleOffset ?? 0)))
      if (info.discovered) {
        result.schedules = info.schedules
        result.schedulesHasMore = info.schedulesHasMore
        result.schedulesTotal = info.schedulesTotal
        result.executions = info.executions
        result.executionsHasMore = info.executionsHasMore
        features[1] = info.failedCronSources
          ? {id:'schedules',availability:info.schedules.length?'partial':'error',
            reason:info.failedCronSources+' Hermes Cron source(s) could not be read'}
          : {id:'schedules',availability:'available'}
        break
      }
    } catch (error) {
      features[1] = {id:'schedules',availability:'error',reason:error instanceof Error ? error.message : 'read failed'}
      break
    }
  }
  for (const root of candidates) {
    try {
      const info = await readProjects(root,Math.min(100000,Math.max(0,options.projectOffset??0)))
      if (info.discovered) {
        result.projects = info.projects
        result.projectsHasMore = info.projectsHasMore
        result.projectsTotal = info.projectsTotal
        features[2] = info.failedProjects
          ? {id:'projects',availability:info.projects.length?'partial':'error',
            reason:info.failedProjects+' Hermes project source(s) could not be read'}
          : {id:'projects',availability:'available'}
        break
      }
    } catch (error) {
      features[2] = {id:'projects',availability:'error',reason:error instanceof Error?error.message:'read failed'}
      break
    }
  }
  return {sourceId:'hermes',...result,meta:{protocolVersion:AGENT_LENS_PROTOCOL_VERSION,generatedAt:new Date().toISOString()}}
}
