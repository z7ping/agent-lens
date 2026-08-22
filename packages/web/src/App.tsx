import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type PropsWithChildren } from 'react'
import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom'
import type { AgentFacetDto } from '@agent-lens/protocol'
import type { AgentLensClientModel, ClientSnapshot } from './client/model'
import { readPinnedAgents, readTheme, writePinnedAgents, writeTheme } from './client/preferences'
import { AgentsPage } from './features/AgentsPage'
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
  ['/review', '任务复盘'],
  ['/tools', '工具分析'],
  ['/agents', '智能体概览'],
] as const

function Shell({ model }: { model: AgentLensClientModel }) {
  const snapshot = useClientSnapshot(model)
  const [theme, setTheme] = useState(readTheme)
  const agents = snapshot.facets?.agents ?? []
  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    writeTheme(next)
  }
  const healthLabel = snapshot.health?.status === 'ok' ? '运行正常' : snapshot.health ? '运行降级' : '连接中'
  const liveLabel = snapshot.liveConnected ? '实时已连接' : '实时未连接'

  return <PinnedProvider agents={agents}>
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-inner">
          <div className="brand" aria-label="AgentLens">
            <span className="brand-mark">A</span>
            <span className="brand-name">AgentLens</span>
          </div>
          <nav className="app-nav" aria-label="主导航">
            {navigation.map(([to, label]) => <NavLink key={to} to={to} className={({ isActive }) => `nav-item ${isActive ? 'nav-item-active' : ''}`}>{label}</NavLink>)}
          </nav>
          <div className="app-status">
            <span className={`status-pill ${snapshot.health?.status === 'ok' ? 'status-pill-online' : snapshot.health ? 'status-pill-warn' : ''}`} title="AgentLens 后台服务状态">
              <span className={`live-dot ${snapshot.health?.status === 'ok' ? 'live-dot-online' : 'live-dot-waiting'}`} />
              <span>{healthLabel}</span>
            </span>
            <span className={`status-pill ${snapshot.liveConnected ? 'status-pill-online' : 'status-pill-warn'}`} title="实时数据通道状态">
              <span className={`live-dot ${snapshot.liveConnected ? 'live-dot-online' : 'live-dot-waiting'}`} />
              <span>{liveLabel}</span>
            </span>
            <button className="theme-toggle" onClick={toggleTheme} title="切换主题" aria-label="切换主题">{theme === 'dark' ? '☀' : '◐'}</button>
          </div>
        </div>
      </header>
      {snapshot.health && !snapshot.liveConnected && <div className="sse-banner" role="status">
        <span className="live-dot live-dot-waiting" />
        <span>实时通道已断开</span>
        <small>页面保留当前内容；重新连接后会继续接收新数据。</small>
      </div>}
      <Routes>
        <Route path="/review" element={<ReviewPage model={model} />} />
        <Route path="/review/:sessionId" element={<ReviewPage model={model} />} />
        <Route path="/tools" element={<ToolsPage model={model} />} />
        <Route path="/agents" element={<AgentsPage model={model} />} />
        <Route path="*" element={<Navigate to="/review" replace />} />
      </Routes>
    </div>
  </PinnedProvider>
}

export function App({ model }: { model: AgentLensClientModel }) {
  return <BrowserRouter><Shell model={model} /></BrowserRouter>
}
