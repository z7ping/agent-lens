import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import type { HubReadAvailability, HubReviewSessionSummaryDto, PiLiveStateDto, ReviewSessionSummaryDto } from '@agent-lens/protocol'
import type { AgentLensClientModel } from '../client/model'
import { fetchHubReviewSessions, fetchLocalReviewSessions } from '../client/hub-review'
import { piLiveApi } from '../client/pi-live'
import { useClientSnapshot } from '../App'
import { agentLabel, sourceDot, useOrderedAgents } from '../components/AgentScope'
import { SidebarFilterDisclosure } from '../components/SidebarFilterDisclosure'
import { Button, IconButton, Input, SelectMenu, StatusBadge, Toolbar } from '../components/ui'
import { UiIcon } from '../components/UiIcon'
import { deriveTaskProjectOptions, historyTaskPresentation, pickTaskProject, sessionListTitle, type TaskProjectOption } from './task-center'
import { piLiveSessionTitle } from './pi-live-task-projection'
import { workspaceDisplayName } from './task-detail-model'
import { PROJECT_BOOTSTRAP_LIMIT } from './new-pi-task'

export type TaskCenterMode = 'history' | 'live' | 'new' | 'hub'

const HubReviewPage = lazy(() => import('./HubReviewPage').then(module => ({ default: module.HubReviewPage })))
const PiLivePage = lazy(() => import('./PiLivePage').then(module => ({ default: module.PiLivePage })))
const ReviewPage = lazy(() => import('./ReviewPage').then(module => ({ default: module.ReviewPage })))
type TaskDayGroup = '今天' | '昨天' | '更早'
type HistoryTaskEntry =
  | { kind: 'local'; id: string; at: string; local: ReviewSessionSummaryDto }
  | { kind: 'remote'; id: string; at: string; remote: HubReviewSessionSummaryDto }

function formatTime(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  const now = new Date()
  const diff = Math.max(0, now.getTime() - date.getTime())
  if (date.toDateString() === now.toDateString()) {
    const minutes = Math.floor(diff / 60_000)
    if (minutes < 1) return '刚刚'
    if (minutes < 60) return `${minutes} 分钟前`
    return `${Math.floor(diff / 3_600_000)} 小时前`
  }
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) {
    return `昨天 ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)}`
  }
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

function taskDayGroup(value: string, now = new Date()): TaskDayGroup {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '更早'
  if (date.toDateString() === now.toDateString()) return '今天'
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return '昨天'
  return '更早'
}

function cleanTitle(value: string | undefined, fallback: string): string {
  const text = value?.replace(/\s+/g, ' ').trim() ?? ''
  if (!text) return fallback
  return text.length > 74 ? `${text.slice(0, 74)}…` : text
}

function availabilityString(value: HubReadAvailability): string | undefined {
  return value.state === 'value' && typeof value.value === 'string' && value.value.trim()
    ? value.value.trim()
    : undefined
}

function localTime(item: ReviewSessionSummaryDto): string {
  return item.endedAt || item.startedAt
}

function remoteTime(item: HubReviewSessionSummaryDto): string {
  return availabilityString(item.endedAt) ?? availabilityString(item.startedAt) ?? ''
}

function remoteTitle(item: HubReviewSessionSummaryDto): string {
  const title = availabilityString(item.title)
  if (title) return cleanTitle(title, '远程任务')
  if (item.title.state === 'redacted') return '标题已脱敏'
  if (item.title.state === 'omitted') return item.title.reason === 'policy' ? '标题未同步' : '远程任务'
  return '远程任务'
}

function remoteVisible(item: HubReviewSessionSummaryDto, review: ReturnType<AgentLensClientModel['getSnapshot']>['review']): boolean {
  if (review.filters.sourceIds !== null || review.filters.projectId || review.filters.status !== 'all') return false
  const search = review.filters.search.trim().toLowerCase()
  if (search && !remoteTitle(item).toLowerCase().includes(search) && !item.origin.nodeId.toLowerCase().includes(search)) return false
  const time = remoteTime(item)
  if (!time || review.filters.range === 'all') return true
  const at = Date.parse(time)
  if (!Number.isFinite(at)) return false
  const now = Date.now()
  if (review.filters.range === 'today') {
    const date = new Date(at)
    const today = new Date(now)
    return date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()
  }
  const days = review.filters.range === '7d' ? 7 : 30
  return at >= now - days * 86_400_000
}

