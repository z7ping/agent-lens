import type { ReactNode } from 'react'
import type { TaskEventModel } from './task-detail-model'

export function TaskEvent({
  model,
  meta,
  onInspect,
  raw,
}: {
  model: TaskEventModel
  meta?: ReactNode
  onInspect?: (() => void) | undefined
  raw?: unknown
}) {
  const content = <>
    <span className="event-mark" />
    <span className="event-copy"><b>{model.label}</b>{model.summary && <small>{model.summary}</small>}</span>
    {meta}
    {model.sourceLabel && <span className="event-source">{model.sourceLabel}</span>}
    {model.time && <time>{model.time}</time>}
  </>
  return <>
    {onInspect
      ? <button className={`event-row event-${model.category}`} onClick={onInspect}>{content}</button>
      : <div className={`event-row event-${model.category}`}>{content}</div>}
    {raw !== undefined && !onInspect && <details className="task-event-raw">
      <summary>查看原始数据{model.nativeType ? ` · ${model.nativeType}` : ''}</summary>
      {(model.nativeId || model.parentId) && <div className="task-event-raw-meta">{model.nativeId ? `Native ID ${model.nativeId}` : ''}{model.nativeId && model.parentId ? ' · ' : ''}{model.parentId ? `Parent ${model.parentId}` : ''}</div>}
      <pre className="raw-json">{JSON.stringify(raw, null, 2)}</pre>
    </details>}
  </>
}
