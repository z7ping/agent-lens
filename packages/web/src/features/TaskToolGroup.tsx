import { useMemo, useState, type ReactNode } from 'react'
import type { TaskToolGroupModel, TaskToolModel } from './task-detail-model'
import { TaskToolRow } from './TaskToolRow'

export interface TaskToolGroupProps {
  model: TaskToolGroupModel
  defaultExpanded?: boolean
  renderMeta?: ((tool: TaskToolModel) => ReactNode) | undefined
  renderDetails?: ((tool: TaskToolModel) => ReactNode) | undefined
  onToolClick?: ((tool: TaskToolModel) => void) | undefined
  className?: string
}

export function TaskToolGroup({
  model,
  defaultExpanded,
  renderMeta,
  renderDetails,
  onToolClick,
  className = '',
}: TaskToolGroupProps) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? model.errorCount > 0)
  const [errorsOnly, setErrorsOnly] = useState(false)
  const visible = useMemo(
    () => errorsOnly ? model.tools.filter(tool => tool.status === 'error') : model.tools,
    [errorsOnly, model.tools],
  )

  return <details
    className={`task-tool-group execution-group ${model.errorCount ? 'execution-group-error' : ''} ${className}`.trim()}
    open={expanded}
    onToggle={event => setExpanded(event.currentTarget.open)}
  >
    <summary>
      <span className="execution-group-icon" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v4a3 3 0 0 0 3 3h6"/><path d="m9 7 3 3-3 3"/></svg></span>
      <span className="execution-group-copy"><b>{model.label}</b><small>{model.itemCount} 次调用</small></span>
      <span className="execution-kind-counts">{model.kindCounts.map(item => <span key={item.kind}>{item.label} {item.count}</span>)}</span>
      <span className={`execution-summary-status ${model.errorCount ? 'is-error' : 'is-ok'}`}>{model.errorCount ? `${model.errorCount} 个错误` : '全部完成'}</span>
      {model.totalDurationLabel && <span className="execution-total">{model.totalDurationLabel}</span>}
    </summary>
    <div className="execution-group-toolbar">
      <span>共 {model.itemCount} 次 · {model.errorCount} 次失败</span>
      {model.errorCount > 0 && <label><input type="checkbox" checked={errorsOnly} onChange={event => setErrorsOnly(event.target.checked)}/> 只看错误</label>}
    </div>
    <div className="execution-list">{visible.map((tool, index) => <TaskToolRow
      key={tool.id}
      model={tool}
      meta={renderMeta?.(tool)}
      details={renderDetails?.(tool)}
      last={index === visible.length - 1}
      onClick={onToolClick ? () => onToolClick(tool) : undefined}
    />)}</div>
  </details>
}
