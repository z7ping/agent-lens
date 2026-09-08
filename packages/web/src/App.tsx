import { lazy, Suspense, useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import type { AgentLensClientModel, ClientSnapshot } from './client/model'
import { readSidebarCollapsed, readTheme, writeSidebarCollapsed, writeTheme } from './client/preferences'
import { useReviewUrlSync } from './client/useReviewUrlSync'
import { AgentsStateOverlay } from './components/AgentsStateOverlay'
import { BackgroundDataNotice } from './components/BackgroundDataNotice'
import { PinnedAgentsProvider } from './components/PinnedAgentsProvider'
import { ReviewStateOverlay } from './components/ReviewStateOverlay'
import { WorkspaceSidebar } from './components/WorkspaceSidebar'
import { PageLoadingState } from './components/StateViews'
import { Breadcrumb, IconButton, UiIcon } from './components/ui'

const AgentsResponsivePage = lazy(() => import('./features/AgentsResponsivePage').then(module => ({ default: module.AgentsResponsivePage })))
const BackupPage = lazy(() => import('./features/BackupPage').then(module => ({ default: module.BackupPage })))
const InsightsPage = lazy(() => import('./features/InsightsPage').then(module => ({ default: module.InsightsPage })))
const NewPiTaskPage = lazy(() => import('./features/NewPiTaskPage').then(module => ({ default: module.NewPiTaskPage })))
const TaskCenterPage = lazy(() => import('./features/TaskCenterPage').then(module => ({ default: module.TaskCenterPage })))
const ToolsPage = lazy(() => import('./features/ToolsPage').then(module => ({ default: module.ToolsPage })))

export function useClientSnapshot(model: AgentLensClientModel): ClientSnapshot {
  return useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot)
}

function WorkspaceBreadcrumb({
  pathname,
  snapshot,
  selectedAgentId,
  onOpenNavigation,
  sidebarCollapsed,
  onExpandSidebar,
}: {
  pathname: string
  snapshot: ClientSnapshot
  selectedAgentId: string
  onOpenNavigation(): void
  sidebarCollapsed: boolean
  onExpandSidebar(): void
}) {
  let items: Array<{ label: string; to?: string }>
  if (pathname === '/review/new') {
    items = [{ label: '任务中心', to: '/review' }, { label: '新建任务' }]
  } else if (pathname.startsWith('/review/live/')) {
    items = [{ label: '任务中心', to: '/review' }, { label: 'Pi 实时任务' }]
  } else if (pathname.startsWith('/review/hub/')) {
    items = [{ label: '任务中心', to: '/review' }, { label: '远程任务' }]
  } else if (pathname.startsWith('/review/')) {
    items = [{ label: '任务中心', to: '/review' }, { label: '会话详情' }]
  } else if (pathname === '/review') {
    items = [{ label: '任务中心' }]
  } else if (pathname.startsWith('/tools')) {
    items = [{ label: '洞察', to: '/insights' }, { label: '工具分析' }]
  } else if (pathname.startsWith('/insights')) {
    items = [{ label: '洞察' }, { label: '使用概览' }]
  } else if (pathname.startsWith('/agents')) {
    const selected = snapshot.agents?.items.find(item => item.sourceId === selectedAgentId)
    items = [{ label: '智能体' }, { label: selected?.displayName || selected?.sourceId || '概览' }]
  } else if (pathname.startsWith('/backup')) {
    items = [{ label: '设置' }, { label: '资产备份' }]
  } else {
    items = [{ label: 'AgentLens' }]
  }

  return <div className="workspace-breadcrumb-shell">
    <IconButton className="workspace-mobile-nav-button" onClick={onOpenNavigation} title="打开工作区导航" aria-label="打开工作区导航"><UiIcon name="menu" size={16}/></IconButton>
    {sidebarCollapsed && <IconButton className="workspace-sidebar-restore-button" onClick={onExpandSidebar} title="展开侧栏" aria-label="展开侧栏"><UiIcon name="panel-left-open" size={16}/></IconButton>}
    <Breadcrumb
      className="workspace-breadcrumb"
      items={items.map((item, index) => item.to && index < items.length - 1
        ? <NavLink key={item.to} to={item.to}>{item.label}</NavLink>
        : <span key={`${item.label}:${index}`} title={item.label}>{item.label}</span>)}
    />
  </div>
}

