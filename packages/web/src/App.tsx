import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { AgentLensClientModel, ClientSnapshot } from './client/model'
import { readSidebarCollapsed, readTheme, writeSidebarCollapsed, writeTheme } from './client/preferences'
import { useReviewUrlSync } from './client/useReviewUrlSync'
import { AgentsStateOverlay } from './components/AgentsStateOverlay'
import { BackgroundDataNotice } from './components/BackgroundDataNotice'
import { PinnedAgentsProvider } from './components/PinnedAgentsProvider'
import { ReviewStateOverlay } from './components/ReviewStateOverlay'
import { WorkspaceSidebar } from './components/WorkspaceSidebar'
import { PageLoadingState } from './components/StateViews'
import { IntegrationOnboarding } from './features/IntegrationOnboarding'
import { Breadcrumb, IconButton, StatusBadge, UiIcon } from './components/ui'

const AgentsResponsivePage = lazy(() => import('./features/AgentsResponsivePage').then(module => ({ default: module.AgentsResponsivePage })))
const BackupPage = lazy(() => import('./features/BackupPage').then(module => ({ default: module.BackupPage })))
const InsightsPage = lazy(() => import('./features/InsightsPage').then(module => ({ default: module.InsightsPage })))
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
  const { t } = useTranslation('navigation')
  let items: Array<{ label: string; to?: string }>
  if (pathname === '/review/new') {
    items = [{ label: t('taskCenter'), to: '/review' }, { label: t('newTask') }]
  } else if (pathname.startsWith('/review/live/')) {
    items = [{ label: t('taskCenter'), to: '/review' }, { label: t('piLiveTask') }]
  } else if (pathname.startsWith('/review/hub/')) {
    items = [{ label: t('taskCenter'), to: '/review' }, { label: t('remoteTask') }]
  } else if (pathname.startsWith('/review/')) {
    items = [{ label: t('taskCenter'), to: '/review' }, { label: t('sessionDetail') }]
  } else if (pathname === '/review') {
    items = [{ label: t('taskCenter') }]
  } else if (pathname.startsWith('/tools')) {
    items = [{ label: t('insights'), to: '/insights' }, { label: t('tools') }]
  } else if (pathname.startsWith('/insights')) {
    items = [{ label: t('insights') }, { label: t('usageOverview') }]
  } else if (pathname.startsWith('/agents')) {
    const selected = snapshot.agents?.items.find(item => item.sourceId === selectedAgentId)
    const managed = snapshot.integrationManagement?.items.find(item =>
      item.integrationId === selectedAgentId || item.productId === selectedAgentId
    )
    items = [{ label: t('agents') }, { label: selected?.displayName || managed?.displayName || selectedAgentId || t('overview') }]
  } else if (pathname.startsWith('/backup')) {
    items = [{ label: t('settings') }, { label: t('assetBackup') }]
  } else {
    items = [{ label: 'AgentLens' }]
  }

  return <div className="workspace-breadcrumb-shell">
    <IconButton className="workspace-mobile-nav-button" onClick={onOpenNavigation} title={t('openWorkspaceNavigation')} aria-label={t('openWorkspaceNavigation')}><UiIcon name="menu" size={16}/></IconButton>
    {sidebarCollapsed && <IconButton className="workspace-sidebar-restore-button" onClick={onExpandSidebar} title={t('expandSidebar')} aria-label={t('expandSidebar')}><UiIcon name="panel-left-open" size={16}/></IconButton>}
    <Breadcrumb
      className="workspace-breadcrumb"
      items={items.map((item, index) => item.to && index < items.length - 1
        ? <NavLink key={item.to} to={item.to}>{item.label}</NavLink>
        : <span key={`${item.label}:${index}`} title={item.label}>{item.label}</span>)}
    />
  </div>
}

