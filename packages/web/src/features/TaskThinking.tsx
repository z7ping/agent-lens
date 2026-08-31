import type { ReactNode } from 'react'
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
  defaultExpanded = false,
  className = '',
}: TaskThinkingProps) {
  return <details
    className={`task-thinking thinking-block ${className}`.trim()}
    data-task-thinking-state={model.state ?? 'settled'}
    open={defaultExpanded}
  >
    <summary>
      <span className="thinking-label">{model.label}</span>
      {model.preview && <span className="thinking-preview">{model.preview}</span>}
      {meta}
      {model.time && <time>{model.time}</time>}
    </summary>
    <div className="thinking-content">{children}</div>
    {actions && <div className="task-thinking-actions">{actions}</div>}
  </details>
}
