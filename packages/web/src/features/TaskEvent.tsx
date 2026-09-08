import { useState, type ReactNode } from 'react'
import { CopyableCodeBlock } from '../components/CopyableCodeBlock'
import { Drawer } from '../components/ui'
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
  const [rawDrawerOpen, setRawDrawerOpen] = useState(false)
  if (model.category === 'usage' && !showUsageDetails) return null

  const content = <>
    <span className="task-event-mark"><UiIcon name="clock" size={14}/></span>
    <span className="task-event-copy"><b>{model.label}</b>{model.summary && <small>{model.summary}</small>}</span>
    {meta}
    {model.sourceLabel && <span className="task-event-source">{model.sourceLabel}</span>}
    {model.time && <time>{model.time}</time>}
  </>
  const rowClass = `task-event-row task-event-${model.category}`
  const openInspector = onInspect ?? (raw !== undefined ? () => setRawDrawerOpen(true) : undefined)
  return <>
    {openInspector
      ? <button type="button" className={rowClass} onClick={openInspector}>{content}</button>
      : <div className={rowClass}>{content}</div>}
    {raw !== undefined && !onInspect && rawDrawerOpen && <Drawer
        open
        className="task-event-raw-drawer"
        title={`${model.label} · 原始数据`}
        description={model.nativeType ? `Pi 原生事件 · ${model.nativeType}` : '原始事件数据'}
        onClose={() => setRawDrawerOpen(false)}
      >
        <div className="task-event-raw-drawer-body">
          {(model.nativeId || model.parentId) && <div className="task-event-raw-drawer-meta">{model.nativeId ? `Native ID ${model.nativeId}` : ''}{model.nativeId && model.parentId ? ' · ' : ''}{model.parentId ? `Parent ${model.parentId}` : ''}</div>}
          <CopyableCodeBlock className="task-event-raw-drawer-json" copyValue={JSON.stringify(raw, null, 2)}>{JSON.stringify(raw, null, 2)}</CopyableCodeBlock>
        </div>
      </Drawer>}
  </>
}