function Shell({ model }: { model: AgentLensClientModel }) {
  const { t } = useTranslation(['shell', 'common', 'navigation'])
  const snapshot = useClientSnapshot(model)
  const location = useLocation()
  const navigate = useNavigate()
  const mainRef = useRef<HTMLDivElement>(null)
  const [theme, setTheme] = useState(readTheme)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed)
  const [agentOverviewSourceId, setAgentOverviewSourceId] = useState('')
  const [backupSourceIds, setBackupSourceIds] = useState<string[] | null>(null)
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
  const onBackup = location.pathname.startsWith('/backup')
  const needsFacets = (onReview && !onNewTask) || onTools || onInsights || onAgents || onBackup
  const hasSseBanner = Boolean(snapshot.health && !snapshot.liveConnected && !onPiLive)
  const agentOverviewItems = snapshot.agents?.items ?? []
  const managedIntegrationItems = snapshot.integrationManagement?.items ?? []
  const selectedIntegrationExists = managedIntegrationItems.some(item =>
    item.integrationId === agentOverviewSourceId || item.productId === agentOverviewSourceId
  )
  const resolvedAgentOverviewSourceId = agentOverviewItems.some(item => item.sourceId === agentOverviewSourceId) || selectedIntegrationExists
    ? agentOverviewSourceId
    : managedIntegrationItems.find(item => item.tool?.presence === 'present' || item.tool?.presence === 'data-only')?.integrationId
      ?? agentOverviewItems.find(item => item.detected)?.sourceId
      ?? managedIntegrationItems[0]?.integrationId
      ?? agentOverviewItems[0]?.sourceId
      ?? agents.find(agent => agent.detected)?.sourceId
      ?? agents[0]?.sourceId
      ?? ''

  useEffect(() => {
    void model.ensureIntegrationManagement().catch(() => undefined)
  }, [model])

  useEffect(() => {
    setMobileNavigationOpen(false)
  }, [location.pathname])

  useEffect(() => {
    const main = mainRef.current
    if (!main) return
    main.inert = mobileNavigationOpen
    return () => { main.inert = false }
  }, [mobileNavigationOpen])

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

  if (!snapshot.integrationManagement && !snapshot.integrationManagementError) {
    return <main className="integration-onboarding-shell">
      <PageLoadingState title={t('shell:loadingIntegrations')} description={t('shell:loadingIntegrationsDescription')}/>
    </main>
  }

  if (snapshot.integrationManagement && !snapshot.integrationManagement.preferences.onboarding.completed) {
    return <IntegrationOnboarding model={model} snapshot={snapshot}/>
  }

  return <PinnedAgentsProvider
    agents={agents}
    management={snapshot.integrationManagement}
    model={model}
  >
    <div className={`app-shell ${sidebarCollapsed ? 'is-sidebar-collapsed' : ''} ${mobileNavigationOpen ? 'is-mobile-navigation-open' : ''}`}>
      <WorkspaceSidebar
        snapshot={snapshot}
        agents={agents}
        selectedAgentId={resolvedAgentOverviewSourceId}
        onSelectAgent={setAgentOverviewSourceId}
        onRefreshAgents={() => { void model.refreshFacetsAndAgents() }}
        backupSourceIds={backupSourceIds}
        onBackupSourceIdsChange={setBackupSourceIds}
        theme={theme}
        onToggleTheme={toggleTheme}
        onContextHost={setSidebarHost}
        onCollapse={() => setDesktopSidebarCollapsed(true)}
        mobileOpen={mobileNavigationOpen}
        onMobileClose={() => setMobileNavigationOpen(false)}
      />
      {mobileNavigationOpen && <button type="button" className="workspace-mobile-backdrop" aria-label={t('navigation:closeWorkspaceNavigation')} onClick={() => setMobileNavigationOpen(false)}/>} 
      <div ref={mainRef} className="app-main">
        <WorkspaceBreadcrumb
          pathname={location.pathname}
          snapshot={snapshot}
          selectedAgentId={resolvedAgentOverviewSourceId}
          onOpenNavigation={() => setMobileNavigationOpen(true)}
          sidebarCollapsed={sidebarCollapsed}
          onExpandSidebar={() => setDesktopSidebarCollapsed(false)}
        />
        {hasSseBanner && <div className="sse-banner" role="status" aria-live="polite">
          <span className="sse-banner-icon" aria-hidden="true"><UiIcon name="exclamation" size={14}/></span>
          <div className="sse-banner-copy">
            <b>{t('shell:realTimeDisconnected')}</b>
            <span>{t('shell:contentReadableWhileReconnecting')}</span>
          </div>
          <StatusBadge className="sse-banner-status" tone="warning" dot>{t('shell:reconnecting')}</StatusBadge>
        </div>}
        <Suspense fallback={<PageLoadingState title={t('common:loadingWorkspace')} description={t('common:loadingWorkspaceDescription')}/>}>
        <Routes>
          <Route path="/review" element={<TaskCenterPage model={model} mode="history" sidebarHost={sidebarHost}/>} />
          <Route path="/review/new" element={<TaskCenterPage model={model} mode="new" sidebarHost={sidebarHost}/>} />
          <Route path="/review/live" element={<Navigate to="/review/new" replace />} />
          <Route path="/review/live/:runtimeSessionId" element={<TaskCenterPage model={model} mode="live" sidebarHost={sidebarHost}/>} />
          <Route path="/review/hub/:sessionId" element={<TaskCenterPage model={model} mode="hub" sidebarHost={sidebarHost}/>} />
          <Route path="/review/:sessionId" element={<TaskCenterPage model={model} mode="history" sidebarHost={sidebarHost}/>} />
          <Route path="/tools" element={<ToolsPage model={model} sidebarHost={sidebarHost}/>} />
          <Route path="/insights" element={<InsightsPage model={model} sidebarHost={sidebarHost}/>} />
          <Route path="/agents" element={<AgentsResponsivePage model={model} sourceId={resolvedAgentOverviewSourceId} onSourceIdChange={setAgentOverviewSourceId} />} />
          <Route path="/backup" element={<BackupPage selectedSourceIds={backupSourceIds} onSelectedSourceIdsChange={setBackupSourceIds} />} />
          <Route path="*" element={<Navigate to="/review" replace />} />
        </Routes>
        </Suspense>
        {onLocalReview && <ReviewStateOverlay model={model} snapshot={snapshot}/>} 
        {onAgents && <AgentsStateOverlay model={model} snapshot={snapshot}/>} 
        {onTools && snapshot.usage.hasNewData && <BackgroundDataNotice label={t('navigation:tools')} hasSseBanner={hasSseBanner} onRefresh={() => model.refreshUsage()}/>} 
        {onAgents && snapshot.agentsHasNewData && <BackgroundDataNotice label={t('navigation:agentOverview')} hasSseBanner={hasSseBanner} onRefresh={() => model.refreshFacetsAndAgents()}/>} 
      </div>
    </div>
  </PinnedAgentsProvider>
}

export function App({ model }: { model: AgentLensClientModel }) {
  return <BrowserRouter><Shell model={model} /></BrowserRouter>
}
