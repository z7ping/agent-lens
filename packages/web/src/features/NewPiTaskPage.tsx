import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { canSelectDesktopWorkspace, selectDesktopWorkspace } from '../client/desktop-workspace'
import { fetchLocalReviewSessions } from '../client/hub-review'
import { piLiveApi } from '../client/pi-live'
import { OperationProgress } from '../components/StateViews'
import { Button, SelectMenu } from '../components/ui'
import { UiIcon } from '../components/UiIcon'
import { TaskSurface } from './TaskSurface'
import { deriveTaskProjectOptions, pickTaskProject, type TaskProjectOption } from './task-center'
import { PROJECT_BOOTSTRAP_LIMIT } from './new-pi-task'

function workspaceLabel(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path
}

export function NewPiTaskPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const [projects, setProjects] = useState<TaskProjectOption[]>([])
  const [selectedKey, setSelectedKey] = useState('')
  const [availability, setAvailability] = useState<{ checked: boolean; available: boolean; label: string }>({ checked: false, available: false, label: '正在检测 Pi…' })
  const [starting, setStarting] = useState(false)
  const [pickingWorkspace, setPickingWorkspace] = useState(false)
  const [startingElapsedMs, setStartingElapsedMs] = useState(0)
  const [error, setError] = useState('')
  const preferredProjectId = new URLSearchParams(location.search).get('project') || undefined
  const canBrowseWorkspace = canSelectDesktopWorkspace()

  useEffect(() => {
    let cancelled = false
    void piLiveApi.availability().then(pi => {
      if (cancelled) return
      setAvailability({ checked: true, available: pi.available, label: pi.available ? 'Pi 已就绪' : `Pi 不可用${pi.reason ? ` · ${pi.reason}` : ''}` })
    }, reason => {
      if (cancelled) return
      setAvailability({ checked: true, available: false, label: reason instanceof Error ? reason.message : String(reason) })
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    void fetchLocalReviewSessions(PROJECT_BOOTSTRAP_LIMIT).then(sessions => {
      if (!cancelled) setProjects(deriveTaskProjectOptions([], sessions.items))
    }, () => {
      if (!cancelled) setProjects([])
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const preferred = pickTaskProject(projects, preferredProjectId)
    setSelectedKey(current => projects.some(option => option.key === current) ? current : preferred?.key ?? '')
  }, [preferredProjectId, projects])

  useEffect(() => {
    if (!starting) {
      setStartingElapsedMs(0)
      return
    }
    const startedAt = Date.now()
    const timer = window.setInterval(() => setStartingElapsedMs(Date.now() - startedAt), 250)
    return () => window.clearInterval(timer)
  }, [starting])

  const selected = projects.find(option => option.key === selectedKey)
  const projectOptions = useMemo(() => projects.map(option => ({ value: option.key, label: option.label, description: option.cwd, keywords: option.cwd })), [projects])
  const availabilityState = !availability.checked ? 'checking' : availability.available ? 'ready' : 'unavailable'
  const agentStateLabel = !availability.checked ? '检测中' : availability.available ? '已就绪' : '不可用'
  const composerStateLabel = !availability.checked ? '正在检测 Pi…' : !availability.available ? availability.label : selected ? '打开后直接在 Pi 页面输入任务' : '等待可启动项目'

  const pickWorkspace = async () => {
    if (!canBrowseWorkspace || pickingWorkspace || starting) return
    setPickingWorkspace(true)
    setError('')
    try {
      const cwd = await selectDesktopWorkspace()
      if (!cwd) return
      const option: TaskProjectOption = {
        key: `workspace:${cwd}`,
        label: workspaceLabel(cwd),
        cwd,
        lastSeenAt: new Date().toISOString(),
      }
      setProjects(current => [option, ...current.filter(item => item.cwd !== cwd)])
      setSelectedKey(option.key)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setPickingWorkspace(false)
    }
  }

  const start = async () => {
    if (!selected || starting || !availability.available) return
    setStarting(true)
    setError('')
    try {
      const state = await piLiveApi.start({ cwd: selected.cwd, name: `${selected.label} · Pi` })
      navigate(`/review/live/${encodeURIComponent(state.runtimeSessionId)}`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setStarting(false)
    }
  }

  return <div className="task-center-page is-new-task">
    <section className="task-center-main">
      <TaskSurface mode="new">
        <div className="task-center-new">
          <section className="task-center-new-card">
            <header className="task-center-new-head">
              <div className="task-center-new-agent-mark" aria-hidden="true">Pi</div>
              <div><div className="task-center-new-kicker">新建任务</div><h1>新建 Pi 任务</h1><p>选择工作项目，进入 Pi 实时任务工作区。</p></div>
              <span className="task-center-new-readiness" data-state={availabilityState}><i/>{agentStateLabel}</span>
            </header>
            {starting ? <div className="task-center-new-operation"><OperationProgress
              statusLabel="正在创建"
              title="正在进入 Pi 实时任务"
              description={`正在为 ${selected?.label || '所选项目'} 分配 Runtime；进入工作区后会继续显示资源与 Session 初始化进度。`}
              elapsedMs={startingElapsedMs}
            /></div> : <>
              <div className="task-center-new-fields">
                <label className="task-center-new-project-field"><span>项目</span><SelectMenu value={selectedKey} options={projectOptions} onChange={setSelectedKey} ariaLabel="选择 Pi 任务项目" placeholder={projects.length ? '选择项目' : '暂无最近项目'} variant="field" className="task-center-new-project-select" menuWidth={420} searchable searchPlaceholder="搜索项目或工作目录" disabled={!projects.length}/></label>
                {canBrowseWorkspace && <Button variant="secondary" disabled={pickingWorkspace} onClick={() => void pickWorkspace()}>{pickingWorkspace ? '正在选择…' : '选择文件夹'}</Button>}
              </div>
              <div className="task-center-new-status"><b>{selected ? `在 ${selected.label} 中启动` : '等待选择项目'}</b><span>{composerStateLabel}</span></div>
              {error && <div className="pi-live-error" role="alert">{error}</div>}
              {!projects.length && availability.checked && <div className="task-center-project-hint">{canBrowseWorkspace ? '最近会话中没有可用工作目录，可以直接选择本机文件夹。' : '最近会话中没有可用工作目录；浏览器版无法直接读取本机目录。'}</div>}
              <div className="task-center-new-actions"><Button variant="primary" disabled={!selected || !availability.available} onClick={() => void start()}>创建 Pi 任务 <UiIcon name="arrow-right" size={14}/></Button></div>
            </>}
          </section>
        </div>
      </TaskSurface>
    </section>
  </div>
}