function NewTaskPanel({
  options,
  preferredProjectId,
  nativeDirectoryPicker,
  onStarted,
}: {
  options: TaskProjectOption[]
  preferredProjectId?: string | undefined
  nativeDirectoryPicker: boolean
  onStarted(runtimeSessionId: string): void | Promise<void>
}) {
  const [selectedKey, setSelectedKey] = useState('')
  const [availability, setAvailability] = useState<{ checked: boolean; available: boolean; label: string }>({ checked: false, available: false, label: '正在检测 Pi…' })
  const [starting, setStarting] = useState(false)
  const [selectingDirectory, setSelectingDirectory] = useState(false)
  const [manualDirectoryOpen, setManualDirectoryOpen] = useState(false)
  const [manualDirectory, setManualDirectory] = useState('')
  const [taskTitle, setTaskTitle] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const preferred = pickTaskProject(options, preferredProjectId)
    setSelectedKey(current => options.some(option => option.key === current) ? current : preferred?.key ?? '')
  }, [options, preferredProjectId])

  useEffect(() => {
    let cancelled = false
    void piLiveApi.availability().then(value => {
      if (cancelled) return
      setAvailability({
        checked: true,
        available: value.available,
        label: value.available ? 'Pi 已就绪' : `Pi 不可用${value.reason ? ` · ${value.reason}` : ''}`,
      })
    }, reason => {
      if (!cancelled) setAvailability({ checked: true, available: false, label: reason instanceof Error ? reason.message : String(reason) })
    })
    return () => { cancelled = true }
  }, [])

  const selected = options.find(option => option.key === selectedKey)
  const projectOptions = useMemo(() => options.map(option => ({ value: option.key, label: option.label, description: option.cwd, keywords: option.cwd })), [options])
  const agentStateLabel = !availability.checked ? '检测中' : availability.available ? '已就绪' : '不可用'
  const availabilityState = !availability.checked ? 'checking' : availability.available ? 'ready' : 'unavailable'
  const manualDirectoryVisible = !nativeDirectoryPicker || manualDirectoryOpen
  const composerStateLabel = selectingDirectory
    ? '正在打开系统目录选择器…'
    : !availability.checked
    ? '正在检测 Pi…'
    : !availability.available
      ? availability.label
      : selected
        ? '打开后直接在 Pi 页面输入任务'
        : '等待可启动项目'
  const start = async (project: { cwd: string; label: string }) => {
    if (starting || !availability.available) return
    setStarting(true)
    setError('')
    try {
      const state = await piLiveApi.start({
        cwd: project.cwd,
        name: taskTitle.trim() || project.label,
      })
      await onStarted(state.runtimeSessionId)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setStarting(false)
    }
  }

  const selectDirectoryAndStart = async () => {
    if (starting || selectingDirectory || !availability.available) return
    setSelectingDirectory(true)
    setError('')
    try {
      const cwd = await piLiveApi.selectProjectDirectory()
      if (!cwd) return
      const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
      const label = parts.at(-1) ?? cwd
      await start({ cwd, label })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSelectingDirectory(false)
    }
  }

  const startManualDirectory = async () => {
    const cwd = manualDirectory.trim()
    if (!cwd) {
      setError('请输入要启动 Pi 任务的工作目录。')
      return
    }
    const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
    const label = parts.at(-1) ?? cwd
    await start({ cwd, label })
  }

  return <div className="task-center-new">
    <section className="task-center-new-card">
      <header className="task-center-new-head">
        <div className="task-center-new-agent-mark" aria-hidden="true">Pi</div>
        <div>
          <div className="task-center-new-kicker">新建任务</div>
          <h1>新建 Pi 任务</h1>
          <p>选择工作项目，进入 Pi 实时任务工作区。</p>
        </div>
        <span className="task-center-new-readiness" data-state={availabilityState}><i/>{agentStateLabel}</span>
      </header>

      <div className="task-center-new-fields">
        <label className="task-center-new-task-title">
          <span>任务标题（可选）</span>
          <Input value={taskTitle} onChange={event => setTaskTitle(event.target.value)} placeholder="例如：修复目录选择无响应" disabled={starting} aria-label="Pi 任务标题"/>
        </label>
        <label className="task-center-new-project-field">
          <span>已有项目</span>
          <SelectMenu
            value={selectedKey}
            options={projectOptions}
            onChange={setSelectedKey}
            ariaLabel="选择已有 Pi 项目"
            placeholder={options.length ? '选择项目' : '暂无可启动项目'}
            variant="field"
            className="task-center-new-project-select"
            menuWidth={420}
            searchable
            searchPlaceholder="搜索项目或工作目录"
            disabled={!options.length}
          />
        </label>
        <div className="task-center-new-directory-action">
          <span>新项目</span>
          <div className="task-center-new-directory-actions">
            {nativeDirectoryPicker && <Button loading={selectingDirectory} disabled={!availability.available || starting} onClick={() => void selectDirectoryAndStart()}>选择目录新建并打开 <UiIcon name="arrow-right" size={14}/></Button>}
            {nativeDirectoryPicker && <Button size="small" disabled={!availability.available || starting} onClick={() => { setManualDirectoryOpen(value => !value); setError('') }}>输入路径</Button>}
          </div>
        </div>
      </div>
      {manualDirectoryVisible && <div className="task-center-new-manual-directory">
        <Input
          value={manualDirectory}
          onChange={event => setManualDirectory(event.target.value)}
          placeholder="例如 F:\\workspace\\my-project"
          aria-label="输入 Pi 新项目目录"
          disabled={starting}
          onKeyDown={event => {
            if (event.key === 'Enter') void startManualDirectory()
          }}
        />
        <Button variant="primary" loading={starting} disabled={!availability.available} onClick={() => void startManualDirectory()}>用此路径新建并打开 <UiIcon name="arrow-right" size={14}/></Button>
        {!nativeDirectoryPicker && <p className="task-center-new-directory-hint">请输入运行 AgentLens 的这台计算机上的绝对路径。系统会先检查目录存在且可读写，再启动 Pi。</p>}
      </div>}

      <div className="task-center-new-status"><b>{selected ? `在 ${selected.label} 中启动` : '等待选择项目'}</b><span>{composerStateLabel}</span></div>
      {error && <div className="pi-live-error" role="alert">{error}</div>}
      {!options.length && availability.checked && <div className="task-center-project-hint">最近会话中没有可用项目；可选择目录新建项目并打开。</div>}
      <div className="task-center-new-actions">
        <Button variant="primary" loading={starting} disabled={!selected || !availability.available} onClick={() => selected && void start(selected)}>打开已有项目 <UiIcon name="arrow-right" size={14}/></Button>
      </div>
    </section>
  </div>
}

