import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AgentFacetDto } from '@agent-lens/protocol'
import { usePinnedAgents } from '../App'

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
  return 'source-unknown'
}

interface ScopeMenuPosition {
  left: number
  top: number
  maxHeight: number
}

export function AgentScope({ agents, value, onChange, allLabel = '全部智能体' }: { agents: AgentFacetDto[]; value: string; onChange(value: string): void; allLabel?: string | false }) {
  const { pinned, toggle } = usePinnedAgents()
  const shown = pinned.map(id => agents.find(agent => agent.sourceId === id)).filter((agent): agent is AgentFacetDto => Boolean(agent))
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
    const menuWidth = Math.min(258, Math.max(180, window.innerWidth - viewportPadding * 2))
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
  }, [menuOpen, agents.length, pinned.join('\u0000')])

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
    <div className="agent-scope-menu-title">快捷智能体</div>
    {agents.length ? agents.map(agent => <label key={agent.sourceId} className="agent-scope-option">
      <input type="checkbox" checked={pinned.includes(agent.sourceId)} onChange={() => toggle(agent.sourceId)} />
      <span className={`source-dot ${sourceDot(agent.sourceId)}`} />
      <span className="agent-scope-option-name">{agentLabel(agent.sourceId, agent.displayName)}</span>
      <span className={`agent-scope-option-state ${agent.detected ? 'is-detected' : ''}`}>{agent.detected ? '已检测' : '未检测'}</span>
    </label>) : <div className="agent-scope-empty">暂未发现智能体</div>}
  </div>

  return <div className="agent-scope">
    {allLabel && <button className={`scope-chip ${value === '' ? 'scope-chip-active' : ''}`} onClick={() => onChange('')}>{allLabel}</button>}
    {shown.map(agent => <button key={agent.sourceId} className={`scope-chip ${value === agent.sourceId ? 'scope-chip-active' : ''}`} onClick={() => onChange(agent.sourceId)}>
      <span className={`source-dot ${sourceDot(agent.sourceId)}`} />
      <span>{agentLabel(agent.sourceId, agent.displayName)}</span>
    </button>)}
    <details ref={detailsRef} className="agent-scope-manage" onToggle={event => setMenuOpen(event.currentTarget.open)}>
      <summary ref={summaryRef} className="scope-manage-button" title="管理智能体快捷入口" aria-label="管理智能体快捷入口">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M8 3v10M3 8h10" />
        </svg>
      </summary>
      {menuOpen && typeof document !== 'undefined' ? createPortal(menu, document.body) : null}
    </details>
  </div>
}
