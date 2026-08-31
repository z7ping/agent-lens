import type { ReactNode } from 'react'
import { ToolKindIcon } from '../components/ToolKindIcon'
import type { TaskToolModel } from './task-detail-model'

export interface TaskToolRowProps {
  model: TaskToolModel
  meta?: ReactNode
  details?: ReactNode
  last?: boolean
  onClick?: (() => void) | undefined
  className?: string
}

export function TaskToolRow({ model, meta, details, last = false, onClick, className = '' }: TaskToolRowProps) {
  const content = <>
    <span className="execution-rail" aria-hidden="true"><span className="execution-dot"/>{!last && <span className="execution-line"/>}</span>
    <span className={`execution-tool-icon tool-kind-${model.kind}`}><ToolKindIcon kind={model.kind}/></span>
    <span className="execution-main">
      <span className="execution-name"><b>{model.name}</b><span className="tool-kind-label">{model.kindLabel}</span><span className="tool-status-label">{model.status === 'error' ? '失败' : model.status === 'success' ? '完成' : model.status === 'running' ? '执行中' : '未知'}</span>{meta}</span>
      {model.primary && <span className="execution-preview execution-primary">{model.primary}</span>}
      {model.secondary && <span className={`execution-preview ${model.status === 'error' ? 'execution-preview-error' : ''}`}>{model.secondary}</span>}
      {details}
    </span>
    {model.durationLabel && <span className="execution-duration">{model.durationLabel}</span>}
  </>

  if (onClick) {
    return <button className={`task-tool-row execution-row ${className}`.trim()} data-status={model.status} data-kind={model.kind} onClick={onClick}>{content}</button>
  }
  return <div className={`task-tool-row execution-row ${className}`.trim()} data-status={model.status} data-kind={model.kind}>{content}</div>
}
