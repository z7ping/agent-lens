import type { ReactNode } from 'react'
import { CopyableCodeBlock } from '../components/CopyableCodeBlock'
import { UiIcon } from '../components/UiIcon'
import { useTaskSurfaceView } from './TaskSurface'
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
  const { showUsageDetails } = useTaskSurfaceView()
  if (model.category === 'usage' && !showUsageDetails) return null

  const content = <>
    <span className="task-event-mark" />
    <span className="task-event-copy"><b>{model.label}</b>{model.summary && <small>{model.summary}</small>}</span>
    {meta}
    {model.sourceLabel && <span className="task-event-source">{model.sourceLabel}</span>}
    {model.time && <time>{model.time}</time>}
  </>
  const rowClass = `task-event-row task-event-${model.category}`
  return <>
    {onInspect
      ? <button className={rowClass} onClick={onInspect}>{content}</button>
      : <div className={rowClass}>{content}</div>}
    {raw !== undefined && !onInspect && <details className="task-event-raw">
      <summary><UiIcon className="task-event-raw-chevron" name="chevron-right" size={14}/><span>查看原始数据{model.nativeType ? ` · ${model.nativeType}` : ''}</span></summary>
      {(model.nativeId || model.parentId) && <div className="task-event-raw-meta">{model.nativeId ? `Native ID ${model.nativeId}` : ''}{model.nativeId && model.parentId ? ' · ' : ''}{model.parentId ? `Parent ${model.parentId}` : ''}</div>}
      <CopyableCodeBlock className="task-event-raw-json" copyValue={JSON.stringify(raw, null, 2)}>{JSON.stringify(raw, null, 2)}</CopyableCodeBlock>
    </details>}
  </>
}
