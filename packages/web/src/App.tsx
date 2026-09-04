import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type PropsWithChildren } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import type { AgentFacetDto } from '@agent-lens/protocol'
import type { AgentLensClientModel, ClientSnapshot } from './client/model'
import { readAgentFilterPreference, readTheme, writeAgentFilterPreference, writeTheme } from './client/preferences'
import { AgentsStateOverlay } from './components/AgentsStateOverlay'
import { BackgroundDataNotice } from './components/BackgroundDataNotice'
import { ReviewStateOverlay } from './components/ReviewStateOverlay'
import { ReviewTurnRail } from './components/ReviewTurnRail'
import { WorkspaceSidebar } from './components/WorkspaceSidebar'
import { AgentsResponsivePage } from './features/AgentsResponsivePage'
import { BackupPage } from './features/BackupPage'
import { InsightsPage } from './features/InsightsPage'
import { TaskCenterPage } from './features/TaskCenterPage'
import { ToolsPage } from './features/ToolsPage'

export function useClientSnapshot(model: AgentLensClientModel): ClientSnapshot {
  return useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot)
}

interface PinnedContextValue {
  ordered: string[]
  pinned: string[]
  toggle(id: string): void
  move(id: string, targetId: string): void
  moveBy(id: string, offset: -1 | 1): void
  reset(): void
}
const PinnedContext = createContext<PinnedContextValue>({ ordered: [], pinned: [], toggle: () => undefined, move: () => undefined, moveBy: () => undefined, reset: () => undefined })
export function usePinnedAgents(): PinnedContextValue { return useContext(PinnedContext) }

function PinnedProvider({ agents, children }: PropsWithChildren<{ agents: AgentFacetDto[] }>) {
  const [preference, setPreference] = useState(() => readAgentFilterPreference() ?? { orderedAgentIds: [], visibleAgentIds: [] })
  useEffect(() => {
    if (!agents.length) return
    setPreference(current => {
      const available = agents.map(agent => agent.sourceId)
      const known = current.orderedAgentIds.filter(id => available.includes(id))
      const orderedAgentIds = [...known, ...available.filter(id => !known.includes(id))]
      const visibleAgentIds = current.orderedAgentIds.length
        ? current.visibleAgentIds.filter(id => available.includes(id))
        : agents.filter(agent => agent.detected).map(agent => agent.sourceId)
      const next = { orderedAgentIds, visibleAgentIds }
      if (orderedAgentIds.join('\u0000') === current.orderedAgentIds.join('\u0000') && visibleAgentIds.join('\u0000') === current.visibleAgentIds.join('\u0000')) return current
      writeAgentFilterPreference(next)
      return next
    })
  }, [agents])
  const value = useMemo<PinnedContextValue>(() => ({
    ordered: preference.orderedAgentIds,
    pinned: preference.visibleAgentIds,
    toggle(id) {
      setPreference(current => {
        const visibleAgentIds = current.visibleAgentIds.includes(id) ? current.visibleAgentIds.filter(item => item !== id) : [...current.visibleAgentIds, id]
        const next = { ...current, visibleAgentIds }
        writeAgentFilterPreference(next)
        return next
      })
    },
    move(id, targetId) {
      setPreference(current => {
        const from = current.orderedAgentIds.indexOf(id)
        const to = current.orderedAgentIds.indexOf(targetId)
        if (from < 0 || to < 0 || from === to) return current
        const orderedAgentIds = [...current.orderedAgentIds]
        orderedAgentIds.splice(from, 1)
        orderedAgentIds.splice(to, 0, id)
        const next = { ...current, orderedAgentIds }
        writeAgentFilterPreference(next)
        return next
      })
    },
    moveBy(id, offset) {
      setPreference(current => {
        const from = current.orderedAgentIds.indexOf(id)
        const to = from + offset
        if (from < 0 || to < 0 || to >= current.orderedAgentIds.length) return current
        const orderedAgentIds = [...current.orderedAgentIds]
        ;[orderedAgentIds[from], orderedAgentIds[to]] = [orderedAgentIds[to]!, orderedAgentIds[from]!]
        const next = { ...current, orderedAgentIds }
        writeAgentFilterPreference(next)
        return next
      })
    },
    reset() {
      const next = { orderedAgentIds: agents.map(agent => agent.sourceId), visibleAgentIds: agents.filter(agent => agent.detected).map(agent => agent.sourceId) }
      writeAgentFilterPreference(next)
      setPreference(next)
    },
  }), [agents, preference])
  return <PinnedContext.Provider value={value}>{children}</PinnedContext.Provider>
}

