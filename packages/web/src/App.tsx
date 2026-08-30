import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type PropsWithChildren } from 'react'
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import type { AgentFacetDto } from '@agent-lens/protocol'
import type { AgentLensClientModel, ClientSnapshot } from './client/model'
import { readPinnedAgents, readTheme, writePinnedAgents, writeTheme } from './client/preferences'
import { AgentsStateOverlay } from './components/AgentsStateOverlay'
import { BackgroundDataNotice } from './components/BackgroundDataNotice'
import { BrandVersion, ReleaseInfo } from './components/ReleaseInfo'
import { ReviewStateOverlay } from './components/ReviewStateOverlay'
import { ReviewTurnRail } from './components/ReviewTurnRail'
import { RuntimeStatus } from './components/RuntimeStatus'
import { AgentsResponsivePage } from './features/AgentsResponsivePage'
import { BackupPage } from './features/BackupPage'
import { HubReviewPage } from './features/HubReviewPage'
import { InsightsPage } from './features/InsightsPage'
import { PiLivePage } from './features/PiLivePage'
import { ReviewPage } from './features/ReviewPage'
import { ToolsPage } from './features/ToolsPage'

export function useClientSnapshot(model: AgentLensClientModel): ClientSnapshot {
  return useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot)
}

interface PinnedContextValue { pinned: string[]; toggle(id: string): void }
const PinnedContext = createContext<PinnedContextValue>({ pinned: [], toggle: () => undefined })
export function usePinnedAgents(): PinnedContextValue { return useContext(PinnedContext) }

function PinnedProvider({ agents, children }: PropsWithChildren<{ agents: AgentFacetDto[] }>) {
  const [pinned, setPinned] = useState<string[]>(() => readPinnedAgents() ?? [])
  useEffect(() => {
    const stored = readPinnedAgents()
    if (stored !== null) {
      const valid = stored.filter(id => agents.some(agent => agent.sourceId === id))
      if (valid.join('\u0000') !== pinned.join('\u0000')) setPinned(valid)
      return
    }
    if (agents.length) {
      const initial = agents.filter(agent => agent.detected).map(agent => agent.sourceId)
      setPinned(initial)
      writePinnedAgents(initial)
    }
  }, [agents])
  const value = useMemo<PinnedContextValue>(() => ({
    pinned,
    toggle(id) {
      setPinned(current => {
        const next = current.includes(id) ? current.filter(item => item !== id) : [...current, id]
        writePinnedAgents(next)
        return next
      })
    },
  }), [pinned])
  return <PinnedContext.Provider value={value}>{children}</PinnedContext.Provider>
}

const navigation = [
  { to: '/review', label: '任务复盘' },
  { to: '/tools', label: '工具分析', startsGroup: true },
  { to: '/insights', label: '使用洞察' },
  { to: '/agents', label: '智能体概览', startsGroup: true },
  { to: '/backup', label: '资产备份' },
] as const

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

function ThemeGlyph({ dark }: { dark: boolean }) {
  return dark
    ? <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3.4"/><path d="M10 1.8v2M10 16.2v2M1.8 10h2M16.2 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M15.8 4.2l-1.4 1.4M5.6 14.4l-1.4 1.4"/></svg>
    : <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M15.8 12.8A6.7 6.7 0 0 1 7.2 4.2 6.8 6.8 0 1 0 15.8 12.8Z"/></svg>
}

function Shell({ model }: { model: AgentLensClientModel }) {
  const snapshot = useClientSnapshot(model)
  const location = useLocation()
  const navigate = useNavigate()
  const [theme, setTheme] = useState(readTheme)
  const [agentOverviewSourceId, setAgentOverviewSourceId] = useState('')
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
  const onLocalReview = onReview && !onHubReview && !onPiLive
  const onTools = location.pathname.startsWith('/tools')
  const onAgents = location.pathname.startsWith('/agents')
  const hasSseBanner = Boolean(snapshot.health && !snapshot.liveConnected && !onPiLive)
  const showTurnRail = onLocalReview && snapshot.review.detail
  const navigationHasNewData = (to: string) => to === '/tools' ? snapshot.usage.hasNewData : to === '/agents' ? snapshot.agentsHasNewData : false

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
      <header className="app-header">
        <div className="app-header-inner">
          <div className="brand" aria-label="AgentLens 智能体透镜">
            <img className="brand-logo" src="/agentlens-icon.svg" alt="" aria-hidden="true"/>
            <span className="brand-name">AgentLens · 智能体透镜</span>
            <BrandVersion />
          </div>
          <nav className="app-nav" aria-label="主导航">
            {navigation.map(item => {
              const hasNewData = navigationHasNewData(item.to)
              return <NavLink key={item.to} to={item.to} aria-label={hasNewData ? `${item.label}，有新数据` : item.label} className={({ isActive }) => `nav-item ${'startsGroup' in item ? 'nav-group-start ' : ''}${isActive ? 'nav-item-active' : ''}`}>
                <span>{item.label}</span>{hasNewData && <span className="nav-new-dot" title="有新数据" aria-hidden="true"/>}
              </NavLink>
            })}
          </nav>
          <div className="app-status">
            <RuntimeStatus health={snapshot.health} liveConnected={snapshot.liveConnected} />
            {onLocalReview && <NavLink className="header-link" to="/review/live">Pi 实时</NavLink>}
            <ReleaseInfo />
            <button className="theme-toggle" onClick={toggleTheme} title={theme === 'dark' ? '切换为浅色主题' : '切换为深色主题'} aria-label={theme === 'dark' ? '切换为浅色主题' : '切换为深色主题'}><ThemeGlyph dark={theme === 'dark'}/></button>
          </div>
        </div>
      </header>
      {hasSseBanner && <div className="sse-banner" role="status">
        <span className="live-dot live-dot-waiting" />
        <span>实时通道已断开</span>
        <small>页面保留当前内容；重新连接后会继续接收新数据。</small>
      </div>}
      <Routes>
        <Route path="/review" element={<ReviewPage model={model} />} />
        <Route path="/review/live" element={<PiLivePage />} />
        <Route path="/review/live/:runtimeSessionId" element={<PiLivePage />} />
        <Route path="/review/hub/:sessionId" element={<HubReviewPage />} />
        <Route path="/review/:sessionId" element={<ReviewPage model={model} />} />
        <Route path="/tools" element={<ToolsPage model={model} />} />
        <Route path="/insights" element={<InsightsPage model={model} />} />
        <Route path="/agents" element={<AgentsResponsivePage model={model} sourceId={agentOverviewSourceId} onSourceIdChange={setAgentOverviewSourceId} />} />
        <Route path="/backup" element={<BackupPage />} />
        <Route path="*" element={<Navigate to="/review" replace />} />
      </Routes>
      {onLocalReview && <ReviewStateOverlay model={model} snapshot={snapshot}/>} 
      {onAgents && <AgentsStateOverlay model={model} snapshot={snapshot}/>} 
      {onTools && snapshot.usage.hasNewData && <BackgroundDataNotice label="工具分析" hasSseBanner={hasSseBanner} onRefresh={() => model.refreshUsage()}/>} 
      {onAgents && snapshot.agentsHasNewData && <BackgroundDataNotice label="智能体概览" hasSseBanner={hasSseBanner} onRefresh={() => model.refreshFacetsAndAgents()}/>} 
      {showTurnRail && <ReviewTurnRail detail={snapshot.review.detail!}/>} 
    </div>
  </PinnedProvider>
}

export function App({ model }: { model: AgentLensClientModel }) {
  return <BrowserRouter><Shell model={model} /></BrowserRouter>
}
