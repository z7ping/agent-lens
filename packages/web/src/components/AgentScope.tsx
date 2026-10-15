import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { AgentFacetDto } from '@agent-lens/protocol'
import { orderAgentsByPreference } from './agent-order'
import { useIntegrationOrder } from './IntegrationOrderProvider'
import { AgentOrderActions, useAgentOrderDrag } from './AgentOrderControls'
import { usePinnedAgents } from './PinnedAgentsProvider'
import { UiIcon } from './UiIcon'
import { Button } from './ui'
import { AgentLogo } from './AgentLogo'

export function agentLabel(sourceId: string, fallback?: string): string {
  if (sourceId === 'claude-code') return 'Claude Code'
  if (sourceId === 'codex') return 'Codex'
  if (sourceId === 'pi') return 'Pi'
  if (sourceId === 'hermes') return 'Hermes'
  if (sourceId === 'opencode') return 'OpenCode'
  if (sourceId === 'dsh') return 'DeepSeek Harness'
  return fallback ?? sourceId
}

export function sourceDot(sourceId: string): string {
  if (sourceId === 'claude-code') return 'source-claude'
  if (sourceId === 'codex') return 'source-codex'
  if (sourceId === 'pi') return 'source-pi'
  if (sourceId === 'hermes') return 'source-hermes'
  if (sourceId === 'opencode') return 'source-opencode'
  if (sourceId === 'dsh') return 'source-dsh'
  return 'source-unknown'
}

export function useOrderedAgents<T extends { sourceId: string }>(agents: readonly T[]): T[] {
  const { ordered } = useIntegrationOrder()
  return useMemo(() => orderAgentsByPreference(agents, ordered), [agents, ordered])
}

interface ScopeMenuPosition {
  left: number
  top: number
  maxHeight: number
}

