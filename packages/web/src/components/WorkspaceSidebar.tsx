import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { ClientSnapshot } from '../client/model'
import { LocaleSelector } from '../i18n/LocaleSelector'
import { BackgroundActivityStatus } from './BackgroundActivityStatus'
import { BrandVersion, ReleaseInfo } from './ReleaseInfo'
import { RuntimeStatus } from './RuntimeStatus'
import { WorkspacePrimaryNavigation } from './WorkspacePrimaryNavigation'
import { IconButton, Popover, UiIcon, useModalFocusScope } from './ui'
import './workspace-sidebar-menu.css'

interface WorkspaceSidebarProps {
  snapshot: ClientSnapshot
  theme: 'light' | 'dark'
  onToggleTheme(): void
  onOpenMarkdownThemes(): void
  onContextHost(node: HTMLDivElement | null): void
  collapsed: boolean
  onToggleCollapse(): void
  mobileOpen?: boolean
  onMobileClose?(): void
}

export function WorkspaceSidebar({
  snapshot,
  theme,
  onToggleTheme,
  onOpenMarkdownThemes,
  onContextHost,
  collapsed,
  onToggleCollapse,
  mobileOpen = false,
  onMobileClose = () => undefined,
}: WorkspaceSidebarProps) {
  const location = useLocation()
  const { t } = useTranslation(['navigation', 'settings', 'shell', 'common'])
  const sidebarRef = useRef<HTMLElement>(null)
  const settingsButtonRef = useRef<HTMLButtonElement>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const onReview = location.pathname.startsWith('/review')
  const onInsights = location.pathname.startsWith('/insights') || location.pathname.startsWith('/tools')
  const onAgents = location.pathname.startsWith('/agents')
  const onBackup = location.pathname.startsWith('/backup')

  useModalFocusScope({ open: mobileOpen, onClose: onMobileClose, panelRef: sidebarRef })

  useEffect(() => {
    setSettingsOpen(false)
  }, [location.pathname])

  return <aside
    ref={sidebarRef}
    className={`workspace-sidebar ${mobileOpen ? 'is-mobile-open' : ''}`}
    aria-label={t('shell:workspaceNavigation')}
    role={mobileOpen ? 'dialog' : undefined}
    aria-modal={mobileOpen ? 'true' : undefined}
    tabIndex={mobileOpen ? -1 : undefined}
  >
    <div className="workspace-sidebar-brand-row">
      <IconButton
        className="workspace-sidebar-collapse-button"
        size="small"
        onClick={onToggleCollapse}
        title={collapsed ? t('navigation:expandSidebar') : t('navigation:collapseSidebar')}
        aria-label={collapsed ? t('navigation:expandSidebar') : t('navigation:collapseSidebar')}
        aria-pressed={collapsed}
      ><UiIcon name={collapsed ? 'panel-left-open' : 'panel-left-close'} size={16}/></IconButton>
    </div>

    <WorkspacePrimaryNavigation
      activeSection={onReview ? 'review' : onInsights ? 'insights' : onAgents ? 'agents' : onBackup ? 'backup' : undefined}
      hasInsightsUpdate={snapshot.usage.hasNewData}
      hasAgentsUpdate={snapshot.agentsHasNewData || Boolean(snapshot.integrationManagement?.items.some(item => item.isNew))}
      onNavigate={onMobileClose}
    />

    <div className="workspace-sidebar-context" ref={onContextHost}/>

    <div className="workspace-sidebar-footer">
      <div className="workspace-settings-anchor">
        <IconButton
          ref={settingsButtonRef}
          className={`workspace-settings-button ${settingsOpen ? 'is-active' : ''}`}
          aria-label={t('settings:openMenu')}
          aria-expanded={settingsOpen}
          title={t('navigation:settings')}
          onClick={() => setSettingsOpen(current => !current)}
        ><UiIcon name="settings" size={16}/></IconButton>

        <Popover
          open={settingsOpen}
          anchorRef={settingsButtonRef}
          onClose={() => setSettingsOpen(false)}
          placement="right-end"
          className="workspace-settings-popover"
        >
          <section aria-label={t('settings:menu')}>
          <section className="workspace-settings-group" aria-labelledby="workspace-settings-appearance-title">
            <div id="workspace-settings-appearance-title" className="workspace-settings-group-title">{t('settings:appearance')}</div>
            <div className="workspace-settings-menu">
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
              <button
                type="button"
                className="workspace-settings-menu-item"
                onClick={() => {
                  setSettingsOpen(false)
                  onOpenMarkdownThemes()
                }}
              >
                <UiIcon name="tool-read" size={14}/>
                <span>{t('settings:markdownThemes')}</span>
                <UiIcon className="workspace-settings-menu-tail" name="chevron-right" size={14}/>
              </button>
              <LocaleSelector/>
            </div>
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
          </section>
        </Popover>
      </div>
      <BackgroundActivityStatus health={snapshot.health}/>
    </div>
  </aside>
}