function HistoryTaskItem({ item, active, onClick }: { item: ReviewSessionSummaryDto; active: boolean; onClick(): void }) {
  const sourceId = item.sourceIds[0] ?? ''
  const fallback = item.projectName ? `${item.projectName} 任务` : `${agentLabel(sourceId, item.productId)} 任务`
  const presentation = historyTaskPresentation(item, fallback)
  return <button className={`session-item ${active ? 'session-item-active' : ''}`} onClick={onClick}>
    <div className="session-item-title-row"><div className="session-item-title" title={presentation.title}>{sessionListTitle(presentation.title, fallback, item.sourceIds)}</div>{sourceId === 'pi' ? <StatusBadge tone="success">可继续</StatusBadge> : presentation.activityLabel && <StatusBadge className="session-activity-badge">{presentation.activityLabel}</StatusBadge>}</div>
    <div className="session-item-meta"><span className={`source-dot ${sourceDot(sourceId)}`}/><span>{agentLabel(sourceId, item.productId)}</span><span className="session-item-project">{item.projectName ?? item.workspacePath?.split(/[\\/]/).filter(Boolean).at(-1) ?? '无项目'}</span><time>{formatTime(localTime(item))}</time></div>
  </button>
}

function RemoteTaskItem({ item, active, onClick }: { item: HubReviewSessionSummaryDto; active: boolean; onClick(): void }) {
  const time = remoteTime(item)
  return <button className={`session-item ${active ? 'session-item-active' : ''}`} onClick={onClick}>
    <div className="session-item-title-row"><div className="session-item-title" title={remoteTitle(item)}>{sessionListTitle(remoteTitle(item), '远程任务')}</div></div>
    <div className="session-item-meta"><span className="hub-session-source remote">远程 · {item.origin.nodeId}</span><time>{time ? formatTime(time) : '时间未同步'}</time></div>
  </button>
}

