import type { ReactNode } from 'react'
import { ToolKindIcon, toolVisualKind, toolVisualLabel } from '../components/ToolKindIcon'
import type { TaskToolModel } from './task-detail-model'

export interface TaskToolRowProps {
  model: TaskToolModel
  meta?: ReactNode
  details?: ReactNode
  last?: boolean
  onClick?: (() => void) | undefined
  className?: string
}

function statusLabel(status: TaskToolModel['status']): string {
  if (status === 'error') return '失败'
  if (status === 'success') return '完成'
  if (status === 'running') return '执行中'
  return '未知'
}

function statusClass(status: TaskToolModel['status']): string {
  if (status === 'error') return 'error'
  if (status === 'success') return 'ok'
  if (status === 'running') return 'run'
  return ''
}

export function TaskToolRow({ model, meta, details, onClick, className = '' }: TaskToolRowProps) {
  const target = model.primary ?? model.secondary ?? ''
  const visualKind = model.kind === 'tool' ? toolVisualKind(model.name) : model.kind
  const rowClass = `task-tool-row execution-row tool-row ${model.status === 'error' ? 'error' : ''} ${className}`.trim()
  const content = <>
    <span className={`tool-kind tool-kind-${visualKind}`}><ToolKindIcon kind={visualKind}/><span>{toolVisualLabel(visualKind)}</span></span>
    <b className="tool-action">{model.name}</b>
    <span className="tool-target">
      <span className="tool-target-text" title={target}>{target}</span>
      {meta && <span className="tool-meta">{meta}</span>}
    </span>
    <span className={`tool-status ${statusClass(model.status)}`.trim()}>{statusLabel(model.status)}{model.durationLabel ? ` · ${model.durationLabel}` : ''}</span>
  </>

  return <div className={`task-tool-row-shell ${details ? 'has-details' : ''}`.trim()}>
    {onClick
      ? <button className={rowClass} data-status={model.status} data-kind={visualKind} onClick={onClick}>{content}</button>
      : <div className={rowClass} data-status={model.status} data-kind={visualKind}>{content}</div>}
    {details && <div className="tool-payload">{details}</div>}
  </div>
}
