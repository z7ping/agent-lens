import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { AgentWorkTaskDto, AgentWorkScheduleDto, AgentWorkOutputResponseDto, AgentInstallationOverviewDto, AgentWorkMutationDto } from '@agent-lens/protocol'
import type { AgentLensClientModel } from '../client/model'
import { useClientSnapshot } from '../client/use-client-snapshot'
import { Button, Dialog, Input, Textarea, SelectMenu, StatusBadge } from '../components/ui'
import { MarkdownContent } from '../components/MarkdownContent'

const PAGE_SIZE = 40
const MAX_EXECUTION_PAGE = 200
const actionLabelKey=(kind:AgentWorkMutationDto['kind'])=>'work.actions.'+kind.replace('.','_')
const formatDate = (value: string | undefined): string => {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

export function AgentWorkPage({model,sourceId,installationId,installations}: {
  model:AgentLensClientModel;sourceId:string;installationId:string;installations:AgentInstallationOverviewDto[]
}) {
  const {t} = useTranslation('agents')
  const navigate = useNavigate()
  const [workSearchParams,setWorkSearchParams] = useSearchParams()
  const [pendingAction,setPendingAction] = useState<AgentWorkMutationDto|null>(null)
  const scopeGeneration=useRef(0)
  const [accessChange,setAccessChange] = useState<boolean|null>(null)
  const [accessBusy,setAccessBusy] = useState(false)
  const [accessEnabled,setAccessEnabled] = useState(false)
  const [accessStatus,setAccessStatus] = useState<'loading'|'ready'|'error'>('loading')
  const [accessRetry,setAccessRetry] = useState(0)
  const [accessError,setAccessError] = useState('')
  useEffect(()=>{
    scopeGeneration.current++
    let valid=true
    setAccessStatus('loading')
    setAccessEnabled(false)
    setAccessError('')
    setAccessChange(null)
    setPendingAction(null)
    setReceiptId(null)
    if(installationId) {
      void model.agentWorkWriteAccess(sourceId,installationId).then(value=>{
        if(valid){setAccessEnabled(value.enabled);setAccessStatus('ready')}
      }).catch(()=>{
        if(valid)setAccessStatus('error')
      })
    }
    return ()=>{valid=false}
  },[model,sourceId,installationId,accessRetry])
  const [actionBusy,setActionBusy] = useState(false)
  const [actionFeedback,setActionFeedback] = useState('')
  const [receiptId,setReceiptId] = useState<string|null>(null)
  useEffect(()=>{
    if(!receiptId || !installationId)return
    let active=true
    let timer:ReturnType<typeof setTimeout>|undefined
    let attempts=0
    const check=async()=>{
      try {
        const receipt=await model.agentWorkReceipt(sourceId,installationId,receiptId)
        if(!active)return
        setActionFeedback(receipt.message)
        if(receipt.status==='running' && attempts++<120){
          timer=setTimeout(()=>void check(),3000)
        } else {
          setReceiptId(null)
          if(receipt.status==='accepted')void model.refreshAgentWorkspace(sourceId,{installationId})
        }
      } catch {
        if(active){setReceiptId(null);setActionFeedback(t('work.receiptUnavailable'))}
      }
    }
    timer=setTimeout(()=>void check(),1000)
    return ()=>{active=false;if(timer)clearTimeout(timer)}
  },[model,sourceId,installationId,receiptId,t])
  const [actionError,setActionError] = useState('')
  const [sessionPending,setSessionPending] = useState(false)
  const [sessionMessage,setSessionMessage] = useState('')
  const openNativeSession = async (sessionId:string) => {
    if (sessionPending) return
    setSessionPending(true)
    setSessionMessage('')
    try {
      const result = await model.resolveAgentNativeSession(sourceId,sessionId,installationId)
      if (result.state === 'linked') navigate('/review/'+encodeURIComponent(result.reviewSessionId))
      else setSessionMessage(t('work.session_'+result.state))
    } catch {
      setSessionMessage(t('work.session_unavailable'))
    } finally { setSessionPending(false) }
  }
  const snapshot = useClientSnapshot(model).agentWorkspace
  const response = snapshot.sourceId === sourceId && snapshot.installationId === installationId
    ? snapshot.response : null
  const chooseInstallation = (id:string) => {
    const next = new URLSearchParams(workSearchParams)
    next.set('installation',id)
    next.delete('section')
    setWorkSearchParams(next)
  }
  const panel = workSearchParams.get('section') === 'schedules' ? 'schedules' : 'boards'
  const selectPanel=(section:'boards'|'schedules')=>{
    if (section===panel) return
    const next=new URLSearchParams(workSearchParams)
    if (section==='boards') next.delete('section')
    else next.set('section',section)
    setWorkSearchParams(next)
  }
  const [selectedTask,setSelectedTask] = useState<string|null>(null)
  const [selectedJob,setSelectedJob] = useState<string|null>(null)
  const outputRequest=useRef(0)
  const [cronOutput,setCronOutput] = useState<AgentWorkOutputResponseDto|null>(null)
  const [cronOutputError,setCronOutputError] = useState('')
  const [cronOutputLoading,setCronOutputLoading] = useState(false)
  const [outputOffset,setOutputOffset] = useState(0)
  const loadOutput = async (job:AgentWorkScheduleDto, file?:string,offset=0) => {
    const generation=++outputRequest.current
    if (!installationId) return
    setCronOutputLoading(true)
    setCronOutputError('')
    try {
      const result=await model.agentWorkOutput(sourceId,{
        installationId,jobId:job.id,profile:job.profile,...(file?{file}:{}),offset,
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
  const refreshWorkspace = (
    options: Omit<Parameters<AgentLensClientModel['refreshAgentWorkspace']>[1], 'installationId'> = {},
  ) => installationId
    ? model.refreshAgentWorkspace(sourceId,{installationId,boardOffset,projectOffset,...options})
    : Promise.resolve()
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
  const boardAvailable = response?.features.some(f => f.id === 'boards' && (f.availability === 'available' || f.availability === 'partial')) ?? false
  const schedulesAvailable = response?.features.some(f => f.id === 'schedules' && (f.availability === 'available' || f.availability === 'partial')) ?? false
  const projectsAvailable = response?.features.some(f => f.id === 'projects' && (f.availability === 'available' || f.availability === 'partial')) ?? false
  const board = response?.boards.find(item => item.id === response.selectedBoard)
  const activePanel = panel === 'boards' && !boardAvailable && schedulesAvailable ? 'schedules'
    : panel === 'schedules' && !schedulesAvailable && boardAvailable ? 'boards'
    : panel
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
  const permitted=(kind:AgentWorkMutationDto['kind'])=>
    accessStatus==='ready' && accessEnabled && (response?.availableActions?.includes(kind) ?? false)
  const changeWriteAccess=async()=>{
    if(accessChange===null || accessBusy || !installationId)return
    setAccessBusy(true)
    setAccessError('')
    const generation=scopeGeneration.current
    try {
      const result=await model.setAgentWorkWriteAccess(sourceId,installationId,accessChange)
      if(generation!==scopeGeneration.current)return
      setAccessEnabled(result.enabled)
      setAccessStatus('ready')
      setAccessChange(null)
      await refreshWorkspace({board:response?.selectedBoard,offset,limit:PAGE_SIZE,scheduleOffset,projectOffset})
    } catch(error) {
      if(generation===scopeGeneration.current)
        setAccessError(error instanceof Error?error.message:t('work.writeAccessError'))
    } finally {setAccessBusy(false)}
  }
  const askAction=(action:AgentWorkMutationDto)=>{
    setPendingAction(action)
    setActionError('')
    setActionFeedback('')
  }
  const applyAction=async()=>{
    if(!pendingAction || actionBusy || !installationId || !permitted(pendingAction.kind))return
    setActionBusy(true)
    setActionError('')
    const generation=scopeGeneration.current
    try{
      const result=await model.agentWorkMutate(sourceId,installationId,pendingAction)
      if(generation!==scopeGeneration.current)return
      if(result.pending && result.receiptId){
        setActionFeedback(result.message)
        setReceiptId(result.receiptId)
        setPendingAction(null)
        return
      }
      if(!result.accepted)throw new Error(result.message||t('work.actionRejected'))
      setActionFeedback(result.message+' · '+(result.verification==='confirmed'
        ?t('work.writeConfirmed'):t('work.writeUnconfirmed'))
      setPendingAction(null)
      if(pendingAction.kind==='board.create'||pendingAction.kind==='board.archive') {
        setBoardOffset(0)
        setOffset(0)
        setSelectedTask(null)
      }
      if(pendingAction.kind==='task.create'||pendingAction.kind==='task.archive') {
        setOffset(0)
        setSelectedTask(null)
      }
      if(pendingAction.kind==='cron.create'||pendingAction.kind==='cron.remove') {
        setScheduleOffset(0)
        setSelectedJob(null)
      }
      // The CLI exit proves acceptance, not the resulting native state.
      await refreshWorkspace({
        board:pendingAction.kind==='board.archive'?undefined:response?.selectedBoard,
        boardOffset:pendingAction.kind==='board.create'||pendingAction.kind==='board.archive'?0:boardOffset,
        offset:pendingAction.kind==='task.create'||pendingAction.kind==='task.archive'
          ||pendingAction.kind==='board.archive'?0:offset,
        limit:PAGE_SIZE,
        scheduleOffset:pendingAction.kind==='cron.create'||pendingAction.kind==='cron.remove'?0:scheduleOffset,
        ...(selectedTask && !['task.create','task.archive'].includes(pendingAction.kind)
          ? {taskId:selectedTask,taskEventOffset,runOffset,commentOffset}:{}),
      })
    }catch(error){
      if(generation===scopeGeneration.current)
        setActionError(error instanceof Error?error.message:t('work.actionRejected'))
    }finally{setActionBusy(false)}
  }
  return <main className="workspace-page">
    <div className="page-content agents-content">
      {snapshot.sourceId === sourceId && snapshot.installationId === installationId && snapshot.error && <div className="agent-path-error" role="alert">{snapshot.error} <Button size="small" onClick={() => void refreshWorkspace()}>{t('work.retry')}</Button></div>}
      {!installationId && <div className="muted-empty compact" role="status">{t('work.noInstallation')}</div>}
      {installations.length > 1 && <div className="runtime-config-row">
        <span>{t('work.installation')}</span>
        <SelectMenu ariaLabel={t('work.installation')} value={installationId} searchable
          options={installations.map(item=>({
            value:item.id,label:item.configRoot ?? item.dataRoot ?? item.id,
          }))}
          onChange={chooseInstallation}/>
      </div>}
      {installationId && (!response && (snapshot.sourceId !== sourceId || snapshot.installationId !== installationId || snapshot.loading)) &&
        <div className="muted-empty compact" role="status">{t('work.loading')}</div>}
      {snapshot.sourceId === sourceId && snapshot.installationId === installationId && snapshot.loading && response &&
        <div className="muted-empty compact" role="status">{t('work.loading')}</div>}
      {sessionMessage && <div className="agent-path-error" role="status">{sessionMessage}</div>}
      {actionFeedback && <div className="muted-empty compact" role="status">{actionFeedback}</div>}
      {accessError && <div className="agent-path-error" role="alert">{accessError}</div>}
      {response && <div className="agent-detail-pane" aria-busy={snapshot.loading}>
        {response.features.filter(f=>f.availability==='error' || f.availability==='partial').map(feature=><div key={feature.id} role="alert" className="agent-path-error">
          {t(feature.availability==='partial'?'work.featurePartial':'work.featureError',{name:feature.id})} {feature.reason}
        </div>)}
        <div className="agent-primary-section">
          <div className="section-heading-row">
            <h2>{t('work.title')}</h2>
            <div className="runtime-config-row">
              {response.writeControlAvailable && <Button size="small" variant={accessEnabled?'danger':'default'}
                disabled={accessStatus==='loading' || accessBusy || actionBusy}
                onClick={()=>accessStatus==='error'?setAccessRetry(value=>value+1):setAccessChange(!accessEnabled)}>{t(accessStatus==='loading'?'work.writeLoading':accessStatus==='error'?'work.retry':accessEnabled?'work.writeDisable':'work.writeEnable')}</Button>}
              <Button size="small" loading={snapshot.loading} onClick={() => void refreshWorkspace({board:response.selectedBoard,offset,limit:PAGE_SIZE,scheduleOffset,projectOffset,...(selectedTask?{taskId:selectedTask,taskEventOffset,runOffset,commentOffset}:{}),...(selectedSchedule?{jobId:selectedSchedule.id,profile:selectedSchedule.profile,executionOffset}:{})})}>{t('work.refresh')}</Button>
            </div>
          </div>
          <div className="runtime-config-row">
            {boardAvailable && <Button size="small" variant={activePanel==='boards'?'primary':'default'} onClick={() => selectPanel('boards')}>{t('work.boards')}</Button>}
            {schedulesAvailable && <Button size="small" variant={activePanel==='schedules'?'primary':'default'} onClick={() => selectPanel('schedules')}>{t('work.schedules')}</Button>}
          </div>
        </div>
        {activePanel==='boards' && boardAvailable && <>
          <section className="agent-primary-section">
            <div className="section-heading-row"><h3>{t('work.boardTasks')}</h3>
              <span className="section-total">{board?.taskCount ?? '—'}</span>
              {permitted('board.create') && <Button size="small" onClick={()=>askAction({
                kind:'board.create',slug:'',
              })}>{t('work.actions.board_create')}</Button>}
              {permitted('board.rename') && response.selectedBoard && <Button size="small" onClick={()=>askAction({
                kind:'board.rename',slug:response.selectedBoard!,name:board?.name??response.selectedBoard!,
              })}>{t('work.actions.board_rename')}</Button>}
              {permitted('board.archive') && response.selectedBoard && response.selectedBoard!=='default'
                && <Button size="small" variant="danger" onClick={()=>askAction({
                  kind:'board.archive',slug:response.selectedBoard!,
                })}>{t('work.actions.board_archive')}</Button>}
              {permitted('task.create') && response.selectedBoard && <Button size="small" onClick={()=>askAction({
                kind:'task.create',boardId:response.selectedBoard!,title:'',
              })}>{t('work.actions.task_create')}</Button>}
            </div>
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
            {!response.selectedBoard && <div className="muted-empty compact">{t('work.noSelectedBoard')}</div>}
            {response.selectedBoard && response.tasks.length===0 && <div className="muted-empty compact">{t('work.noTasks')}</div>}
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
                commentOffset={commentOffset} commentsHasMore={response.taskCommentsHasMore} onCommentPage={nextTaskComments}
                permitted={permitted} onAction={askAction}/>} 
            </div>)}
            <div className="runtime-config-row">
              <span>{t('work.loaded')} {offset+response.tasks.length} / {board?.taskCount ?? '—'}</span>
              {offset>0 && <Button size="small" disabled={snapshot.loading} onClick={()=>loadBoard(response.selectedBoard??'default',Math.max(0,offset-PAGE_SIZE))}>{t('work.previous')}</Button>}
              {response.tasksHasMore && <Button size="small" disabled={snapshot.loading} onClick={()=>loadBoard(response.selectedBoard??'default',offset+PAGE_SIZE)}>{t('work.next')}</Button>}
            </div>
          </section>
        </>}
        {activePanel==='schedules' && schedulesAvailable && <section className="agent-primary-section">
          <div className="section-heading-row"><h3>{t('work.schedules')}</h3>
            <span className="section-total">{response.schedulesTotal}</span>
            {permitted('cron.create') && <Button size="small" onClick={()=>askAction({
              kind:'cron.create',profile:'default',schedule:'',prompt:'',
            })}>{t('work.actions.cron_create')}</Button>}
          </div>
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
              <div className="runtime-config-row">
                {permitted('cron.edit') && <Button size="small" onClick={()=>askAction({
                  kind:'cron.edit',profile:job.profile,jobId:job.id,name:job.name,
                })}>{t('work.actions.cron_edit')}</Button>}
                {permitted(job.enabled?'cron.pause':'cron.resume') && <Button size="small" onClick={()=>askAction({
                  kind:job.enabled?'cron.pause':'cron.resume',profile:job.profile,jobId:job.id,
                })}>{t(job.enabled?'work.actions.cron_pause':'work.actions.cron_resume')}</Button>}
                {permitted('cron.run') && <Button size="small" onClick={()=>askAction({
                  kind:'cron.run',profile:job.profile,jobId:job.id,
                })}>{t(['failed','error','timed_out','blocked_config'].includes(job.lastStatus??'')
                  ?'work.actions.cron_retry':'work.actions.cron_run')}</Button>}
                {permitted('cron.cancel') && response.executions.some(run=>
                  run.jobId===job.id && run.profile===job.profile &&
                  (run.status==='running'||run.status==='claimed'))
                && <Button size="small" onClick={()=>askAction({
                  kind:'cron.cancel',profile:job.profile,jobId:job.id,
                })}>{t('work.actions.cron_cancel')}</Button>}
                {permitted('cron.remove') && <Button size="small" variant="danger" onClick={()=>askAction({
                  kind:'cron.remove',profile:job.profile,jobId:job.id,
                })}>{t('work.actions.cron_remove')}</Button>}
              </div>
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
                {(cronOutput?.state === 'unavailable' || (cronOutput?.state === 'available' && !cronOutput.files.length)) &&
                  <div className="muted-empty compact">{t('work.noOutput')}</div>}
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
      <Dialog open={accessChange!==null} title={t(accessChange?'work.writeEnable':'work.writeDisable')}
        description={t('work.writeAccessDescription')}
        onClose={()=>{if(!accessBusy)setAccessChange(null)}} closeDisabled={accessBusy}
        footer={<div className="runtime-config-row">
          <Button disabled={accessBusy} onClick={()=>setAccessChange(null)}>{t('work.cancelAction')}</Button>
          <Button variant={accessChange?'danger':'primary'} loading={accessBusy}
            onClick={()=>void changeWriteAccess()}>{t('work.confirmAction')}</Button>
        </div>}>
        <div className="runtime-config-row"><span>{t('work.installation')}</span><code>{installationId}</code></div>
        {accessError && <div className="agent-path-error" role="alert">{accessError}</div>}
      </Dialog>
      <Dialog open={Boolean(pendingAction)} title={pendingAction?t(actionLabelKey(pendingAction.kind)):t('work.title')}
        description={t('work.confirmDescription')} onClose={()=>{if(!actionBusy)setPendingAction(null)}}
        closeDisabled={actionBusy} footer={<div className="runtime-config-row">
          <Button disabled={actionBusy} onClick={()=>setPendingAction(null)}>{t('work.cancelAction')}</Button>
          <Button variant={pendingAction?.kind==='cron.remove'||pendingAction?.kind==='task.archive'?'danger':'primary'}
            loading={actionBusy} onClick={()=>void applyAction()}>{t('work.confirmAction')}</Button>
        </div>}>
        {pendingAction && <>
          {pendingAction.kind==='cron.run' && <p>{t('work.runCaution')}</p>}
          {'slug' in pendingAction && <label>{t('work.fieldSlug')}<Input maxLength={80}
            disabled={pendingAction.kind!=='board.create'}
            value={pendingAction.slug} onChange={event=>pendingAction.kind==='board.create'
              && setPendingAction({...pendingAction,slug:event.target.value})}/></label>}
          {(pendingAction.kind==='board.create'||pendingAction.kind==='board.rename') && <label>
            {t('work.fieldName')}<Input maxLength={180} value={pendingAction.name??''}
              onChange={event=>setPendingAction({...pendingAction,name:event.target.value})}/></label>}
          <div className="runtime-config-row"><span>{t('work.installation')}</span><code>{installationId}</code></div>
          {'boardId' in pendingAction && <div className="runtime-config-row"><span>{t('work.boards')}</span><code>{pendingAction.boardId}</code></div>}
          {'jobId' in pendingAction && <div className="runtime-config-row"><span>{t('work.taskId')}</span><code>{pendingAction.jobId}</code></div>}
          {'taskId' in pendingAction && <div className="runtime-config-row"><span>{t('work.taskId')}</span><code>{pendingAction.taskId}</code></div>}
          {(pendingAction.kind==='task.create'||pendingAction.kind==='task.edit') && <>
            <label>{t('work.fieldTitle')}<Input value={pendingAction.title??''} maxLength={180}
              onChange={event=>setPendingAction({...pendingAction,title:event.target.value})}/></label>
            <label>{t('work.fieldPriority')}<Input type="number" value={pendingAction.priority??0}
              onChange={event=>setPendingAction({...pendingAction,priority:Number(event.target.value)})}/></label>
            <label>{t('work.fieldBody')}<Textarea rows={3} maxLength={4000} value={pendingAction.body??''}
              onChange={event=>setPendingAction({...pendingAction,body:event.target.value||undefined})}/></label>
          </>}
          {['task.block','task.unblock','task.complete','task.promote'].includes(pendingAction.kind)
            && 'reason' in pendingAction && <label>{t('work.fieldReason')}<Textarea rows={2}
            value={pendingAction.reason??''} maxLength={400}
            onChange={event=>setPendingAction({...pendingAction,reason:event.target.value||undefined})}/></label>}
          {pendingAction.kind==='task.assign' && <label>{t('work.fieldProfile')}<Input
            value={pendingAction.profile} maxLength={80} onChange={event=>setPendingAction({...pendingAction,profile:event.target.value})}/></label>}
          {(pendingAction.kind==='task.link'||pendingAction.kind==='task.unlink') && <>
            <label>{t('work.fieldParent')}<Input value={pendingAction.parentId} maxLength={128}
              onChange={event=>setPendingAction({...pendingAction,parentId:event.target.value})}/></label>
            <label>{t('work.fieldChild')}<Input value={pendingAction.childId} maxLength={128}
              onChange={event=>setPendingAction({...pendingAction,childId:event.target.value})}/></label>
          </>}
          {(pendingAction.kind==='cron.create'||pendingAction.kind==='cron.edit') && <>
            {pendingAction.kind==='cron.create' && <label>{t('work.fieldProfile')}<Input
              value={pendingAction.profile} maxLength={80} onChange={event=>setPendingAction({...pendingAction,profile:event.target.value})}/></label>}
            <label>{t('work.fieldName')}<Input value={pendingAction.name??''} maxLength={180}
              onChange={event=>setPendingAction({...pendingAction,name:event.target.value||undefined})}/></label>
            <label>{t('work.fieldSchedule')}<Input value={pendingAction.schedule??''} maxLength={180}
              onChange={event=>setPendingAction(pendingAction.kind==='cron.create'
                ? {...pendingAction,schedule:event.target.value}
                : {...pendingAction,schedule:event.target.value||undefined})}/></label>
            <label>{t('work.fieldPrompt')}<Textarea rows={4} maxLength={4000}
              value={pendingAction.prompt??''}
              onChange={event=>setPendingAction(pendingAction.kind==='cron.create'
                ? {...pendingAction,prompt:event.target.value}
                : {...pendingAction,prompt:event.target.value||undefined})}/></label>
          </>}
          {actionError && <div className="agent-path-error" role="alert">{actionError}</div>}
        </>}
      </Dialog>
    </div>
  </main>
}
function TaskRuns({task,runs,links,comments,events,hasMore,eventOffset,onEventPage,loading,onOpenSession,sessionPending,runOffset,runsHasMore,onRunPage,commentOffset,commentsHasMore,onCommentPage,permitted,onAction}: {
  task:AgentWorkTaskDto
  runs:import('@agent-lens/protocol').AgentWorkRunDto[]
  links:import('@agent-lens/protocol').AgentWorkLinkDto[]
  comments:import('@agent-lens/protocol').AgentWorkCommentDto[]
  events:import('@agent-lens/protocol').AgentWorkEventDto[]
  hasMore:boolean;eventOffset:number;onEventPage(offset:number):void;loading:boolean
  onOpenSession(id:string):void;sessionPending:boolean
  runOffset:number;runsHasMore:boolean;onRunPage(offset:number):void
  commentOffset:number;commentsHasMore:boolean;onCommentPage(offset:number):void
  permitted(kind:AgentWorkMutationDto['kind']):boolean
  onAction(action:AgentWorkMutationDto):void
}) {
  const {t} = useTranslation('agents')
  return <section className="agent-secondary">
    <div className="runtime-config-row"><span>{t('work.taskId')}</span><code>{task.id}</code></div>
    {task.sourceSessionNativeId && <div className="runtime-config-row"><span>{t('work.nativeSession')}</span><code>{task.sourceSessionNativeId}</code><Button size="small" loading={sessionPending} onClick={()=>onOpenSession(task.sourceSessionNativeId!)}>{t('work.openSession')}</Button></div>}
    <div className="runtime-config-row">
      {permitted('task.edit') && <Button size="small" onClick={()=>onAction({
        kind:'task.edit',boardId:task.boardId,taskId:task.id,title:task.title,priority:task.priority,
      })}>{t('work.actions.task_edit')}</Button>}
      {permitted('task.assign') && <Button size="small" onClick={()=>onAction({
        kind:'task.assign',boardId:task.boardId,taskId:task.id,profile:task.assignee??'default',
      })}>{t('work.actions.task_assign')}</Button>}
      {permitted('task.link') && <Button size="small" onClick={()=>onAction({
        kind:'task.link',boardId:task.boardId,parentId:task.id,childId:'',
      })}>{t('work.actions.task_link')}</Button>}
      {permitted('task.block') && !['blocked','done','archived'].includes(task.status) && <Button size="small" onClick={()=>onAction({
        kind:'task.block',boardId:task.boardId,taskId:task.id,
      })}>{t('work.actions.task_block')}</Button>}
      {permitted('task.unblock') && ['blocked','scheduled'].includes(task.status) && <Button size="small" onClick={()=>onAction({
        kind:'task.unblock',boardId:task.boardId,taskId:task.id,
      })}>{t(task.status==='blocked' && task.lastError?'work.actions.task_requeue':'work.actions.task_unblock')}</Button>}
      {permitted('task.promote') && ['todo','blocked','triage'].includes(task.status) && <Button size="small" onClick={()=>onAction({
        kind:'task.promote',boardId:task.boardId,taskId:task.id,
      })}>{t('work.actions.task_promote')}</Button>}
      {permitted('task.complete') && !['done','archived','running'].includes(task.status) && <Button size="small" onClick={()=>onAction({
        kind:'task.complete',boardId:task.boardId,taskId:task.id,
      })}>{t('work.actions.task_complete')}</Button>}
      {permitted('task.archive') && <Button size="small" variant="danger" onClick={()=>onAction({
        kind:'task.archive',boardId:task.boardId,taskId:task.id,
      })}>{t('work.actions.task_archive')}</Button>}
    </div>
    <div className="section-heading-row"><h3>{t('work.runs')}</h3><span className="section-total">{runs.length}</span></div>
    {!runs.length && <div className="muted-empty compact">{t('work.noRuns')}</div>}
    {links.length>0 && <div className="runtime-config-row"><span>{t('work.links')}</span>{links.map(link=>
      <span key={link.parentId+':'+link.childId}><code>{link.parentId} → {link.childId}</code>
        {permitted('task.unlink') && <Button size="small" onClick={()=>onAction({
          kind:'task.unlink',boardId:task.boardId,parentId:link.parentId,childId:link.childId,
        })}>{t('work.actions.task_unlink')}</Button>}
      </span>)}</div>}
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
