import { Children, Fragment, isValidElement, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button, Popover, UiIcon } from '../components/ui'
import { useTaskSurfaceView } from './TaskSurface'

export interface TaskHeaderMetric {
  label: string
  value: ReactNode
  tone?: 'danger' | 'accent' | undefined
}

export interface TaskHeaderInfoItem {
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
  infoItems?: TaskHeaderInfoItem[]
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

export function TaskHeader({ marker, agent, context, status, title, submeta, metrics = [], infoItems = [], actions, className = '' }: TaskHeaderProps) {
  const resolvedStatus = status ?? '已完成'
  const resolvedContext = context === '无项目' ? '未关联项目' : context
  const { showUsageDetails, setShowUsageDetails } = useTaskSurfaceView()
  const auditToggle = findAuditToggle(actions)
  const primaryActions = collectPrimaryActions(actions)
  const showAllEvents = auditToggle?.props['aria-pressed'] === true
  const headerRef = useRef<HTMLElement>(null)
  const viewMenuAnchorRef = useRef<HTMLSpanElement>(null)
  const [viewMenuOpen, setViewMenuOpen] = useState(false)
  const [compactInfoOpen, setCompactInfoOpen] = useState(false)
  const [reviewTailHost, setReviewTailHost] = useState<HTMLElement | null>(null)
  const compactInfoAnchorRef = useRef<HTMLSpanElement>(null)
  const hasCompactInfo = Boolean(infoItems.length > 0 || resolvedContext || submeta || metrics.length > 0)

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
  const hasHeaderActions = hasCompactInfo || Boolean(auditToggle) || inlineActions.length > 0
  const tailActions = reviewTailHost && primaryActions.length > 0
    ? createPortal(
        <section className="task-review-continuation" aria-label="继续此会话">
          <div className="task-review-continuation-copy">
            <span>继续原会话，或从当前节点创建新会话。</span>
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
          {hasCompactInfo && <>
            <span ref={compactInfoAnchorRef} className="task-header-compact-info-anchor">
              <Button
                size="small"
                className="task-header-compact-info-trigger"
                aria-haspopup="dialog"
                aria-expanded={compactInfoOpen}
                onClick={() => setCompactInfoOpen(value => !value)}
              >任务信息</Button>
            </span>
            <Popover
              open={compactInfoOpen}
              anchorRef={compactInfoAnchorRef}
              className="task-header-compact-info-popover"
              onClose={() => setCompactInfoOpen(false)}
            >
              <section className="task-header-compact-info-list" aria-label="任务信息">
                <div className="task-header-compact-info-heading">
                  <strong>任务信息</strong>
                  <span>当前任务详情</span>
                </div>
                {infoItems.length > 0
                  ? infoItems.map((item, index) => <div key={`${item.label}-${index}`} data-tone={item.tone ?? ''}><span>{item.label}</span><b>{item.value}</b></div>)
                  : <>
                    {resolvedContext && <div><span>上下文</span><b>{resolvedContext}</b></div>}
                    {submeta && <div><span>工作区</span><b>{submeta}</b></div>}
                    {metrics.map(metric => <div key={metric.label} data-tone={metric.tone ?? ''}><span>{metric.label}</span><b>{metric.value}</b></div>)}
                  </>}
              </section>
            </Popover>
          </>}
          {auditToggle && <>
            <span ref={viewMenuAnchorRef} className="task-view-menu-anchor">
              <Button
                size="small"
                className="task-view-menu-trigger"
                aria-label="视图选项"
                aria-haspopup="menu"
                aria-expanded={viewMenuOpen}
                onClick={() => setViewMenuOpen(value => !value)}
              >视图 <UiIcon name="chevron-down" size={14}/></Button>
            </span>
            <Popover
              open={viewMenuOpen}
              anchorRef={viewMenuAnchorRef}
              className="task-view-menu-popover"
              onClose={() => setViewMenuOpen(false)}
            >
              <div className="task-view-menu-list" role="menu" aria-label="视图选项">
                <button type="button" role="menuitemcheckbox" aria-checked={showAllEvents} onClick={() => auditToggle.props.onClick?.()}><span>全部事件</span><b>{showAllEvents && <UiIcon name="check" size={14}/>}</b></button>
                <button type="button" role="menuitemcheckbox" aria-checked={showUsageDetails} onClick={() => setShowUsageDetails(!showUsageDetails)}><span>用量详情</span><b>{showUsageDetails && <UiIcon name="check" size={14}/>}</b></button>
              </div>
            </Popover>
          </>}
          {inlineActions}
        </div>}
      </div>}
    </header>
    {tailActions}
  </>
}
