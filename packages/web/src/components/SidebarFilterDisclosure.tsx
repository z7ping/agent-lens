import type { ReactNode } from 'react'
import type { AgentFacetDto } from '@agent-lens/protocol'
import { agentLabel, sourceDot, useOrderedAgents } from './AgentScope'
import { Disclosure } from './ui'

type AgentSelection =
  | { mode: 'single'; value: string; onChange(value: string): void }
  | { mode: 'multiple'; value: string[] | null; onChange(value: string[] | null): void }

interface SidebarFilterDisclosureProps {
  summary?: string
  summaryMeta?: ReactNode
  className?: string
  agents?: AgentFacetDto[]
  agentSelection?: AgentSelection
  children?: ReactNode
}

/** 工作区左侧筛选的统一折叠壳；页面只提供筛选字段与业务状态。 */
export function SidebarFilterDisclosure({
  summary = '筛选',
  summaryMeta,
  className = '',
  agents = [],
  agentSelection,
  children,
}: SidebarFilterDisclosureProps) {
  const orderedAgents = useOrderedAgents(agents)
  const detectedIds = orderedAgents.filter(agent => agent.detected).map(agent => agent.sourceId)
  const selectedIds = agentSelection?.mode === 'multiple'
    ? agentSelection.value === null ? detectedIds : agentSelection.value
    : agentSelection?.value ? [agentSelection.value] : []
  const allSelected = agentSelection?.mode === 'multiple'
    ? detectedIds.length > 0 && detectedIds.every(id => selectedIds.includes(id))
    : !agentSelection?.value
  const selectedCount = selectedIds.filter(id => detectedIds.includes(id)).length
  const computedSummary = agentSelection?.mode === 'multiple'
    ? allSelected ? '全部' : selectedCount ? `已选 ${selectedCount} 个` : '未选择'
    : agentSelection?.value ? agentLabel(agentSelection.value, orderedAgents.find(agent => agent.sourceId === agentSelection.value)?.displayName) : '全部'

  const selectAll = () => {
    if (!agentSelection) return
    if (agentSelection.mode === 'multiple') agentSelection.onChange(null)
    else agentSelection.onChange('')
  }

  const selectAgent = (sourceId: string) => {
    if (!agentSelection) return
    if (agentSelection.mode === 'single') {
      agentSelection.onChange(sourceId)
      return
    }
    const current = agentSelection.value === null ? detectedIds : agentSelection.value
    const next = current.includes(sourceId)
      ? current.filter(id => id !== sourceId)
      : [...current, sourceId]
    agentSelection.onChange(next)
  }

  return <Disclosure className={`workspace-sidebar-filter-disclosure ${className}`.trim()} summary={summary} summaryMeta={summaryMeta ?? computedSummary}>
    {agentSelection && <div className="workspace-agent-filter-list" role="group" aria-label="按智能体筛选">
      <button type="button" className={`workspace-agent-filter-option ${allSelected ? 'is-selected' : ''}`} aria-pressed={allSelected} onClick={selectAll}>全部智能体</button>
      {orderedAgents.map(agent => {
        const selected = selectedIds.includes(agent.sourceId)
        return <button
          key={agent.sourceId}
          type="button"
          className={`workspace-agent-filter-option ${selected ? 'is-selected' : ''}`}
          aria-pressed={selected}
          disabled={!agent.detected}
          onClick={() => selectAgent(agent.sourceId)}
        >
          <span className={`source-dot ${sourceDot(agent.sourceId)}`} aria-hidden="true"/>
          <span>{agentLabel(agent.sourceId, agent.displayName)}</span>
          {!agent.detected && <span className="workspace-agent-filter-state">未检测</span>}
        </button>
      })}
      {!orderedAgents.length && <div className="workspace-context-empty">暂未发现智能体</div>}
    </div>}
    {children}
  </Disclosure>
}
