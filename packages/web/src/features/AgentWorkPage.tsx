import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { AgentWorkTaskDto, AgentWorkScheduleDto, AgentWorkOutputResponseDto } from '@agent-lens/protocol'
import type { AgentLensClientModel } from '../client/model'
import { useClientSnapshot } from '../client/use-client-snapshot'
import { Button, SelectMenu, StatusBadge } from '../components/ui'
import { MarkdownContent } from '../components/MarkdownContent'

const PAGE_SIZE = 40
const MAX_EXECUTION_PAGE = 200
const formatDate = (value: string | undefined): string => {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

export function AgentWorkPage({model,sourceId}: {model:AgentLensClientModel;sourceId:string}) {
  const {t} = useTranslation('agents')
  const navigate = useNavigate()
  const [sessionPending,setSessionPending] = useState(false)
  const [sessionMessage,setSessionMessage] = useState('')
  const openNativeSession = async (sessionId:string) => {
    if (sessionPending) return
    setSessionPending(true)
    setSessionMessage('')
    try {
      const result = await model.resolveAgentNativeSession(sourceId,sessionId)
      if (result.state === 'linked') navigate('/review/'+encodeURIComponent(result.reviewSessionId))
      else setSessionMessage(t('work.session_'+result.state))
    } catch {
      setSessionMessage(t('work.session_unavailable'))
    } finally { setSessionPending(false) }
  }
  const snapshot = useClientSnapshot(model).agentWorkspace
  const response = snapshot.sourceId === sourceId ? snapshot.response : null
  const [panel,setPanel] = useState<'boards'|'schedules'>('boards')
  const [selectedTask,setSelectedTask] = useState<string|null>(null)
  const [selectedJob,setSelectedJob] = useState<string|null>(null)
  const outputRequest=useRef(0)
  const [cronOutput,setCronOutput] = useState<AgentWorkOutputResponseDto|null>(null)
  const [cronOutputError,setCronOutputError] = useState('')
  const [cronOutputLoading,setCronOutputLoading] = useState(false)
  const [outputOffset,setOutputOffset] = useState(0)
  const loadOutput = async (job:AgentWorkScheduleDto, file?:string,offset=0) => {
    const generation=++outputRequest.current
    setCronOutputLoading(true)
    setCronOutputError('')
    try {
      const result=await model.agentWorkOutput(sourceId,{
        jobId:job.id,profile:job.profile,...(file?{file}:{}),offset,
      })
      if (generation !== outputRequest.current) return
      setCronOutput(result)
      setOutputOffset(offset)
    } catch {
      if (generation !== outputRequest.current) return
      setCronOutputError(t('work.outputError'))
    } finally {
      if (generation===outputRequest.current) setCronOutputLoading(false)
    }
  }
  const [executionOffset,setExecutionOffset] = useState(0)
  const [scheduleOffset,setScheduleOffset] = useState(0)
  const [offset,setOffset] = useState(0)
  const [taskEventOffset,setTaskEventOffset] = useState(0)
  const [runOffset,setRunOffset] = useState(0)
  const [commentOffset,setCommentOffset] = useState(0)
  const [projectOffset,setProjectOffset] = useState(0)
  const [boardOffset,setBoardOffset] = useState(0)
  const refreshWorkspace = (options: Parameters<AgentLensClientModel['refreshAgentWorkspace']>[1] = {}) =>
    model.refreshAgentWorkspace(sourceId,{boardOffset,projectOffset,...options})
  const nextBoards=(nextOffset:number)=>{
    setBoardOffset(nextOffset)
    setOffset(0)
    setSelectedTask(null)
    setTaskEventOffset(0)
    setRunOffset(0)
    setCommentOffset(0)
    void refreshWorkspace({boardOffset:nextOffset,offset:0,limit:PAGE_SIZE,scheduleOffset,projectOffset})
  }
  const loadBoard = (board: string, nextOffset = 0) => {
    setSelectedTask(null)
    setTaskEventOffset(0)
    setRunOffset(0)
    setCommentOffset(0)
    setOffset(nextOffset)
    void refreshWorkspace({board,offset:nextOffset,limit:PAGE_SIZE})
  }
  const openTask = (task:AgentWorkTaskDto) => {
    const next=selectedTask===task.id?null:task.id
    setSelectedTask(next)
    setTaskEventOffset(0)
    setRunOffset(0)
    setCommentOffset(0)
    if (next) void refreshWorkspace({
      board:task.boardId,offset,limit:PAGE_SIZE,scheduleOffset,taskId:next,taskEventOffset:0,runOffset:0,commentOffset:0,
    })
  }
  const nextTaskEvents=(nextOffset:number)=>{
    if (!selectedTask||!response?.selectedBoard) return
    setTaskEventOffset(nextOffset)
    void refreshWorkspace({
      board:response.selectedBoard,offset,limit:PAGE_SIZE,scheduleOffset,taskId:selectedTask,taskEventOffset:nextOffset,runOffset,commentOffset,
    })
  }
  const nextTaskRuns=(nextOffset:number)=>{
    if (!selectedTask||!response?.selectedBoard) return
    setRunOffset(nextOffset)
    void refreshWorkspace({
      board:response.selectedBoard,offset,limit:PAGE_SIZE,scheduleOffset,taskId:selectedTask,
      taskEventOffset,runOffset:nextOffset,commentOffset,
    })
  }
  const nextTaskComments=(nextOffset:number)=>{
    if (!selectedTask||!response?.selectedBoard) return
    setCommentOffset(nextOffset)
    void refreshWorkspace({
      board:response.selectedBoard,offset,limit:PAGE_SIZE,scheduleOffset,taskId:selectedTask,
      taskEventOffset,runOffset,commentOffset:nextOffset,
    })
  }
  const nextProjects=(nextOffset:number)=>{
    setProjectOffset(nextOffset)
    void refreshWorkspace({
      board:response?.selectedBoard,offset,limit:PAGE_SIZE,scheduleOffset,projectOffset:nextOffset,
      ...(selectedTask?{taskId:selectedTask,taskEventOffset,runOffset,commentOffset}:{}),
      ...(selectedSchedule?{jobId:selectedSchedule.id,profile:selectedSchedule.profile,executionOffset}:{}),
    })
  }
  const boardAvailable = response?.features.some(f => f.id === 'boards' && f.availability === 'available') ?? false
  const schedulesAvailable = response?.features.some(f => f.id === 'schedules' && f.availability === 'available') ?? false
  const projectsAvailable = response?.features.some(f => f.id === 'projects' && f.availability === 'available') ?? false
  const board = response?.boards.find(item => item.id === response.selectedBoard)
  const activePanel = panel === 'boards' && !boardAvailable && schedulesAvailable ? 'schedules' : panel
  const openJob = (job:AgentWorkScheduleDto) => {
    const identity=job.profile+':'+job.id
    const next=selectedJob===identity?null:identity
    setSelectedJob(next)
    setCronOutput(null)
    setCronOutputError('')
    setOutputOffset(0)
    outputRequest.current++
    setCronOutputLoading(false)
    if (next) void loadOutput(job)
    setExecutionOffset(0)
    if (next) void refreshWorkspace({
      board:response?.selectedBoard,jobId:job.id,profile:job.profile,executionOffset:0,scheduleOffset,
    })
  }
  const goExecutionPage = (job:AgentWorkScheduleDto,offset:number) => {
    setExecutionOffset(offset)
    void refreshWorkspace({
      board:response?.selectedBoard,jobId:job.id,profile:job.profile,executionOffset:offset,scheduleOffset,
    })
  }
  const goSchedulePage = (nextOffset:number) => {
    setScheduleOffset(nextOffset)
    setSelectedJob(null)
    setCronOutput(null)
    setCronOutputError('')
    outputRequest.current++
    setExecutionOffset(0)
    void refreshWorkspace({
      board:response?.selectedBoard,scheduleOffset:nextOffset,limit:PAGE_SIZE,
    })
  }
  const selectedSchedule:AgentWorkScheduleDto|undefined = response?.schedules.find(item =>
    item.profile + ':' + item.id === selectedJob)
  return <main className="workspace-page">
    <div className="page-content agents-content">
      {snapshot.sourceId === sourceId && snapshot.error && <div className="agent-path-error" role="alert">{snapshot.error} <Button size="small" onClick={() => void model.refreshAgentWorkspace(sourceId)}>{t('work.retry')}</Button></div>}
      {(!response && snapshot.loading) && <div className="muted-empty compact" role="status">{t('work.loading')}</div>}
      {sessionMessage && <div className="agent-path-error" role="status">{sessionMessage}</div>}
      {response && <div className="agent-detail-pane">
        {response.features.filter(f=>f.availability==='error').map(feature=><div key={feature.id} role="alert" className="agent-path-error">
          {t('work.featureError',{name:feature.id})} {feature.reason}
        </div>)}
        <div className="agent-primary-section">
          <div className="section-heading-row">
            <h2>{t('work.title')}</h2>
            <Button size="small" loading={snapshot.loading} onClick={() => void refreshWorkspace({board:response.selectedBoard,offset,limit:PAGE_SIZE,scheduleOffset,projectOffset,...(selectedTask?{taskId:selectedTask,taskEventOffset,runOffset,commentOffset}:{}),...(selectedSchedule?{jobId:selectedSchedule.id,profile:selectedSchedule.profile,executionOffset}:{})})}>{t('work.refresh')}</Button>
          </div>
          <div className="runtime-config-row">
            {boardAvailable && <Button size="small" variant={activePanel==='boards'?'primary':'default'} onClick={() => setPanel('boards')}>{t('work.boards')}</Button>}
            {schedulesAvailable && <Button size="small" variant={activePanel==='schedules'?'primary':'default'} onClick={() => setPanel('schedules')}>{t('work.schedules')}</Button>}
          </div>
        </div>
        {activePanel==='boards' && boardAvailable && <>
          <section className="agent-primary-section">
            <div className="section-heading-row"><h3>{t('work.boardTasks')}</h3><span className="section-total">{board?.taskCount ?? 0}</span></div>
            <SelectMenu ariaLabel={t('work.selectBoard')} value={response.selectedBoard ?? ''} searchable
              options={response.boards.map(item => ({value:item.id,label:item.name + (item.archived?t('work.archived'):'')}))}
              onChange={value=>loadBoard(value)}/>
            <div className="runtime-config-row">
              <span>{response.boardsTotal}</span>
              {boardOffset>0 && <Button size="small" disabled={snapshot.loading}
                onClick={()=>nextBoards(Math.max(0,boardOffset-24))}>{t('work.previous')}</Button>}
              {response.boardsHasMore && <Button size="small" disabled={snapshot.loading}
                onClick={()=>nextBoards(boardOffset+24)}>{t('work.next')}</Button>}
            </div>
            {response.tasks.length===0 && <div className="muted-empty compact">{t('work.noTasks')}</div>}
            {response.tasks.map(item => <div className="asset-item" key={item.id}>
              <div className="asset-item-head">
                <StatusBadge tone={item.status==='done'?'success':item.status==='blocked'?'warning':item.status==='running'?'accent':'neutral'}>{item.status}</StatusBadge>
                {item.assignee && <span className="asset-scope">{item.assignee}</span>}
                {item.projectId && <span className="asset-scope">{item.projectId}</span>}
              </div>
              <Button size="small" variant="quiet" onClick={()=>openTask(item)} aria-expanded={selectedTask===item.id}>{item.title}</Button>
              {item.lastError && <div className="agent-path-error">{item.lastError}</div>}
              {selectedTask===item.id && <TaskRuns task={item} runs={response.runs.filter(run=>run.taskId===item.id)}
                links={response.detailTaskId===item.id?response.taskLinks:[]}
                comments={response.detailTaskId===item.id?response.taskComments:[]}
                events={response.detailTaskId===item.id?response.taskEvents:[]}
                hasMore={response.taskEventsHasMore} eventOffset={taskEventOffset} onEventPage={nextTaskEvents} loading={snapshot.loading} onOpenSession={openNativeSession} sessionPending={sessionPending}
                runOffset={runOffset} runsHasMore={response.runsHasMore} onRunPage={nextTaskRuns}
                commentOffset={commentOffset} commentsHasMore={response.taskCommentsHasMore} onCommentPage={nextTaskComments}/>} 
            </div>)}
            <div className="runtime-config-row">
              <span>{t('work.loaded')} {offset+response.tasks.length} / {board?.taskCount ?? 0}</span>
              {offset>0 && <Button size="small" disabled={snapshot.loading} onClick={()=>loadBoard(response.selectedBoard??'default',Math.max(0,offset-PAGE_SIZE))}>{t('work.previous')}</Button>}
              {response.tasksHasMore && <Button size="small" disabled={snapshot.loading} onClick={()=>loadBoard(response.selectedBoard??'default',offset+PAGE_SIZE)}>{t('work.next')}</Button>}
            </div>
          </section>
        </>}
        {activePanel==='schedules' && schedulesAvailable && <section className="agent-primary-section">
          <div className="section-heading-row"><h3>{t('work.schedules')}</h3><span className="section-total">{response.schedulesTotal}</span></div>
          {!response.schedules.length && <div className="muted-empty compact">{t('work.noSchedules')}</div>}
          {response.schedules.map(job=><div className="asset-item" key={job.profile+':'+job.id}>
            <div className="asset-item-head">
              <StatusBadge tone={job.state==='error'?'danger':job.enabled?'success':'neutral'}>{job.state}</StatusBadge>
              <span className="asset-scope">{job.profile}</span>
              {job.noAgent && <span className="asset-scope">{t('work.scriptOnly')}</span>}
            </div>
            <Button size="small" variant="quiet" onClick={()=>openJob(job)}>{job.name}</Button>
            <div className="runtime-config-row"><span>{job.schedule || '—'}</span><span>{t('work.nextRun')} {formatDate(job.nextRunAt)}</span></div>
            {job.lastError && <div className="agent-path-error">{job.lastError}</div>}
            {selectedSchedule && selectedSchedule.id===job.id && selectedSchedule.profile===job.profile && <>
              <div className="section-heading-row"><h3>{t('work.runs')}</h3></div>
              {response.executions.filter(run=>run.jobId===job.id && run.profile===job.profile).map(run=><div key={run.id} className="runtime-config-row">
                <StatusBadge tone={run.status==='failed'?'danger':run.status==='completed'?'success':'neutral'}>{run.status}</StatusBadge>
                <span>{formatDate(run.startedAt ?? run.claimedAt)}</span>
                {run.deliveryOutcome && <span>{t('work.delivery')} {run.deliveryOutcome}</span>}
                {run.error && <div className="agent-path-error">{run.error}</div>}
              </div>)}
              <div className="runtime-config-row">
                {executionOffset>0 && <Button size="small" disabled={snapshot.loading} onClick={()=>goExecutionPage(job,Math.max(0,executionOffset-MAX_EXECUTION_PAGE))}>{t('work.previous')}</Button>}
                {response.executionsHasMore && <Button size="small" disabled={snapshot.loading} onClick={()=>goExecutionPage(job,executionOffset+MAX_EXECUTION_PAGE)}>{t('work.next')}</Button>}
              </div>
              <section className="agent-secondary">
                <div className="section-heading-row"><h3>{t('work.output')}</h3></div>
                {cronOutputLoading && <div className="muted-empty compact" role="status">{t('work.loading')}</div>}
                {cronOutputError && <div className="agent-path-error" role="alert">{cronOutputError}</div>}
                {cronOutput?.state === 'unavailable' && <div className="muted-empty compact">{t('work.noOutput')}</div>}
                {cronOutput?.files.map(file=><div key={file.name} className="runtime-config-row">
                  <Button size="small" variant="quiet" disabled={cronOutputLoading}
                    onClick={()=>void loadOutput(job,file.name,outputOffset)}>{file.name}</Button>
                  <span>{formatDate(file.modifiedAt)}</span>
                </div>)}
                {cronOutput?.state==='available' && <div className="runtime-config-row">
                  {outputOffset>0 && <Button size="small" disabled={cronOutputLoading}
                    onClick={()=>void loadOutput(job,undefined,Math.max(0,outputOffset-50))}>{t('work.previous')}</Button>}
                  {cronOutput.hasMore && <Button size="small" disabled={cronOutputLoading}
                    onClick={()=>void loadOutput(job,undefined,outputOffset+50)}>{t('work.next')}</Button>}
                </div>}
                {cronOutput?.preview && <div className="agent-secondary">
                  <div className="section-heading-row"><h3>{cronOutput.preview.name}</h3></div>
                  <MarkdownContent text={cronOutput.preview.text}/>
                </div>}
              </section>
            </>}
          </div>)}
        </section>}
        {projectsAvailable && <section className="agent-primary-section">
          <div className="section-heading-row"><h3>{t('work.projects')}</h3><span className="section-total">{response.projectsTotal}</span></div>
          {response.projects.map(project=><div className="runtime-config-row" key={project.profile+':'+project.id}>
            <span>{project.name}</span><span className="asset-scope">{project.profile}</span>
            {project.boardId && <span className="asset-scope">{project.boardId}</span>}
            {project.primaryPath && <code>{project.primaryPath}</code>}
          </div>)}
          <div className="runtime-config-row">
            {projectOffset>0 && <Button size="small" disabled={snapshot.loading}
              onClick={()=>nextProjects(Math.max(0,projectOffset-100))}>{t('work.previous')}</Button>}
            {response.projectsHasMore && <Button size="small" disabled={snapshot.loading}
              onClick={()=>nextProjects(projectOffset+100)}>{t('work.next')}</Button>}
          </div>
        </section>}
      </div>}
    </div>
  </main>
}
function TaskRuns({task,runs,links,comments,events,hasMore,eventOffset,onEventPage,loading,onOpenSession,sessionPending,runOffset,runsHasMore,onRunPage,commentOffset,commentsHasMore,onCommentPage}: {
  task:AgentWorkTaskDto
  runs:import('@agent-lens/protocol').AgentWorkRunDto[]
  links:import('@agent-lens/protocol').AgentWorkLinkDto[]
  comments:import('@agent-lens/protocol').AgentWorkCommentDto[]
  events:import('@agent-lens/protocol').AgentWorkEventDto[]
  hasMore:boolean;eventOffset:number;onEventPage(offset:number):void;loading:boolean
  onOpenSession(id:string):void;sessionPending:boolean
  runOffset:number;runsHasMore:boolean;onRunPage(offset:number):void
  commentOffset:number;commentsHasMore:boolean;onCommentPage(offset:number):void
}) {
  const {t} = useTranslation('agents')
  return <section className="agent-secondary">
    <div className="runtime-config-row"><span>{t('work.taskId')}</span><code>{task.id}</code></div>
    {task.sourceSessionNativeId && <div className="runtime-config-row"><span>{t('work.nativeSession')}</span><code>{task.sourceSessionNativeId}</code><Button size="small" loading={sessionPending} onClick={()=>onOpenSession(task.sourceSessionNativeId!)}>{t('work.openSession')}</Button></div>}
    <div className="section-heading-row"><h3>{t('work.runs')}</h3><span className="section-total">{runs.length}</span></div>
    {!runs.length && <div className="muted-empty compact">{t('work.noRuns')}</div>}
    {links.length>0 && <div className="runtime-config-row"><span>{t('work.links')}</span>{links.map(link=><code key={link.parentId+':'+link.childId}>{link.parentId} → {link.childId}</code>)}</div>}
    {runs.map(run=><div className="asset-item" key={run.id}>
      <div className="asset-item-head"><StatusBadge tone={run.status==='done'?'success':run.status==='failed'?'danger':'neutral'}>{run.status}</StatusBadge>
        {run.profile && <span className="asset-scope">{run.profile}</span>}</div>
      <div className="runtime-config-row"><span>{formatDate(run.startedAt)}</span><span>{run.outcome??'—'}</span></div>
      {run.workerSessionNativeId && <div className="runtime-config-row">
        <span>{t('work.workerSession')}</span><code>{run.workerSessionNativeId}</code>
        <Button size="small" loading={sessionPending}
          onClick={()=>onOpenSession(run.workerSessionNativeId!)}>{t('work.openSession')}</Button>
      </div>}
      {run.summary && <p>{run.summary}</p>}
      {run.error && <div className="agent-path-error">{run.error}</div>}
    </div>)}
    <div className="runtime-config-row">{runOffset>0 && <Button size="small" disabled={loading} onClick={()=>onRunPage(Math.max(0,runOffset-100))}>{t('work.previous')}</Button>}
      {runsHasMore && <Button size="small" disabled={loading} onClick={()=>onRunPage(runOffset+100)}>{t('work.next')}</Button>}</div>
    {(comments.length>0||commentOffset>0||commentsHasMore) && <section className="agent-secondary"><h3>{t('work.comments')}</h3>{comments.map(comment=><div className="asset-item" key={comment.id}><strong>{comment.author}</strong><p>{comment.body}</p></div>)}
      <div className="runtime-config-row">{commentOffset>0 && <Button size="small" disabled={loading} onClick={()=>onCommentPage(Math.max(0,commentOffset-50))}>{t('work.previous')}</Button>}
      {commentsHasMore && <Button size="small" disabled={loading} onClick={()=>onCommentPage(commentOffset+50)}>{t('work.next')}</Button>}</div></section>}
    {events.length>0 && <section className="agent-secondary"><h3>{t('work.events')}</h3>{events.map(event=><div className="runtime-config-row" key={event.id}><span>{event.kind}</span><span>{formatDate(event.createdAt)}</span></div>)}
      <div className="runtime-config-row">{eventOffset>0 && <Button size="small" disabled={loading} onClick={()=>onEventPage(Math.max(0,eventOffset-100))}>{t('work.previous')}</Button>}
        {hasMore && <Button size="small" disabled={loading} onClick={()=>onEventPage(eventOffset+100)}>{t('work.next')}</Button>}</div></section>}
  </section>
}
