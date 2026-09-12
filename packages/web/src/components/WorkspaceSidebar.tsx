import { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { AgentFacetDto } from '@agent-lens/protocol'
import type { ClientSnapshot } from '../client/model'
import { LocaleSelector } from '../i18n/LocaleSelector'
import { BackgroundActivityStatus } from './BackgroundActivityStatus'
import { BrandVersion, ReleaseInfo } from './ReleaseInfo'
import { RuntimeStatus } from './RuntimeStatus'
import { SidebarFilterDisclosure } from './SidebarFilterDisclosure'
import { WorkspacePrimaryNavigation } from './WorkspacePrimaryNavigation'
import { IconButton, UiIcon, useModalFocusScope } from './ui'
import './workspace-sidebar-menu.css'

interface WorkspaceSidebarProps {
  snapshot: ClientSnapshot
  agents: AgentFacetDto[]
  selectedAgentId: string
  onSelectAgent(id: string): void
  onRefreshAgents(): void
  backupSourceIds: string[] | null
  onBackupSourceIdsChange(sourceIds: string[] | null): void
  theme: 'light' | 'dark'
  onToggleTheme(): void
  onContextHost(node: HTMLDivElement | null): void
  onCollapse(): void
  mobileOpen?: boolean
  onMobileClose?(): void
}

export function WorkspaceSidebar({
  snapshot,
  agents,
  selectedAgentId,
  onSelectAgent,
  onRefreshAgents,
  backupSourceIds,
  onBackupSourceIdsChange,
  theme,
  onToggleTheme,
  onContextHost,
  onCollapse,
  mobileOpen = false,
  onMobileClose = () => undefined,
}: WorkspaceSidebarProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const { t } = useTranslation(['navigation', 'settings', 'shell'])
  const sidebarRef = useRef<HTMLElement>(null)
  const settingsAnchorRef = useRef<HTMLDivElement>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const onReview = location.pathname.startsWith('/review')
  const onInsights = location.pathname.startsWith('/insights') || location.pathname.startsWith('/tools')
  const onAgents = location.pathname.startsWith('/agents')
  const onBackup = location.pathname.startsWith('/backup')

  useModalFocusScope({ open: mobileOpen, onClose: onMobileClose, panelRef: sidebarRef })

  useEffect(() => {
    setSettingsOpen(false)
  }, [location.pathname])

  useEffect(() => {
    if (!settingsOpen) return

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!settingsAnchorRef.current?.contains(event.target as Node)) setSettingsOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      setSettingsOpen(false)
      requestAnimationFrame(() => settingsAnchorRef.current?.querySelector<HTMLButtonElement>('.workspace-settings-button')?.focus({ preventScroll: true }))
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [settingsOpen])

  return <aside
    ref={sidebarRef}
    className={`workspace-sidebar ${mobileOpen ? 'is-mobile-open' : ''}`}
    aria-label={t('shell:workspaceNavigation')}
    role={mobileOpen ? 'dialog' : undefined}
    aria-modal={mobileOpen ? 'true' : undefined}
    tabIndex={mobileOpen ? -1 : undefined}
  >
    <div className="workspace-sidebar-brand-row">
      <NavLink to="/review" className="workspace-sidebar-brand" aria-label={`AgentLens，${t('navigation:backToTaskCenter')}`} title={t('navigation:backToTaskCenter')} onClick={onMobileClose}>
        <img className="workspace-sidebar-logo" src="/agentlens-icon.svg" alt="" aria-hidden="true"/>
        <span className="workspace-sidebar-brand-copy"><b>AgentLens</b></span>
      </NavLink>
      <IconButton className="workspace-sidebar-collapse-button" size="small" onClick={onCollapse} title={t('navigation:collapseSidebar')} aria-label={t('navigation:collapseSidebar')}><UiIcon name="panel-left-close" size={16}/></IconButton>
    </div>

    <WorkspacePrimaryNavigation
      activeSection={onReview ? 'review' : onInsights ? 'insights' : onAgents ? 'agents' : undefined}
      hasInsightsUpdate={snapshot.usage.hasNewData}
      hasAgentsUpdate={snapshot.agentsHasNewData}
      onNavigate={onMobileClose}
    />

    <div className="workspace-sidebar-context" ref={onContextHost}>
      {onInsights && <nav className="workspace-insight-switcher" aria-label={t('navigation:insightsView')}>
        <NavLink to="/insights" onClick={onMobileClose} className={({ isActive }) => `workspace-insight-link ${isActive ? 'is-active' : ''}`} end>{t('navigation:usageOverview')}</NavLink>
        <NavLink to="/tools" onClick={onMobileClose} className={({ isActive }) => `workspace-insight-link ${isActive ? 'is-active' : ''}`}>{t('navigation:tools')}{snapshot.usage.hasNewData && <i className="workspace-nav-dot" aria-hidden="true"/>}</NavLink>
      </nav>}

      {onAgents && <div className="workspace-context-menu workspace-agent-context">
        <div className="workspace-context-utility">
          <span>{t('navigation:sourceCount', { count: agents.length })}</span>
          <IconButton size="small" onClick={onRefreshAgents} title={t('navigation:refreshAgents')} aria-label={t('navigation:refreshAgents')}><UiIcon name="refresh" size={14}/></IconButton>
        </div>
        <SidebarFilterDisclosure agents={agents} agentSelection={{ mode: 'single', value: selectedAgentId, onChange: sourceId => { onSelectAgent(sourceId); onMobileClose() } }} />
      </div>}

      {onBackup && <nav className="workspace-context-menu workspace-maintenance-context" aria-label={t('navigation:maintenance')}>
        <NavLink to="/backup" onClick={onMobileClose} className="workspace-context-link is-active">{t('navigation:assetBackup')}</NavLink>
        <SidebarFilterDisclosure agents={agents} agentSelection={{ mode: 'multiple', value: backupSourceIds, onChange: onBackupSourceIdsChange }}/>
      </nav>}
    </div>

    <div className="workspace-sidebar-footer">
      <div className="workspace-settings-anchor" ref={settingsAnchorRef}>
        <IconButton
          className={`workspace-settings-button ${settingsOpen || onBackup ? 'is-active' : ''}`}
          aria-label={t('settings:openMenu')}
          aria-expanded={settingsOpen}
          title={t('navigation:settings')}
          onClick={() => setSettingsOpen(current => !current)}
        ><UiIcon name="settings" size={16}/></IconButton>

        {settingsOpen && <section className="workspace-settings-popover" aria-label={t('settings:menu')}>
          <section className="workspace-settings-group" aria-labelledby="workspace-settings-maintenance-title">
            <div id="workspace-settings-maintenance-title" className="workspace-settings-group-title">{t('settings:maintenanceAndAppearance')}</div>
            <div className="workspace-settings-menu">
              <button
                type="button"
                className={`workspace-settings-menu-item ${onAgents ? 'is-active' : ''}`}
                onClick={() => {
                  navigate('/agents')
                  setSettingsOpen(false)
                  onMobileClose()
                }}
              >
                <UiIcon name="agent" size={14}/>
                <span>{t('settings:agentsAndIntegrations')}</span>
                <UiIcon className="workspace-settings-menu-tail" name="chevron-right" size={14}/>
              </button>
              <button
                type="button"
                className={`workspace-settings-menu-item ${onBackup ? 'is-active' : ''}`}
                onClick={() => {
                  navigate('/backup')
                  onMobileClose()
                }}
              >
                <UiIcon name="upload" size={14}/>
                <span>{t('navigation:assetBackup')}</span>
                <UiIcon className="workspace-settings-menu-tail" name="chevron-right" size={14}/>
              </button>
              <button
                type="button"
                className="workspace-settings-menu-item"
                onClick={() => {
                  onToggleTheme()
                  setSettingsOpen(false)
                }}
              >
                <UiIcon name={theme === 'dark' ? 'sun' : 'moon'} size={14}/>
                <span>{theme === 'dark' ? t('settings:switchToLight') : t('settings:switchToDark')}</span>
              </button>
            </div>
            <LocaleSelector/>
          </section>

          <section className="workspace-settings-group" aria-labelledby="workspace-settings-runtime-title">
            <div id="workspace-settings-runtime-title" className="workspace-settings-group-title">{t('settings:runtime')}</div>
            <div className="workspace-settings-runtime">
              <RuntimeStatus health={snapshot.health} liveConnected={snapshot.liveConnected}/>
            </div>
          </section>

          <section className="workspace-settings-group" aria-labelledby="workspace-settings-release-title">
            <div id="workspace-settings-release-title" className="workspace-settings-group-title">{t('settings:versionAndUpdates')}</div>
            <div className="workspace-settings-release">
              <ReleaseInfo runtimeOwner={snapshot.health?.runtime?.owner ?? null} runtimeReady={snapshot.health !== null}/>
            </div>
            <div className="workspace-settings-version">
              <span>AgentLens</span>
              <BrandVersion/>
            </div>
          </section>
        </section>}
      </div>
      <BackgroundActivityStatus health={snapshot.health}/>
    </div>
  </aside>
}
