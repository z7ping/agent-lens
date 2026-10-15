import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { AgentFacetDto } from '@agent-lens/protocol'
import type { AgentLensClientModel, ClientSnapshot } from './client/model'
import { readSidebarCollapsed, readTheme, writeSidebarCollapsed, writeTheme } from './client/preferences'
import { useReviewUrlSync } from './client/useReviewUrlSync'
import { AgentsStateOverlay } from './components/AgentsStateOverlay'
import { BackgroundDataNotice } from './components/BackgroundDataNotice'
import { IntegrationOrderProvider } from './components/IntegrationOrderProvider'
import { PinnedAgentsProvider } from './components/PinnedAgentsProvider'
import { ReviewStateOverlay } from './components/ReviewStateOverlay'
import { WorkspaceSidebar } from './components/WorkspaceSidebar'
import { WorkspaceViewTabs } from './components/WorkspaceViewTabs'
import { MarkdownThemeManager } from './components/MarkdownThemeManager'
import { ErrorStateBanner, PageLoadingState } from './components/StateViews'
import { IntegrationOnboarding } from './features/IntegrationOnboarding'
import { Breadcrumb, Button, IconButton, StatusBadge, UiIcon } from './components/ui'

const AgentsResponsivePage = lazy(() => import('./features/AgentsResponsivePage').then(module => ({ default: module.AgentsResponsivePage })))
const BackupPage = lazy(() => import('./features/BackupPage').then(module => ({ default: module.BackupPage })))
const InsightsPage = lazy(() => import('./features/InsightsPage').then(module => ({ default: module.InsightsPage })))
const LegacyLiveTaskRedirect = lazy(() => import('./features/LegacyLiveTaskRedirect').then(module => ({ default: module.LegacyLiveTaskRedirect })))
const TaskCenterPage = lazy(() => import('./features/TaskCenterPage').then(module => ({ default: module.TaskCenterPage })))
const ToolsPage = lazy(() => import('./features/ToolsPage').then(module => ({ default: module.ToolsPage })))

export function useClientSnapshot(model: AgentLensClientModel): ClientSnapshot {
  return useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot)
}

function AgentRescanAction({
  model,
  snapshot,
  selectedAgentId,
}: {
  model: AgentLensClientModel
  snapshot: ClientSnapshot
  selectedAgentId: string
}) {
  const { t } = useTranslation('agents')
  const directAgent = snapshot.agents?.items.find(item => item.sourceId === selectedAgentId)
  const summaryAgent = snapshot.agentSummaries?.items.find(item => item.sourceId === selectedAgentId)
  const management = snapshot.integrationManagement?.items.find(item =>
    item.integrationId === selectedAgentId
    || item.productId === selectedAgentId
    || (directAgent ? item.productId === directAgent.productId : false)
    || (summaryAgent ? item.productId === summaryAgent.productId : false)
  )
  const agent = directAgent ?? snapshot.agents?.items.find(item =>
    management ? item.productId === management.productId : false
  )
  const summary = summaryAgent ?? snapshot.agentSummaries?.items.find(item =>
    management ? item.productId === management.productId : false
  )
  const discovery = management?.tool ?? snapshot.integrationDiscovery?.items.find(item =>
    item.integrationId === selectedAgentId
    || item.productId === selectedAgentId
    || (management ? item.integrationId === management.integrationId || item.productId === management.productId : false)
    || (agent ? item.productId === agent.productId : false)
    || (summary ? item.productId === summary.productId : false)
  )
  const targetId = selectedAgentId || agent?.sourceId || summary?.sourceId || management?.integrationId || ''
  const sourceId = agent?.sourceId ?? summary?.sourceId
  const integrationId = management?.integrationId ?? discovery?.integrationId
  const ownsStatus = Boolean(targetId) && snapshot.agentEnvironmentRescanTargetId === targetId
  const anyScanBusy = snapshot.agentsRescanning || snapshot.integrationDiscoveryRescanning
  const scanBusy = ownsStatus && anyScanBusy
  const scanError = [
    snapshot.agentsRescanError,
    snapshot.integrationDiscoveryError,
    discovery?.presence === 'error' ? discovery.reason : '',
  ].filter(Boolean).join('\n')
  const result = ownsStatus ? snapshot.agentsRescanResult : null

  const status = !ownsStatus
    ? null
    : scanBusy
      ? <StatusBadge tone="accent" dot>{t('page.scanningCurrent')}</StatusBadge>
      : scanError || result?.status === 'failed'
        ? <StatusBadge tone="danger" title={scanError || undefined}>{t('page.scanCurrentFailed')}</StatusBadge>
        : result?.status === 'partial'
          ? <StatusBadge tone="warning" title={result.failures.map(item => `${item.sourceId}: ${item.message}`).join('\n') || undefined}>{t('page.scanCurrentPartial')}</StatusBadge>
          : <StatusBadge tone="success" dot>{t('page.scanCurrentComplete')}</StatusBadge>

  return <>
    {status}
    <Button
      size="small"
      loading={scanBusy}
      disabled={anyScanBusy || !targetId || (!sourceId && !integrationId)}
      title={t('page.rescanCurrent')}
      onClick={() => void model.rescanAgentEnvironment({
        targetId,
        ...(sourceId ? { sourceId } : {}),
        ...(integrationId ? { integrationId } : {}),
      }).catch(() => undefined)}
    >
      <UiIcon name="refresh" size={14}/>
      <span className="agent-rescan-label">{scanBusy ? t('page.scanning') : t('page.rescan')}</span>
    </Button>
  </>
}

