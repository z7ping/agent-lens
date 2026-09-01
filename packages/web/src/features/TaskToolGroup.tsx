import type { ReactNode } from 'react'
import type { TaskToolGroupModel, TaskToolModel } from './task-detail-model'
import { TaskToolRow } from './TaskToolRow'

export interface TaskToolGroupProps {
  model: TaskToolGroupModel
  /**
   * 保留旧调用签名用于渐进迁移。高保真原型不再给 Tool Group 单独的折叠层；
   * 若该组真实位于 Thinking 内，会自然跟随 Thinking 一起折叠。
   */
  defaultExpanded?: boolean
  renderMeta?: ((tool: TaskToolModel) => ReactNode) | undefined
  renderDetails?: ((tool: TaskToolModel) => ReactNode) | undefined
  onToolClick?: ((tool: TaskToolModel) => void) | undefined
  className?: string
}

export function TaskToolGroup({
  model,
  renderMeta,
  renderDetails,
  onToolClick,
  className = '',
}: TaskToolGroupProps) {
  return <div
    className={`task-tool-group ${model.errorCount ? 'task-tool-group-error' : ''} ${className}`.trim()}
    data-error-count={model.errorCount}
    data-task-tool-group="true"
    aria-label={`${model.itemCount} 次工具调用`}
  >
    <div className="task-tool-list">{model.tools.map((tool, index) => <TaskToolRow
      key={tool.id}
      model={tool}
      meta={renderMeta?.(tool)}
      details={renderDetails?.(tool)}
      last={index === model.tools.length - 1}
      onClick={onToolClick ? () => onToolClick(tool) : undefined}
    />)}</div>
  </div>
}
