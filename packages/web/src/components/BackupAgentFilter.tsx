import type { AgentFacetDto } from '@agent-lens/protocol'
import { agentLabel, sourceDot, useOrderedAgents } from './AgentScope'
import { Disclosure } from './ui'

interface BackupAgentFilterProps {
  agents: AgentFacetDto[]
  selectedSourceIds: string[] | null
  onSelectedSourceIdsChange(sourceIds: string[] | null): void
}

/** 资产备份页的范围筛选：平铺在侧栏，并与备份页共享同一个选择状态。 */
export function BackupAgentFilter({ agents, selectedSourceIds, onSelectedSourceIdsChange }: BackupAgentFilterProps) {
  const orderedAgents = useOrderedAgents(agents)
  const detectedIds = orderedAgents.filter(agent => agent.detected).map(agent => agent.sourceId)
  const selectedIds = selectedSourceIds ?? detectedIds
  const selectedDetectedIds = selectedIds.filter(id => detectedIds.includes(id))
  const allDetectedSelected = detectedIds.length > 0 && detectedIds.every(id => selectedIds.includes(id))
  const summaryMeta = allDetectedSelected ? '全部' : selectedDetectedIds.length ? `已选 ${selectedDetectedIds.length} 个` : '未选择'

  const toggle = (sourceId: string) => {
    const current = selectedSourceIds ?? detectedIds
    onSelectedSourceIdsChange(current.includes(sourceId)
      ? current.filter(id => id !== sourceId)
      : [...current, sourceId])
  }

  return <Disclosure className="workspace-backup-filter" summary="筛选" summaryMeta={summaryMeta} open>
    <div className="workspace-backup-filter-options" role="group" aria-label="按智能体筛选备份范围">
      <button
        type="button"
        className={`workspace-backup-filter-option ${allDetectedSelected ? 'is-selected' : ''}`}
        aria-pressed={allDetectedSelected}
        onClick={() => onSelectedSourceIdsChange(null)}
      >全部智能体</button>
      {orderedAgents.map(agent => {
        const selected = selectedIds.includes(agent.sourceId)
        return <button
          key={agent.sourceId}
          type="button"
          className={`workspace-backup-filter-option ${selected ? 'is-selected' : ''}`}
          aria-pressed={selected}
          disabled={!agent.detected}
          onClick={() => toggle(agent.sourceId)}
        >
          <span className={`source-dot ${sourceDot(agent.sourceId)}`} aria-hidden="true"/>
          <span>{agentLabel(agent.sourceId, agent.displayName)}</span>
          {!agent.detected && <span className="workspace-backup-filter-state">未检测</span>}
        </button>
      })}
      {!orderedAgents.length && <div className="workspace-context-empty">暂未发现智能体</div>}
    </div>
  </Disclosure>
}
