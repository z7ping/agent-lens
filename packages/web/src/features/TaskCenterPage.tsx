import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { HubReadAvailability, HubReviewSessionSummaryDto, PiLiveStateDto, ReviewSessionSummaryDto } from '@agent-lens/protocol'
import type { AgentLensClientModel } from '../client/model'
import { fetchHubReviewSessions, fetchLocalReviewSessions } from '../client/hub-review'
import { piLiveApi } from '../client/pi-live'
import { useClientSnapshot } from '../App'
import { agentLabel, sourceDot } from '../components/AgentScope'
import { HubReviewPage } from './HubReviewPage'
import { PiLivePage } from './PiLivePage'
import { ReviewPage } from './ReviewPage'
import { deriveTaskProjectOptions, pickTaskProject, type TaskProjectOption } from './task-center'

export type TaskCenterMode = 'history' | 'live' | 'new' | 'hub'

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

function cleanTitle(value: string | undefined, fallback: string): string {
  const text = value?.replace(/\s+/g, ' ').trim() ?? ''
  if (!text) return fallback
  return text.length > 74 ? `${text.slice(0, 74)}…` : text
}

function modelLabel(state: PiLiveStateDto): string {
  const model = state.model && typeof state.model === 'object' && !Array.isArray(state.model)
    ? state.model as Record<string, unknown>
    : {}
  const provider = typeof model.provider === 'string' ? model.provider : ''
  const id = typeof model.id === 'string' ? model.id : typeof model.modelId === 'string' ? model.modelId : ''
  return [provider, id].filter(Boolean).join(' / ') || 'Pi 默认模型'
}

