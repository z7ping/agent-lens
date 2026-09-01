import { useEffect, useState, type ReactNode } from 'react'
import { taskDurationLabel, type TaskRoundModel } from './task-detail-model'

export interface TaskRoundProps {
  model: TaskRoundModel
  children: ReactNode
  summaryMeta?: ReactNode
  defaultExpanded?: boolean
  expansionStore?: Map<string, boolean> | undefined
  forceExpanded?: boolean | undefined
  forceRevision?: number | undefined
  className?: string | undefined
}

function DisclosureChevron() {
  return <span className="task-disclosure-chevron task-round-chevron" aria-hidden="true">
    <svg viewBox="0 0 16 16" fill="none"><path d="m6 4 4 4-4 4"/></svg>
  </span>
}

export function TaskRound({
  model,
  children,
  summaryMeta,
  defaultExpanded = true,
  expansionStore,
  forceExpanded = true,
  forceRevision = 0,
  className = '',
}: TaskRoundProps) {
  const [expanded, setExpanded] = useState(() => expansionStore?.get(model.id) ?? defaultExpanded)

  useEffect(() => {
    const stored = expansionStore?.get(model.id)
    if (stored !== undefined) {
      setExpanded(stored)
      return
    }
    setExpanded(defaultExpanded)
    if (defaultExpanded) expansionStore?.set(model.id, true)
  }, [defaultExpanded, expansionStore, model.id])

  useEffect(() => {
    if (forceRevision === 0) return
    setExpanded(forceExpanded)
    expansionStore?.set(model.id, forceExpanded)
  }, [expansionStore, forceExpanded, forceRevision, model.id])

  const onToggle = (open: boolean) => {
    setExpanded(open)
    expansionStore?.set(model.id, open)
  }

  return <details
    className={`task-round interaction-block ${model.errorCount ? 'task-round-has-error' : ''} ${className}`.trim()}
    data-interaction-id={model.id}
    data-task-round-state={model.state}
    open={expanded}
    onToggle={event => onToggle(event.currentTarget.open)}
  >
    <summary className="task-round-summary">
      <DisclosureChevron/>
      <span className="task-round-label">{model.label}</span>
      {model.preview && <span className="task-round-preview">{model.preview}</span>}
      <span className="task-round-meta">
        {model.state === 'running' && <span className="task-round-live">进行中</span>}
        {model.state === 'stopped' && <span>已停止</span>}
        {model.toolCount > 0 && <span>{model.toolCount} 调用</span>}
        {model.errorCount > 0 && <span className="task-round-error">{model.errorCount} 错误</span>}
        {model.highLatency && <span className="task-round-latency">耗时较高</span>}
        {model.durationMs > 0 && <span>{taskDurationLabel(model.durationMs)}</span>}
        {summaryMeta}
      </span>
    </summary>
    <div className="task-round-flow">{children}</div>
  </details>
}