function Shell({ model }: { model: AgentLensClientModel }) {
  const snapshot = useClientSnapshot(model)
  const location = useLocation()
  const navigate = useNavigate()
  const [theme, setTheme] = useState(readTheme)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed)
  const [agentOverviewSourceId, setAgentOverviewSourceId] = useState('')
  const [sidebarHost, setSidebarHost] = useState<HTMLDivElement | null>(null)
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false)
  const agents = snapshot.facets?.agents ?? []
  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    writeTheme(next)
  }
  const setDesktopSidebarCollapsed = (collapsed: boolean) => {
    setSidebarCollapsed(collapsed)
    writeSidebarCollapsed(collapsed)
  }
  const replaceReviewUrl = useCallback((pathname: string, search: string) => {
    navigate({ pathname, search }, { replace: true })
  }, [navigate])

  const onReview = location.pathname.startsWith('/review')
  const onHubReview = location.pathname.startsWith('/review/hub/')
  const onPiLive = location.pathname === '/review/live' || location.pathname.startsWith('/review/live/')
  const onNewTask = location.pathname === '/review/new'
  const onLocalReview = onReview && !onHubReview && !onPiLive && !onNewTask
  const onTools = location.pathname.startsWith('/tools')
  const onInsights = location.pathname.startsWith('/insights')
  const onAgents = location.pathname.startsWith('/agents')
  const needsFacets = (onReview && !onNewTask) || onTools || onInsights || onAgents
  const hasSseBanner = Boolean(snapshot.health && !snapshot.liveConnected && !onPiLive)
  const agentOverviewItems = snapshot.agents?.items ?? []
  const resolvedAgentOverviewSourceId = agentOverviewItems.some(item => item.sourceId === agentOverviewSourceId)
    ? agentOverviewSourceId
    : agentOverviewItems.find(item => item.detected)?.sourceId ?? agentOverviewItems[0]?.sourceId ?? agents.find(agent => agent.detected)?.sourceId ?? agents[0]?.sourceId ?? ''

  useEffect(() => {
    setMobileNavigationOpen(false)
  }, [location.pathname])

  useEffect(() => {
    model.setReviewActive(onLocalReview)
    if (needsFacets) void model.ensureFacets()
    if (onLocalReview) void model.ensureReview()
    if (onTools) void model.ensureUsage()
    if (onAgents) void model.ensureAgents()
    return () => { if (onLocalReview) model.setReviewActive(false) }
  }, [model, needsFacets, onLocalReview, onTools, onAgents])

  useReviewUrlSync({
    active: onLocalReview,
    model,
    pathname: location.pathname,
    search: location.search,
    filters: snapshot.review.filters,
    replace: replaceReviewUrl,
  })

  return <PinnedAgentsProvider agents={agents}>
    <div className={`app-shell ${sidebarCollapsed ? 'is-sidebar-collapsed' : ''} ${mobileNavigationOpen ? 'is-mobile-navigation-open' : ''}`}>
      <WorkspaceSidebar
        snapshot={snapshot}
        agents={agents}
        selectedAgentId={resolvedAgentOverviewSourceId}
        onSelectAgent={setAgentOverviewSourceId}
        onRefreshAgents={() => { void model.refreshFacetsAndAgents() }}
        theme={theme}
        onToggleTheme={toggleTheme}
        onContextHost={setSidebarHost}
        onCollapse={() => setDesktopSidebarCollapsed(true)}
        mobileOpen={mobileNavigationOpen}
        onMobileClose={() => setMobileNavigationOpen(false)}
      />
      {mobileNavigationOpen && <button type="button" className="workspace-mobile-backdrop" aria-label="关闭工作区导航" onClick={() => setMobileNavigationOpen(false)}/>} 
      <div className="app-main">
        <WorkspaceBreadcrumb
          pathname={location.pathname}
          snapshot={snapshot}
          selectedAgentId={resolvedAgentOverviewSourceId}
          onOpenNavigation={() => setMobileNavigationOpen(true)}
          sidebarCollapsed={sidebarCollapsed}
          onExpandSidebar={() => setDesktopSidebarCollapsed(false)}
        />
        {hasSseBanner && <div className="sse-banner" role="status">
          <span className="live-dot live-dot-waiting" />
          <span>实时通道已断开</span>
          <small>页面保留当前内容；重新连接后会继续接收新数据。</small>
        </div>}
        <Suspense fallback={<PageLoadingState title="正在加载工作区" description="正在准备当前页面所需的数据与界面。"/>}>
        <Routes>
          <Route path="/review" element={<TaskCenterPage model={model} mode="history" sidebarHost={sidebarHost}/>} />
          <Route path="/review/new" element={<NewPiTaskPage/>} />
          <Route path="/review/live" element={<Navigate to="/review/new" replace />} />
          <Route path="/review/live/:runtimeSessionId" element={<TaskCenterPage model={model} mode="live" sidebarHost={sidebarHost}/>} />
          <Route path="/review/hub/:sessionId" element={<TaskCenterPage model={model} mode="hub" sidebarHost={sidebarHost}/>} />
          <Route path="/review/:sessionId" element={<TaskCenterPage model={model} mode="history" sidebarHost={sidebarHost}/>} />
          <Route path="/tools" element={<ToolsPage model={model} sidebarHost={sidebarHost}/>} />
          <Route path="/insights" element={<InsightsPage model={model} sidebarHost={sidebarHost}/>} />
          <Route path="/agents" element={<AgentsResponsivePage model={model} sourceId={resolvedAgentOverviewSourceId} onSourceIdChange={setAgentOverviewSourceId} />} />
          <Route path="/backup" element={<BackupPage />} />
          <Route path="*" element={<Navigate to="/review" replace />} />
        </Routes>
        </Suspense>
        {onLocalReview && <ReviewStateOverlay model={model} snapshot={snapshot}/>} 
        {onAgents && <AgentsStateOverlay model={model} snapshot={snapshot}/>} 
        {onTools && snapshot.usage.hasNewData && <BackgroundDataNotice label="工具分析" hasSseBanner={hasSseBanner} onRefresh={() => model.refreshUsage()}/>} 
        {onAgents && snapshot.agentsHasNewData && <BackgroundDataNotice label="智能体概览" hasSseBanner={hasSseBanner} onRefresh={() => model.refreshFacetsAndAgents()}/>} 
      </div>
    </div>
  </PinnedAgentsProvider>
}

export function App({ model }: { model: AgentLensClientModel }) {
  return <BrowserRouter><Shell model={model} /></BrowserRouter>
}
