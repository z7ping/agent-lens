import type { AgentFacetDto } from '@agent-lens/protocol'
import { usePinnedAgents } from '../App'

export function agentLabel(sourceId: string, fallback?: string): string {
  if (sourceId === 'claude-code') return 'Claude Code'
  if (sourceId === 'codex') return 'Codex'
  if (sourceId === 'pi') return 'Pi'
  return fallback ?? sourceId
}

export function sourceDot(sourceId: string): string {
  if (sourceId === 'claude-code') return 'bg-[#D97757]'
  if (sourceId === 'codex') return 'bg-[#10A37F]'
  if (sourceId === 'pi') return 'bg-[#7C6FE8]'
  return 'bg-muted'
}

export function AgentScope({ agents, value, onChange }: { agents: AgentFacetDto[]; value: string; onChange(value: string): void }) {
  const { pinned, toggle } = usePinnedAgents()
  const shown = pinned.map(id => agents.find(agent => agent.sourceId === id)).filter((agent): agent is AgentFacetDto => Boolean(agent))
  return <div className="flex min-w-0 items-center gap-1">
    <button className={`agent-chip ${value === '' ? 'agent-chip-active' : ''}`} onClick={() => onChange('')}>全部</button>
    {shown.map(agent => <button key={agent.sourceId} className={`agent-chip ${value === agent.sourceId ? 'agent-chip-active' : ''}`} onClick={() => onChange(agent.sourceId)}>
      <span className={`size-1.5 rounded-full ${sourceDot(agent.sourceId)}`} />{agentLabel(agent.sourceId, agent.displayName)}
    </button>)}
    <details className="relative">
      <summary className="agent-chip cursor-pointer list-none" title="管理 Agent 快捷入口">＋</summary>
      <div className="absolute left-0 top-9 z-40 w-64 rounded-xl border border-line bg-surface p-2 shadow-xl">
        <div className="px-2 pb-2 text-xs font-medium text-muted">快捷 Agent</div>
        {agents.map(agent => <label key={agent.sourceId} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-soft">
          <input type="checkbox" checked={pinned.includes(agent.sourceId)} onChange={() => toggle(agent.sourceId)} />
          <span className={`size-2 rounded-full ${sourceDot(agent.sourceId)}`} />
          <span className="flex-1">{agentLabel(agent.sourceId, agent.displayName)}</span>
          <span className="text-xs text-muted">{agent.detected ? '已检测' : '未检测'}</span>
        </label>)}
      </div>
    </details>
  </div>
}
