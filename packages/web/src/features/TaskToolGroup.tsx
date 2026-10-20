import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, UiIcon } from '../components/ui'
import type { TaskToolGroupModel, TaskToolModel } from './task-detail-model'
import { TaskToolRow } from './TaskToolRow'

export const TASK_TOOL_PREVIEW_LIMIT = 3

/** Share the same progressive visibility rule across Live and Review. */
export function visibleTaskToolIds(tools: readonly TaskToolModel[], expanded: boolean): Set<string> {
  return new Set(tools.filter((tool, index) =>
    expanded || index < TASK_TOOL_PREVIEW_LIMIT || tool.status === 'running' || tool.status === 'error',
  ).map(tool => tool.id))
}

/** Preserve interleaved thinking, commentary and events while collapsing tools across the whole round. */
export type TaskToolGroupSequenceEntry =
  | { type: 'tool'; key: string; tool: TaskToolModel; meta?: ReactNode; details?: ReactNode; onToolClick?: () => void }
  | { type: 'content'; key: string; content: ReactNode }

export interface TaskToolGroupProps {
  sequence?: readonly TaskToolGroupSequenceEntry[]
  model: TaskToolGroupModel
  defaultExpanded?: boolean
  /** Defer expensive payload rendering until a tool row is opened. */
  compact?: boolean
  renderMeta?: ((tool: TaskToolModel) => ReactNode) | undefined
  renderDetails?: ((tool: TaskToolModel) => ReactNode) | undefined
  onToolClick?: ((tool: TaskToolModel) => void) | undefined
  className?: string
}

export function TaskToolGroup({
  model,
  sequence,
  defaultExpanded = false,
  compact = false,
  renderMeta,
  renderDetails,
  onToolClick,
  className = '',
}: TaskToolGroupProps) {
  const { t } = useTranslation('task')
  const [expanded, setExpanded] = useState(defaultExpanded)
  useEffect(() => setExpanded(defaultExpanded), [defaultExpanded, model.id])

  const tools = sequence ? sequence.flatMap(entry => entry.type === 'tool' ? [entry.tool] : []) : model.tools
  const collapsible = tools.some((tool, index) =>
    index >= TASK_TOOL_PREVIEW_LIMIT && tool.status !== 'running' && tool.status !== 'error')
  const visibleIds = visibleTaskToolIds(tools, expanded)
  const hiddenCount = tools.length - visibleIds.size
  const running = tools.filter(tool => tool.status === 'running').length
  const failed = tools.filter(tool => tool.status === 'error').length

  return <div
    className={`task-tool-group ${failed ? 'task-tool-group-error' : ''} ${className}`.trim()}
    data-error-count={failed}
    data-task-tool-group="true"
    data-collapsible={collapsible || undefined}
    data-interleaved={sequence ? 'true' : undefined}
    aria-label={t('tool.calls', { count: tools.length })}
  >
    {collapsible && <Button
      size="small"
      className="task-tool-group-toggle"
      aria-expanded={expanded}
      onClick={() => setExpanded(value => !value)}
    >
      <UiIcon name="tool-shell" size={14}/>
      <span className="task-tool-group-title">{t('live.toolGroup')} · {t('live.toolGroupCount', { count: tools.length })}</span>
      {running > 0 && <span className="task-tool-group-running">{t('live.toolGroupRunning', { count: running })}</span>}
      {failed > 0 && <span className="task-tool-group-failed">{t('live.toolGroupFailed', { count: failed })}</span>}
      <span className="task-tool-group-more">{expanded
        ? t('live.toolGroupLess')
        : t('live.toolGroupMore', { count: hiddenCount })}</span>
      <UiIcon name="chevron-down" className="task-tool-group-chevron" size={14}/>
    </Button>}
    <div className="task-tool-list">{(sequence ?? tools.map((tool): TaskToolGroupSequenceEntry => ({
      type: 'tool', key: tool.id, tool,
    }))).map((entry, index) => entry.type === 'content'
      ? <Fragment key={entry.key}>{entry.content}</Fragment>
      : visibleIds.has(entry.tool.id) && <TaskToolRow
        key={entry.key}
        model={entry.tool}
        compact={compact}
        meta={entry.meta ?? renderMeta?.(entry.tool)}
        details={entry.details ?? renderDetails?.(entry.tool)}
        last={index === (sequence?.length ?? tools.length) - 1}
        onClick={entry.onToolClick ?? (onToolClick ? () => onToolClick(entry.tool) : undefined)}
      />)}</div>
  </div>
}
