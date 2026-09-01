import type { ReactNode } from 'react'

export interface TaskHeaderMetric {
  label: string
  value: ReactNode
  tone?: 'danger' | 'accent' | undefined
}

export interface TaskHeaderProps {
  marker?: ReactNode
  agent: ReactNode
  context?: ReactNode
  status?: ReactNode
  title: ReactNode
  submeta?: ReactNode
  metrics?: TaskHeaderMetric[]
  actions?: ReactNode
  className?: string
}

export function TaskHeader({ marker, agent, context, status, title, submeta, metrics = [], actions, className = '' }: TaskHeaderProps) {
  const resolvedStatus = status ?? '已完成'
  return <header className={`task-header ${className}`.trim()}>
    <div className="task-header-copy">
      <div className="task-header-meta">
        {marker && <span className="task-header-marker">{marker}</span>}
        <b>{agent}</b>
        {context && <span className="task-header-context">{context}</span>}
        <span className="task-header-status" data-tone={status === undefined ? 'success' : ''}>{resolvedStatus}</span>
      </div>
      <h1 className="task-header-title">{title}</h1>
      {submeta && <div className="task-header-submeta">{submeta}</div>}
    </div>
    {(metrics.length > 0 || actions) && <div className="task-header-side">
      {metrics.length > 0 && <div className="task-header-metrics">
        {metrics.map(metric => <div key={metric.label} className="task-header-metric" data-tone={metric.tone ?? ''}>
          <b>{metric.value}</b><span>{metric.label}</span>
        </div>)}
      </div>}
      {actions && <div className="task-header-actions">{actions}</div>}
    </div>}
  </header>
}
