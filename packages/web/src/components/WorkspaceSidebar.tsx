import { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import type { AgentFacetDto } from '@agent-lens/protocol'
import type { ClientSnapshot } from '../client/model'
import { BrandVersion, ReleaseInfo } from './ReleaseInfo'
import { RuntimeStatus } from './RuntimeStatus'
import { agentLabel, sourceDot, useOrderedAgents } from './AgentScope'
import { IconButton, UiIcon } from './ui'
import './workspace-sidebar-menu.css'

interface WorkspaceSidebarProps {
  snapshot: ClientSnapshot
  agents: AgentFacetDto[]
  selectedAgentId: string
  onSelectAgent(id: string): void
  onRefreshAgents(): void
  theme: 'light' | 'dark'
  onToggleTheme(): void
  onContextHost(node: HTMLDivElement | null): void
  mobileOpen?: boolean
  onMobileClose?(): void
}

export function WorkspaceSidebar({
  snapshot,
  agents,
  selectedAgentId,
  onSelectAgent,
  onRefreshAgents,
  theme,
  onToggleTheme,
  onContextHost,
  mobileOpen = false,
  onMobileClose = () => undefined,
}: WorkspaceSidebarProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const settingsAnchorRef = useRef<HTMLDivElement>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const orderedAgents = useOrderedAgents(agents)
  const onReview = location.pathname.startsWith('/review')
  const onInsights = location.pathname.startsWith('/insights') || location.pathname.startsWith('/tools')
  const onAgents = location.pathname.startsWith('/agents')
  const onBackup = location.pathname.startsWith('/backup')

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

  return <aside className={`workspace-sidebar ${mobileOpen ? 'is-mobile-open' : ''}`} aria-label="AgentLens 工作区导航">
    <NavLink to="/review" className="workspace-sidebar-brand" aria-label="AgentLens，返回任务中心" title="返回任务中心" onClick={onMobileClose}>
      <img className="workspace-sidebar-logo" src="/agentlens-icon.svg" alt="" aria-hidden="true"/>
      <span className="workspace-sidebar-brand-copy"><b>AgentLens</b></span>
    </NavLink>

    <nav className="workspace-primary-nav" aria-label="主导航">
      <NavLink to="/review" onClick={onMobileClose} className={`workspace-primary-link ${onReview ? 'is-active' : ''}`}><UiIcon name="task" size={16}/><span aria-label="任务中心">任务</span></NavLink>
      <NavLink to="/insights" onClick={onMobileClose} className={`workspace-primary-link ${onInsights ? 'is-active' : ''}`}><UiIcon name="trend" size={16}/><span>洞察</span>{snapshot.usage.hasNewData && <i className="workspace-nav-dot" aria-label="有新数据"/>}</NavLink>
      <NavLink to="/agents" onClick={onMobileClose} className={`workspace-primary-link ${onAgents ? 'is-active' : ''}`}><UiIcon name="agent" size={16}/><span>智能体</span>{snapshot.agentsHasNewData && <i className="workspace-nav-dot" aria-label="有新数据"/>}</NavLink>
    </nav>

    <div className="workspace-sidebar-context" ref={onContextHost}>
      {onInsights && <nav className="workspace-insight-switcher" aria-label="洞察视图">
        <NavLink to="/insights" onClick={onMobileClose} className={({ isActive }) => `workspace-insight-link ${isActive ? 'is-active' : ''}`} end>使用概览</NavLink>
        <NavLink to="/tools" onClick={onMobileClose} className={({ isActive }) => `workspace-insight-link ${isActive ? 'is-active' : ''}`}>工具分析{snapshot.usage.hasNewData && <i className="workspace-nav-dot" aria-hidden="true"/>}</NavLink>
      </nav>}

      {onAgents && <div className="workspace-context-menu workspace-agent-context">
        <div className="workspace-context-utility">
          <span>{agents.length} 个来源</span>
          <IconButton size="small" onClick={onRefreshAgents} title="刷新智能体" aria-label="刷新智能体"><UiIcon name="refresh" size={14}/></IconButton>
        </div>
        {orderedAgents.map(agent => <button
          key={agent.sourceId}
          type="button"
          className={`workspace-agent-link ${selectedAgentId === agent.sourceId ? 'is-active' : ''}`}
          onClick={() => {
            onSelectAgent(agent.sourceId)
            onMobileClose()
          }}
          title={`${agentLabel(agent.sourceId, agent.displayName)} · ${agent.detected ? '已检测' : '未检测'}`}
        >
          <span className={`source-dot ${sourceDot(agent.sourceId)}`}/>
          <span>{agentLabel(agent.sourceId, agent.displayName)}</span>
        </button>)}
        {!agents.length && <div className="workspace-context-empty">暂未发现智能体</div>}
      </div>}

      {onBackup && <nav className="workspace-context-menu workspace-maintenance-context" aria-label="维护">
        <NavLink to="/backup" onClick={onMobileClose} className="workspace-context-link is-active">资产备份</NavLink>
      </nav>}
    </div>

    <div className="workspace-sidebar-footer">
      <div className="workspace-settings-anchor" ref={settingsAnchorRef}>
        <IconButton
          className={`workspace-settings-button ${settingsOpen || onBackup ? 'is-active' : ''}`}
          aria-label="打开设置与维护菜单"
          aria-expanded={settingsOpen}
          title="设置"
          onClick={() => setSettingsOpen(current => !current)}
        ><UiIcon name="settings" size={16}/></IconButton>

        {settingsOpen && <section className="workspace-settings-popover" aria-label="设置与维护">
          <section className="workspace-settings-group" aria-labelledby="workspace-settings-maintenance-title">
            <div id="workspace-settings-maintenance-title" className="workspace-settings-group-title">维护与外观</div>
            <div className="workspace-settings-menu">
              <button
                type="button"
                className={`workspace-settings-menu-item ${onBackup ? 'is-active' : ''}`}
                onClick={() => {
                  navigate('/backup')
                  onMobileClose()
                }}
              >
                <UiIcon name="upload" size={14}/>
                <span>资产备份</span>
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
                <span>{theme === 'dark' ? '切换为浅色主题' : '切换为深色主题'}</span>
              </button>
            </div>
          </section>

          <section className="workspace-settings-group" aria-labelledby="workspace-settings-runtime-title">
            <div id="workspace-settings-runtime-title" className="workspace-settings-group-title">运行</div>
            <div className="workspace-settings-runtime">
              <RuntimeStatus health={snapshot.health} liveConnected={snapshot.liveConnected}/>
            </div>
          </section>

          <section className="workspace-settings-group" aria-labelledby="workspace-settings-release-title">
            <div id="workspace-settings-release-title" className="workspace-settings-group-title">版本与更新</div>
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
    </div>
  </aside>
}
