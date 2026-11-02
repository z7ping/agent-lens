import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentWorkTaskDto, AgentWorkScheduleDto } from '@agent-lens/protocol'
import type { AgentLensClientModel } from '../client/model'
import { useClientSnapshot } from '../client/use-client-snapshot'
import { Button, SelectMenu, StatusBadge } from '../components/ui'

const PAGE_SIZE = 40
const MAX_EXECUTION_PAGE = 200
const formatDate = (value: string | undefined): string => {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

export function AgentWorkPage({model,sourceId}: {model:AgentLensClientModel;sourceId:string}) {
  const {t} = useTranslation('agents')
  const snapshot = useClientSnapshot(model).agentWorkspace
  const response = snapshot.sourceId === sourceId ? snapshot.response : null
  const [panel,setPanel] = useState<'boards'|'schedules'>('boards')
  const [selectedTask,setSelectedTask] = useState<string|null>(null)
  const [selectedJob,setSelectedJob] = useState<string|null>(null)
  const [executionOffset,setExecutionOffset] = useState(0)
  const [scheduleOffset,setScheduleOffset] = useState(0)
  const [offset,setOffset] = useState(0)
  const loadBoard = (board: string, nextOffset = 0) => {
    setSelectedTask(null)
    setOffset(nextOffset)
    void model.refreshAgentWorkspace(sourceId,{board,offset:nextOffset,limit:PAGE_SIZE})
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
    setExecutionOffset(0)
    if (next) void model.refreshAgentWorkspace(sourceId,{
      board:response?.selectedBoard,jobId:job.id,profile:job.profile,executionOffset:0,
    })
  }
  const goExecutionPage = (job:AgentWorkScheduleDto,offset:number) => {
    setExecutionOffset(offset)
    void model.refreshAgentWorkspace(sourceId,{
      board:response?.selectedBoard,jobId:job.id,profile:job.profile,executionOffset:offset,
    })
  }
  const goSchedulePage = (nextOffset:number) => {
    setScheduleOffset(nextOffset)
    setSelectedJob(null)
    setExecutionOffset(0)
    void model.refreshAgentWorkspace(sourceId,{
      board:response?.selectedBoard,scheduleOffset:nextOffset,
    })
  }
  const selectedSchedule:AgentWorkScheduleDto|undefined = response?.schedules.find(item =>
    item.profile + ':' + item.id === selectedJob)
  return <main className="workspace-page">
    <div className="page-content agents-content">
      {snapshot.sourceId === sourceId && snapshot.error && <div className="agent-path-error" role="alert">{snapshot.error} <Button size="small" onClick={() => void model.refreshAgentWorkspace(sourceId)}>{t('work.retry')}</Button></div>}
      {(!response && snapshot.loading) && <div className="muted-empty compact" role="status">{t('work.loading')}</div>}
      {response && <div className="agent-detail-pane">
        {response.features.filter(f=>f.availability==='error').map(feature=><div key={feature.id} role="alert" className="agent-path-error">
          {t('work.featureError',{name:feature.id})} {feature.reason}
        </div>)}
        <div className="agent-primary-section">
          <div className="section-heading-row">
            <h2>{t('work.title')}</h2>
            <Button size="small" loading={snapshot.loading} onClick={() => void model.refreshAgentWorkspace(sourceId,{board:response.selectedBoard,limit:PAGE_SIZE})}>{t('work.refresh')}</Button>
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
            {response.tasks.length===0 && <div className="muted-empty compact">{t('work.noTasks')}</div>}
            {response.tasks.map(item => <div className="asset-item" key={item.id}>
              <div className="asset-item-head">
                <StatusBadge tone={item.status==='done'?'success':item.status==='blocked'?'warning':item.status==='running'?'accent':'neutral'}>{item.status}</StatusBadge>
                {item.assignee && <span className="asset-scope">{item.assignee}</span>}
                {item.projectId && <span className="asset-scope">{item.projectId}</span>}
              </div>
              <Button size="small" variant="quiet" onClick={()=>setSelectedTask(old=>old===item.id?null:item.id)} aria-expanded={selectedTask===item.id}>{item.title}</Button>
              {item.lastError && <div className="agent-path-error">{item.lastError}</div>}
              {selectedTask===item.id && <TaskRuns task={item} runs={response.runs.filter(run=>run.taskId===item.id)} />}
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
            </>}
          </div>)}
        </section>}
        {projectsAvailable && <section className="agent-primary-section">
          <div className="section-heading-row"><h3>{t('work.projects')}</h3><span className="section-total">{response.projects.length}</span></div>
          {response.projects.map(project=><div className="runtime-config-row" key={project.profile+':'+project.id}>
            <span>{project.name}</span><span className="asset-scope">{project.profile}</span>
            {project.boardId && <span className="asset-scope">{project.boardId}</span>}
            {project.primaryPath && <code>{project.primaryPath}</code>}
          </div>)}
        </section>}
      </div>}
    </div>
  </main>
}
function TaskRuns({task,runs}: {task:AgentWorkTaskDto;runs:import('@agent-lens/protocol').AgentWorkRunDto[]}) {
  const {t} = useTranslation('agents')
  return <section className="agent-secondary">
    <div className="runtime-config-row"><span>{t('work.taskId')}</span><code>{task.id}</code></div>
    <div className="section-heading-row"><h3>{t('work.runs')}</h3><span className="section-total">{runs.length}</span></div>
    {!runs.length && <div className="muted-empty compact">{t('work.noRuns')}</div>}
    {runs.map(run=><div className="asset-item" key={run.id}>
      <div className="asset-item-head"><StatusBadge tone={run.status==='done'?'success':run.status==='failed'?'danger':'neutral'}>{run.status}</StatusBadge>
        {run.profile && <span className="asset-scope">{run.profile}</span>}</div>
      <div className="runtime-config-row"><span>{formatDate(run.startedAt)}</span><span>{run.outcome??'—'}</span></div>
      {run.summary && <p>{run.summary}</p>}
      {run.error && <div className="agent-path-error">{run.error}</div>}
    </div>)}
  </section>
}
