import { useState, type ReactNode } from 'react'
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
  defaultExpanded = true,
  renderMeta,
  renderDetails,
  onToolClick,
  className = '',
}: TaskToolGroupProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const sequence = model.kindCounts.map(item => item.label).join(' → ')

  return <details
    className={`task-tool-group execution-group agent-lane-node ${model.errorCount ? 'execution-group-error' : ''} ${className}`.trim()}
    data-error-count={model.errorCount}
    open={expanded}
    onToggle={event => setExpanded(event.currentTarget.open)}
  >
    <summary>
      <span className="tool-title">{model.label}</span>
      <span className="node-preview">{sequence}</span>
      <span className="tool-counts"><span>{model.itemCount} 次</span></span>
    </summary>
    <div className="execution-list tool-list">{model.tools.map((tool, index) => <TaskToolRow
      key={tool.id}
      model={tool}
      meta={renderMeta?.(tool)}
      details={renderDetails?.(tool)}
      last={index === model.tools.length - 1}
      onClick={onToolClick ? () => onToolClick(tool) : undefined}
    />)}</div>
  </details>
}
