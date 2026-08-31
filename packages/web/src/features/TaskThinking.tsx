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
      <span className="thinking-label thinking-title">{model.label}</span>
      {model.preview && <span className="thinking-preview node-preview">{model.preview}</span>}
      <span className="thinking-summary-meta">{meta}{model.time && <time>{model.time}</time>}</span>
    </summary>
    <div className="thinking-content thinking-body">{children}</div>
    {actions && <div className="task-thinking-actions">{actions}</div>}
  </details>
}
