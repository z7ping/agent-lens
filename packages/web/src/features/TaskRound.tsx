import { useEffect, useState, type ReactNode } from 'react'
import { taskDurationLabel, type TaskRoundModel } from './task-detail-model'

export interface TaskRoundProps {
  model: TaskRoundModel
  children: ReactNode
  defaultExpanded?: boolean
  expansionStore?: Map<string, boolean> | undefined
  forceExpanded?: boolean | undefined
  forceRevision?: number | undefined
  className?: string | undefined
}

export function TaskRound({
  model,
  children,
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
    className={`task-round interaction-block ${model.errorCount ? 'interaction-has-error' : ''} ${className}`.trim()}
    data-interaction-id={model.id}
    data-task-round-state={model.state}
    open={expanded}
    onToggle={event => onToggle(event.currentTarget.open)}
  >
    <summary className="interaction-summary task-round-summary">
      <span className="interaction-chevron">›</span>
      <span className="interaction-title">{model.label}</span>
      {model.preview && <span className="interaction-preview">{model.preview}</span>}
      <span className="interaction-summary-meta">
        {model.state === 'running' && <span className="is-live">进行中</span>}
        {model.state === 'stopped' && <span>已停止</span>}
        {model.toolCount > 0 && <span>{model.toolCount} 工具</span>}
        {model.errorCount > 0 && <span className="is-error">{model.errorCount} 错误</span>}
        {model.highLatency && <span className="is-latency">耗时较高</span>}
        {model.durationMs > 0 && <span>{taskDurationLabel(model.durationMs)}</span>}
      </span>
    </summary>
    <div className="interaction-flow task-round-flow">{children}</div>
  </details>
}
