import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { useTaskSurfaceView } from './TaskSurface'
import { UiIcon } from '../components/UiIcon'

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

interface AuditToggleProps {
  className?: string
  'aria-pressed'?: boolean
  onClick?: () => void
  children?: ReactNode
}

function findAuditToggle(node: ReactNode): ReactElement<AuditToggleProps> | null {
  let match: ReactElement<AuditToggleProps> | null = null
  Children.forEach(node, child => {
    if (match || !isValidElement<AuditToggleProps>(child)) return
    const className = child.props.className
    if (typeof className === 'string' && className.split(/\s+/).includes('review-audit-toggle')) {
      match = child
      return
    }
    if (child.props.children) match = findAuditToggle(child.props.children)
  })
  return match
}

export function TaskHeader({ marker, agent, context, status, title, submeta, metrics = [], actions, className = '' }: TaskHeaderProps) {
  const resolvedStatus = status ?? '已完成'
  const { showUsageDetails, setShowUsageDetails } = useTaskSurfaceView()
  const auditToggle = findAuditToggle(actions)
  const showAllEvents = auditToggle?.props['aria-pressed'] === true

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
      {actions && <div className="task-header-actions">
        {auditToggle && <details className="task-view-menu">
          <summary aria-label="视图选项">视图 <UiIcon name="chevron-down" size={12}/></summary>
          <div className="task-view-menu-popover">
            <button type="button" aria-pressed={showAllEvents} onClick={() => auditToggle.props.onClick?.()}><span>全部事件</span><b>{showAllEvents && <UiIcon name="check" size={12}/>}</b></button>
            <button type="button" aria-pressed={showUsageDetails} onClick={() => setShowUsageDetails(!showUsageDetails)}><span>用量详情</span><b>{showUsageDetails && <UiIcon name="check" size={12}/>}</b></button>
          </div>
        </details>}
        {actions}
      </div>}
    </div>}
  </header>
}
