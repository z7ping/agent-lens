import { Children, Fragment, isValidElement, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
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

function isAuditToggle(node: ReactElement<AuditToggleProps>): boolean {
  const className = node.props.className
  return typeof className === 'string' && className.split(/\s+/).includes('review-audit-toggle')
}

function findAuditToggle(node: ReactNode): ReactElement<AuditToggleProps> | null {
  let match: ReactElement<AuditToggleProps> | null = null
  Children.forEach(node, child => {
    if (match || !isValidElement<AuditToggleProps>(child)) return
    if (isAuditToggle(child)) {
      match = child
      return
    }
    if (child.type === Fragment && child.props.children) match = findAuditToggle(child.props.children)
  })
  return match
}

function collectPrimaryActions(node: ReactNode, result: ReactNode[] = []): ReactNode[] {
  Children.forEach(node, child => {
    if (child === null || child === undefined || typeof child === 'boolean') return
    if (!isValidElement<AuditToggleProps>(child)) {
      result.push(child)
      return
    }
    if (isAuditToggle(child)) return
    if (child.type === Fragment) {
      collectPrimaryActions(child.props.children, result)
      return
    }
    result.push(child)
  })
  return result
}

export function TaskHeader({ marker, agent, context, status, title, submeta, metrics = [], actions, className = '' }: TaskHeaderProps) {
  const resolvedStatus = status ?? '已完成'
  const resolvedContext = context === '无项目' ? '未关联项目' : context
  const { showUsageDetails, setShowUsageDetails } = useTaskSurfaceView()
  const auditToggle = findAuditToggle(actions)
  const primaryActions = collectPrimaryActions(actions)
  const showAllEvents = auditToggle?.props['aria-pressed'] === true
  const headerRef = useRef<HTMLElement>(null)
  const [reviewTailHost, setReviewTailHost] = useState<HTMLElement | null>(null)

  useLayoutEffect(() => {
    const header = headerRef.current
    const reader = header?.closest<HTMLElement>('.review-reader')
    if (!reader || primaryActions.length === 0) {
      setReviewTailHost(null)
      return
    }

    const host = document.createElement('div')
    host.className = 'task-review-tail-actions-host'
    reader.append(host)
    setReviewTailHost(host)
    return () => {
      host.remove()
    }
  }, [primaryActions.length])

  const inlineActions = reviewTailHost ? [] : primaryActions
  const hasHeaderActions = Boolean(auditToggle) || inlineActions.length > 0
  const tailActions = reviewTailHost && primaryActions.length > 0
    ? createPortal(
        <section className="task-review-continuation" aria-label="继续此会话">
          <div className="task-review-continuation-copy">
            <b>继续此会话</b>
            <span>继续原会话，或保留当前历史并从这里分叉。</span>
          </div>
          <div className="task-review-continuation-actions">{primaryActions}</div>
        </section>,
        reviewTailHost,
      )
    : null

  return <>
    <header ref={headerRef} className={`task-header ${className}`.trim()}>
      <div className="task-header-copy">
        <div className="task-header-meta">
          {marker && <span className="task-header-marker">{marker}</span>}
          <b>{agent}</b>
          {resolvedContext && <span className="task-header-context">{resolvedContext}</span>}
          <span className="task-header-status" data-tone={status === undefined ? 'success' : ''}>{resolvedStatus}</span>
        </div>
        <h1 className="task-header-title">{title}</h1>
        {submeta && <div className="task-header-submeta">{submeta}</div>}
      </div>
      {(metrics.length > 0 || hasHeaderActions) && <div className="task-header-side">
        {metrics.length > 0 && <div className="task-header-metrics">
          {metrics.map(metric => <div key={metric.label} className="task-header-metric" data-tone={metric.tone ?? ''}>
            <b>{metric.value}</b><span>{metric.label}</span>
          </div>)}
        </div>}
        {hasHeaderActions && <div className="task-header-actions">
          {auditToggle && <details className="task-view-menu">
            <summary aria-label="视图选项">视图 <UiIcon name="chevron-down" size={12}/></summary>
            <div className="task-view-menu-popover">
              <button type="button" aria-pressed={showAllEvents} onClick={() => auditToggle.props.onClick?.()}><span>全部事件</span><b>{showAllEvents && <UiIcon name="check" size={12}/>}</b></button>
              <button type="button" aria-pressed={showUsageDetails} onClick={() => setShowUsageDetails(!showUsageDetails)}><span>用量详情</span><b>{showUsageDetails && <UiIcon name="check" size={12}/>}</b></button>
            </div>
          </details>}
          {inlineActions}
        </div>}
      </div>}
    </header>
    {tailActions}
  </>
}
