import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { resolveHermesConfigRoots } from '@agent-lens/runtime-cordis'
import { AGENT_LENS_PROTOCOL_VERSION, type AgentWorkspaceResponseDto, type AgentWorkBoardDto, type AgentWorkTaskDto, type AgentWorkRunDto, type AgentWorkScheduleDto, type AgentWorkExecutionDto, type AgentWorkFeatureDto, type AgentWorkProjectDto } from '@agent-lens/protocol'

const MAX_BOARDS = 24
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
  const boards = [{ id: 'default', path: join(root, 'kanban.db'), metadata: join(root, 'kanban', 'board.json') }]
  for (const slug of (await dirs(join(root, 'kanban', 'boards'))).slice(0, MAX_BOARDS - 1)) {
    boards.push({ id: slug, path: join(root, 'kanban', 'boards', slug, 'kanban.db'), metadata: join(root, 'kanban', 'boards', slug, 'board.json') })
  }
  return boards
}
async function readBoards(root: string, requestedBoard: string | undefined, offset: number, limit: number) {
  const boards: AgentWorkBoardDto[] = []
  let tasks: AgentWorkTaskDto[] = []
  let runs: AgentWorkRunDto[] = []
  let tasksHasMore = false
  let selectedBoard: string | undefined
  for (const board of await boardList(root)) {
    if (!await fileExists(board.path)) continue
    const db = openReadOnly(board.path)
    try {
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
      const active = (requestedBoard ? board.id === requestedBoard : selectedBoard === undefined)
      if (!active) continue
      selectedBoard = board.id
      const records = db.prepare('SELECT ' + select(tc, ['id','title','status','assignee','project_id','priority','created_at','last_failure_error','current_run_id']) +
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
      }))
      const rc = columns(db, 'task_runs')
      if (rc.has('task_id') && rc.has('id')) {
        // Only materialize runs for the current bounded task page.
        const ids = tasks.map(t => t.id)
        if (ids.length) {
          const records = db.prepare('SELECT ' + select(rc, ['id','task_id','profile','status','outcome','started_at','ended_at','summary','error']) +
            ' FROM task_runs WHERE task_id IN (' + ids.map(() => '?').join(',') + ') ORDER BY started_at DESC, id DESC LIMIT 200')
            .all(...ids) as Record<string,unknown>[]
          runs = records.map(row => ({
            id: Number(row.id), boardId: board.id, taskId: String(row.task_id), status: String(row.status ?? 'unknown'),
            ...(text(row.profile) ? {profile:text(row.profile)} : {}),
            ...(text(row.outcome) ? {outcome:text(row.outcome)} : {}),
            ...(epoch(row.started_at) ? {startedAt:epoch(row.started_at)} : {}),
            ...(epoch(row.ended_at) ? {endedAt:epoch(row.ended_at)} : {}),
            ...(text(row.summary) ? {summary:text(row.summary)?.slice(0,1000)} : {}),
            ...(text(row.error) ? {error:text(row.error)?.slice(0,1000)} : {}),
          }))
        }
      }
    } finally { db.close() }
  }
  return { boards, selectedBoard, tasks, runs, tasksHasMore }
}
async function readProjects(root: string): Promise<AgentWorkProjectDto[]> {
  const profiles = [{name:'default',home:root}, ...(await dirs(join(root,'profiles'))).map(name => ({name,home:join(root,'profiles',name)}))]
  const projects:AgentWorkProjectDto[]=[]
  for (const profile of profiles.slice(0,32)) {
    const path = join(profile.home,'projects.db')
    if (!await fileExists(path)) continue
    const db = openReadOnly(path)
    try {
      const pc=columns(db,'projects')
      if (!pc.has('id') || !pc.has('slug') || !pc.has('name')) throw new Error('Unsupported Hermes projects schema')
      const rows=db.prepare('SELECT '+select(pc,['id','slug','name','archived','board_slug','primary_path'])+
        ' FROM projects ORDER BY name ASC LIMIT 200').all() as Record<string,unknown>[]
      for (const row of rows) projects.push({
        id:String(row.id),profile:profile.name,slug:String(row.slug),name:String(row.name),
        archived:Number(row.archived??0)!==0,
        ...(text(row.board_slug)?{boardId:text(row.board_slug)}:{}),
        ...(text(row.primary_path)?{primaryPath:text(row.primary_path)}:{}),
      })
    }finally{db.close()}
  }
  return projects
}
async function readSchedules(root: string) {
  const profiles = [{name:'default',home:root}, ...(await dirs(join(root,'profiles'))).map(name => ({name, home:join(root,'profiles',name)}))]
  const schedules: AgentWorkScheduleDto[] = []
  const executions: AgentWorkExecutionDto[] = []
  let discovered = false
  for (const profile of profiles.slice(0, 32)) {
    const jobsPath = join(profile.home, 'cron', 'jobs.json')
    const executionPath = join(profile.home, 'cron', 'executions.db')
    if (await fileExists(jobsPath)) {
      discovered = true
      const parsed = await jsonFile(jobsPath, MAX_JOB_BYTES)
      const value = Array.isArray(parsed) ? parsed : obj(parsed).jobs
      const records = Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(obj(value)) : []
      for (const raw of records) {
        const job = obj(raw)
        const id = text(job.id)
        if (!id || schedules.length >= MAX_SCHEDULES) continue
        const schedule = obj(job.schedule)
        schedules.push({
          id, profile:profile.name, name:text(job.name) ?? text(job.prompt)?.slice(0,50) ?? id,
          state: job.enabled === false ? 'paused' : text(job.state) === 'paused' ? 'scheduled' : text(job.state) ?? 'scheduled',
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
    }
    if (await fileExists(executionPath)) {
      discovered = true
      const db = openReadOnly(executionPath)
      try {
        const ec = columns(db, 'executions')
        if (!ec.has('job_id') || !ec.has('id') || !ec.has('status')) throw new Error('Unsupported Hermes cron executions schema')
        const records = db.prepare('SELECT ' + select(ec, ['id','job_id','status','claimed_at','started_at','finished_at','error','delivery_outcome']) +
          ' FROM executions ORDER BY claimed_at DESC, id DESC LIMIT ?').all(MAX_EXECUTIONS) as Record<string,unknown>[]
        for (const row of records) {
          executions.push({
            id:String(row.id),jobId:String(row.job_id),profile:profile.name,status:String(row.status),
            claimedAt:String(row.claimed_at ?? ''),
            ...(text(row.started_at)?{startedAt:text(row.started_at)}:{}),
            ...(text(row.finished_at)?{finishedAt:text(row.finished_at)}:{}),
            ...(text(row.error)?{error:text(row.error)?.slice(0,1000)}:{}),
            ...(text(row.delivery_outcome)?{deliveryOutcome:text(row.delivery_outcome)}:{}),
          })
        }
      } finally { db.close() }
    }
  }
  return { discovered, schedules, executions }
}
/** Bounded, read-only Hermes work view. Features are independent so one broken source does not hide the other. */
export async function readHermesWorkspace(options: {
  board?: string
  offset?: number
  limit?: number
  roots?: string[]
} = {}): Promise<AgentWorkspaceResponseDto> {
  const roots = options.roots ?? resolveHermesConfigRoots()
  const features: AgentWorkFeatureDto[] = [
    {id:'boards',availability:'unknown'},
    {id:'schedules',availability:'unknown'},
  ]
  const result: Workspace = {features,projects:[],boards:[],tasks:[],runs:[],tasksHasMore:false,schedules:[],executions:[]}
  const limit = Math.min(100,Math.max(1,Math.floor(options.limit ?? 40)))
  const offset = Math.max(0,Math.min(100000,Math.floor(options.offset ?? 0)))
  const candidates = [...new Set(roots.map(root => basename(dirname(root)) === 'profiles' ? dirname(dirname(root)) : root))]
  for (const root of candidates) {
    try {
      const info = await readBoards(root,options.board,offset,limit)
      if (info.boards.length) {
        Object.assign(result,info)
        features[0] = {id:'boards',availability:'available'}
        break
      }
    } catch (error) {
      features[0] = {id:'boards',availability:'error',reason:error instanceof Error ? error.message : 'read failed'}
      break
    }
  }
  for (const root of candidates) {
    try {
      const info = await readSchedules(root)
      if (info.discovered) {
        result.schedules = info.schedules
        result.executions = info.executions
        features[1] = {id:'schedules',availability:'available'}
        break
      }
    } catch (error) {
      features[1] = {id:'schedules',availability:'error',reason:error instanceof Error ? error.message : 'read failed'}
      break
    }
  }
  for (const root of candidates) {
    try {
      const projects = await readProjects(root)
      if (projects.length) {
        result.projects = projects
        break
      }
    } catch {
      // Project metadata does not gate Board/Cron availability.
    }
  }
  return {sourceId:'hermes',...result,meta:{protocolVersion:AGENT_LENS_PROTOCOL_VERSION,generatedAt:new Date().toISOString()}}
}