export function AgentScope({ agents, value, onChange, allLabel }: { agents: AgentFacetDto[]; value: string; onChange(value: string): void; allLabel?: string | false }) {
  const { t } = useTranslation('agents')
  const resolvedAllLabel = allLabel === undefined ? t('scope.all') : allLabel
  const { pinned, toggle } = usePinnedAgents()
  const { ordered, canReorder, reset } = useIntegrationOrder()
  const { draggedId, dragProps } = useAgentOrderDrag()
  const orderedAgents = useOrderedAgents(agents)
  const visible = orderedAgents.filter(agent => pinned.includes(agent.sourceId))
  const shown = resolvedAllLabel === false ? orderedAgents : (() => {
    const shortcuts = visible.slice(0, 4)
    const selected = value ? orderedAgents.find(agent => agent.sourceId === value) : undefined
    if (selected && !shortcuts.some(agent => agent.sourceId === selected.sourceId)) {
      return shortcuts.length < 4 ? [...shortcuts, selected] : [...shortcuts.slice(0, 3), selected]
    }
    return shortcuts
  })()
  const moreCount = Math.max(0, orderedAgents.length - shown.length)
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const summaryRef = useRef<HTMLElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState<ScopeMenuPosition | null>(null)

  const updateMenuPosition = () => {
    const anchor = summaryRef.current
    if (!anchor || typeof window === 'undefined') return
    const rect = anchor.getBoundingClientRect()
    const viewportPadding = 12
    const menuWidth = Math.min(310, Math.max(180, window.innerWidth - viewportPadding * 2))
    const measuredHeight = menuRef.current?.getBoundingClientRect().height ?? 280
    const belowSpace = window.innerHeight - rect.bottom - viewportPadding
    const aboveSpace = rect.top - viewportPadding
    const placeAbove = belowSpace < Math.min(measuredHeight, 240) && aboveSpace > belowSpace
    const availableHeight = Math.max(120, (placeAbove ? aboveSpace : belowSpace) - 6)
    const renderedHeight = Math.min(measuredHeight, availableHeight)
    const left = Math.min(
      Math.max(viewportPadding, rect.left),
      Math.max(viewportPadding, window.innerWidth - menuWidth - viewportPadding),
    )
    const top = placeAbove
      ? Math.max(viewportPadding, rect.top - renderedHeight - 6)
      : rect.bottom + 6
    setMenuPosition({ left, top, maxHeight: availableHeight })
  }

  useLayoutEffect(() => {
    if (!menuOpen) {
      setMenuPosition(null)
      return
    }
    updateMenuPosition()
    const frame = window.requestAnimationFrame(updateMenuPosition)
    return () => window.cancelAnimationFrame(frame)
  }, [menuOpen, agents.length, ordered.join('\u0000'), pinned.join('\u0000')])

  useEffect(() => {
    if (!menuOpen) return
    const reposition = () => updateMenuPosition()
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (detailsRef.current?.contains(target) || menuRef.current?.contains(target)) return
      if (detailsRef.current) detailsRef.current.open = false
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (detailsRef.current) detailsRef.current.open = false
      summaryRef.current?.focus()
    }
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [menuOpen])

  const menu = <div
    ref={menuRef}
    className="agent-scope-menu agent-scope-menu-portal"
    style={menuPosition ? {
      position: 'fixed',
      left: menuPosition.left,
      top: menuPosition.top,
      zIndex: 120,
      maxHeight: menuPosition.maxHeight,
      overflowY: 'auto',
    } : { position: 'fixed', visibility: 'hidden' }}
  >
    <div className="agent-scope-menu-head"><div><b>{t('scope.title')}</b><span>{t('scope.reorderHint')}</span></div><Button size="small" onClick={reset}>{t('scope.reset')}</Button></div>
    {orderedAgents.length ? orderedAgents.map(agent => {
      const reorderable = canReorder(agent.sourceId)
      return <div
        key={agent.sourceId}
        className={`agent-scope-option ${draggedId === agent.sourceId ? 'is-dragging' : ''} ${reorderable ? '' : 'is-fixed-order'}`}
        {...dragProps(agent.sourceId)}
      >
        <UiIcon name="drag" size={16} className={`agent-scope-drag ${reorderable ? '' : 'is-disabled'}`} />
        <input type="checkbox" aria-label={t('scope.showInToolbar', { agent: agentLabel(agent.sourceId, agent.displayName) })} checked={pinned.includes(agent.sourceId)} onChange={() => toggle(agent.sourceId)} />
        <AgentLogo sourceId={agent.sourceId} size="compact" />
        <span className="agent-scope-option-name">{agentLabel(agent.sourceId, agent.displayName)}</span>
        <AgentOrderActions sourceId={agent.sourceId} label={agentLabel(agent.sourceId, agent.displayName)} className="agent-scope-order-actions"/>
        <span className={`agent-scope-option-state ${agent.detected ? 'is-detected' : ''}`}>{agent.detected ? t('scope.detected') : t('scope.notDetected')}</span>
      </div>
    }) : <div className="agent-scope-empty">{t('scope.empty')}</div>}
  </div>

  return <div className="agent-scope">
    {resolvedAllLabel && <button className={`scope-chip ${value === '' ? 'scope-chip-active' : ''}`} onClick={() => onChange('')}>{resolvedAllLabel}</button>}
    {shown.map(agent => <button key={agent.sourceId} className={`scope-chip ${value === agent.sourceId ? 'scope-chip-active' : ''}`} onClick={() => onChange(agent.sourceId)}>
      <AgentLogo sourceId={agent.sourceId} size="compact" />
      <span>{agentLabel(agent.sourceId, agent.displayName)}</span>
    </button>)}
    {resolvedAllLabel !== false && <details ref={detailsRef} className="agent-scope-manage" onToggle={event => setMenuOpen(event.currentTarget.open)}>
      <summary ref={summaryRef} className="scope-manage-button" title={t('scope.manageTitle')} aria-label={t('scope.manageAria', { more: moreCount ? t('scope.moreSuffix', { count: moreCount }) : '' })}>
        <span>{t('scope.more')}{moreCount ? ` ${moreCount}` : ''}</span><UiIcon name="chevron-down" size={14}/>
      </summary>
      {menuOpen && typeof document !== 'undefined' ? createPortal(menu, document.body) : null}
    </details>}
  </div>
}
