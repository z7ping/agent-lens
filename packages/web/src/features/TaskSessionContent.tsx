import type { ReactNode } from 'react'
import { MarkdownContent } from '../components/MarkdownContent'
import { TaskMessage, type TaskMessageProps } from './TaskMessage'
import { TaskThinking } from './TaskThinking'
import { TaskToolRow } from './TaskToolRow'
import { TaskProcessGroup, type TaskProcessGroupProps } from './TaskProcessGroup'
import type { TaskThinkingModel, TaskToolModel } from './task-detail-model'

/**
 * Single renderer for Review and Live session facts.
 * Adapters supply source-specific evidence or streaming state, never their own
 * message/thinking/tool markup or CSS.
 */
export type TaskSessionMode = 'review' | 'live'

export function TaskSessionMessage(props: TaskMessageProps) {
  return <TaskMessage {...props}/>
}

export function TaskSessionProcessText({
  text, streaming = false, role = 'commentary',
}: {
  text: string
  streaming?: boolean
  role?: 'commentary' | 'reasoning'
}) {
  return <div className="task-process-message" data-message-role={role}>
    <div className="markdown-message"><MarkdownContent text={text} streaming={streaming}/></div>
  </div>
}

export function TaskSessionThinking({
  model, streaming = false, meta, actions, nested, expansionStore,
}: {
  model: TaskThinkingModel
  streaming?: boolean
  meta?: ReactNode
  actions?: ReactNode
  nested?: ReactNode
  expansionStore?: Map<string, boolean>
}) {
  // durationMs is only a measured reasoning interval. Do not derive it from
  // the enclosing round or process, or from a lone historic message timestamp.
  const durationMs = model.durationMs !== undefined
    && Number.isFinite(model.durationMs) && model.durationMs > 0
      ? model.durationMs : undefined
  return <TaskThinking
    model={{ ...model, durationMs }}
    defaultExpanded={false}
    className="task-process-thinking-card"
    meta={meta}
    actions={actions}
    expansionStore={expansionStore}
  >
    <div className="markdown-message"><MarkdownContent text={model.text} streaming={streaming}/></div>
    {nested}
  </TaskThinking>
}

export function TaskSessionTool({
  model, meta, onInspect,
}: {
  model: TaskToolModel
  meta?: ReactNode
  onInspect?: () => void
}) {
  // Both modes use a single collapsed row; arguments/results mount on expand.
  return <TaskToolRow model={model} compact meta={meta} onClick={onInspect}/>
}

export function TaskSessionProcess({
  mode, ...props
}: Omit<TaskProcessGroupProps, 'defaultExpanded' | 'autoCollapseOnSettle' | 'className'> & {
  mode: TaskSessionMode
}) {
  // The only mode difference is lifecycle: Live opens while running and
  // settles automatically; Review is read-only and lazy-loads from its adapter.
  return <TaskProcessGroup
    {...props}
    defaultExpanded={mode === 'live' && props.state === 'running'}
    autoCollapseOnSettle={mode === 'live'}
  />
}
