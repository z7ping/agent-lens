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
  return <div className="agent-scope">
    <button className={`scope-chip ${value === '' ? 'scope-chip-active' : ''}`} onClick={() => onChange('')}>全部</button>
    {shown.map(agent => <button key={agent.sourceId} className={`scope-chip ${value === agent.sourceId ? 'scope-chip-active' : ''}`} onClick={() => onChange(agent.sourceId)}>
      <span className={`source-dot ${sourceDot(agent.sourceId)}`} />
      <span>{agentLabel(agent.sourceId, agent.displayName)}</span>
    </button>)}
    <details className="agent-scope-manage">
      <summary className="scope-manage-button" title="管理 Agent 快捷入口" aria-label="管理 Agent 快捷入口">＋</summary>
      <div className="agent-scope-menu">
        <div className="agent-scope-menu-title">快捷 Agent</div>
        {agents.length ? agents.map(agent => <label key={agent.sourceId} className="agent-scope-option">
          <input type="checkbox" checked={pinned.includes(agent.sourceId)} onChange={() => toggle(agent.sourceId)} />
          <span className={`source-dot ${sourceDot(agent.sourceId)}`} />
          <span className="agent-scope-option-name">{agentLabel(agent.sourceId, agent.displayName)}</span>
          <span className={`agent-scope-option-state ${agent.detected ? 'is-detected' : ''}`}>{agent.detected ? '已检测' : '未检测'}</span>
        </label>) : <div className="agent-scope-empty">暂未发现 Agent</div>}
      </div>
    </details>
  </div>
}
