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

function Shell({ model }: { model: AgentLensClientModel }) {
  const snapshot = useClientSnapshot(model)
  const [theme, setTheme] = useState(readTheme)
  const agents = snapshot.facets?.agents ?? []
  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    writeTheme(next)
  }
  return <PinnedProvider agents={agents}>
    <div className="min-h-screen bg-canvas text-ink">
      <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1800px] items-center gap-7 px-5">
          <div className="flex items-center gap-2 font-semibold tracking-tight"><span className="grid size-7 place-items-center rounded-lg bg-accent text-white">A</span><span>AgentLens</span></div>
          <nav className="flex h-full items-center gap-1 text-sm">
            {[[ '/review', '任务复盘' ], [ '/tools', '工具分析' ], [ '/agents', 'Agent 概览' ]].map(([to,label]) => <NavLink key={to} to={to} className={({isActive}) => `nav-item ${isActive ? 'nav-item-active' : ''}`}>{label}</NavLink>)}
          </nav>
          <div className="ml-auto flex items-center gap-2 text-xs text-muted">
            <span className={`size-2 rounded-full ${snapshot.liveConnected ? 'bg-success' : 'bg-warning'}`} />
            <span>{snapshot.health?.status === 'ok' ? '运行正常' : snapshot.health ? '运行降级' : '连接中'}</span>
            <button className="icon-button" onClick={toggleTheme} title="切换主题">{theme === 'dark' ? '☀' : '◐'}</button>
          </div>
        </div>
      </header>
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
