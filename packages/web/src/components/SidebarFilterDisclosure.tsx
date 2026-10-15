import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentFacetDto } from '@agent-lens/protocol'
import { agentLabel, sourceDot, useOrderedAgents } from './AgentScope'
import { useIntegrationOrder } from './IntegrationOrderProvider'
import { Button, Disclosure, IconButton, UiIcon } from './ui'
import { nextAgentFilterSelection } from './task-agent-selection'

type AgentSelection =
  | { mode: 'single'; value: string; onChange(value: string): void }
  | { mode: 'multiple'; value: string[] | null; onChange(value: string[] | null): void }

interface SidebarFilterDisclosureProps {
  summary?: ReactNode
  agents?: AgentFacetDto[]
  agentSelection?: AgentSelection
  showAllOption?: boolean
  agentOrderManagement?: boolean
}

/** 工作区左侧筛选的统一折叠壳；页面只提供筛选字段与业务状态。 */
export function SidebarFilterDisclosure({
  summary,
  agents = [],
  agentSelection,
  showAllOption = false,
  agentOrderManagement = false,
}: SidebarFilterDisclosureProps) {
  const { t } = useTranslation('common')
  const { t: tAgents } = useTranslation('agents')
  const [open, setOpen] = useState(false)
  const disclosureRef = useRef<HTMLDetailsElement>(null)
  const [managingOrder, setManagingOrder] = useState(false)
  const [draggedId, setDraggedId] = useState('')
  const { canReorder, move, moveBy, reset } = useIntegrationOrder()
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && !disclosureRef.current?.contains(target)) setOpen(false)
    }
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (!disclosureRef.current?.contains(document.activeElement)) return
      event.preventDefault()
      setOpen(false)
      disclosureRef.current?.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true })
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeEscape)
    }
  }, [open])


  const resolvedSummary = summary ?? t('sidebarFilter.summary')
  const orderedAgents = useOrderedAgents(agents)
  const detectedIds = orderedAgents.filter(agent => agent.detected).map(agent => agent.sourceId)
  const selectedIds = agentSelection?.mode === 'multiple'
    ? agentSelection.value ?? []
    : agentSelection?.value ? [agentSelection.value] : []
  const allSelected = agentSelection?.mode === 'multiple'
    ? agentSelection.value === null
    : !agentSelection?.value
  const reorderableAgents = orderedAgents.filter(agent => canReorder(agent.sourceId))

  const selectAll = () => {
    if (!agentSelection) return
    if (agentSelection.mode === 'multiple') agentSelection.onChange(null)
    else {
      agentSelection.onChange('')
      setOpen(false)
      disclosureRef.current?.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true })
    }
  }

  const selectAgent = (sourceId: string) => {
    if (!agentSelection) return
    if (agentSelection.mode === 'single') {
      agentSelection.onChange(sourceId)
      setOpen(false)
      disclosureRef.current?.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true })
      return
    }
    agentSelection.onChange(nextAgentFilterSelection(agentSelection.value, sourceId, detectedIds))
  }

  return <Disclosure
    ref={disclosureRef}
    className="workspace-sidebar-filter-disclosure"
    summary={resolvedSummary}
    title={typeof resolvedSummary === 'string' ? resolvedSummary : undefined}
    summaryMeta={false}
    open={open}
    onToggle={event => setOpen(event.currentTarget.open)}
  >
    {agentSelection && <div className="workspace-agent-filter-list" role="group" aria-label={typeof resolvedSummary === 'string' ? resolvedSummary : t('sidebarFilter.summary')}>
      {(agentSelection.mode === 'multiple' || showAllOption) && <button type="button" className={`workspace-agent-filter-option ${allSelected ? 'is-selected' : ''}`} aria-pressed={allSelected} onClick={selectAll}><span>{t('sidebarFilter.allAgents')}</span>{allSelected && <UiIcon name="check" size={14} aria-hidden="true"/>}</button>}
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
          {!agent.detected && <span className="workspace-agent-filter-state">{t('sidebarFilter.notDetected')}</span>}
          {selected && <UiIcon name="check" size={14} aria-hidden="true"/>}
        </button>
      })}
      {!orderedAgents.length && <div className="workspace-context-empty">{t('sidebarFilter.empty')}</div>}
    </div>}
    {agentOrderManagement && reorderableAgents.length > 1 && <section className="workspace-agent-order" aria-label={tAgents('page.orderTitle')}>
      {managingOrder ? <>
        <div className="workspace-agent-order-actions">
          <Button size="small" onClick={reset}>{tAgents('scope.reset')}</Button>
          <Button size="small" variant="primary" onClick={() => { setManagingOrder(false); setDraggedId('') }}>{tAgents('page.orderDone')}</Button>
        </div>
        <div className="workspace-agent-order-list">
          {orderedAgents.map(agent => {
            const reorderable = canReorder(agent.sourceId)
            const reorderIndex = reorderableAgents.findIndex(item => item.sourceId === agent.sourceId)
            const label = agentLabel(agent.sourceId, agent.displayName)
            return <div
              key={agent.sourceId}
              className={`workspace-agent-order-option ${draggedId === agent.sourceId ? 'is-dragging' : ''} ${reorderable ? '' : 'is-fixed'}`}
              draggable={reorderable}
              onDragStart={(event: DragEvent<HTMLDivElement>) => {
                if (!reorderable) return
                setDraggedId(agent.sourceId)
                event.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={event => {
                if (!reorderable) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
              }}
              onDrop={event => {
                if (!reorderable) return
                event.preventDefault()
                if (draggedId) move(draggedId, agent.sourceId)
                setDraggedId('')
              }}
              onDragEnd={() => setDraggedId('')}
            >
              <UiIcon name="drag" size={16} className="workspace-agent-order-drag"/>
              <span className={`source-dot ${sourceDot(agent.sourceId)}`} aria-hidden="true"/>
              <b>{label}</b>
              <span className="workspace-agent-order-buttons">
                <IconButton size="small" disabled={!reorderable || reorderIndex <= 0} onClick={() => moveBy(agent.sourceId, -1)} aria-label={tAgents('scope.moveUp', { agent: label })}><UiIcon name="arrow-big-up" size={14}/></IconButton>
                <IconButton size="small" disabled={!reorderable || reorderIndex < 0 || reorderIndex === reorderableAgents.length - 1} onClick={() => moveBy(agent.sourceId, 1)} aria-label={tAgents('scope.moveDown', { agent: label })}><UiIcon name="arrow-big-down" size={14}/></IconButton>
              </span>
            </div>
          })}
        </div>
      </> : <Button size="small" onClick={() => setManagingOrder(true)}>{tAgents('page.manageOrder')}</Button>}
    </section>}
  </Disclosure>
}
