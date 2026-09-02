import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { createPortal } from 'react-dom'
import type { AgentFacetDto } from '@agent-lens/protocol'
import { usePinnedAgents } from '../App'
import { UiIcon } from './UiIcon'

export function agentLabel(sourceId: string, fallback?: string): string {
  if (sourceId === 'claude-code') return 'Claude Code'
  if (sourceId === 'codex') return 'Codex'
  if (sourceId === 'pi') return 'Pi'
  if (sourceId === 'hermes') return 'Hermes'
  if (sourceId === 'opencode') return 'OpenCode'
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

export function AgentIcon({ sourceId }: { sourceId: string }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  return <span className={`agent-icon ${sourceDot(sourceId)}`} aria-hidden="true"><svg viewBox="0 0 18 18" focusable="false">
    {sourceId === 'codex' && <><path {...common} d="M9 2.2 11 6l4.2 1.1L12 9.5l.5 4.3L9 11.8l-3.5 2 .5-4.3-3.2-2.4L7 6z"/><circle {...common} cx="9" cy="8.5" r="1.2"/></>}
    {sourceId === 'claude-code' && <><path {...common} d="M9 2.3 14.2 5v6L9 13.7 3.8 11V5z"/><path {...common} d="M6.2 6.2h5.6M6.2 8.6h3.7"/></>}
    {sourceId === 'pi' && <><path {...common} d="M4 4.5v7M14 4.5v7M4 5.2c1.5-1.2 3.1-1.2 5 0v6.3M14 5.2c-1.5-1.2-3.1-1.2-5 0"/></>}
    {sourceId === 'hermes' && <><path {...common} d="M3 12.8c2.3-3.8 4.1-5.7 6-7.6 1.9 1.9 3.7 3.8 6 7.6"/><path {...common} d="M5.2 10.3 9 12.8l3.8-2.5"/></>}
    {sourceId === 'opencode' && <><path {...common} d="m7 4-4 5 4 5M11 4l4 5-4 5M10 3.5 8 14.5"/></>}
    {sourceId === 'dsh' && <><path {...common} d="m9 2.5 6 6.5-6 6.5L3 9z"/><path {...common} d="M7 9h4M9 7v4"/></>}
    {!['codex', 'claude-code', 'pi', 'hermes', 'opencode', 'dsh'].includes(sourceId) && <><circle {...common} cx="9" cy="9" r="5.5"/><path {...common} d="M6.5 9h5M9 6.5v5"/></>}
  </svg></span>
}

interface ScopeMenuPosition {
  left: number
  top: number
  maxHeight: number
}

export function AgentScope({ agents, value, onChange, allLabel = '全部智能体' }: { agents: AgentFacetDto[]; value: string; onChange(value: string): void; allLabel?: string | false }) {
  const { ordered, pinned, toggle, move, moveBy, reset } = usePinnedAgents()
  const orderedAgents = useMemo(() => {
    const byId = new Map(agents.map(agent => [agent.sourceId, agent]))
    return [...ordered.map(id => byId.get(id)).filter((agent): agent is AgentFacetDto => Boolean(agent)), ...agents.filter(agent => !ordered.includes(agent.sourceId))]
  }, [agents, ordered])
  const visible = orderedAgents.filter(agent => pinned.includes(agent.sourceId))
  const shown = allLabel === false ? orderedAgents : (() => {
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
  const [draggedId, setDraggedId] = useState('')

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
    <div className="agent-scope-menu-head"><div><b>智能体筛选</b><span>拖动或使用箭头调整顺序</span></div><button type="button" onClick={reset}>恢复默认</button></div>
    {orderedAgents.length ? orderedAgents.map((agent, index) => <div
      key={agent.sourceId}
      className={`agent-scope-option ${draggedId === agent.sourceId ? 'is-dragging' : ''}`}
      draggable
      onDragStart={(event: DragEvent<HTMLDivElement>) => { setDraggedId(agent.sourceId); event.dataTransfer.effectAllowed = 'move' }}
      onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }}
      onDrop={event => { event.preventDefault(); if (draggedId) move(draggedId, agent.sourceId); setDraggedId('') }}
      onDragEnd={() => setDraggedId('')}
    >
      <UiIcon name="drag" size={15} className="agent-scope-drag" />
      <input type="checkbox" aria-label={`${agentLabel(agent.sourceId, agent.displayName)}显示在工具栏`} checked={pinned.includes(agent.sourceId)} onChange={() => toggle(agent.sourceId)} />
      <AgentIcon sourceId={agent.sourceId} />
      <span className="agent-scope-option-name">{agentLabel(agent.sourceId, agent.displayName)}</span>
      <span className="agent-scope-order-actions">
        <button type="button" disabled={index === 0} onClick={() => moveBy(agent.sourceId, -1)} aria-label={`${agentLabel(agent.sourceId, agent.displayName)}上移`}><UiIcon name="sort-up" size={14}/></button>
        <button type="button" disabled={index === orderedAgents.length - 1} onClick={() => moveBy(agent.sourceId, 1)} aria-label={`${agentLabel(agent.sourceId, agent.displayName)}下移`}><UiIcon name="sort-down" size={14}/></button>
      </span>
      <span className={`agent-scope-option-state ${agent.detected ? 'is-detected' : ''}`}>{agent.detected ? '已检测' : '未检测'}</span>
    </div>) : <div className="agent-scope-empty">暂未发现智能体</div>}
  </div>

  return <div className="agent-scope">
    {allLabel && <button className={`scope-chip ${value === '' ? 'scope-chip-active' : ''}`} onClick={() => onChange('')}>{allLabel}</button>}
    {shown.map(agent => <button key={agent.sourceId} className={`scope-chip ${value === agent.sourceId ? 'scope-chip-active' : ''}`} onClick={() => onChange(agent.sourceId)}>
      <AgentIcon sourceId={agent.sourceId} />
      <span>{agentLabel(agent.sourceId, agent.displayName)}</span>
    </button>)}
    {allLabel !== false && <details ref={detailsRef} className="agent-scope-manage" onToggle={event => setMenuOpen(event.currentTarget.open)}>
      <summary ref={summaryRef} className="scope-manage-button" title="查看更多并管理智能体" aria-label={`查看更多并管理智能体${moreCount ? `，另有 ${moreCount} 个` : ''}`}>
        <span>更多{moreCount ? ` ${moreCount}` : ''}</span><UiIcon name="chevron-down" size={14}/>
      </summary>
      {menuOpen && typeof document !== 'undefined' ? createPortal(menu, document.body) : null}
    </details>}
  </div>
}