export function TaskCenterPage({ model, mode, sidebarHost }: { model: AgentLensClientModel; mode: TaskCenterMode; sidebarHost?: HTMLDivElement | null }) {
  const snapshot = useClientSnapshot(model)
  const location = useLocation()
  const navigate = useNavigate()
  const [runtimes, setRuntimes] = useState<PiLiveStateDto[]>([])
  const [hubSessions, setHubSessions] = useState<HubReviewSessionSummaryDto[]>([])
  const [projectHistory, setProjectHistory] = useState<ReviewSessionSummaryDto[]>([])
  const historyScrollTargetRef = useRef('')
  const resumeRequestRef = useRef('')
  const review = snapshot.review
  const [searchOpen, setSearchOpen] = useState(Boolean(review.filters.search))
  const [resumingSessionId, setResumingSessionId] = useState('')
  const [piResumeError, setPiResumeError] = useState<{ sessionId: string; message: string } | null>(null)
  const agents = useOrderedAgents(snapshot.facets?.agents ?? [])
  const agentSelectionSummary = review.filters.sourceIds === null ? '全部智能体' : review.filters.sourceIds.length ? `已选 ${review.filters.sourceIds.length} 个` : '未选择'
  const projects = snapshot.facets?.projects ?? []

  const refreshRuntimes = useCallback(() => {
    void piLiveApi.knownRuntimes().then(setRuntimes, () => setRuntimes([]))
  }, [])

  useEffect(() => {
    refreshRuntimes()
    const onVisibility = () => { if (!document.hidden) refreshRuntimes() }
    const onPiLiveStateChanged = () => refreshRuntimes()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('agent-lens:pi-live-state-changed', onPiLiveStateChanged)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('agent-lens:pi-live-state-changed', onPiLiveStateChanged)
    }
  }, [location.pathname, refreshRuntimes])

  useEffect(() => {
    let cancelled = false
    void fetchHubReviewSessions(200).then(
      value => { if (!cancelled) setHubSessions(value.items.filter(item => item.origin.kind === 'remote')) },
      () => { if (!cancelled) setHubSessions([]) },
    )
    return () => { cancelled = true }
  }, [review.response?.meta.generatedAt])

  useEffect(() => {
    if (mode !== 'new') return
    let cancelled = false
    void fetchLocalReviewSessions(PROJECT_BOOTSTRAP_LIMIT).then(
      value => { if (!cancelled) setProjectHistory(value.items) },
      () => { if (!cancelled) setProjectHistory([]) },
    )
    return () => { cancelled = true }
  }, [mode])

  const localSessions = review.response?.items ?? []
  const projectSessions = useMemo(() => {
    const byId = new Map<string, ReviewSessionSummaryDto>()
    for (const item of [...projectHistory, ...localSessions]) byId.set(item.id, item)
    if (review.detail) byId.set(review.detail.id, review.detail)
    return [...byId.values()]
  }, [projectHistory, localSessions, review.detail])
  const projectOptions = useMemo(() => deriveTaskProjectOptions(projects, projectSessions), [projects, projectSessions])
  const visibleHub = useMemo(() => hubSessions.filter(item => remoteVisible(item, review)), [hubSessions, review])
  const historyGroups = useMemo(() => {
    const combined: HistoryTaskEntry[] = [
      ...localSessions.map(item => ({ kind: 'local' as const, id: item.id, at: localTime(item), local: item })),
      ...visibleHub.map(item => ({ kind: 'remote' as const, id: item.id, at: remoteTime(item), remote: item })),
    ].sort((left, right) => {
      const leftAt = Date.parse(left.at)
      const rightAt = Date.parse(right.at)
      if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt !== rightAt) return rightAt - leftAt
      if (Number.isFinite(leftAt) && !Number.isFinite(rightAt)) return -1
      if (!Number.isFinite(leftAt) && Number.isFinite(rightAt)) return 1
      return left.id.localeCompare(right.id)
    })
    const groups = new Map<TaskDayGroup, HistoryTaskEntry[]>([['今天', []], ['昨天', []], ['更早', []]])
    const now = new Date()
    for (const item of combined) groups.get(taskDayGroup(item.at, now))!.push(item)
    return (['今天', '昨天', '更早'] as const)
      .map(label => ({ label, items: groups.get(label)! }))
      .filter(group => group.items.length > 0)
  }, [localSessions, visibleHub])
  const preferredProjectId = new URLSearchParams(location.search).get('project') || review.detail?.projectId || review.filters.projectId || undefined

  const newTask = () => {
    const params = new URLSearchParams()
    const projectId = review.detail?.projectId || review.filters.projectId
    if (projectId) params.set('project', projectId)
    const search = params.toString()
    navigate(`/review/new${search ? `?${search}` : ''}`)
  }

  const openHistoryTask = useCallback((id: string) => {
    historyScrollTargetRef.current = id
    navigate(`/review/${encodeURIComponent(id)}`)

    let remainingFrames = 90
    let stableFrames = 0
    let previousHeight = -1
    const settle = () => {
      if (historyScrollTargetRef.current !== id) {
        document.querySelector<HTMLElement>('.review-reader-pane')?.style.removeProperty('overflow-anchor')
        return
      }

      const current = model.getSnapshot().review
      const pane = document.querySelector<HTMLElement>('.review-reader-pane')
      if (current.selectedId !== id || current.detailLoading || current.detail?.id !== id || !pane) {
        remainingFrames -= 1
        if (remainingFrames > 0) window.requestAnimationFrame(settle)
        return
      }

      pane.style.setProperty('overflow-anchor', 'none')
      pane.scrollTop = pane.scrollHeight
      const height = pane.scrollHeight
      stableFrames = height === previousHeight ? stableFrames + 1 : 0
      previousHeight = height
      remainingFrames -= 1
      if (stableFrames >= 3 || remainingFrames <= 0) {
        pane.style.removeProperty('overflow-anchor')
        if (historyScrollTargetRef.current === id) historyScrollTargetRef.current = ''
        return
      }
      window.requestAnimationFrame(settle)
    }
    window.requestAnimationFrame(settle)
  }, [model, navigate])

  const resumePiSession = useCallback(async (logicalSessionId: string) => {
    if (resumeRequestRef.current) return
    resumeRequestRef.current = logicalSessionId
    setResumingSessionId(logicalSessionId)
    setPiResumeError(null)
    try {
      const state = await piLiveApi.resume(logicalSessionId)
      navigate(`/review/live/${encodeURIComponent(state.runtimeSessionId)}`)
    } catch (reason) {
      setPiResumeError({
        sessionId: logicalSessionId,
        message: reason instanceof Error ? reason.message : String(reason),
      })
    } finally {
      resumeRequestRef.current = ''
      setResumingSessionId('')
    }
  }, [navigate])

  const selectedRuntimeId = location.pathname.startsWith('/review/live/')
    ? decodeURIComponent(location.pathname.slice('/review/live/'.length))
    : ''
  const historyCount = localSessions.length + visibleHub.length
  const projectFilterOptions = [
    { value: '', label: '全部项目' },
    ...projects.map(project => ({ value: project.id, label: project.name ?? project.repositoryIdentity ?? project.id, description: project.repositoryIdentity ?? undefined })),
  ]

  const taskRail = <aside className="task-center-rail" aria-label="任务列表：进行中 + 历史">
    <div className="task-center-rail-head">
      <Button size="small" variant="primary" className="task-center-new-task-button" onClick={newTask}><UiIcon name="plus" size={14}/> 新建任务</Button>
      <Toolbar className="task-center-toolbar" aria-label="筛选历史任务">
        <IconButton
          size="small"
          className={searchOpen || review.filters.search ? 'is-active' : ''}
          onClick={() => setSearchOpen(current => !current)}
          title={searchOpen ? '收起搜索' : '搜索历史任务'}
          aria-label={searchOpen ? '收起搜索' : '搜索历史任务'}
          aria-pressed={searchOpen}
        ><UiIcon name="search" size={14}/></IconButton>
        <IconButton size="small" onClick={() => void model.refreshReview()} title="刷新历史任务" aria-label="刷新历史任务"><UiIcon name="refresh" size={14}/></IconButton>
      </Toolbar>
    </div>

    <SidebarFilterDisclosure className="task-center-sidebar-filter" summaryMeta={agentSelectionSummary} agents={agents} agentSelection={{ mode: 'multiple', value: review.filters.sourceIds, onChange: sourceIds => model.setReviewFilters({ sourceIds }) }}>
      <div className="workspace-insight-filter-fields" aria-label="筛选历史任务">
        <label><span>项目</span><SelectMenu variant="field" value={review.filters.projectId} onChange={projectId => model.setReviewFilters({ projectId })} ariaLabel="筛选项目" placeholder="全部项目" menuWidth={280} searchable searchPlaceholder="搜索项目" options={projectFilterOptions}/></label>
        <label><span>时间</span><SelectMenu variant="field" value={review.filters.range} onChange={range => model.setReviewFilters({ range: range as typeof review.filters.range })} ariaLabel="筛选时间范围" menuWidth={156} options={[
          { value: 'today', label: '今天' }, { value: '7d', label: '最近 7 天' }, { value: '30d', label: '最近 30 天' }, { value: 'all', label: '全部时间' },
        ]}/></label>
        <label><span>状态</span><SelectMenu variant="field" value={review.filters.status} onChange={status => model.setReviewFilters({ status: status as typeof review.filters.status })} ariaLabel="筛选状态" menuWidth={150} options={[
          { value: 'all', label: '全部状态' }, { value: 'clean', label: '无错误' }, { value: 'with-errors', label: '有错误' },
        ]}/></label>
      </div>
    </SidebarFilterDisclosure>

    {searchOpen && <div className="task-center-search-panel">
      <div className="task-center-search-field">
        <UiIcon name="search" size={14}/>
        <Input
          autoFocus
          className="task-center-search-input"
          placeholder="搜索任务…"
          value={review.filters.search}
          onChange={event => model.setReviewFilters({ search: event.target.value })}
          onKeyDown={event => { if (event.key === 'Escape') setSearchOpen(false) }}
          aria-label="搜索历史任务"
        />
        {review.filters.search && <IconButton
          size="small"
          className="task-center-search-clear"
          onClick={() => model.setReviewFilters({ search: '' })}
          title="清除搜索"
          aria-label="清除搜索"
        ><UiIcon name="close" size={14}/></IconButton>}
      </div>
    </div>}

    <div className="task-center-scroll">
      {runtimes.length > 0 && <section className="task-center-group task-center-live-group">
        <div className="task-center-group-title"><span>进行中</span><span>{runtimes.length}</span></div>
        {runtimes.map(item => <button key={item.runtimeSessionId} className={`session-item task-live-item ${selectedRuntimeId === item.runtimeSessionId ? 'session-item-active' : ''}`} onClick={() => navigate(`/review/live/${encodeURIComponent(item.runtimeSessionId)}`)}>
          <div className="session-item-title-row"><div className="session-item-title" title={piLiveSessionTitle(item)}>{sessionListTitle(piLiveSessionTitle(item), 'Pi 任务', ['pi'])}</div><PiLiveRuntimeStatusBadge state={item}/></div>
          <div className="session-item-meta"><span className={item.isStreaming || item.status === 'initializing' ? 'pi-live-pulse' : 'pi-live-idle-dot'}/><span>Pi</span><span className="session-item-project">{item.projectName || workspaceDisplayName(item.workspacePath) || '未关联项目'}</span>{item.startedAt && <time>{formatTime(item.startedAt)}</time>}</div>
        </button>)}
      </section>}

      {historyGroups.map(group => <section className="task-center-group task-center-history-group" key={group.label}>
        <div className="task-center-group-title"><span>{group.label}</span><span>{group.items.length}{group.label === '更早' && review.response?.meta.hasMore ? '+' : ''}</span></div>
        {group.items.map(entry => entry.kind === 'local'
          ? <HistoryTaskItem key={`local:${entry.id}`} item={entry.local} active={mode === 'history' && review.selectedId === entry.id} onClick={() => openHistoryTask(entry.id)}/>
          : <RemoteTaskItem key={`remote:${entry.id}`} item={entry.remote} active={mode === 'hub' && location.pathname === `/review/hub/${encodeURIComponent(entry.id)}`} onClick={() => navigate(`/review/hub/${encodeURIComponent(entry.id)}`)}/>)}
      </section>)}

      {!historyCount && !review.loading && <div className="task-center-empty">当前筛选范围没有历史任务。</div>}
      {review.response?.meta.hasMore && <Button size="small" className="session-load-more" loading={review.loadingMore} onClick={() => void model.loadMoreReview()}>加载更多历史任务</Button>}
    </div>
  </aside>

  return <>
    {sidebarHost ? createPortal(taskRail, sidebarHost) : null}
    <div className={`task-center-page ${mode === 'new' ? 'is-new-task' : ''}`}>
      <section className="task-center-main">
        <Suspense fallback={<div className="workspace-skeleton" role="status" aria-label="正在加载任务详情"><span className="state-skeleton"/><span className="state-skeleton"/><span className="state-skeleton"/></div>}>
          {mode === 'history' && <ReviewPage
            model={model}
            embedded
            onResumePiSession={resumePiSession}
            resumingPiSession={resumingSessionId === review.detail?.id}
            piResumeError={piResumeError && piResumeError.sessionId === review.detail?.id ? piResumeError.message : ''}
          />}
          {mode === 'live' && <PiLivePage embedded/>}
          {mode === 'hub' && <HubReviewPage embedded/>}
          {mode === 'new' && <NewTaskPanel options={projectOptions} preferredProjectId={preferredProjectId} nativeDirectoryPicker={snapshot.health?.runtime?.owner === 'desktop'} onStarted={runtimeSessionId => navigate(`/review/live/${encodeURIComponent(runtimeSessionId)}`)}/>}
        </Suspense>
      </section>
    </div>
  </>
}

function runtimeStatusBadge(state: PiLiveStateDto): { label: string; tone: 'neutral' | 'accent' | 'warning' | 'danger'; dot?: boolean } {
  if (state.status === 'failed') return { label: '需要处理', tone: 'danger' }
  if (state.status === 'initializing') return { label: '启动中', tone: 'warning', dot: true }
  if (state.isStreaming) return { label: '执行中', tone: 'accent', dot: true }
  return { label: '等待输入', tone: 'warning' }
}

function PiLiveRuntimeStatusBadge({ state }: { state: PiLiveStateDto }) {
  const badge = runtimeStatusBadge(state)
  return <StatusBadge tone={badge.tone} dot={badge.dot}>{badge.label}</StatusBadge>
}