function IntegrationRescanAction({
  model,
  snapshot,
}: {
  model: AgentLensClientModel
  snapshot: ClientSnapshot
}) {
  const { t } = useTranslation('agents')
  const scanBusy = snapshot.integrationDiscoveryLoading
    || snapshot.integrationDiscoveryRescanning
    || snapshot.integrationManagement?.discovery.status === 'scanning'
  const scanError = snapshot.integrationDiscoveryError

  return <>
    {scanError && <StatusBadge tone="danger" title={scanError}>{t('status.scanFailed')}</StatusBadge>}
    <Button
      size="small"
      loading={Boolean(scanBusy)}
      disabled={Boolean(scanBusy)}
      title={t('onboarding.rescan')}
      onClick={() => void model.rescanIntegrationDiscovery().catch(() => undefined)}
    >
      <UiIcon name="refresh" size={14}/>
      <span className="agent-rescan-label">{scanBusy ? t('status.scanning') : t('onboarding.rescan')}</span>
    </Button>
  </>
}

function WorkspaceTopBar({
  pathname,
  onOpenNavigation,
}: {
  pathname: string
  onOpenNavigation(): void
}) {
  const { t } = useTranslation('navigation')
  let items: Array<{ label: string; to?: string }>
  if (pathname === '/review/new') {
    items = [{ label: t('taskCenter'), to: '/review' }, { label: t('newTask') }]
  } else if (pathname.startsWith('/review/live/')) {
    items = [{ label: t('taskCenter'), to: '/review' }, { label: t('sessionDetail') }]
  } else if (pathname.startsWith('/review/hub/')) {
    items = [{ label: t('taskCenter'), to: '/review' }, { label: t('remoteTask') }]
  } else if (pathname.startsWith('/review/')) {
    items = [{ label: t('taskCenter'), to: '/review' }, { label: t('sessionDetail') }]
  } else if (pathname === '/review') {
    items = [{ label: t('taskCenter') }]
  } else if (pathname.startsWith('/tools') || pathname.startsWith('/insights')) {
    items = [{ label: t('insights') }]
  } else if (pathname.startsWith('/agents')) {
    items = [{ label: t('agents') }]
  } else if (pathname.startsWith('/backup')) {
    items = [{ label: t('assetBackup') }]
  } else {
    items = [{ label: 'AgentLens' }]
  }

  return <div className="workspace-topbar">
    <IconButton className="workspace-mobile-nav-button" onClick={onOpenNavigation} title={t('openWorkspaceNavigation')} aria-label={t('openWorkspaceNavigation')}><UiIcon name="menu" size={16}/></IconButton>
    <Breadcrumb
      className="workspace-breadcrumb"
      items={items.map((item, index) => item.to && index < items.length - 1
        ? <NavLink key={item.to} to={item.to}>{item.label}</NavLink>
        : <span key={`${item.label}:${index}`} title={item.label}>{item.label}</span>)}
    />
    <div className="workspace-topbar-page-tools"/>
  </div>
}

