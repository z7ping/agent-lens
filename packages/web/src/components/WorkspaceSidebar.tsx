import { useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import type { AgentFacetDto } from '@agent-lens/protocol'
import type { ClientSnapshot } from '../client/model'
import { ReleaseInfo } from './ReleaseInfo'
import { RuntimeStatus } from './RuntimeStatus'
import { agentLabel, sourceDot } from './AgentScope'
import { Button, Drawer, IconButton, UiIcon } from './ui'

interface WorkspaceSidebarProps {
  snapshot: ClientSnapshot
  agents: AgentFacetDto[]
  selectedAgentId: string
  onSelectAgent(id: string): void
  onRefreshAgents(): void
  theme: 'light' | 'dark'
  onToggleTheme(): void
  onContextHost(node: HTMLDivElement | null): void
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
}: WorkspaceSidebarProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const onReview = location.pathname.startsWith('/review')
  const onInsights = location.pathname.startsWith('/insights') || location.pathname.startsWith('/tools')
  const onAgents = location.pathname.startsWith('/agents')
  const onBackup = location.pathname.startsWith('/backup')

  return <>
    <aside className="workspace-sidebar" aria-label="AgentLens 工作区导航">
      <NavLink to="/review" className="workspace-sidebar-brand" aria-label="AgentLens，返回任务中心" title="返回任务中心">
        <img className="workspace-sidebar-logo" src="/agentlens-icon.svg" alt="" aria-hidden="true"/>
        <span className="workspace-sidebar-brand-copy"><b>AgentLens</b></span>
      </NavLink>

      <nav className="workspace-primary-nav" aria-label="主导航">
        <NavLink to="/review" className={`workspace-primary-link ${onReview ? 'is-active' : ''}`}><span>任务中心</span></NavLink>
        <NavLink to="/insights" className={`workspace-primary-link ${onInsights ? 'is-active' : ''}`}><span>洞察</span>{snapshot.usage.hasNewData && <i className="workspace-nav-dot" aria-label="有新数据"/>}</NavLink>
        <NavLink to="/agents" className={`workspace-primary-link ${onAgents ? 'is-active' : ''}`}><span>智能体</span>{snapshot.agentsHasNewData && <i className="workspace-nav-dot" aria-label="有新数据"/>}</NavLink>
      </nav>

      <div className="workspace-sidebar-context" ref={onContextHost}>
        {onInsights && <nav className="workspace-context-menu workspace-insight-navigation" aria-label="洞察视图">
          <NavLink to="/insights" className={({ isActive }) => `workspace-context-link ${isActive ? 'is-active' : ''}`} end>使用概览</NavLink>
          <NavLink to="/tools" className={({ isActive }) => `workspace-context-link ${isActive ? 'is-active' : ''}`}>工具分析{snapshot.usage.hasNewData && <i className="workspace-nav-dot" aria-hidden="true"/>}</NavLink>
        </nav>}

        {onAgents && <div className="workspace-context-menu workspace-agent-context">
          <div className="workspace-context-utility">
            <span>{agents.length} 个来源</span>
            <IconButton size="small" onClick={onRefreshAgents} title="刷新智能体" aria-label="刷新智能体"><UiIcon name="refresh" size={14}/></IconButton>
          </div>
          {agents.map(agent => <button
            key={agent.sourceId}
            type="button"
            className={`workspace-agent-link ${selectedAgentId === agent.sourceId ? 'is-active' : ''}`}
            onClick={() => onSelectAgent(agent.sourceId)}
            title={`${agentLabel(agent.sourceId, agent.displayName)} · ${agent.detected ? '已检测' : '未检测'}`}
          >
            <span className={`source-dot ${sourceDot(agent.sourceId)}`}/>
            <span>{agentLabel(agent.sourceId, agent.displayName)}</span>
          </button>)}
          {!agents.length && <div className="workspace-context-empty">暂未发现智能体</div>}
        </div>}

        {onBackup && <nav className="workspace-context-menu workspace-maintenance-context" aria-label="维护">
          <NavLink to="/backup" className="workspace-context-link is-active">资产备份</NavLink>
        </nav>}
      </div>

      <div className="workspace-sidebar-footer">
        <span className="workspace-user-avatar" aria-label="本机用户" title="本机用户"><UiIcon name="agent" size={16}/></span>
        <IconButton aria-label="打开设置" title="设置" onClick={() => setSettingsOpen(true)}><UiIcon name="settings" size={16}/></IconButton>
      </div>
    </aside>

    <Drawer open={settingsOpen} title="设置" description="运行状态、版本与低频维护入口" onClose={() => setSettingsOpen(false)} className="workspace-settings-drawer">
      <div className="workspace-settings-section">
        <h3>运行状态</h3>
        <RuntimeStatus health={snapshot.health} liveConnected={snapshot.liveConnected}/>
      </div>
      <div className="workspace-settings-section">
        <h3>版本</h3>
        <ReleaseInfo runtimeOwner={snapshot.health?.runtime?.owner ?? null} runtimeReady={snapshot.health !== null}/>
      </div>
      <div className="workspace-settings-section workspace-settings-actions">
        <h3>外观与维护</h3>
        <Button onClick={onToggleTheme}><UiIcon name={theme === 'dark' ? 'sun' : 'moon'} size={14}/>{theme === 'dark' ? '切换为浅色主题' : '切换为深色主题'}</Button>
        <Button onClick={() => { setSettingsOpen(false); navigate('/backup') }}>资产备份 <UiIcon name="arrow-right" size={14}/></Button>
      </div>
    </Drawer>
  </>
}