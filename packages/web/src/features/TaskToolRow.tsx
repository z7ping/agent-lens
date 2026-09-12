import { useEffect, useState, type ReactNode } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { ToolKindIcon, toolVisualKind } from '../components/ToolKindIcon'
import type { TaskToolModel } from './task-detail-model'

export interface TaskToolRowProps {
  model: TaskToolModel
  meta?: ReactNode
  details?: ReactNode
  last?: boolean
  onClick?: (() => void) | undefined
  className?: string
}

function statusLabel(status: TaskToolModel['status'], t: TFunction): string {
  if (status === 'error') return t('tool.status.error')
  if (status === 'success') return t('tool.status.success')
  if (status === 'running') return t('tool.status.running')
  return t('tool.status.unknown')
}

function statusClass(status: TaskToolModel['status']): string {
  if (status === 'error') return 'error'
  if (status === 'success') return 'ok'
  if (status === 'running') return 'run'
  return 'unknown'
}

function durationLabel(ms: number): string {
  const value = Math.max(0, ms)
  if (value < 1000) return `${Math.round(value)}ms`
  if (value < 60_000) {
    const seconds = value / 1000
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`
  }
  const minutes = value / 60_000
  return `${minutes < 10 ? minutes.toFixed(1) : Math.round(minutes)}m`
}

export function TaskToolRow({ model, meta, details, onClick, className = '' }: TaskToolRowProps) {
  const { t } = useTranslation('task')
  const [now, setNow] = useState(() => Date.now())
  const target = model.primary ?? model.secondary ?? '—'
  const visualKind = model.kind === 'tool' ? toolVisualKind(model.name) : model.kind
  const rowClass = `task-tool-row ${model.status === 'error' ? 'task-tool-row-error' : ''} ${className}`.trim()

  useEffect(() => {
    if (model.status !== 'running' || model.startedAtMs === undefined) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [model.startedAtMs, model.status])

  const elapsedLabel = model.durationLabel
    ?? (model.durationMs !== undefined ? durationLabel(model.durationMs) : undefined)
    ?? (model.status === 'running' && model.startedAtMs !== undefined ? durationLabel(now - model.startedAtMs) : undefined)
  const icon = model.kind === 'tool'
    ? <ToolKindIcon kind={visualKind}/>
    : <ToolKindIcon kind={model.kind}/>
  const content = <>
    <span className={`task-tool-kind task-tool-kind-${visualKind}`}>{icon}<span>{t(`tool.kind.${visualKind}`)}</span></span>
    <span className={`task-tool-status task-tool-status-${statusClass(model.status)}`}>{statusLabel(model.status, t)}{elapsedLabel ? ` · ${elapsedLabel}` : ''}</span>
    <b className="task-tool-action" title={model.name}>{model.name}</b>
    <span className="task-tool-target">
      <span className="task-tool-target-text" title={target}>{target}</span>
      {meta && <span className="task-tool-meta">{meta}</span>}
    </span>
  </>

  return <div className={`task-tool-row-shell ${details ? 'has-details' : ''}`.trim()} data-tool-fact="true">
    {onClick
      ? <button className={rowClass} data-status={model.status} data-kind={visualKind} onClick={onClick} aria-label={`${model.name}，${statusLabel(model.status, t)}`}>{content}</button>
      : <div className={rowClass} data-status={model.status} data-kind={visualKind}>{content}</div>}
    {details && <div className="task-tool-payload">{details}</div>}
  </div>
}