function LegacyIntegrationRedirect() {
  const { search } = useLocation()
  const params = new URLSearchParams(search)
  params.set('view', 'management')
  return <Navigate to={{ pathname: '/agents', search: `?${params.toString()}` }} replace/>
}

function Shell({ model }: { model: AgentLensClientModel }) {
  const { t } = useTranslation(['shell', 'common', 'navigation', 'backup'])
  const snapshot = useClientSnapshot(model)
  const location = useLocation()
  const navigate = useNavigate()
  const mainRef = useRef<HTMLDivElement>(null)
  const [theme, setTheme] = useState(readTheme)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed)
  const [agentOverviewSourceId, setAgentOverviewSourceId] = useState('')
  const [backupAssetSourceId, setBackupAssetSourceId] = useState('')
  const [workspaceToolbarHost, setWorkspaceToolbarHost] = useState<HTMLDivElement | null>(null)
  const [sidebarHost, setSidebarHost] = useState<HTMLDivElement | null>(null)
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false)
  const [markdownThemeManagerOpen, setMarkdownThemeManagerOpen] = useState(false)
  const summaryAgents: AgentFacetDto[] = (snapshot.agentSummaries?.items ?? []).map(agent => ({
    sourceId: agent.sourceId,
    productId: agent.productId,
    displayName: agent.displayName,
    supported: agent.supported,
    enabled: agent.enabled,
    detected: agent.detected,
    installationIds: agent.installationIds,
  }))
  const agents = snapshot.facets?.agents ?? summaryAgents
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
  const onLiveTask = location.pathname === '/review/live' || location.pathname.startsWith('/review/live/')
  const onNewTask = location.pathname === '/review/new'
  const onLocalReview = onReview && !onHubReview && !onLiveTask && !onNewTask
  const onTools = location.pathname.startsWith('/tools')
  const onInsights = location.pathname.startsWith('/insights')
  const onAgents = location.pathname.startsWith('/agents')
  const onAgentManagement = onAgents && new URLSearchParams(location.search).get('view') === 'management'
  const onBackup = location.pathname.startsWith('/backup')
  const onReviewIndex = location.pathname === '/review'
  const hasWorkspaceTabs = onTools || onInsights || onAgents || onBackup
  const hasSseBanner = Boolean(snapshot.health && !snapshot.liveConnected && !onLiveTask)
  const agentSummaryItems = snapshot.agentSummaries?.items ?? []
  const managedIntegrationItems = snapshot.integrationManagement?.items ?? []
  const agentSelectionMap = new Map<string, AgentFacetDto>(agents.map(agent => [agent.sourceId, agent] as const))
  for (const agent of agentSummaryItems) {
    agentSelectionMap.set(agent.sourceId, {
      sourceId: agent.sourceId,
      productId: agent.productId,
      displayName: agent.displayName,
      supported: agent.supported,
      enabled: agent.enabled,
      detected: agent.detected,
      installationIds: agent.installationIds,
    })
  }
  for (const management of managedIntegrationItems) {
    const discoveryDetected = management.tool?.presence === 'present' || management.tool?.presence === 'data-only'
    const overview = agentSummaryItems.find(item =>
      item.productId === management.productId || item.sourceId === management.integrationId
    )
    const sourceId = overview?.sourceId ?? management.integrationId
    const current = agentSelectionMap.get(sourceId)
    agentSelectionMap.set(sourceId, {
      sourceId,
      productId: management.productId,
      displayName: overview?.displayName ?? management.displayName,
      supported: true,
      enabled: management.enabled.configured,
      detected: Boolean(current?.detected || overview?.detected || discoveryDetected),
      installationIds: overview?.installationIds ?? current?.installationIds ?? [],
    })
  }
  const agentSelectionItems = [...agentSelectionMap.values()]
  const firstPresentIntegration = managedIntegrationItems.find(item =>
    item.tool?.presence === 'present' || item.tool?.presence === 'data-only'
  )
  const firstPresentSourceId = firstPresentIntegration
    ? agentSummaryItems.find(item =>
      item.productId === firstPresentIntegration.productId || item.sourceId === firstPresentIntegration.integrationId
    )?.sourceId ?? firstPresentIntegration.integrationId
    : undefined
  const resolvedAgentOverviewSourceId = agentSelectionMap.has(agentOverviewSourceId)
    ? agentOverviewSourceId
    : firstPresentSourceId
      ?? agentSummaryItems.find(item => item.detected)?.sourceId
      ?? agentSummaryItems[0]?.sourceId
      ?? agents.find(agent => agent.detected)?.sourceId
      ?? agents[0]?.sourceId
      ?? ''

  // Deep links from the former /integrations route select the same agent in the unified workspace.
  useEffect(() => {
    if (!onAgents) return
    const requestedId = new URLSearchParams(location.search).get('agent')
    if (!requestedId) return
    const managed = managedIntegrationItems.find(item => item.integrationId === requestedId || item.productId === requestedId)
    const resolvedId = agentSummaryItems.find(item => item.sourceId === requestedId || (managed && item.productId === managed.productId))?.sourceId
      ?? managed?.integrationId ?? requestedId
    if (agentSelectionItems.some(item => item.sourceId === resolvedId)) {
      setAgentOverviewSourceId(current => current === resolvedId ? current : resolvedId)
    }
  }, [onAgents, location.search, snapshot.agentSummaries, snapshot.integrationManagement])

  useEffect(() => {
    if (resolvedAgentOverviewSourceId && resolvedAgentOverviewSourceId !== agentOverviewSourceId) {
      setAgentOverviewSourceId(resolvedAgentOverviewSourceId)
    }
  }, [agentOverviewSourceId, resolvedAgentOverviewSourceId])

  useEffect(() => {
    void model.ensureIntegrationPreferences().catch(() => undefined)
  }, [model])

  useEffect(() => {
    const onboardingIncomplete = snapshot.integrationPreferences
      ? !snapshot.integrationPreferences.preferences.onboarding.completed
      : false
    if (onAgentManagement || onboardingIncomplete) {
      void model.ensureIntegrationManagement().catch(() => undefined)
    }
  }, [model, onAgentManagement, snapshot.integrationPreferences])

  useEffect(() => {
    if (
      onAgentManagement
      || !snapshot.integrationPreferences?.preferences.onboarding.completed
      || snapshot.integrationManagement
      || snapshot.integrationManagementLoading
    ) return
    const timer = window.setTimeout(() => {
      void model.ensureIntegrationManagement().catch(() => undefined)
    }, 750)
    return () => window.clearTimeout(timer)
  }, [
    model,
    onAgentManagement,
    snapshot.integrationPreferences,
    snapshot.integrationManagement,
    snapshot.integrationManagementLoading,
  ])

  useEffect(() => {
    const onboardingIncomplete = snapshot.integrationPreferences
      ? !snapshot.integrationPreferences.preferences.onboarding.completed
      : false
    model.setIntegrationDiscoveryActive(onAgents || onboardingIncomplete)
    return () => model.setIntegrationDiscoveryActive(false)
  }, [model, onAgents, snapshot.integrationPreferences])

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
    if (onLocalReview && onReviewIndex) void model.ensureReview()
    if (onTools) void model.ensureUsage()
    if (onAgents) void model.ensureAgents()
    return () => { if (onLocalReview) model.setReviewActive(false) }
  }, [model, onLocalReview, onReviewIndex, onTools, onAgents])

  useEffect(() => {
    const reviewReadyForFacets = onLocalReview && snapshot.review.response !== null
    const toolsReadyForFacets = onTools && snapshot.usage.response !== null
    if (reviewReadyForFacets || toolsReadyForFacets || onInsights) {
      void model.ensureFacets()
    }
  }, [model, onLocalReview, onTools, onInsights, snapshot.review.response, snapshot.usage.response])

  useReviewUrlSync({
    active: onLocalReview,
    model,
    pathname: location.pathname,
    search: location.search,
    filters: snapshot.review.filters,
    replace: replaceReviewUrl,
  })

  if (!snapshot.integrationPreferences) {
    return <main className="integration-onboarding-shell">
      {snapshot.integrationPreferencesError
        ? <ErrorStateBanner
            message={snapshot.integrationPreferencesError}
            onRetry={() => void model.refreshIntegrationPreferences().catch(() => undefined)}
          />
        : <PageLoadingState title={t('shell:loadingIntegrations')} description={t('shell:loadingIntegrationsDescription')}/>}
    </main>
  }

  if (!snapshot.integrationPreferences.preferences.onboarding.completed) {
    if (!snapshot.integrationManagement) {
      return <main className="integration-onboarding-shell">
        {snapshot.integrationManagementError
          ? <ErrorStateBanner
              message={snapshot.integrationManagementError}
              onRetry={() => void model.refreshIntegrationManagement().catch(() => undefined)}
            />
          : <PageLoadingState title={t('shell:loadingIntegrations')} description={t('shell:loadingIntegrationsDescription')}/>}
      </main>
    }
    return <IntegrationOnboarding model={model} snapshot={snapshot}/>
  }

  const agentManagementId = managedIntegrationItems.find(item =>
    item.integrationId === resolvedAgentOverviewSourceId
      || item.productId === agentSelectionMap.get(resolvedAgentOverviewSourceId)?.productId
  )?.integrationId ?? resolvedAgentOverviewSourceId
  const currentView = new URLSearchParams(location.search).get('view')
  const workspaceTabs = onTools || onInsights
    ? [
        { value: 'overview', label: t('navigation:usageOverview'), to: '/insights' },
        { value: 'tools', label: t('navigation:tools'), to: '/tools' },
      ]
    : onAgents
      ? [
          { value: 'overview', label: t('navigation:overview'), to: `/agents${resolvedAgentOverviewSourceId ? `?agent=${encodeURIComponent(resolvedAgentOverviewSourceId)}` : ''}` },
          { value: 'management', label: t('navigation:integrationManagement'), to: `/agents?view=management${agentManagementId ? `&agent=${encodeURIComponent(agentManagementId)}` : ''}` },
        ]
      : [
          { value: 'assets', label: t('backup:assetView.currentTab'), to: '/backup' },
          { value: 'history', label: t('backup:assetView.historyTab'), to: '/backup?view=history' },
        ]
  const selectedWorkspaceTab = onTools ? 'tools'
    : onAgents ? (currentView === 'management' ? 'management' : 'overview')
      : onBackup ? (currentView === 'history' ? 'history' : 'assets') : 'overview'

  return <IntegrationOrderProvider
    management={snapshot.integrationManagement}
    preferences={snapshot.integrationPreferences}
    model={model}
  >
    <PinnedAgentsProvider agents={agents}>
      <div className={`app-shell ${onReview ? 'is-task-center' : ''} ${hasWorkspaceTabs ? 'is-contextless-workspace' : ''} ${onAgents ? 'is-agent-workspace' : ''} ${sidebarCollapsed ? 'is-sidebar-collapsed' : ''} ${mobileNavigationOpen ? 'is-mobile-navigation-open' : ''}`}>
      <WorkspaceSidebar
        snapshot={snapshot}
        theme={theme}
        onToggleTheme={toggleTheme}
        onOpenMarkdownThemes={() => setMarkdownThemeManagerOpen(true)}
        onContextHost={setSidebarHost}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setDesktopSidebarCollapsed(!sidebarCollapsed)}
        mobileOpen={mobileNavigationOpen}
        onMobileClose={() => setMobileNavigationOpen(false)}
      />
      {mobileNavigationOpen && <button type="button" className="workspace-mobile-backdrop" aria-label={t('navigation:closeWorkspaceNavigation')} onClick={() => setMobileNavigationOpen(false)}/>} 
      <MarkdownThemeManager open={markdownThemeManagerOpen} onClose={() => setMarkdownThemeManagerOpen(false)}/>
      <div ref={mainRef} className="app-main">
        {!hasWorkspaceTabs && <WorkspaceTopBar
          pathname={location.pathname}
          onOpenNavigation={() => setMobileNavigationOpen(true)}
        />}
        {hasWorkspaceTabs && <>
          <WorkspaceViewTabs
            label={onAgents ? t('navigation:agentViews') : onTools || onInsights ? t('navigation:insightsView') : t('backup:assetView.tabsAria')}
            value={selectedWorkspaceTab}
            tabs={workspaceTabs}
            onOpenNavigation={() => setMobileNavigationOpen(true)}
          />
          <div className="workspace-view-toolbar">
            <div className="workspace-view-toolbar-content" ref={setWorkspaceToolbarHost}/>
            {onAgents && <div className="workspace-view-toolbar-actions">
              {onAgentManagement
                ? <IntegrationRescanAction model={model} snapshot={snapshot}/>
                : <AgentRescanAction model={model} snapshot={snapshot} selectedAgentId={resolvedAgentOverviewSourceId}/>}
            </div>}
          </div>
        </>}
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
          <Route path="/review/live/:liveId/:runtimeSessionId" element={<TaskCenterPage model={model} mode="live" sidebarHost={sidebarHost}/>} />
          <Route path="/review/live/:runtimeSessionId" element={<LegacyLiveTaskRedirect />} />
          <Route path="/review/hub/:sessionId" element={<TaskCenterPage model={model} mode="hub" sidebarHost={sidebarHost}/>} />
          <Route path="/review/:sessionId" element={<TaskCenterPage model={model} mode="history" sidebarHost={sidebarHost}/>} />
          <Route path="/tools" element={<ToolsPage model={model} toolbarHost={workspaceToolbarHost}/>} />
          <Route path="/insights" element={<InsightsPage model={model} toolbarHost={workspaceToolbarHost}/>} />
          <Route path="/agents" element={<AgentsResponsivePage model={model} sourceId={resolvedAgentOverviewSourceId} agents={agentSelectionItems} onSelectAgent={setAgentOverviewSourceId} toolbarHost={workspaceToolbarHost} />} />
          <Route path="/integrations" element={<LegacyIntegrationRedirect/>} />
          <Route path="/backup" element={<BackupPage selectedAssetSourceId={backupAssetSourceId} onSelectedAssetSourceIdChange={setBackupAssetSourceId} agents={agentSelectionItems} toolbarHost={workspaceToolbarHost} />} />
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
  </IntegrationOrderProvider>
}

export function App({ model }: { model: AgentLensClientModel }) {
  return <BrowserRouter><Shell model={model} /></BrowserRouter>
}
