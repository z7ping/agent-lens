import { Children, Fragment, isValidElement, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Button, Drawer, Popover, UiIcon } from '../components/ui'
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
  showStatus?: boolean
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

function readonlySessionDocument(header: HTMLElement | null): HTMLElement | null {
  const surface = header?.closest<HTMLElement>('.task-session-view[data-task-session-interactive="false"]')
  if (!surface) return null
  const reader = Array.from(surface.children).find(child => child instanceof HTMLElement && child.classList.contains('task-session-reader'))
  if (!(reader instanceof HTMLElement)) return null
  const documentRoot = Array.from(reader.children).find(child => child instanceof HTMLElement && child.classList.contains('task-session-document'))
  return documentRoot instanceof HTMLElement ? documentRoot : null
}

export function TaskHeader({ marker, agent, context, status, showStatus = true, title, submeta, metrics = [], infoItems = [], actions, className = '' }: TaskHeaderProps) {
  const { t } = useTranslation('task')
  const resolvedStatus = status ?? t('header.completed')
  const resolvedContext = context === t('header.noProject') ? t('header.unlinkedProject') : context
  const { showUsageDetails, setShowUsageDetails } = useTaskSurfaceView()
  const auditToggle = findAuditToggle(actions)
  const primaryActions = collectPrimaryActions(actions)
  const showAllEvents = auditToggle?.props['aria-pressed'] === true
  const headerRef = useRef<HTMLElement>(null)
  const viewMenuAnchorRef = useRef<HTMLSpanElement>(null)
  const [viewMenuOpen, setViewMenuOpen] = useState(false)
  const [compactInfoOpen, setCompactInfoOpen] = useState(false)
  const [sessionTailHost, setSessionTailHost] = useState<HTMLElement | null>(null)
  const hasCompactInfo = Boolean(infoItems.length > 0 || resolvedContext || submeta || metrics.length > 0)

  useLayoutEffect(() => {
    const documentRoot = readonlySessionDocument(headerRef.current)
    if (!documentRoot || primaryActions.length === 0) {
      if (sessionTailHost) {
        sessionTailHost.remove()
        setSessionTailHost(null)
      }
      return
    }

    if (sessionTailHost?.parentElement === documentRoot) return
    sessionTailHost?.remove()
    const host = document.createElement('div')
    host.className = 'task-session-tail-actions-host'
    host.dataset.taskSessionContinuationHost = 'true'
    documentRoot.append(host)
    setSessionTailHost(host)
  })

  useLayoutEffect(() => () => {
    sessionTailHost?.remove()
  }, [sessionTailHost])

  const inlineActions = sessionTailHost ? [] : primaryActions
  const hasHeaderActions = hasCompactInfo || Boolean(auditToggle) || inlineActions.length > 0
  const tailActions = sessionTailHost && primaryActions.length > 0
    ? createPortal(
        <section className="task-session-continuation" aria-label={t('header.continueSession')}>
          <div className="task-session-continuation-copy">
            <span>{t('header.continueDescription')}</span>
          </div>
          <div className="task-session-continuation-actions">{primaryActions}</div>
        </section>,
        sessionTailHost,
      )
    : null

  return <>
    <header ref={headerRef} className={`task-header ${className}`.trim()}>
      <div className="task-header-copy">
        <div className="task-header-meta">
          {marker && <span className="task-header-marker">{marker}</span>}
          <b>{agent}</b>
          {resolvedContext && <span className="task-header-context">{resolvedContext}</span>}
          {showStatus && <span className="task-header-status" data-tone={status === undefined ? 'success' : ''}>{resolvedStatus}</span>}
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
          {hasCompactInfo && <Button
            size="small"
            className="task-header-compact-info-trigger"
            aria-haspopup="dialog"
            aria-expanded={compactInfoOpen}
            onClick={() => setCompactInfoOpen(true)}
          >{t('header.taskInfo')}</Button>}
          {auditToggle && <>
            <span ref={viewMenuAnchorRef} className="task-view-menu-anchor">
              <Button
                size="small"
                className="task-view-menu-trigger"
                aria-label={t('header.viewOptions')}
                aria-haspopup="menu"
                aria-expanded={viewMenuOpen}
                onClick={() => setViewMenuOpen(value => !value)}
              >{t('header.view')} <UiIcon name="chevron-down" size={14}/></Button>
            </span>
            <Popover
              open={viewMenuOpen}
              anchorRef={viewMenuAnchorRef}
              className="task-view-menu-popover"
              onClose={() => setViewMenuOpen(false)}
            >
              <div className="task-view-menu-list" role="menu" aria-label={t('header.viewOptions')}>
                <button type="button" role="menuitemcheckbox" aria-checked={showAllEvents} onClick={() => auditToggle.props.onClick?.()}><span>{t('header.allEvents')}</span><b>{showAllEvents && <UiIcon name="check" size={14}/>}</b></button>
                <button type="button" role="menuitemcheckbox" aria-checked={showUsageDetails} onClick={() => setShowUsageDetails(!showUsageDetails)}><span>{t('header.usageDetails')}</span><b>{showUsageDetails && <UiIcon name="check" size={14}/>}</b></button>
              </div>
            </Popover>
          </>}
          {inlineActions}
        </div>}
      </div>}
    </header>
    {tailActions}
    <Drawer
      open={compactInfoOpen}
      className="task-header-info-drawer"
      title={t('header.taskInfo')}
      description={t('header.currentDetails')}
      onClose={() => setCompactInfoOpen(false)}
    >
      <section className="task-header-compact-info-list" aria-label={t('header.taskInfo')}>
        {infoItems.length > 0
          ? infoItems.map((item, index) => <div key={`${item.label}-${index}`} data-tone={item.tone ?? ''}><span>{item.label}</span><b>{item.value}</b></div>)
          : <>
            {resolvedContext && <div><span>{t('header.context')}</span><b>{resolvedContext}</b></div>}
            {submeta && <div><span>{t('header.workspace')}</span><b>{submeta}</b></div>}
            {metrics.map(metric => <div key={metric.label} data-tone={metric.tone ?? ''}><span>{metric.label}</span><b>{metric.value}</b></div>)}
          </>}
      </section>
    </Drawer>
  </>
}
