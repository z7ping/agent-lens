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
  summaryMeta?: ReactNode
  className?: string
  agents?: AgentFacetDto[]
  agentSelection?: AgentSelection
  children?: ReactNode
  defaultOpen?: boolean
  showAllOption?: boolean
  agentOrderManagement?: boolean
  closeOnOutside?: boolean
  /** In a filter, selecting an agent from All narrows to that agent instead of excluding it. */
  multipleSelectionBehavior?: 'toggle' | 'pick-from-all'
}

/** 工作区左侧筛选的统一折叠壳；页面只提供筛选字段与业务状态。 */
export function SidebarFilterDisclosure({
  summary,
  summaryMeta,
  className = '',
  agents = [],
  agentSelection,
  children,
  defaultOpen = false,
  showAllOption = false,
  agentOrderManagement = false,
  closeOnOutside = false,
  multipleSelectionBehavior = 'toggle',
}: SidebarFilterDisclosureProps) {
  const { t } = useTranslation('common')
  const { t: tAgents } = useTranslation('agents')
  const [open, setOpen] = useState(defaultOpen)
  const disclosureRef = useRef<HTMLDetailsElement>(null)
  const [managingOrder, setManagingOrder] = useState(false)
  const [draggedId, setDraggedId] = useState('')
  const { canReorder, move, moveBy, reset } = useIntegrationOrder()
  useEffect(() => {
    if (!closeOnOutside || !open) return
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
  }, [closeOnOutside, open])


  const resolvedSummary = summary ?? t('sidebarFilter.summary')
  const orderedAgents = useOrderedAgents(agents)
  const detectedIds = orderedAgents.filter(agent => agent.detected).map(agent => agent.sourceId)
  const pickFromAll = agentSelection?.mode === 'multiple' && multipleSelectionBehavior === 'pick-from-all'
  const selectedIds = agentSelection?.mode === 'multiple'
    ? agentSelection.value === null ? (pickFromAll ? [] : detectedIds) : agentSelection.value
    : agentSelection?.value ? [agentSelection.value] : []
  const allSelected = agentSelection?.mode === 'multiple'
    ? pickFromAll
      ? agentSelection.value === null
      : detectedIds.length > 0 && detectedIds.every(id => selectedIds.includes(id))
    : !agentSelection?.value
  const selectedCount = selectedIds.filter(id => detectedIds.includes(id)).length
  const reorderableAgents = orderedAgents.filter(agent => canReorder(agent.sourceId))
  const computedSummary = agentSelection?.mode === 'multiple'
    ? allSelected ? t('sidebarFilter.all') : selectedCount ? t('sidebarFilter.selected', { count: selectedCount }) : t('sidebarFilter.none')
    : agentSelection?.value ? agentLabel(agentSelection.value, orderedAgents.find(agent => agent.sourceId === agentSelection.value)?.displayName) : t('sidebarFilter.all')

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
    if (pickFromAll) {
      agentSelection.onChange(nextAgentFilterSelection(agentSelection.value, sourceId, detectedIds))
      return
    }
    const current = agentSelection.value === null ? detectedIds : agentSelection.value
    const next = current.includes(sourceId)
      ? current.filter(id => id !== sourceId)
      : [...current, sourceId]
    agentSelection.onChange(next)
  }

  return <Disclosure
    ref={disclosureRef}
    className={`workspace-sidebar-filter-disclosure ${className}`.trim()}
    summary={resolvedSummary}
    summaryMeta={summaryMeta ?? computedSummary}
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
    {children}
  </Disclosure>
}