type ReviewFilters = ClientSnapshot['review']['filters']

function reviewFiltersFromSearch(search: string): ReviewFilters {
  const params = new URLSearchParams(search)
  const range = params.get('range')
  const status = params.get('status')
  return {
    sourceId: params.get('source') ?? '',
    projectId: params.get('project') ?? '',
    range: range === 'today' || range === '7d' || range === '30d' || range === 'all' ? range : '7d',
    status: status === 'clean' || status === 'with-errors' || status === 'all' ? status : 'all',
    search: params.get('q') ?? '',
  }
}

function reviewSearchFromFilters(filters: ReviewFilters): string {
  const params = new URLSearchParams()
  if (filters.sourceId) params.set('source', filters.sourceId)
  if (filters.projectId) params.set('project', filters.projectId)
  params.set('range', filters.range)
  params.set('status', filters.status)
  if (filters.search) params.set('q', filters.search)
  return `?${params.toString()}`
}

function sameReviewFilters(left: ReviewFilters, right: ReviewFilters): boolean {
  return left.sourceId === right.sourceId
    && left.projectId === right.projectId
    && left.range === right.range
    && left.status === right.status
    && left.search === right.search
}

function Shell({ model }: { model: AgentLensClientModel }) {
  const snapshot = useClientSnapshot(model)
  const location = useLocation()
  const navigate = useNavigate()
  const [theme, setTheme] = useState(readTheme)
  const [agentOverviewSourceId, setAgentOverviewSourceId] = useState('')
  const [sidebarHost, setSidebarHost] = useState<HTMLDivElement | null>(null)
  const reviewUrlReadyRef = useRef(false)
  const skipReviewUrlWriteRef = useRef(false)
  const agents = snapshot.facets?.agents ?? []
  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    writeTheme(next)
  }

  const onReview = location.pathname.startsWith('/review')
  const onHubReview = location.pathname.startsWith('/review/hub/')
  const onPiLive = location.pathname === '/review/live' || location.pathname.startsWith('/review/live/')
  const onNewTask = location.pathname === '/review/new'
  const onLocalReview = onReview && !onHubReview && !onPiLive && !onNewTask
  const onTools = location.pathname.startsWith('/tools')
  const onAgents = location.pathname.startsWith('/agents')
  const hasSseBanner = Boolean(snapshot.health && !snapshot.liveConnected && !onPiLive)
  const showTurnRail = onLocalReview && snapshot.review.detail
  const agentOverviewItems = snapshot.agents?.items ?? []
  const resolvedAgentOverviewSourceId = agentOverviewItems.some(item => item.sourceId === agentOverviewSourceId)
    ? agentOverviewSourceId
    : agentOverviewItems.find(item => item.detected)?.sourceId ?? agentOverviewItems[0]?.sourceId ?? agents.find(agent => agent.detected)?.sourceId ?? agents[0]?.sourceId ?? ''

  useEffect(() => {
    model.setReviewActive(onLocalReview)
    if (onReview) void model.ensureReview()
    if (onTools) void model.ensureUsage()
    if (onAgents) void model.ensureAgents()
    return () => { if (onLocalReview) model.setReviewActive(false) }
  }, [model, onReview, onLocalReview, onTools, onAgents])

  useEffect(() => {
    if (!onLocalReview) {
      reviewUrlReadyRef.current = false
      skipReviewUrlWriteRef.current = false
      return
    }
    if (reviewUrlReadyRef.current && !location.search) return
    const filters = reviewFiltersFromSearch(location.search)
    reviewUrlReadyRef.current = true
    if (!sameReviewFilters(filters, model.getSnapshot().review.filters)) {
      skipReviewUrlWriteRef.current = true
      model.setReviewFilters(filters)
    }
  }, [location.search, model, onLocalReview])

  useEffect(() => {
    if (!onLocalReview || !reviewUrlReadyRef.current) return
    if (skipReviewUrlWriteRef.current) {
      skipReviewUrlWriteRef.current = false
      return
    }
    const search = reviewSearchFromFilters(snapshot.review.filters)
    if (location.search === search) return
    navigate({ pathname: location.pathname, search }, { replace: true })
  }, [location.pathname, location.search, navigate, onLocalReview, snapshot.review.filters])

  return <PinnedProvider agents={agents}>
    <div className="app-shell">
      <WorkspaceSidebar
        snapshot={snapshot}
        agents={agents}
        selectedAgentId={resolvedAgentOverviewSourceId}
        onSelectAgent={setAgentOverviewSourceId}
        onRefreshAgents={() => { void model.refreshFacetsAndAgents() }}
        theme={theme}
        onToggleTheme={toggleTheme}
        onContextHost={setSidebarHost}
      />
      <div className="app-main">
        {hasSseBanner && <div className="sse-banner" role="status">
          <span className="live-dot live-dot-waiting" />
          <span>实时通道已断开</span>
          <small>页面保留当前内容；重新连接后会继续接收新数据。</small>
        </div>}
        <Routes>
          <Route path="/review" element={<TaskCenterPage model={model} mode="history" sidebarHost={sidebarHost}/>} />
          <Route path="/review/new" element={<TaskCenterPage model={model} mode="new" sidebarHost={sidebarHost}/>} />
          <Route path="/review/live" element={<Navigate to="/review/new" replace />} />
          <Route path="/review/live/:runtimeSessionId" element={<TaskCenterPage model={model} mode="live" sidebarHost={sidebarHost}/>} />
          <Route path="/review/hub/:sessionId" element={<TaskCenterPage model={model} mode="hub" sidebarHost={sidebarHost}/>} />
          <Route path="/review/:sessionId" element={<TaskCenterPage model={model} mode="history" sidebarHost={sidebarHost}/>} />
          <Route path="/tools" element={<ToolsPage model={model} sidebarHost={sidebarHost}/>} />
          <Route path="/insights" element={<InsightsPage model={model} sidebarHost={sidebarHost}/>} />
          <Route path="/agents" element={<AgentsResponsivePage model={model} sourceId={agentOverviewSourceId} onSourceIdChange={setAgentOverviewSourceId} />} />
          <Route path="/backup" element={<BackupPage />} />
          <Route path="*" element={<Navigate to="/review" replace />} />
        </Routes>
        {onLocalReview && <ReviewStateOverlay model={model} snapshot={snapshot}/>} 
        {onAgents && <AgentsStateOverlay model={model} snapshot={snapshot}/>} 
        {onTools && snapshot.usage.hasNewData && <BackgroundDataNotice label="工具分析" hasSseBanner={hasSseBanner} onRefresh={() => model.refreshUsage()}/>} 
        {onAgents && snapshot.agentsHasNewData && <BackgroundDataNotice label="智能体概览" hasSseBanner={hasSseBanner} onRefresh={() => model.refreshFacetsAndAgents()}/>} 
        {showTurnRail && <ReviewTurnRail detail={snapshot.review.detail!} onLoadInteraction={ordinal => model.jumpToReviewInteraction(ordinal)}/>} 
      </div>
    </div>
  </PinnedProvider>
}

export function App({ model }: { model: AgentLensClientModel }) {
  return <BrowserRouter><Shell model={model} /></BrowserRouter>
}
