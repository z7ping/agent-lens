import { useState, type ReactNode } from 'react'
import { toolVisualKind, toolVisualLabel } from '../components/ToolKindIcon'
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

function executionSequence(model: TaskToolGroupModel): string {
  const labels: string[] = []
  for (const tool of model.tools) {
    const visualKind = tool.kind === 'tool' ? toolVisualKind(tool.name) : tool.kind
    const label = toolVisualLabel(visualKind)
    if (labels[labels.length - 1] !== label) labels.push(label)
  }
  if (labels.length <= 5) return labels.join(' → ')
  return `${labels.slice(0, 4).join(' → ')} → …`
}

/**
 * 与 alpha.3 高保真原型一致：Tool Group 初始展开，具体 Tool Call 默认直接可见；
 * 用户可以主动折叠整个组。Payload / 长输出仍由单次 Tool Call 自己下钻。
 */
export function TaskToolGroup({
  model,
  defaultExpanded = true,
  renderMeta,
  renderDetails,
  onToolClick,
  className = '',
}: TaskToolGroupProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const sequence = executionSequence(model)

  return <details
    className={`task-tool-group execution-group tool-group agent-lane-node ${model.errorCount ? 'execution-group-error' : ''} ${className}`.trim()}
    data-error-count={model.errorCount}
    data-task-tool-group="true"
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
