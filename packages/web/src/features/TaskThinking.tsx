import { useState, type ReactNode } from 'react'
import type { TaskThinkingModel } from './task-detail-model'

export interface TaskThinkingProps {
  model: TaskThinkingModel
  meta?: ReactNode
  actions?: ReactNode
  children: ReactNode
  defaultExpanded?: boolean
  className?: string
}

function DisclosureChevron({ expanded }: { expanded: boolean }) {
  return <span
    className="disclosure-chevron thinking-chevron"
    aria-hidden="true"
    style={{
      display: 'inline-flex',
      width: 14,
      height: 14,
      flex: '0 0 14px',
      alignItems: 'center',
      justifyContent: 'center',
      transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
      transition: 'transform .14s ease',
    }}
  >
    <svg viewBox="0 0 16 16" fill="none" width="14" height="14">
      <path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  </span>
}

export function TaskThinking({
  model,
  meta,
  actions,
  children,
  defaultExpanded = true,
  className = '',
}: TaskThinkingProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  return <details
    className={`task-thinking thinking-block thinking-node agent-lane-node ${className}`.trim()}
    data-task-thinking-state={model.state ?? 'settled'}
    open={expanded}
    onToggle={event => setExpanded(event.currentTarget.open)}
  >
    <summary>
      <span
        className="thinking-summary-main"
        style={{ display: 'flex', minWidth: 0, alignItems: 'center', gap: 7 }}
      >
        <DisclosureChevron expanded={expanded}/>
        <span className="thinking-label thinking-title" style={{ flex: '0 0 auto' }}>{model.label}</span>
        {model.preview && !expanded && <span
          className="thinking-preview node-preview"
          style={{ minWidth: 0, flex: '1 1 auto' }}
        >{model.preview}</span>}
      </span>
      <span className="thinking-summary-meta">{meta}{model.time && <time>{model.time}</time>}</span>
    </summary>
    <div
      className="thinking-content thinking-body"
      style={{ paddingLeft: 30 }}
    >{children}</div>
    {actions && <div className="task-thinking-actions" style={{ paddingLeft: 30 }}>{actions}</div>}
  </details>
}
