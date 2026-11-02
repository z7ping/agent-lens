import { useState } from 'react'
import type { AgentWorkTaskDto, AgentWorkScheduleDto } from '@agent-lens/protocol'
import type { AgentLensClientModel } from '../client/model'
import { useClientSnapshot } from '../client/use-client-snapshot'
import { Button, SelectMenu, StatusBadge } from '../components/ui'

const PAGE_SIZE = 40
const formatDate = (value: string | undefined): string => {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

export function AgentWorkPage({model,sourceId}: {model:AgentLensClientModel;sourceId:string}) {
  const snapshot = useClientSnapshot(model).agentWorkspace
  const response = snapshot.sourceId === sourceId ? snapshot.response : null
  const [panel,setPanel] = useState<'boards'|'schedules'>('boards')
  const [selectedTask,setSelectedTask] = useState<string|null>(null)
  const [selectedJob,setSelectedJob] = useState<string|null>(null)
  const [offset,setOffset] = useState(0)
  const loadBoard = (board: string, nextOffset = 0) => {
    setSelectedTask(null)
    setOffset(nextOffset)
    void model.refreshAgentWorkspace(sourceId,{board,offset:nextOffset,limit:PAGE_SIZE})
  }
  const boardAvailable = response?.features.some(f => f.id === 'boards' && f.availability === 'available') ?? false
  const schedulesAvailable = response?.features.some(f => f.id === 'schedules' && f.availability === 'available') ?? false
  const board = response?.boards.find(item => item.id === response.selectedBoard)
  const task = response?.tasks.find(item => item.id === selectedTask)
  const selectedSchedule:AgentWorkScheduleDto|undefined = response?.schedules.find(item =>
    item.profile + ':' + item.id === selectedJob)
  return <main className="workspace-page">
    <div className="page-content agents-content">
      {snapshot.sourceId === sourceId && snapshot.error && <div className="agent-path-error" role="alert">{snapshot.error} <Button size="small" onClick={() => void model.refreshAgentWorkspace(sourceId)}>重试</Button></div>}
      {(!response && snapshot.loading) && <div className="muted-empty compact" role="status">正在读取工作数据…</div>}
      {response && <div className="agent-detail-pane">
        <div className="agent-primary-section">
          <div className="section-heading-row">
            <h2>工作</h2>
            <Button size="small" loading={snapshot.loading} onClick={() => void model.refreshAgentWorkspace(sourceId,{board:response.selectedBoard,limit:PAGE_SIZE})}>刷新</Button>
          </div>
          <div className="agent-asset-actions">
            {boardAvailable && <Button size="small" variant={panel==='boards'?'primary':'secondary'} onClick={() => setPanel('boards')}>看板</Button>}
            {schedulesAvailable && <Button size="small" variant={panel==='schedules'?'primary':'secondary'} onClick={() => setPanel('schedules')}>定时任务</Button>}
          </div>
        </div>
        {panel==='boards' && boardAvailable && <>
          <section className="agent-primary-section">
            <div className="section-heading-row"><h3>看板任务</h3><span className="section-total">{board?.taskCount ?? 0}</span></div>
            <SelectMenu ariaLabel="选择看板" value={response.selectedBoard ?? ''} searchable
              options={response.boards.map(item => ({value:item.id,label:item.name + (item.archived?'（已归档）':'')}))}
              onChange={value=>loadBoard(value)}/>
            {response.tasks.length===0 && <div className="muted-empty compact">当前看板暂无任务</div>}
            {response.tasks.map(item => <div className="asset-item" key={item.id}>
              <div className="asset-item-head">
                <StatusBadge tone={item.status==='done'?'success':item.status==='blocked'?'warning':item.status==='running'?'accent':'neutral'}>{item.status}</StatusBadge>
                {item.assignee && <span className="asset-scope">{item.assignee}</span>}
                {item.projectId && <span className="asset-scope">{item.projectId}</span>}
              </div>
              <Button size="small" variant="ghost" onClick={()=>setSelectedTask(old=>old===item.id?null:item.id)} aria-expanded={selectedTask===item.id}>{item.title}</Button>
              {item.lastError && <div className="agent-path-error">{item.lastError}</div>}
              {selectedTask===item.id && <TaskRuns task={item} runs={response.runs.filter(run=>run.taskId===item.id)} />}
            </div>)}
            <div className="runtime-config-row">
              <span>已加载 {offset+response.tasks.length} / {board?.taskCount ?? 0}</span>
              {offset>0 && <Button size="small" disabled={snapshot.loading} onClick={()=>loadBoard(response.selectedBoard??'default',Math.max(0,offset-PAGE_SIZE))}>上一页</Button>}
              {response.tasksHasMore && <Button size="small" disabled={snapshot.loading} onClick={()=>loadBoard(response.selectedBoard??'default',offset+PAGE_SIZE)}>下一页</Button>}
            </div>
          </section>
        </>}
        {panel==='schedules' && schedulesAvailable && <section className="agent-primary-section">
          <div className="section-heading-row"><h3>定时任务</h3><span className="section-total">{response.schedules.length}</span></div>
          {!response.schedules.length && <div className="muted-empty compact">暂无定时任务</div>}
          {response.schedules.map(job=><div className="asset-item" key={job.profile+':'+job.id}>
            <div className="asset-item-head">
              <StatusBadge tone={job.state==='error'?'danger':job.enabled?'success':'neutral'}>{job.state}</StatusBadge>
              <span className="asset-scope">{job.profile}</span>
              {job.noAgent && <span className="asset-scope">脚本任务</span>}
            </div>
            <Button size="small" variant="ghost" onClick={()=>setSelectedJob(old=>old===job.profile+':'+job.id?null:job.profile+':'+job.id)}>{job.name}</Button>
            <div className="runtime-config-row"><span>{job.schedule || '—'}</span><span>下次 {formatDate(job.nextRunAt)}</span></div>
            {job.lastError && <div className="agent-path-error">{job.lastError}</div>}
            {selectedSchedule && selectedSchedule.id===job.id && selectedSchedule.profile===job.profile && <>
              <div className="section-heading-row"><h3>执行记录</h3></div>
              {response.executions.filter(run=>run.jobId===job.id && run.profile===job.profile).map(run=><div key={run.id} className="runtime-config-row">
                <StatusBadge tone={run.status==='failed'?'danger':run.status==='completed'?'success':'neutral'}>{run.status}</StatusBadge>
                <span>{formatDate(run.startedAt ?? run.claimedAt)}</span>
                {run.deliveryOutcome && <span>投递：{run.deliveryOutcome}</span>}
                {run.error && <div className="agent-path-error">{run.error}</div>}
              </div>)}
            </>}
          </div>)}
        </section>}
      </div>}
    </div>
  </main>
}
function TaskRuns({task,runs}: {task:AgentWorkTaskDto;runs:import('@agent-lens/protocol').AgentWorkRunDto[]}) {
  return <section className="agent-secondary">
    <div className="runtime-config-row"><span>任务 ID</span><code>{task.id}</code></div>
    <div className="section-heading-row"><h3>执行记录</h3><span className="section-total">{runs.length}</span></div>
    {!runs.length && <div className="muted-empty compact">暂无执行记录</div>}
    {runs.map(run=><div className="asset-item" key={run.id}>
      <div className="asset-item-head"><StatusBadge tone={run.status==='done'?'success':run.status==='failed'?'danger':'neutral'}>{run.status}</StatusBadge>
        {run.profile && <span className="asset-scope">{run.profile}</span>}</div>
      <div className="runtime-config-row"><span>{formatDate(run.startedAt)}</span><span>{run.outcome??'—'}</span></div>
      {run.summary && <p>{run.summary}</p>}
      {run.error && <div className="agent-path-error">{run.error}</div>}
    </div>)}
  </section>
}