function availabilityString(value: HubReadAvailability): string | undefined {
  return value.state === 'value' && typeof value.value === 'string' && value.value.trim()
    ? value.value.trim()
    : undefined
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
  if (review.filters.sourceId || review.filters.projectId || review.filters.status !== 'all') return false
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
  onStarted,
}: {
  options: TaskProjectOption[]
  preferredProjectId?: string | undefined
  onStarted(runtimeSessionId: string): void | Promise<void>
}) {
  const [selectedKey, setSelectedKey] = useState('')
  const [prompt, setPrompt] = useState('')
  const [availability, setAvailability] = useState<{ checked: boolean; available: boolean; label: string }>({ checked: false, available: false, label: '正在检测 Pi…' })
  const [starting, setStarting] = useState(false)
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
  const start = async () => {
    const task = prompt.trim()
    if (!selected || !task || starting || !availability.available) return
    setStarting(true)
    setError('')
    try {
      const state = await piLiveApi.start({
        cwd: selected.cwd,
        name: cleanTitle(task, `${selected.label} · Pi`),
      })
      await piLiveApi.prompt(state.runtimeSessionId, task)
      await onStarted(state.runtimeSessionId)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setStarting(false)
    }
  }

  return <div className="task-center-new">
    <section className="task-center-new-card">
      <div className="task-center-new-kicker">新建任务</div>
      <h1>让 Pi 开始一个任务</h1>
      <p>选择项目并描述要做的事情。工作目录由 AgentLens 根据已观测到的项目会话自动确定，不需要手动输入路径。</p>

      <div className="task-center-new-fields">
        <label>
          <span>项目</span>
          <select value={selectedKey} onChange={event => setSelectedKey(event.target.value)} disabled={!options.length}>
            {!options.length && <option value="">暂无可启动项目</option>}
            {options.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
          </select>
          <small>{options.length ? '目录来自最近一次已观测任务。' : '当前还没有从真实会话中识别到可靠项目目录。'}</small>
        </label>
        <label>
          <span>智能体</span>
          <div className="task-center-agent-fixed"><span className="pi-live-pulse"/><b>Pi</b><small>alpha.3 当前可主动启动的智能体</small></div>
        </label>
      </div>

      <label className="task-center-prompt">
        <span>任务</span>
        <textarea value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="例如：检查当前项目的 CI 失败原因并给出修复方案" autoFocus/>
      </label>

      <div className="task-center-new-status">{availability.label}</div>
      {error && <div className="pi-live-error" role="alert">{error}</div>}
      {!options.length && <div className="task-center-project-hint">先让 AgentLens 采集到一次带工作目录的项目会话，再从这里新建任务；本页面不会要求你手填 cwd。</div>}
      <div className="task-center-new-actions">
        <button className="btn primary" disabled={!selected || !prompt.trim() || starting || !availability.available} onClick={() => void start()}>{starting ? '正在启动…' : '开始任务'}</button>
      </div>
    </section>
  </div>
}

function HistoryTaskItem({ item, active, onClick }: { item: ReviewSessionSummaryDto; active: boolean; onClick(): void }) {
  const sourceId = item.sourceIds[0] ?? ''
  const fallback = item.projectName ? `${item.projectName} 任务` : `${agentLabel(sourceId, item.productId)} 任务`
  return <button className={`session-item ${active ? 'session-item-active' : ''}`} onClick={onClick}>
    <div className="session-item-meta"><span className={`source-dot ${sourceDot(sourceId)}`}/><span>{agentLabel(sourceId, item.productId)}</span><time>{formatTime(item.endedAt)}</time></div>
    <div className="session-item-title">{cleanTitle(item.title || item.preview, fallback)}</div>
    <div className="session-item-foot"><span>{item.projectName ?? item.workspacePath?.split(/[\\/]/).filter(Boolean).at(-1) ?? '无项目'}</span><span>{item.toolCount} 调用{item.errorCount ? ` · ${item.errorCount} 错误` : ''}</span></div>
  </button>
}

export function TaskCenterPage({ model, mode }: { model: AgentLensClientModel; mode: TaskCenterMode }) {
  const snapshot = useClientSnapshot(model)
  const location = useLocation()
  const navigate = useNavigate()
  const [runtimes, setRuntimes] = useState<PiLiveStateDto[]>([])
  const [hubSessions, setHubSessions] = useState<HubReviewSessionSummaryDto[]>([])
  const [projectHistory, setProjectHistory] = useState<ReviewSessionSummaryDto[]>([])
  const review = snapshot.review

  const refreshRuntimes = useCallback(() => {
    void piLiveApi.knownRuntimes().then(setRuntimes, () => setRuntimes([]))
  }, [])

  useEffect(() => {
    refreshRuntimes()
    const onVisibility = () => { if (!document.hidden) refreshRuntimes() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
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
    void fetchLocalReviewSessions(500).then(
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
  const projectOptions = useMemo(() => deriveTaskProjectOptions(snapshot.facets?.projects ?? [], projectSessions), [snapshot.facets?.projects, projectSessions])
  const visibleHub = useMemo(() => hubSessions.filter(item => remoteVisible(item, review)), [hubSessions, review])
  const preferredProjectId = new URLSearchParams(location.search).get('project') || review.detail?.projectId || review.filters.projectId || undefined

  const newTask = () => {
    const params = new URLSearchParams()
    const projectId = review.detail?.projectId || review.filters.projectId
    if (projectId) params.set('project', projectId)
    const search = params.toString()
    navigate(`/review/new${search ? `?${search}` : ''}`)
  }

  const selectedRuntimeId = location.pathname.startsWith('/review/live/')
    ? decodeURIComponent(location.pathname.slice('/review/live/'.length))
    : ''

  return <div className="task-center-page">
    <aside className="task-center-rail">
      <div className="task-center-rail-head">
        <div><b>任务</b><span>进行中 + 历史</span></div>
        <button className="btn small primary" onClick={newTask}>+ 新建任务</button>
      </div>
      <div className="task-center-scroll">
        {runtimes.length > 0 && <section className="task-center-group">
          <div className="task-center-group-title"><span>进行中</span><span>{runtimes.length}</span></div>
          {runtimes.map(item => <button key={item.runtimeSessionId} className={`session-item task-live-item ${selectedRuntimeId === item.runtimeSessionId ? 'session-item-active' : ''}`} onClick={() => navigate(`/review/live/${encodeURIComponent(item.runtimeSessionId)}`)}>
            <div className="session-item-meta"><span className={item.isStreaming ? 'pi-live-pulse' : 'pi-live-idle-dot'}/><span>Pi</span><time>{item.isStreaming ? '实时' : '等待输入'}</time></div>
            <div className="session-item-title">{item.sessionName || 'Pi 任务'}</div>
            <div className="session-item-foot"><span>{modelLabel(item)}</span><span>{item.isStreaming ? '执行中' : '可继续'}</span></div>
          </button>)}
        </section>}

        <section className="task-center-group">
          <div className="task-center-group-title"><span>历史任务</span><span>{localSessions.length + visibleHub.length}{review.response?.meta.hasMore ? '+' : ''}</span></div>
          {localSessions.map(item => <HistoryTaskItem key={item.id} item={item} active={mode === 'history' && review.selectedId === item.id} onClick={() => navigate(`/review/${encodeURIComponent(item.id)}`)}/>)}
          {visibleHub.map(item => {
            const time = remoteTime(item)
            const active = mode === 'hub' && location.pathname === `/review/hub/${encodeURIComponent(item.id)}`
            return <button key={`remote:${item.id}`} className={`session-item ${active ? 'session-item-active' : ''}`} onClick={() => navigate(`/review/hub/${encodeURIComponent(item.id)}`)}>
              <div className="session-item-meta"><span className="hub-session-source remote">远程 · {item.origin.nodeId}</span><time>{time ? formatTime(time) : '时间未同步'}</time></div>
              <div className="session-item-title">{remoteTitle(item)}</div>
              <div className="session-item-foot"><span>Hub 任务</span><span>{item.origin.nodeId}</span></div>
            </button>
          })}
          {!localSessions.length && !visibleHub.length && !review.loading && <div className="task-center-empty">当前筛选范围没有历史任务。</div>}
          {review.response?.meta.hasMore && <button className="session-load-more" disabled={review.loadingMore} onClick={() => void model.loadMoreReview()}>{review.loadingMore ? '正在加载…' : '加载更多历史任务'}</button>}
        </section>
      </div>
    </aside>

    <section className="task-center-main">
      {mode === 'history' && <ReviewPage model={model}/>} 
      {mode === 'live' && <PiLivePage/>} 
      {mode === 'hub' && <HubReviewPage/>} 
      {mode === 'new' && <NewTaskPanel options={projectOptions} preferredProjectId={preferredProjectId} onStarted={runtimeSessionId => navigate(`/review/live/${encodeURIComponent(runtimeSessionId)}`)}/>} 
    </section>
  </div>
}
